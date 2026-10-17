//! Native LiveKit voice for the Linux app (WebKitGTK has no RTCPeerConnection, so livekit-client can't run in the page).
//! The page's `NativeTransport` (src/voice/nativeTransport.ts) drives one room here through the `native_voice_*` commands and
//! hears back through the Channel it passes to `native_voice_connect`. Same policy as livekitTransport.ts: the microphone is
//! published only while not self-muted, remote microphones are subscribed unless their volume is 0, media bots are ignored.

mod audio;
mod gate;

use audio::{AudioDevice, Capture, Params, Playback, Shared};
use futures_util::StreamExt;
use gate::GateOptions;
use livekit::options::TrackPublishOptions;
use livekit::prelude::*;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_source::{AudioSourceOptions, RtcAudioSource};
use livekit::webrtc::audio_stream::native::NativeAudioStream;
use livekit::webrtc::prelude::AudioFrame;
use livekit::webrtc::stats::RtcStats;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::State;
use tauri::async_runtime::JoinHandle;
use tauri::ipc::Channel;
use tokio::sync::Mutex;

const PING_EVERY: Duration = Duration::from_secs(2);

/// The page's VoiceSettings (src/voice/reducer.ts); fields the native side doesn't use are ignored.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSettings {
    input_mode: String,
    ptt_release_ms: f64,
    vad_threshold_db: f64,
    vad_auto: bool,
    input_device_id: String,
    output_device_id: String,
    echo_cancellation: bool,
    noise_suppression: bool,
    auto_gain_control: bool,
    input_gain: f32,
    /// RNNoise lives in the page's Web Audio chain; here it falls back to WebRTC's noise suppression.
    rnnoise: bool,
    output_gain: f32,
    duck: f32,
}

impl VoiceSettings {
    fn params(&self) -> Params {
        Params {
            gate: GateOptions { ptt: self.input_mode == "ptt", threshold_db: self.vad_threshold_db, auto: self.vad_auto, ptt_release_ms: self.ptt_release_ms },
            input_gain: self.input_gain.clamp(0.0, 2.0),
            output_gain: (self.output_gain * self.duck).clamp(0.0, 2.0),
            echo_cancellation: self.echo_cancellation,
            noise_suppression: self.noise_suppression || self.rnnoise,
            auto_gain_control: self.auto_gain_control,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectInit {
    self_mute: bool,
    self_deaf: bool,
    settings: VoiceSettings,
    /// Playback volume per user id (0..2) for the users known at connect; later ones come through set_user_volume.
    volumes: HashMap<String, f32>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum NativeEvent {
    Status {
        status: &'static str,
    },
    Speaking {
        user_ids: Vec<String>,
    },
    SelfSpeaking {
        speaking: bool,
    },
    Quality {
        quality: &'static str,
    },
    Ping {
        ms: Option<f64>,
    },
    Closed {
        #[serde(rename = "final")]
        is_final: bool,
        reason: Option<&'static str>,
    },
    /// A user joined the room: the page answers with set_user_volume when it has a stored volume for them.
    Participant {
        user_id: String,
    },
    MicFailed {
        reason: &'static str,
    },
}

#[derive(Serialize)]
pub struct DeviceLists {
    input: Vec<AudioDevice>,
    output: Vec<AudioDevice>,
}

struct Mic {
    publication: LocalTrackPublication,
    _capture: Capture,
    pump: JoinHandle<()>,
}

struct Session {
    room: Arc<Room>,
    events: Channel<NativeEvent>,
    settings: VoiceSettings,
    playback: Option<Playback>,
    mic: Option<Mic>,
    /// The client is leaving: the room's Disconnected event is ours, not something to report.
    leaving: Arc<AtomicBool>,
    tasks: Vec<JoinHandle<()>>,
    /// Remote microphone readers by track sid.
    readers: Arc<std::sync::Mutex<HashMap<String, JoinHandle<()>>>>,
}

pub struct NativeVoice {
    shared: Arc<Shared>,
    session: Mutex<Option<Session>>,
}

impl Default for NativeVoice {
    fn default() -> Self {
        let params = Params {
            gate: GateOptions { ptt: false, threshold_db: -60.0, auto: true, ptt_release_ms: 20.0 },
            input_gain: 1.0,
            output_gain: 1.0,
            echo_cancellation: true,
            noise_suppression: true,
            auto_gain_control: true,
        };
        Self { shared: Arc::new(Shared::new(params)), session: Mutex::new(None) }
    }
}

fn is_media_identity(identity: &str) -> bool {
    identity.starts_with("bot:") || identity.starts_with("viewer:")
}

/// Subscription policy for one remote publication: microphones unless the user's volume is 0 (saves egress, as on the web).
fn consider(shared: &Shared, publication: &RemoteTrackPublication, participant: &RemoteParticipant) {
    let identity = participant.identity().to_string();
    if is_media_identity(&identity) || publication.kind() != TrackKind::Audio || publication.source() != TrackSource::Microphone {
        return;
    }
    let wanted = shared.volume(&identity) > 0.0;
    if publication.is_subscribed() != wanted {
        publication.set_subscribed(wanted);
    }
}

fn quality_name(quality: ConnectionQuality) -> &'static str {
    match quality {
        ConnectionQuality::Excellent => "excellent",
        ConnectionQuality::Good => "good",
        ConnectionQuality::Poor => "poor",
        ConnectionQuality::Lost => "lost",
    }
}

/// Round trip of the selected ICE candidate pair, in ms.
async fn ping_ms(room: &Room) -> Option<f64> {
    let stats = room.get_stats().await.ok()?;
    stats.publisher_stats.iter().chain(stats.subscriber_stats.iter()).find_map(|s| match s {
        RtcStats::CandidatePair(pair) if pair.candidate_pair.nominated && pair.candidate_pair.current_round_trip_time > 0.0 => {
            Some(pair.candidate_pair.current_round_trip_time * 1000.0)
        }
        _ => None,
    })
}

fn start_reader(shared: Arc<Shared>, readers: &Arc<std::sync::Mutex<HashMap<String, JoinHandle<()>>>>, track: RemoteAudioTrack, identity: String) {
    let sid = track.sid().to_string();
    let key = sid.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let mut stream = NativeAudioStream::new(track.rtc_track(), audio::RATE as i32, 1);
        while let Some(frame) = stream.next().await {
            shared.push_voice(&sid, &identity, &frame.data);
        }
        shared.drop_voice(&sid);
    });
    if let Ok(mut readers) = readers.lock() {
        if let Some(old) = readers.insert(key, handle) {
            old.abort();
        }
    }
}

fn stop_reader(shared: &Shared, readers: &std::sync::Mutex<HashMap<String, JoinHandle<()>>>, sid: &str) {
    if let Ok(mut readers) = readers.lock() {
        if let Some(handle) = readers.remove(sid) {
            handle.abort();
        }
    }
    shared.drop_voice(sid);
}

/// Room events → page events and subscriptions. Ends with the room.
async fn room_loop(
    room: Arc<Room>,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<RoomEvent>,
    shared: Arc<Shared>,
    events: Channel<NativeEvent>,
    leaving: Arc<AtomicBool>,
    readers: Arc<std::sync::Mutex<HashMap<String, JoinHandle<()>>>>,
) {
    let send = |event: NativeEvent| {
        if !leaving.load(Ordering::Relaxed) {
            let _ = events.send(event);
        }
    };
    let me = room.local_participant().identity();
    while let Some(event) = rx.recv().await {
        match event {
            RoomEvent::ParticipantConnected(participant) => {
                let identity = participant.identity().to_string();
                if !is_media_identity(&identity) {
                    send(NativeEvent::Participant { user_id: identity });
                }
            }
            RoomEvent::TrackPublished { publication, participant } => consider(&shared, &publication, &participant),
            RoomEvent::TrackSubscribed { track: RemoteTrack::Audio(track), publication, participant } => {
                let identity = participant.identity().to_string();
                if publication.source() == TrackSource::Microphone && !is_media_identity(&identity) {
                    start_reader(shared.clone(), &readers, track, identity);
                }
            }
            RoomEvent::TrackUnsubscribed { publication, .. } | RoomEvent::TrackUnpublished { publication, .. } => {
                stop_reader(&shared, &readers, &publication.sid().to_string())
            }
            RoomEvent::ActiveSpeakersChanged { speakers } => {
                let user_ids =
                    speakers.iter().map(|p| p.identity()).filter(|id| *id != me && !is_media_identity(id.as_str())).map(|id| id.to_string()).collect();
                send(NativeEvent::Speaking { user_ids });
            }
            RoomEvent::ConnectionQualityChanged { quality, participant } if participant.identity() == me => {
                send(NativeEvent::Quality { quality: quality_name(quality) })
            }
            RoomEvent::Reconnecting => send(NativeEvent::Status { status: "reconnecting" }),
            RoomEvent::Reconnected => send(NativeEvent::Status { status: "connected" }),
            RoomEvent::Disconnected { reason } => {
                // Duplicate identity = we joined from another device; removed = kicked by a moderator. Never retried.
                let (is_final, reason) = match reason {
                    DisconnectReason::DuplicateIdentity => (true, Some("moved")),
                    DisconnectReason::ParticipantRemoved => (true, Some("kicked")),
                    _ => (false, None),
                };
                log::info!("native voice: room disconnected (final: {is_final})");
                send(NativeEvent::Closed { is_final, reason });
                break;
            }
            _ => {}
        }
    }
}

impl Session {
    async fn close(mut self, shared: &Shared) {
        self.leaving.store(true, Ordering::Relaxed);
        if let Some(mic) = self.mic.take() {
            mic.pump.abort();
        }
        self.playback = None;
        for task in self.tasks.drain(..) {
            task.abort();
        }
        if let Ok(mut readers) = self.readers.lock() {
            for (_, handle) in readers.drain() {
                handle.abort();
            }
        }
        shared.clear_voices();
        let _ = self.room.close().await;
    }

    /// Opens and publishes the microphone (connected and not muted only); a failure leaves the call listen-only.
    async fn publish_mic(&mut self, shared: &Arc<Shared>) {
        if self.mic.is_some() || shared.muted.load(Ordering::Relaxed) {
            return;
        }
        let Some(playback) = self.playback.as_ref() else { return };
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<i16>>(32);
        let events = self.events.clone();
        let capture = match audio::start_capture(&self.settings.input_device_id, shared.clone(), playback, tx, move |speaking| {
            let _ = events.send(NativeEvent::SelfSpeaking { speaking });
        }) {
            Ok(capture) => capture,
            Err(error) => {
                log::warn!("native voice: microphone unavailable: {error}");
                let _ = self.events.send(NativeEvent::MicFailed { reason: "no_microphone" });
                return;
            }
        };
        let source =
            NativeAudioSource::new(AudioSourceOptions { echo_cancellation: false, noise_suppression: false, auto_gain_control: false }, audio::RATE, 1, 0);
        let pump_source = source.clone();
        let pump = tauri::async_runtime::spawn(async move {
            while let Some(samples) = rx.recv().await {
                let frame = AudioFrame { data: samples.into(), sample_rate: audio::RATE, num_channels: 1, samples_per_channel: audio::FRAME as u32 };
                let _ = pump_source.capture_frame(&frame).await;
            }
        });
        let track = LocalAudioTrack::create_audio_track("microphone", RtcAudioSource::Native(source));
        let options = TrackPublishOptions { source: TrackSource::Microphone, dtx: true, red: true, ..Default::default() };
        match self.room.local_participant().publish_track(LocalTrack::Audio(track), options).await {
            Ok(publication) => {
                // Muted while the publish was in flight: the gate already sends silence; the publication follows too.
                if shared.muted.load(Ordering::Relaxed) {
                    publication.mute();
                }
                self.mic = Some(Mic { publication, _capture: capture, pump });
            }
            Err(error) => {
                pump.abort();
                log::warn!("native voice: microphone publish failed: {error}");
                let _ = self.events.send(NativeEvent::MicFailed { reason: "no_microphone" });
            }
        }
    }

    fn restart_playback(&mut self, shared: &Arc<Shared>) {
        // The microphone's dsp thread is fed by the speakers: reopen both so the echo canceller keeps its reference.
        self.mic.take().map(|mic| mic.pump.abort());
        self.playback = match audio::start_playback(&self.settings.output_device_id, shared.clone()) {
            Ok(playback) => Some(playback),
            Err(error) => {
                log::warn!("native voice: speakers unavailable: {error}");
                None
            }
        };
    }
}

async fn connect(state: &NativeVoice, url: String, token: String, init: ConnectInit, events: Channel<NativeEvent>) -> Result<(), String> {
    let shared = state.shared.clone();
    let mut slot = state.session.lock().await;
    if let Some(old) = slot.take() {
        old.close(&shared).await;
    }
    shared.muted.store(init.self_mute, Ordering::Relaxed);
    shared.deaf.store(init.self_deaf, Ordering::Relaxed);
    shared.ptt.store(false, Ordering::Relaxed);
    if let Ok(mut params) = shared.params.lock() {
        *params = init.settings.params();
    }
    if let Ok(mut volumes) = shared.volumes.lock() {
        *volumes = init.volumes;
    }
    let _ = events.send(NativeEvent::Status { status: "rtc_connecting" });
    let options = RoomOptions { auto_subscribe: false, dynacast: true, ..Default::default() };
    let (room, rx) = Room::connect(&url, &token, options).await.map_err(|e| e.to_string())?;
    let room = Arc::new(room);
    let leaving = Arc::new(AtomicBool::new(false));
    let readers = Arc::new(std::sync::Mutex::new(HashMap::new()));
    let mut tasks = vec![tauri::async_runtime::spawn(room_loop(room.clone(), rx, shared.clone(), events.clone(), leaving.clone(), readers.clone()))];
    let ping_room = room.clone();
    let ping_events = events.clone();
    tasks.push(tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(PING_EVERY).await;
            let _ = ping_events.send(NativeEvent::Ping { ms: ping_ms(&ping_room).await });
        }
    }));
    let mut session = Session { room: room.clone(), events: events.clone(), settings: init.settings, playback: None, mic: None, leaving, tasks, readers };
    session.restart_playback(&shared);
    for participant in room.remote_participants().values() {
        for publication in participant.track_publications().values() {
            consider(&shared, publication, participant);
        }
    }
    let _ = events.send(NativeEvent::Status { status: "connected" });
    session.publish_mic(&shared).await;
    *slot = Some(session);
    Ok(())
}

async fn disconnect(state: &NativeVoice) -> Result<(), String> {
    if let Some(session) = state.session.lock().await.take() {
        session.close(&state.shared).await;
    }
    Ok(())
}

async fn set_mute(state: &NativeVoice, mute: bool) -> Result<(), String> {
    // The gate closes at once (the dsp thread reads the flag every frame), before the session lock is free.
    state.shared.muted.store(mute, Ordering::Relaxed);
    let mut slot = state.session.lock().await;
    let Some(session) = slot.as_mut() else { return Ok(()) };
    match (&session.mic, mute) {
        (Some(mic), true) => mic.publication.mute(),
        (Some(mic), false) => mic.publication.unmute(),
        (None, false) => session.publish_mic(&state.shared).await,
        (None, true) => {}
    }
    Ok(())
}

fn set_deaf(state: &NativeVoice, deaf: bool) {
    state.shared.deaf.store(deaf, Ordering::Relaxed);
}

fn set_ptt(state: &NativeVoice, pressed: bool) {
    state.shared.ptt.store(pressed, Ordering::Relaxed);
}

async fn set_user_volume(state: &NativeVoice, user_id: String, volume: f32) -> Result<(), String> {
    if let Ok(mut volumes) = state.shared.volumes.lock() {
        volumes.insert(user_id.clone(), volume.clamp(0.0, 2.0));
    }
    let slot = state.session.lock().await;
    let Some(session) = slot.as_ref() else { return Ok(()) };
    if let Some(participant) = session.room.remote_participants().values().find(|p| p.identity().as_str() == user_id) {
        for publication in participant.track_publications().values() {
            consider(&state.shared, publication, participant);
        }
    }
    Ok(())
}

async fn apply_settings(state: &NativeVoice, settings: VoiceSettings) -> Result<(), String> {
    if let Ok(mut params) = state.shared.params.lock() {
        *params = settings.params();
    }
    let mut slot = state.session.lock().await;
    let Some(session) = slot.as_mut() else { return Ok(()) };
    let input_changed = session.settings.input_device_id != settings.input_device_id;
    let output_changed = session.settings.output_device_id != settings.output_device_id;
    session.settings = settings;
    if output_changed {
        let had_mic = session.mic.is_some();
        session.restart_playback(&state.shared);
        if had_mic {
            republish_mic(session, &state.shared).await;
        }
    } else if input_changed && session.mic.is_some() {
        republish_mic(session, &state.shared).await;
    }
    Ok(())
}

/// A new microphone device: unpublish the old track and publish one from the new device (keeps the mute).
async fn republish_mic(session: &mut Session, shared: &Arc<Shared>) {
    if let Some(mic) = session.mic.take() {
        mic.pump.abort();
        let _ = session.room.local_participant().unpublish_track(&mic.publication.sid()).await;
    }
    let muted = shared.muted.load(Ordering::Relaxed);
    if !muted {
        session.publish_mic(shared).await;
    }
}

async fn devices() -> Result<DeviceLists, String> {
    let (input, output) = tauri::async_runtime::spawn_blocking(audio::list_devices).await.map_err(|e| e.to_string())?;
    Ok(DeviceLists { input, output })
}

// ---- commands: thin wrappers, so the self-test below drives the same code without a Tauri app ----

#[tauri::command]
pub async fn native_voice_connect(
    state: State<'_, NativeVoice>,
    url: String,
    token: String,
    init: ConnectInit,
    events: Channel<NativeEvent>,
) -> Result<(), String> {
    connect(&state, url, token, init, events).await
}

#[tauri::command]
pub async fn native_voice_disconnect(state: State<'_, NativeVoice>) -> Result<(), String> {
    disconnect(&state).await
}

#[tauri::command]
pub async fn native_voice_set_mute(state: State<'_, NativeVoice>, mute: bool) -> Result<(), String> {
    set_mute(&state, mute).await
}

#[tauri::command]
pub fn native_voice_set_deaf(state: State<'_, NativeVoice>, deaf: bool) {
    set_deaf(&state, deaf)
}

#[tauri::command]
pub fn native_voice_set_ptt(state: State<'_, NativeVoice>, pressed: bool) {
    set_ptt(&state, pressed)
}

#[tauri::command]
pub async fn native_voice_set_user_volume(state: State<'_, NativeVoice>, user_id: String, volume: f32) -> Result<(), String> {
    set_user_volume(&state, user_id, volume).await
}

#[tauri::command]
pub async fn native_voice_apply_settings(state: State<'_, NativeVoice>, settings: VoiceSettings) -> Result<(), String> {
    apply_settings(&state, settings).await
}

#[tauri::command]
pub async fn native_voice_devices() -> Result<DeviceLists, String> {
    devices().await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Live check against a LiveKit server (the VPS harness, docs/desktop-release.md): `NATIVE_VOICE_URL`, `NATIVE_VOICE_TOKEN`,
    /// optional `NATIVE_VOICE_SCRIPT` = "secs:action,..." (mute, unmute, deaf, undeaf, vol0, vol1:<user>) and `NATIVE_VOICE_SECS`.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs a LiveKit server and a PulseAudio server"]
    async fn live_room() {
        let (Ok(url), Ok(token)) = (std::env::var("NATIVE_VOICE_URL"), std::env::var("NATIVE_VOICE_TOKEN")) else { return };
        let secs: u64 = std::env::var("NATIVE_VOICE_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(30);
        let script = std::env::var("NATIVE_VOICE_SCRIPT").unwrap_or_default();
        let voice = NativeVoice::default();
        let events = Channel::new(|body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                println!("event {json}");
            }
            Ok(())
        });
        let settings: VoiceSettings = serde_json::from_value(serde_json::json!({
            "inputMode": "vad", "pttReleaseMs": 20, "vadThresholdDb": -60, "vadAuto": false, "inputDeviceId": "default",
            "outputDeviceId": "default", "echoCancellation": true, "noiseSuppression": true, "autoGainControl": false,
            "inputGain": 1, "rnnoise": false, "outputGain": 1, "duck": 1
        }))
        .unwrap();
        let init = ConnectInit { self_mute: false, self_deaf: false, settings, volumes: HashMap::new() };
        connect(&voice, url, token, init, events).await.unwrap();
        println!("connected");
        let mut steps: Vec<(u64, String)> =
            script.split(',').filter_map(|step| step.split_once(':').map(|(t, a)| (t.parse().unwrap_or(0), a.to_string()))).collect();
        steps.sort();
        let started = std::time::Instant::now();
        for (at, action) in steps {
            tokio::time::sleep(Duration::from_secs(at).saturating_sub(started.elapsed())).await;
            println!("step {at}s {action}");
            match action.split_once('=').unwrap_or((action.as_str(), "")) {
                ("mute", _) => set_mute(&voice, true).await.unwrap(),
                ("unmute", _) => set_mute(&voice, false).await.unwrap(),
                ("deaf", _) => set_deaf(&voice, true),
                ("undeaf", _) => set_deaf(&voice, false),
                ("volume", user) => set_user_volume(&voice, user.to_string(), 0.0).await.unwrap(),
                ("unvolume", user) => set_user_volume(&voice, user.to_string(), 1.0).await.unwrap(),
                _ => println!("unknown step {action}"),
            }
        }
        tokio::time::sleep(Duration::from_secs(secs).saturating_sub(started.elapsed())).await;
        disconnect(&voice).await.unwrap();
        println!("done");
    }
}
