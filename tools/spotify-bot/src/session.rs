//! The one session (one account, one stream): a task driven by the desired state the server keeps re-sending. It owns the
//! librespot `Session` and `Player` (not a Connect device) and the LiveKit room, and drops all of them when it ends.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use librespot_core::{Session, SpotifyUri};
use librespot_playback::audio_backend::{Sink, SinkError, SinkResult};
use librespot_playback::config::{Bitrate, NormalisationType, PlayerConfig};
use librespot_playback::convert::Converter;
use librespot_playback::decoder::AudioPacket;
use librespot_playback::mixer::NoOpVolume;
use librespot_playback::player::{Player, PlayerEvent, PlayerEventChannel};
use livekit::prelude::RoomEvent;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::account::{Account, Fail};
use crate::plan::{self, Desired, Lease, Now, Step};
use crate::pump::{Pipeline, Publisher};
use crate::report::{Event, Kind, Reason, Reporter};

pub enum PutError {
    /// Another channel holds the account; the API turns this into 503.
    Busy,
}

struct Entry {
    generation: u64,
    channel_id: String,
    desired: watch::Sender<Desired>,
    cancel: CancellationToken,
    lease: Lease,
}

/// A new session for the caller to spawn with `run`.
pub struct Start {
    generation: u64,
    desired: watch::Receiver<Desired>,
    cancel: CancellationToken,
}

pub struct Manager {
    reporter: Reporter,
    pub account: Arc<Account>,
    slot: Mutex<Option<Entry>>,
    generation: AtomicU64,
}

impl Manager {
    pub fn new(reporter: Reporter, account: Arc<Account>) -> Arc<Self> {
        Arc::new(Self { reporter, account, slot: Mutex::default(), generation: AtomicU64::new(1) })
    }

    /// Idempotent: renews the lease and hands the session the new state when its `seq` is not older, or returns a `Start`.
    pub fn put(&self, desired: Desired) -> Result<Option<Start>, PutError> {
        let mut slot = self.slot.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        if let Some(entry) = slot.as_mut() {
            if entry.channel_id != desired.channel_id {
                return Err(PutError::Busy);
            }
            entry.lease.renew(now);
            entry.desired.send_if_modified(|current| {
                let newer = desired.seq >= current.seq && *current != desired;
                if newer {
                    *current = desired;
                }
                newer
            });
            return Ok(None);
        }
        let generation = self.generation.fetch_add(1, Ordering::Relaxed);
        let channel_id = desired.channel_id.clone();
        let (tx, rx) = watch::channel(desired);
        let cancel = CancellationToken::new();
        *slot = Some(Entry { generation, channel_id, desired: tx, cancel: cancel.clone(), lease: Lease::new(now) });
        Ok(Some(Start { generation, desired: rx, cancel }))
    }

    pub fn delete(&self) {
        if let Some(entry) = self.slot.lock().unwrap_or_else(|e| e.into_inner()).take() {
            entry.cancel.cancel();
        }
    }

    /// Drops the session when its lease ran out (the server stopped renewing it).
    pub fn sweep_expired(&self) {
        let mut slot = self.slot.lock().unwrap_or_else(|e| e.into_inner());
        if slot.as_ref().is_some_and(|entry| entry.lease.expired(Instant::now()))
            && let Some(entry) = slot.take()
        {
            tracing::warn!(channel_id = entry.channel_id, "lease expired, dropping session");
            entry.cancel.cancel();
        }
    }

    fn finished(&self, generation: u64) {
        let mut slot = self.slot.lock().unwrap_or_else(|e| e.into_inner());
        if slot.as_ref().is_some_and(|e| e.generation == generation) {
            *slot = None;
        }
    }
}

pub async fn run(mgr: Arc<Manager>, start: Start) {
    let Start { generation, mut desired, cancel } = start;
    let first = desired.borrow_and_update().clone();
    let opened = tokio::select! {
        () = cancel.cancelled() => None,
        opened = Live::open(&mgr, &first) => Some(opened),
    };
    let result = match opened {
        None => Ok(()),
        Some(Err(fail)) => Err((fail, first.track.clone(), first.seq)),
        Some(Ok(mut live)) => {
            let result = live.drive(&mut desired, &cancel).await;
            let at = (live.current.clone().unwrap_or_else(|| live.applied.track.clone()), live.applied.seq);
            live.teardown(&mgr.account).await;
            result.map_err(|fail| (fail, at.0, at.1))
        }
    };
    mgr.finished(generation);
    match result {
        Ok(()) => tracing::info!(channel_id = first.channel_id, "session closed"),
        Err((fail, track, seq)) => {
            tracing::warn!(channel_id = first.channel_id, ?fail, "session failed");
            let reason = if fail == Fail::Auth { Reason::Auth } else { Reason::Io };
            mgr.reporter.send(Event { channel_id: first.channel_id, event: Kind::Error, track, position_ms: 0, seq, reason: Some(reason) });
        }
    }
}

/// The player's position, extrapolated while it plays.
#[derive(Clone, Copy)]
struct Clock {
    ms: u64,
    at: Instant,
    playing: bool,
}

impl Clock {
    fn new(ms: u64, playing: bool) -> Self {
        Self { ms, at: Instant::now(), playing }
    }
    fn now(&self) -> u64 {
        if self.playing { self.ms + self.at.elapsed().as_millis() as u64 } else { self.ms }
    }
}

struct LiveSink {
    tx: std::sync::mpsc::SyncSender<(u64, Vec<i16>)>,
    epoch: Arc<AtomicU64>,
    pipeline: Pipeline,
}

impl Sink for LiveSink {
    fn write(&mut self, packet: AudioPacket, _converter: &mut Converter) -> SinkResult<()> {
        let AudioPacket::Samples(samples) = packet else { return Err(SinkError::OnWrite("raw packets are not supported".into())) };
        let epoch = self.epoch.load(Ordering::Acquire);
        for frame in self.pipeline.process(&samples) {
            self.tx.send((epoch, frame)).map_err(|_| SinkError::OnWrite("publisher closed".into()))?;
        }
        Ok(())
    }
}

/// First word of a Debug string, so event logs carry the variant and never a payload.
fn variant(event: &PlayerEvent) -> String {
    format!("{event:?}").split([' ', '{', '(']).next().unwrap_or("").to_owned()
}

fn uri(track: &str) -> Option<SpotifyUri> {
    // Validated at the API; checked again before anything reaches the player (design §9.4).
    if plan::valid_track_uri(track) { SpotifyUri::from_uri(track).ok() } else { None }
}

struct Live {
    reporter: Reporter,
    channel_id: String,
    session: Session,
    player: Arc<Player>,
    events: PlayerEventChannel,
    publisher: Publisher,
    room_events: UnboundedReceiver<RoomEvent>,
    /// The newest desired state taken (its `seq` and `next`).
    applied: Desired,
    /// What the player has loaded.
    current: Option<String>,
    advanced_from: Option<String>,
    clock: Clock,
    started: Option<u64>,
    preload_due: bool,
    /// The track ended and nothing followed.
    ended: bool,
}

impl Live {
    async fn open(mgr: &Manager, d: &Desired) -> Result<Self, Fail> {
        let session = mgr.account.connect().await?;
        let (publisher, room_events) = match Publisher::join(&d.livekit_url, &d.token).await {
            Ok(joined) => joined,
            Err(message) => {
                tracing::warn!(message = message.replace(&d.token, "<token>"), "cannot publish");
                session.shutdown();
                return Err(Fail::Io);
            }
        };
        let config = PlayerConfig {
            bitrate: Bitrate::Bitrate320,
            gapless: true,
            normalisation: true,
            normalisation_type: NormalisationType::Auto,
            position_update_interval: Some(Duration::from_secs(5)),
            ..PlayerConfig::default()
        };
        let sink = LiveSink { tx: publisher.tx.clone(), epoch: publisher.epoch.clone(), pipeline: Pipeline::new() };
        let player = Player::new(config, session.clone(), Box::new(NoOpVolume), move || Box::new(sink));
        let events = player.get_player_event_channel();
        mgr.account.set_playing(Some(session.clone()));
        tracing::info!(channel_id = d.channel_id, "session open");
        let mut live = Self {
            reporter: mgr.reporter.clone(),
            channel_id: d.channel_id.clone(),
            session,
            player,
            events,
            publisher,
            room_events,
            applied: d.clone(),
            current: None,
            advanced_from: None,
            clock: Clock::new(d.position_ms, false),
            started: None,
            preload_due: false,
            ended: false,
        };
        live.load(&d.track, d.position_ms, d.playing);
        Ok(live)
    }

    async fn drive(&mut self, desired: &mut watch::Receiver<Desired>, cancel: &CancellationToken) -> Result<(), Fail> {
        let mut health = tokio::time::interval(Duration::from_secs(1));
        loop {
            tokio::select! {
                () = cancel.cancelled() => return Ok(()),
                changed = desired.changed() => {
                    if changed.is_err() {
                        return Ok(());
                    }
                    let next = desired.borrow_and_update().clone();
                    self.apply(next);
                }
                event = self.events.recv() => match event {
                    Some(event) => self.on_player(event),
                    None => return Err(Fail::Io),
                },
                event = self.room_events.recv() => match event {
                    Some(RoomEvent::Disconnected { reason }) => {
                        tracing::warn!(?reason, "disconnected from LiveKit");
                        return Err(Fail::Io);
                    }
                    None => return Err(Fail::Io),
                    Some(_) => {}
                },
                _ = health.tick() => {
                    if self.session.is_invalid() || self.player.is_invalid() {
                        tracing::warn!(session = self.session.is_invalid(), player = self.player.is_invalid(), "spotify session ended");
                        return Err(Fail::Io);
                    }
                }
            }
        }
    }

    fn report(&self, event: Kind, track: &str, reason: Option<Reason>) {
        self.reporter.send(Event {
            channel_id: self.channel_id.clone(),
            event,
            track: track.to_owned(),
            position_ms: self.clock.now(),
            seq: self.applied.seq,
            reason,
        });
    }

    fn load(&mut self, track: &str, position_ms: u64, playing: bool) {
        let Some(id) = uri(track) else { return };
        self.publisher.flush();
        self.player.load(id, playing, u32::try_from(position_ms).unwrap_or(u32::MAX));
        self.current = Some(track.to_owned());
        self.advanced_from = None;
        self.clock = Clock::new(position_ms, false);
        self.started = None;
        self.preload_due = false;
        self.ended = false;
    }

    fn apply(&mut self, d: Desired) {
        let now = Now {
            seq: self.applied.seq,
            track: self.current.as_deref(),
            advanced_from: self.advanced_from.as_deref(),
            position_ms: self.clock.now(),
            playing: self.clock.playing,
        };
        let step = plan::reconcile(&now, &d);
        tracing::debug!(?step, seq = d.seq, "update");
        if step == Step::Stale {
            return;
        }
        if self.current.as_deref() == Some(d.track.as_str()) {
            self.advanced_from = None;
        }
        let next_changed = d.next != self.applied.next;
        match step {
            Step::Stale | Step::Keep => {}
            Step::Load => self.load(&d.track, d.position_ms, d.playing),
            // After the end the player has nothing loaded to steer.
            Step::Steer { .. } if self.ended => self.load(&d.track, d.position_ms, d.playing),
            Step::Steer { play, seek } => {
                if let Some(at) = seek {
                    self.publisher.flush();
                    self.player.seek(u32::try_from(at).unwrap_or(u32::MAX));
                    self.clock = Clock::new(at, self.clock.playing);
                }
                match play {
                    Some(true) => self.player.play(),
                    Some(false) => {
                        self.player.pause();
                        self.publisher.flush();
                        self.clock = Clock::new(self.clock.now(), false);
                    }
                    None => {}
                }
            }
        }
        self.applied = d;
        if next_changed && self.preload_due {
            self.preload();
        }
    }

    fn preload(&self) {
        if let Some(next) = self.applied.next.as_deref().and_then(uri) {
            self.player.preload(next);
        }
    }

    fn is_current(&self, track: &SpotifyUri) -> bool {
        self.current.as_deref() == Some(track.to_uri().as_str())
    }

    fn on_player(&mut self, event: PlayerEvent) {
        tracing::debug!(event = variant(&event), "player");
        match event {
            PlayerEvent::Playing { play_request_id, track_id, position_ms } if self.is_current(&track_id) => {
                self.clock = Clock::new(u64::from(position_ms), true);
                let first = self.started != Some(play_request_id);
                self.started = Some(play_request_id);
                self.report(if first { Kind::Started } else { Kind::Position }, &track_id.to_uri(), None);
            }
            PlayerEvent::Paused { track_id, position_ms, .. } if self.is_current(&track_id) => {
                self.clock = Clock::new(u64::from(position_ms), false);
                self.report(Kind::Position, &track_id.to_uri(), None);
            }
            PlayerEvent::Seeked { track_id, position_ms, .. } | PlayerEvent::PositionChanged { track_id, position_ms, .. } if self.is_current(&track_id) => {
                self.clock = Clock::new(u64::from(position_ms), self.clock.playing);
                self.report(Kind::Position, &track_id.to_uri(), None);
            }
            PlayerEvent::PositionCorrection { track_id, position_ms, .. } if self.is_current(&track_id) => {
                self.clock = Clock::new(u64::from(position_ms), self.clock.playing);
            }
            PlayerEvent::TimeToPreloadNextTrack { track_id, .. } if self.is_current(&track_id) => {
                self.preload_due = true;
                self.preload();
            }
            PlayerEvent::EndOfTrack { track_id, .. } if self.is_current(&track_id) => {
                let ended = track_id.to_uri();
                self.clock = Clock::new(self.clock.now(), false);
                self.report(Kind::Ended, &ended, None);
                match self.applied.next.clone() {
                    // Gapless when preloaded; the server hears `ended`, then `started` for this one.
                    Some(next) => {
                        self.load(&next, 0, true);
                        self.advanced_from = Some(ended);
                    }
                    None => self.ended = true,
                }
            }
            PlayerEvent::Unavailable { track_id, .. } | PlayerEvent::AudioKeyUnavailable { track_id, .. } if self.is_current(&track_id) => {
                self.clock = Clock::new(self.clock.now(), false);
                self.report(Kind::Error, &track_id.to_uri(), Some(Reason::Unavailable));
            }
            _ => {}
        }
    }

    async fn teardown(self, account: &Account) {
        account.set_playing(None);
        self.player.stop();
        let Self { player, events, publisher, session, .. } = self;
        drop(events);
        // Dropping the player joins its thread, which may sit in the sink's blocking send for a moment.
        let _ = tokio::task::spawn_blocking(move || drop(player)).await;
        publisher.close().await;
        session.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn desired(channel: &str, seq: u64) -> Desired {
        Desired {
            channel_id: channel.into(),
            livekit_url: "ws://127.0.0.1:27880".into(),
            token: "t".into(),
            track: "spotify:track:4uLU6hMCjMI75M1A2tKUQC".into(),
            next: None,
            position_ms: 0,
            playing: true,
            seq,
        }
    }

    fn manager() -> Arc<Manager> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        Manager::new(Reporter::new("http://127.0.0.1:9", "0123456789abcdef"), Arc::new(Account::new().expect("account")))
    }

    #[tokio::test]
    async fn one_session_newest_seq_wins_and_others_are_busy() {
        let mgr = manager();
        let Ok(Some(mut start)) = mgr.put(desired("1", 5)) else { panic!("first put starts a session") };
        assert!(matches!(mgr.put(desired("2", 9)), Err(PutError::Busy)));
        assert!(matches!(mgr.put(desired("1", 4)), Ok(None)));
        assert_eq!(start.desired.borrow_and_update().seq, 5);
        assert!(matches!(mgr.put(desired("1", 6)), Ok(None)));
        assert!(start.desired.has_changed().expect("open"));
        assert_eq!(start.desired.borrow_and_update().seq, 6);
        // A lease re-send of the same state does not wake the session.
        assert!(matches!(mgr.put(desired("1", 6)), Ok(None)));
        assert!(!start.desired.has_changed().expect("open"));

        mgr.delete();
        assert!(start.cancel.is_cancelled());
        assert!(matches!(mgr.put(desired("2", 1)), Ok(Some(_))));
    }

    #[tokio::test]
    async fn an_old_session_finishing_does_not_drop_the_new_one() {
        let mgr = manager();
        let Ok(Some(old)) = mgr.put(desired("1", 1)) else { panic!("starts") };
        mgr.delete();
        let Ok(Some(_new)) = mgr.put(desired("1", 2)) else { panic!("starts") };
        mgr.finished(old.generation);
        assert!(matches!(mgr.put(desired("2", 3)), Err(PutError::Busy)));
    }

    #[test]
    fn clock_runs_only_while_playing() {
        let paused = Clock { ms: 1000, at: Instant::now() - Duration::from_secs(2), playing: false };
        assert_eq!(paused.now(), 1000);
        let playing = Clock { playing: true, ..paused };
        assert!(playing.now() >= 3000);
    }
}
