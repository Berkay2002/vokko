//! Sessions: one task per voice channel, driven by the desired state the server keeps re-sending.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use livekit::prelude::{Room, RoomEvent, RoomOptions};
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;

use crate::config::Config;
use crate::media::{self, Notify, Pipeline, Published};
use crate::plan::{self, Action, Choice, Desired, Geometry, Lease, Probe};
use crate::report::{Kind, Reporter, Tracks};

pub enum PutError {
    /// `VOKKO_STREMIO_MAX_SESSIONS` reached; the API turns this into 503.
    Busy,
}

struct Entry {
    generation: u64,
    desired: watch::Sender<Desired>,
    cancel: CancellationToken,
    lease: Lease,
}

pub struct Manager {
    cfg: Arc<Config>,
    reporter: Reporter,
    sessions: Mutex<HashMap<String, Entry>>,
    generation: AtomicU64,
}

impl Manager {
    pub fn new(cfg: Arc<Config>, reporter: Reporter) -> Arc<Self> {
        Arc::new(Self { cfg, reporter, sessions: Mutex::default(), generation: AtomicU64::new(1) })
    }

    /// Idempotent: creates the session, or renews its lease and hands the actor the new desired state.
    pub fn put(self: &Arc<Self>, channel_id: &str, desired: Desired) -> Result<(), PutError> {
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        if let Some(entry) = sessions.get_mut(channel_id) {
            entry.lease.renew(now);
            entry.desired.send_if_modified(|current| {
                let changed = *current != desired;
                if changed {
                    *current = desired;
                }
                changed
            });
            return Ok(());
        }
        if sessions.len() >= self.cfg.max_sessions {
            return Err(PutError::Busy);
        }
        let generation = self.generation.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = watch::channel(desired);
        let cancel = CancellationToken::new();
        sessions.insert(channel_id.to_owned(), Entry { generation, desired: tx, cancel: cancel.clone(), lease: Lease::new(now) });
        tokio::spawn(run(self.clone(), channel_id.to_owned(), generation, rx, cancel));
        Ok(())
    }

    pub fn delete(&self, channel_id: &str) {
        let entry = self.sessions.lock().unwrap_or_else(|e| e.into_inner()).remove(channel_id);
        if let Some(entry) = entry {
            entry.cancel.cancel();
        }
    }

    pub fn delete_all(&self) {
        let all: Vec<Entry> = self.sessions.lock().unwrap_or_else(|e| e.into_inner()).drain().map(|(_, e)| e).collect();
        for entry in all {
            entry.cancel.cancel();
        }
    }

    /// Drops every session whose lease ran out (the server stopped renewing it).
    pub fn sweep_expired(&self) {
        let now = Instant::now();
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        sessions.retain(|channel_id, entry| {
            let alive = !entry.lease.expired(now);
            if !alive {
                tracing::warn!(channel_id, "lease expired, dropping session");
                entry.cancel.cancel();
            }
            alive
        });
    }

    fn finished(&self, channel_id: &str, generation: u64) {
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        if sessions.get(channel_id).is_some_and(|e| e.generation == generation) {
            sessions.remove(channel_id);
        }
    }
}

async fn run(mgr: Arc<Manager>, channel_id: String, generation: u64, rx: watch::Receiver<Desired>, cancel: CancellationToken) {
    let mut live = Live::new(mgr.clone(), channel_id.clone());
    let result = live.drive(rx, &cancel).await;
    let (position, duration) = (live.current_ms(), live.duration_ms());
    live.teardown().await;
    mgr.finished(&channel_id, generation);
    match result {
        Ok(()) => tracing::info!(channel_id, "session closed"),
        Err(message) => {
            tracing::error!(channel_id, %message, "session failed");
            mgr.reporter.send(&channel_id, Kind::Error, position, duration, Some(message));
        }
    }
}

struct Source {
    probe: Probe,
    geo: Geometry,
}

/// The state of one running session. Everything the actor owns lives here so teardown is one call.
struct Live {
    mgr: Arc<Manager>,
    channel_id: String,
    desired: Option<Desired>,
    room: Option<Room>,
    out: Option<Published>,
    source: Option<Source>,
    pipeline: Option<Pipeline>,
    /// Where a paused or finished session stands.
    hold_ms: u64,
    ended: bool,
    retries: u8,
    /// The tracks ffmpeg runs with, and the item (`Desired::generation`) they were chosen for.
    choice: Choice,
    item: Option<u64>,
}

impl Live {
    fn new(mgr: Arc<Manager>, channel_id: String) -> Self {
        Self {
            mgr,
            channel_id,
            desired: None,
            room: None,
            out: None,
            source: None,
            pipeline: None,
            hold_ms: 0,
            ended: false,
            retries: 1,
            choice: Choice::default(),
            item: None,
        }
    }

    fn current_ms(&self) -> u64 {
        self.pipeline.as_ref().map_or(self.hold_ms, Pipeline::position_ms)
    }

    fn duration_ms(&self) -> Option<u64> {
        self.source.as_ref().and_then(|s| s.probe.duration_ms)
    }

    async fn drive(&mut self, mut rx: watch::Receiver<Desired>, cancel: &CancellationToken) -> Result<(), String> {
        let first = rx.borrow_and_update().clone();
        self.hold_ms = first.position_ms;
        let mut events = tokio::select! {
            () = cancel.cancelled() => return Ok(()),
            r = self.open(&first) => r?,
        };
        self.desired = Some(first.clone());
        if first.playing {
            self.start(first.position_ms).await?;
        }

        let mut position_tick = tokio::time::interval(Duration::from_secs(5));
        let mut keepalive_tick = tokio::time::interval(Duration::from_secs(1));
        loop {
            tokio::select! {
                () = cancel.cancelled() => return Ok(()),
                event = events.recv() => match event {
                    Some(RoomEvent::Disconnected { reason }) => return Err(format!("disconnected from LiveKit: {reason:?}")),
                    None => return Err("LiveKit connection closed".into()),
                    Some(_) => {}
                },
                changed = rx.changed() => {
                    if changed.is_err() {
                        return Ok(());
                    }
                    let next = rx.borrow_and_update().clone();
                    if let Some(new_events) = self.apply(next).await? {
                        events = new_events;
                    }
                }
                status = exited(&mut self.pipeline) => self.on_exit(status).await?,
                _ = position_tick.tick() => {
                    if self.pipeline.is_some() {
                        self.mgr.reporter.send(&self.channel_id, Kind::Position, self.current_ms(), self.duration_ms(), None);
                        if let Some(out) = &self.out {
                            out.log_stats().await;
                        }
                    }
                }
                _ = keepalive_tick.tick() => {
                    if self.pipeline.is_none()
                        && let Some(out) = &self.out
                    {
                        out.resend_last_frame();
                    }
                }
            }
        }
    }

    /// Probes the file, joins the room and publishes both tracks.
    async fn open(&mut self, d: &Desired) -> Result<mpsc::UnboundedReceiver<RoomEvent>, String> {
        self.load(d).await?;
        let events = self.join(d).await?;
        self.republish(d).await?;
        Ok(events)
    }

    async fn load(&mut self, d: &Desired) -> Result<(), String> {
        let probe = media::probe(&self.mgr.cfg, d).await.map_err(|e| redact(&e, d))?;
        let geo = plan::geometry(&probe, d.max_height);
        tracing::info!(
            channel_id = self.channel_id,
            width = geo.width,
            height = geo.height,
            fps = geo.fps,
            hdr = probe.hdr,
            audio = probe.audio_tracks.len(),
            subtitles = probe.subtitle_tracks.len(),
            "probed"
        );
        let defaults = plan::defaults(&probe);
        let tracks = Tracks {
            generation: d.generation,
            audio: defaults.audio,
            burned_subtitle: defaults.burned,
            audio_tracks: probe.audio_tracks.clone(),
            subtitle_tracks: probe.subtitle_tracks.clone(),
        };
        self.mgr.reporter.send_tracks(&self.channel_id, d.position_ms, tracks);
        self.choice = plan::choose(&probe, d, self.item != Some(d.generation));
        self.item = Some(d.generation);
        self.source = Some(Source { probe, geo });
        Ok(())
    }

    async fn join(&mut self, d: &Desired) -> Result<mpsc::UnboundedReceiver<RoomEvent>, String> {
        let mut options = RoomOptions::default();
        options.auto_subscribe = false;
        let connect = Room::connect(&d.livekit_url, &d.token, options);
        let (room, events) = tokio::time::timeout(Duration::from_secs(30), connect)
            .await
            .map_err(|_| "LiveKit connect timed out".to_owned())?
            .map_err(|e| redact(&format!("LiveKit connect: {e}"), d))?;
        tracing::info!(channel_id = self.channel_id, host = plan::host_of(&d.livekit_url), "joined room");
        self.room = Some(room);
        Ok(events)
    }

    /// (Re)publishes the tracks when the geometry or bitrate they were created with changed.
    async fn republish(&mut self, d: &Desired) -> Result<(), String> {
        let (Some(room), Some(source)) = (&self.room, &self.source) else { return Err("not connected".into()) };
        if let Some(out) = self.out.take() {
            out.unpublish(room).await;
        }
        let out = media::publish(room, &source.geo, d, &self.mgr.cfg).await.map_err(|e| redact(&e, d))?;
        self.out = Some(out);
        Ok(())
    }

    async fn start(&mut self, at_ms: u64) -> Result<(), String> {
        self.stop_pipeline().await;
        let (Some(d), Some(source), Some(out)) = (&self.desired, &self.source, &self.out) else { return Err("not ready".into()) };
        let notify = Notify { reporter: self.mgr.reporter.clone(), channel_id: self.channel_id.clone(), duration_ms: source.probe.duration_ms };
        let pipeline = Pipeline::spawn(&self.mgr.cfg, d, &source.probe, &source.geo, self.choice, at_ms, out, notify).await.map_err(|e| redact(&e, d))?;
        self.pipeline = Some(pipeline);
        self.hold_ms = at_ms;
        self.ended = false;
        Ok(())
    }

    async fn stop_pipeline(&mut self) {
        if let Some(p) = self.pipeline.take() {
            self.hold_ms = p.position_ms();
            p.stop().await;
        }
        if let Some(out) = &self.out {
            out.clear_audio();
        }
    }

    /// Applies a re-sent `PUT`. Returns new room events when the room was rejoined.
    async fn apply(&mut self, next: Desired) -> Result<Option<mpsc::UnboundedReceiver<RoomEvent>>, String> {
        let Some(prev) = self.desired.clone() else { return Ok(None) };
        let playing_now = self.pipeline.is_some() || self.ended;
        let wanted = self.source.as_ref().map_or(self.choice, |s| plan::choose(&s.probe, &next, false));
        let mut action = plan::reconcile(&prev, &next, self.current_ms(), playing_now, wanted != self.choice);
        self.choice = wanted;
        // After the end the server's position sits at the end, which can be a few seconds from where audio stopped.
        if let (true, Action::Seek(pos)) = (self.ended, action)
            && pos + 10_000 >= self.hold_ms
        {
            action = Action::Keep;
        }
        tracing::debug!(channel_id = self.channel_id, ?action, "update");
        self.desired = Some(next.clone());
        match action {
            Action::Keep => {}
            Action::Hold(pos) => self.hold_ms = pos,
            Action::Pause => {
                self.stop_pipeline().await;
                self.ended = false;
            }
            Action::Resume(pos) | Action::Seek(pos) => self.start(pos).await?,
            Action::Retrack => {
                if self.pipeline.is_some() {
                    self.start(self.current_ms()).await?;
                }
            }
            Action::Restart => {
                self.stop_pipeline().await;
                self.load(&next).await?;
                self.republish(&next).await?;
                self.begin(&next).await?;
            }
            Action::Reconnect => {
                self.stop_pipeline().await;
                self.leave().await;
                self.load(&next).await?;
                let events = self.join(&next).await?;
                self.republish(&next).await?;
                self.begin(&next).await?;
                return Ok(Some(events));
            }
        }
        Ok(None)
    }

    async fn begin(&mut self, d: &Desired) -> Result<(), String> {
        self.retries = 1;
        self.hold_ms = d.position_ms;
        self.ended = false;
        if d.playing { self.start(d.position_ms).await } else { Ok(()) }
    }

    async fn on_exit(&mut self, status: std::io::Result<std::process::ExitStatus>) -> Result<(), String> {
        let Some(mut p) = self.pipeline.take() else { return Ok(()) };
        p.drain().await;
        let position = p.position_ms();
        let started_at = self.hold_ms;
        self.hold_ms = position;
        // A clean exit that produced nothing (a seek ffmpeg could not do) is a failure, not the end, unless the seek was at the end.
        let near_end = self.duration_ms().is_some_and(|d| position + 1000 >= d);
        if status.as_ref().is_ok_and(|s| s.success()) && (position > started_at || near_end) {
            tracing::info!(channel_id = self.channel_id, position, "ended");
            self.ended = true;
            self.mgr.reporter.send(&self.channel_id, Kind::Ended, position, self.duration_ms(), None);
            return Ok(());
        }
        let reason = p.last_error();
        if self.retries > 0 {
            self.retries -= 1;
            tracing::warn!(channel_id = self.channel_id, position, %reason, "ffmpeg failed, retrying once");
            return self.start(position).await;
        }
        Err(if reason.is_empty() { "ffmpeg produced no frames".into() } else { format!("ffmpeg: {reason}") })
    }

    async fn leave(&mut self) {
        if let (Some(room), Some(out)) = (&self.room, self.out.take()) {
            out.unpublish(room).await;
        }
        if let Some(room) = self.room.take() {
            let _ = room.close().await;
        }
    }

    async fn teardown(&mut self) {
        self.stop_pipeline().await;
        self.leave().await;
    }
}

async fn exited(pipeline: &mut Option<Pipeline>) -> std::io::Result<std::process::ExitStatus> {
    match pipeline {
        Some(p) => p.exited().await,
        None => std::future::pending().await,
    }
}

/// Error text goes to the server and the log: take the secrets out first.
fn redact(message: &str, d: &Desired) -> String {
    message.replace(&d.token, "<token>").replace(&d.media_url, "<media>").replace(&d.livekit_url, "<livekit>")
}
