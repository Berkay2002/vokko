//! The impure media side: ffprobe, the ffmpeg child with its two loopback streams, and publishing into a LiveKit room.

use std::borrow::Cow;
use std::future::Future;
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use livekit::options::{AudioEncoding, DegradationPreference, TrackPublishOptions, VideoCodec, VideoEncoding, VideoPreset};
use livekit::prelude::{DataPacket, LocalAudioTrack, LocalParticipant, LocalTrack, LocalVideoTrack, Room, TrackSid, TrackSource};
use livekit::webrtc::audio_frame::AudioFrame;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_source::{AudioSourceOptions, RtcAudioSource};
use livekit::webrtc::rtp_sender::VideoEncoderBackend;
use livekit::webrtc::stats::RtcStats;
use livekit::webrtc::video_frame::{I420Buffer, VideoFrame, VideoRotation};
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_source::{RtcVideoSource, VideoResolution};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use vokko_protocol::api::{StremioCue, StremioSubtitleKind};

use crate::config::{Codec, Config, Encoder};
use crate::plan::{self, Anchors, Choice, Desired, FfmpegPlan, Geometry, Probe};
use crate::readahead::ReadAhead;
use crate::report::Reporter;
use crate::subs::{Budget, VttReader};

const CONNECT_WAIT: Duration = Duration::from_secs(45);
/// Lines of ffmpeg's stderr logged per run.
const MAX_LOGGED_LINES: usize = 40;
/// 10 ms of 48 kHz stereo s16le.
const AUDIO_CHUNK_BYTES: usize = 480 * 2 * 2;
/// libwebrtc's audio queue. `capture_frame` returns once a chunk fits, so the sound handed over runs this far ahead of the sound sent.
const AUDIO_QUEUE_MS: u32 = 100;
/// Video follows the sound; after this long without new sound (the audio ended or broke) it keeps its own beat.
const AUDIO_SILENT: Duration = Duration::from_secs(1);
/// A frame this many frame intervals behind the sound is dropped instead of shown late.
const LATE_FRAMES: f64 = 2.0;

pub async fn probe(cfg: &Config, d: &Desired) -> Result<Probe, String> {
    if !plan::local_media() {
        crate::guard::resolves_public(&d.media_url).await?;
    }
    let out = tokio::time::timeout(
        Duration::from_secs(30),
        Command::new(&cfg.ffprobe).args(plan::probe_args(&d.media_url, &d.headers)).stdin(Stdio::null()).kill_on_drop(true).output(),
    )
    .await
    .map_err(|_| "ffprobe timed out")?
    .map_err(|e| format!("cannot run ffprobe: {e}"))?;
    if !out.status.success() {
        return Err(format!("ffprobe failed: {}", scrub(&String::from_utf8_lossy(&out.stderr), &d.media_url)));
    }
    plan::parse_probe(&String::from_utf8_lossy(&out.stdout))
}

/// Last line of ffmpeg's stderr with the media URL removed (it is a secret and must not reach logs or the server).
fn scrub(text: &str, media_url: &str) -> String {
    let line = text.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").replace(media_url, "<media>");
    line.chars().filter(|c| !c.is_control()).take(300).collect()
}

/// The two tracks of one session. Their size is fixed at publish time, so every new source republishes them.
pub struct Published {
    video: NativeVideoSource,
    audio: NativeAudioSource,
    /// The last frame, re-sent while paused so a late joiner gets a picture (libwebrtc needs a frame to cut a keyframe).
    last: Arc<Mutex<Option<I420Buffer>>>,
    video_track: LocalVideoTrack,
    /// Where text subtitle cues are published as data.
    data: LocalParticipant,
    video_sid: TrackSid,
    audio_sid: TrackSid,
}

pub async fn publish(room: &Room, geo: &Geometry, d: &Desired, cfg: &Config) -> Result<Published, String> {
    // Not a screencast: libwebrtc keeps resolution and drops frames for screen content, which made films choppy.
    let video = NativeVideoSource::new(VideoResolution { width: geo.width, height: geo.height }, false);
    let audio = NativeAudioSource::new(
        AudioSourceOptions { echo_cancellation: false, noise_suppression: false, auto_gain_control: false },
        plan::AUDIO_RATE as u32,
        2,
        AUDIO_QUEUE_MS,
    );
    let local = room.local_participant();
    // The SDK panics on an empty custom list when simulcast is on, so a source with no smaller layer publishes a single stream.
    let layers: Vec<VideoPreset> =
        plan::simulcast_layers(geo, d.bitrate, cfg.simulcast).into_iter().map(|(w, h, bitrate)| VideoPreset::new(w, h, bitrate, geo.fps)).collect();
    let video_track = LocalVideoTrack::create_video_track("Stremio", RtcVideoSource::Native(video.clone()));
    let video_pub = local
        .publish_track(
            LocalTrack::Video(video_track.clone()),
            TrackPublishOptions {
                source: TrackSource::Screenshare,
                video_codec: match cfg.codec {
                    Codec::Vp8 => VideoCodec::VP8,
                    Codec::H264 => VideoCodec::H264,
                },
                video_encoding: Some(VideoEncoding { max_bitrate: u64::from(d.bitrate) * 1000, max_framerate: geo.fps }),
                simulcast: !layers.is_empty(),
                // The SDK's screenshare defaults are a 3 fps low layer and dropping frames under load; a film wants full motion.
                simulcast_layers: Some(layers),
                degradation_preference: Some(DegradationPreference::MaintainFramerate),
                video_encoder: match cfg.encoder {
                    Encoder::Auto => VideoEncoderBackend::Auto,
                    Encoder::Software => VideoEncoderBackend::Software,
                    Encoder::VideoToolbox => VideoEncoderBackend::VideoToolbox,
                },
                ..Default::default()
            },
        )
        .await
        .map_err(|e| format!("publish video: {e}"))?;
    let audio_track = LocalAudioTrack::create_audio_track("Stremio audio", RtcAudioSource::Native(audio.clone()));
    let audio_pub = local
        .publish_track(
            LocalTrack::Audio(audio_track),
            TrackPublishOptions {
                source: TrackSource::ScreenshareAudio,
                audio_encoding: Some(AudioEncoding { max_bitrate: 128_000 }),
                dtx: false,
                red: false,
                ..Default::default()
            },
        )
        .await
        .map_err(|e| format!("publish audio: {e}"))?;
    Ok(Published { video, audio, last: Arc::default(), video_track, data: local.clone(), video_sid: video_pub.sid(), audio_sid: audio_pub.sid() })
}

impl Published {
    pub async fn unpublish(&self, room: &Room) {
        let local = room.local_participant();
        let _ = local.unpublish_track(&self.video_sid).await;
        let _ = local.unpublish_track(&self.audio_sid).await;
    }

    /// Called every second while nothing is playing.
    pub fn resend_last_frame(&self) {
        if let Ok(last) = self.last.lock()
            && let Some(buffer) = last.as_ref()
        {
            self.video.capture_frame(&VideoFrame::new(VideoRotation::VideoRotation0, buffer));
        }
    }

    /// One line per encoded layer, so choppy playback can be traced to the encoder (cpu) or the network (bandwidth).
    pub async fn log_stats(&self) {
        let Ok(stats) = self.video_track.get_stats().await else { return };
        for s in stats {
            if let RtcStats::OutboundRtp(o) = s {
                let o = o.outbound;
                tracing::info!(
                    rid = o.rid,
                    width = o.frame_width,
                    height = o.frame_height,
                    fps = o.frames_per_second,
                    target_kbps = (o.target_bitrate / 1000.0) as u64,
                    limit = ?o.quality_limitation_reason,
                    encoder = o.encoder_implementation,
                    "video send"
                );
            }
        }
    }

    pub fn clear_audio(&self) {
        self.audio.clear_buffer();
    }
}

#[derive(Default)]
struct Counters {
    /// Frames read from ffmpeg into the queue.
    video_read: AtomicU64,
    /// Frames taken from the queue (shown or dropped): the video's media time.
    video_frames: AtomicU64,
    /// Frames waiting in the queue.
    queue_depth: AtomicU64,
    video_sent: AtomicU64,
    video_dropped: AtomicU64,
    audio_samples: AtomicU64,
    /// The sound's media time, which the video follows (see `Heard`); the audio loop wakes the video loop with every chunk.
    heard: Mutex<Option<Heard>>,
    audio_moved: tokio::sync::Notify,
    /// Heard sound minus shown picture at the last frame, in ms: positive means the sound is ahead.
    av_offset_ms: AtomicI64,
    /// What the server has been told about the position (see `Anchors`).
    anchors: Mutex<Anchors>,
    /// (frames read, frames sent, when) at the last stats line.
    last_stats: Mutex<Option<(u64, u64, Instant)>>,
}

impl Counters {
    fn anchor(&self, position_ms: u64) {
        self.anchors.lock().unwrap_or_else(|e| e.into_inner()).push(position_ms, Instant::now());
    }

    fn heard(&self) -> Option<Heard> {
        *self.heard.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// How much of the sound has been sent, as a function of time. libwebrtc queues what it is handed (`capture_frame` returns at once
/// while the queue holds at most `AUDIO_QUEUE_MS`) and sends 10 ms of it every 10 ms, so the sound sent is what was handed over minus
/// what is queued, and it moves on with the clock until the queue runs dry.
#[derive(Debug, Clone, Copy)]
struct Heard {
    /// Sound handed over (media ms since the run's start).
    handed_ms: f64,
    /// Sound in libwebrtc's queue right after that.
    queued_ms: f64,
    at: Instant,
}

impl Heard {
    /// Before the first chunk: nothing handed over, nothing queued.
    fn start(at: Instant) -> Self {
        Self { handed_ms: 0.0, queued_ms: 0.0, at }
    }

    /// After handing over `chunk_ms` more at `now`: what was queued drained in real time, the chunk joined it, and the queue never holds
    /// more than `AUDIO_QUEUE_MS` once `capture_frame` returned.
    fn handed(self, chunk_ms: f64, now: Instant) -> Self {
        let drained = (self.queued_ms - ms_between(self.at, now)).max(0.0);
        Self { handed_ms: self.handed_ms + chunk_ms, queued_ms: (drained + chunk_ms).min(f64::from(AUDIO_QUEUE_MS)), at: now }
    }

    fn ms_at(&self, t: Instant) -> f64 {
        self.handed_ms - self.queued_ms + ms_between(self.at, t).min(self.queued_ms)
    }
}

fn ms_between(from: Instant, to: Instant) -> f64 {
    to.saturating_duration_since(from).as_secs_f64() * 1000.0
}

#[derive(Debug, PartialEq)]
enum Pace {
    /// Its sound is sent at this time: show it then (or now, if that has passed).
    Show(Instant),
    /// The sound is past this frame: drop it so the picture catches up.
    Drop,
    /// Its sound has not been handed over yet: wait for the audio loop.
    Wait,
    /// No sound for `AUDIO_SILENT`: the picture keeps its own beat.
    Beat,
}

/// When the video frame at `frame_ms` (media time) goes out, so that it goes out with its sound.
fn pace(heard: Heard, frame_ms: f64, now: Instant, interval: Duration) -> Pace {
    if heard.ms_at(now) - frame_ms > LATE_FRAMES * interval.as_secs_f64() * 1000.0 {
        return Pace::Drop;
    }
    if frame_ms < heard.handed_ms {
        let wait_ms = frame_ms - (heard.handed_ms - heard.queued_ms);
        return Pace::Show(heard.at + Duration::from_secs_f64(wait_ms.max(0.0) / 1000.0));
    }
    if now.saturating_duration_since(heard.at) >= AUDIO_SILENT { Pace::Beat } else { Pace::Wait }
}

/// What a pipeline needs to tell the server.
#[derive(Clone)]
pub struct Notify {
    pub reporter: Reporter,
    pub channel_id: String,
    pub duration_ms: Option<u64>,
    /// The item (`Desired.generation`) the pipeline plays; restarts of one item (seek, track change, retry) keep it.
    pub generation: u64,
}

/// One ffmpeg process and the tasks that move its frames into the sources.
pub struct Pipeline {
    child: Child,
    tasks: Vec<JoinHandle<()>>,
    counters: Arc<Counters>,
    start_ms: u64,
    has_audio: bool,
    fps: f64,
    stderr: Arc<Mutex<String>>,
}

impl Pipeline {
    #[allow(clippy::too_many_arguments)]
    pub async fn spawn(
        cfg: &Config,
        cache: &ReadAhead,
        probe: &Probe,
        geo: &Geometry,
        choice: Choice,
        with_text: bool,
        start_ms: u64,
        out: &Published,
        notify: Notify,
    ) -> Result<Self, String> {
        let video_listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
        let audio_listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
        let port = |l: &TcpListener| l.local_addr().map(|a| a.port()).map_err(|e| e.to_string());
        // One loopback listener per text subtitle stream; ffmpeg writes each as WebVTT.
        let mut text_listeners = Vec::new();
        for track in probe.subtitle_tracks.iter().filter(|t| with_text && t.kind == StremioSubtitleKind::Text) {
            let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
            text_listeners.push((track.id, listener));
        }
        let text_ports = text_listeners.iter().map(|(index, l)| port(l).map(|p| (*index, p))).collect::<Result<Vec<_>, _>>()?;
        let input_url = cache.input_url();
        let args = plan::ffmpeg_args(&FfmpegPlan {
            media_url: &input_url,
            start_ms,
            geo,
            hdr: probe.hdr,
            has_audio: probe.has_audio,
            choice,
            source_size: (probe.width, probe.height),
            video_port: port(&video_listener)?,
            audio_port: port(&audio_listener)?,
            text_subs: &text_ports,
        });
        let mut child = Command::new(&cfg.ffmpeg)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("cannot run ffmpeg: {e}"))?;
        let counters = Arc::new(Counters::default());
        // the server's idea of the position starts here: it steered (or was told) start_ms when the PUT that led to this run arrived
        counters.anchor(start_ms);
        let stderr = Arc::new(Mutex::new(String::new()));
        let mut tasks = Vec::new();

        if let Some(pipe) = child.stderr.take() {
            let (stderr, url, channel_id) = (stderr.clone(), input_url.clone(), notify.channel_id.clone());
            tasks.push(tokio::spawn(async move {
                let mut lines = CappedLines::new(pipe);
                let mut logged = 0;
                while let Ok(Some(line)) = lines.next_line().await {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let line = scrub(&line, &url);
                    // a broken file can make ffmpeg repeat one warning for every frame
                    if logged < MAX_LOGGED_LINES {
                        logged += 1;
                        tracing::warn!(channel_id, %line, "ffmpeg");
                    }
                    if let Ok(mut last) = stderr.lock() {
                        *last = line;
                    }
                }
            }));
        }
        let began = Instant::now();
        let gate = cache.gate();
        let sink = Arc::new(Tracks { video: out.video.clone(), audio: out.audio.clone(), last: out.last.clone(), width: geo.width, height: geo.height });
        let first = {
            let counters = counters.clone();
            move || {
                tracing::info!(first_frame_ms = began.elapsed().as_millis() as u64, start_ms, "first video frame");
                notify.reporter.send_started(&notify.channel_id, start_ms, notify.duration_ms, notify.generation);
                counters.anchor(start_ms);
            }
        };
        let video = Video { fps: geo.fps, frame_bytes: frame_bytes(geo), has_audio: probe.has_audio };
        let primed = gate.clone();
        tasks.push(tokio::spawn(video_loop(video_listener, video, sink.clone(), counters.clone(), async move { primed.primed().await }, first)));
        if probe.has_audio {
            tasks.push(tokio::spawn(audio_loop(audio_listener, sink, counters.clone(), async move { gate.primed().await })));
        }
        if !text_listeners.is_empty() {
            // try_send from the readers: a slow data channel drops cues instead of stalling ffmpeg.
            let (tx, rx) = mpsc::channel(64);
            tasks.push(tokio::spawn(publish_cues(out.data.clone(), rx)));
            for (index, listener) in text_listeners {
                tasks.push(tokio::spawn(subtitle_loop(listener, index, start_ms, tx.clone())));
            }
        }
        Ok(Self { child, tasks, counters, start_ms, has_audio: probe.has_audio, fps: geo.fps, stderr })
    }

    /// The bot just sent the server this position.
    pub fn reported(&self, position_ms: u64) {
        self.counters.anchor(position_ms);
    }

    /// `put_ms` is what the server would work out itself from the positions it was given (see `Anchors`).
    pub fn explains(&self, put_ms: u64) -> bool {
        self.counters.anchors.lock().unwrap_or_else(|e| e.into_inner()).explains(put_ms, Instant::now())
    }

    pub fn position_ms(&self) -> u64 {
        plan::position_ms(
            self.start_ms,
            self.counters.audio_samples.load(Ordering::Relaxed),
            self.counters.video_frames.load(Ordering::Relaxed),
            self.fps,
            self.has_audio,
        )
    }

    /// Cancel safe. Resolves when ffmpeg has exited.
    pub async fn exited(&mut self) -> std::io::Result<std::process::ExitStatus> {
        self.child.wait().await
    }

    /// Lets the readers drain what ffmpeg already wrote. ffmpeg runs ahead of the output now, so at its end the audio socket is full
    /// (about 1.2 s on macOS) and the picture follows that sound out.
    pub async fn drain(&mut self) {
        for mut task in self.tasks.drain(..) {
            if tokio::time::timeout(Duration::from_secs(5), &mut task).await.is_err() {
                task.abort();
            }
        }
    }

    /// The 5 s stats line: frames read from ffmpeg and frames sent per second, the frames queued between the two, frames dropped to keep
    /// up with the sound, and how far the sound is ahead of the picture.
    pub fn log_stats(&self, channel_id: &str) {
        let c = &self.counters;
        let (read, sent) = (c.video_read.load(Ordering::Relaxed), c.video_sent.load(Ordering::Relaxed));
        let now = Instant::now();
        let last = c.last_stats.lock().unwrap_or_else(|e| e.into_inner()).replace((read, sent, now));
        let Some((read0, sent0, then)) = last else { return };
        let secs = now.saturating_duration_since(then).as_secs_f64().max(0.001);
        let rate = |n: u64, n0: u64| ((n - n0) as f64 / secs * 10.0).round() / 10.0;
        tracing::info!(
            channel_id,
            read_fps = rate(read, read0),
            sent_fps = rate(sent, sent0),
            queued = c.queue_depth.load(Ordering::Relaxed),
            dropped = c.video_dropped.load(Ordering::Relaxed),
            av_offset_ms = c.av_offset_ms.load(Ordering::Relaxed),
            "video pacing"
        );
    }

    pub fn last_error(&self) -> String {
        self.stderr.lock().map(|s| s.clone()).unwrap_or_default()
    }

    pub async fn stop(mut self) {
        let _ = self.child.kill().await;
        for task in &self.tasks {
            task.abort();
        }
    }
}

async fn accept(listener: TcpListener) -> Option<TcpStream> {
    tokio::time::timeout(CONNECT_WAIT, listener.accept()).await.ok()?.ok().map(|(s, _)| s)
}

/// Where one run's frames go: the published tracks, or a recorder in the tests.
trait Sink: Send + Sync + 'static {
    /// One raw I420 frame of the run's size.
    fn video(&self, raw: &[u8]);
    /// 10 ms of 48 kHz stereo. Resolves once there is room for more, which paces the sound in real time; false when the track is gone.
    fn audio(&self, samples: Vec<i16>) -> impl Future<Output = bool> + Send;
}

/// The published sources of one run.
struct Tracks {
    video: NativeVideoSource,
    audio: NativeAudioSource,
    last: Arc<Mutex<Option<I420Buffer>>>,
    width: u32,
    height: u32,
}

impl Sink for Tracks {
    fn video(&self, raw: &[u8]) {
        let mut buffer = I420Buffer::new(self.width, self.height);
        {
            let (y, u, v) = buffer.data_mut();
            if y.len() + u.len() + v.len() != raw.len() {
                tracing::error!("unexpected I420 plane sizes");
                return;
            }
            let (ry, rest) = raw.split_at(y.len());
            let (ru, rv) = rest.split_at(u.len());
            y.copy_from_slice(ry);
            u.copy_from_slice(ru);
            v.copy_from_slice(rv);
        }
        let frame = VideoFrame::new(VideoRotation::VideoRotation0, buffer);
        self.video.capture_frame(&frame);
        if let Ok(mut slot) = self.last.lock() {
            *slot = Some(frame.buffer);
        }
    }

    async fn audio(&self, samples: Vec<i16>) -> bool {
        let frame = AudioFrame { data: Cow::Owned(samples), sample_rate: plan::AUDIO_RATE as u32, num_channels: 2, samples_per_channel: 480 };
        self.audio.capture_frame(&frame).await.is_ok()
    }
}

fn frame_bytes(geo: &Geometry) -> usize {
    let (w, h) = (geo.width as usize, geo.height as usize);
    w * h + 2 * ((w / 2) * (h / 2))
}

struct Video {
    fps: f64,
    frame_bytes: usize,
    /// The picture follows the sound when there is any, so the two go out together.
    has_audio: bool,
}

/// Frames read ahead of the pacer, so ffmpeg's bursts and hiccups are absorbed here and not by a socket that holds about one 1080p
/// frame: at most `QUEUE_SECS` of film and `QUEUE_BYTES` of memory (16 frames at 1080p, 36 at 720p). ffmpeg runs ahead until it is full.
const QUEUE_SECS: f64 = 2.0;
const QUEUE_BYTES: usize = 48 << 20;

fn queue_frames(frame_bytes: usize, fps: f64) -> usize {
    ((QUEUE_SECS * fps) as usize).min(QUEUE_BYTES / frame_bytes.max(1)).max(2)
}

async fn video_loop<S: Sink>(
    listener: TcpListener,
    video: Video,
    sink: Arc<S>,
    counters: Arc<Counters>,
    primed: impl Future<Output = ()>,
    first: impl FnOnce(),
) {
    let Some(stream) = accept(listener).await else { return };
    let (tx, rx) = mpsc::channel(queue_frames(video.frame_bytes, video.fps));
    // one task for both, so stopping the pipeline (pause, seek, retrack) drops the reader and its queue with it
    tokio::join!(read_frames(stream, video.frame_bytes, tx, counters.clone()), pace_frames(rx, video, sink, counters, primed, first));
}

/// Reads whole frames from ffmpeg into the queue until either side is gone. While the queue is full it does not read, which holds
/// ffmpeg back.
async fn read_frames(mut stream: impl AsyncRead + Unpin, frame_bytes: usize, queue: mpsc::Sender<Vec<u8>>, counters: Arc<Counters>) {
    loop {
        let mut raw = vec![0u8; frame_bytes];
        if stream.read_exact(&mut raw).await.is_err() {
            return;
        }
        counters.video_read.fetch_add(1, Ordering::Relaxed);
        if queue.send(raw).await.is_err() {
            return;
        }
        counters.queue_depth.store((queue.max_capacity() - queue.capacity()) as u64, Ordering::Relaxed);
    }
}

async fn pace_frames<S: Sink>(
    mut queue: mpsc::Receiver<Vec<u8>>,
    video: Video,
    sink: Arc<S>,
    counters: Arc<Counters>,
    primed: impl Future<Output = ()>,
    first: impl FnOnce(),
) {
    // the first frame goes out once a few seconds of film are buffered
    primed.await;
    let started = Instant::now();
    let mut first = Some(first);
    let interval = Duration::from_secs_f64(1.0 / video.fps);
    let mut next: Option<Instant> = None;
    while let Some(raw) = queue.recv().await {
        counters.queue_depth.store(queue.len() as u64, Ordering::Relaxed);
        let index = counters.video_frames.fetch_add(1, Ordering::Relaxed);
        let frame_ms = index as f64 * 1000.0 / video.fps;
        let due = loop {
            if !video.has_audio {
                break Some(frame_due(next, Instant::now(), interval));
            }
            // registered before the check, so a chunk that lands in between still wakes us
            let moved = counters.audio_moved.notified();
            tokio::pin!(moved);
            moved.as_mut().enable();
            // before the first chunk the sound stands at 0, since the start
            let heard = counters.heard().unwrap_or(Heard::start(started));
            match pace(heard, frame_ms, Instant::now(), interval) {
                Pace::Show(at) => break Some(at),
                Pace::Drop => break None,
                // ffmpeg writes video in bursts, and libwebrtc drops frames that arrive closer together than max_framerate allows, so
                // without sound to follow each frame is handed over on its own beat
                Pace::Beat => break Some(frame_due(next, Instant::now(), interval)),
                Pace::Wait => {
                    let _ = tokio::time::timeout(AUDIO_SILENT, moved).await;
                }
            }
        };
        let Some(due) = due else {
            counters.video_dropped.fetch_add(1, Ordering::Relaxed);
            continue;
        };
        tokio::time::sleep_until(due.into()).await;
        let shown = Instant::now();
        next = Some(due + interval);
        sink.video(&raw);
        counters.video_sent.fetch_add(1, Ordering::Relaxed);
        if let Some(heard) = counters.heard().filter(|_| video.has_audio) {
            counters.av_offset_ms.store((heard.ms_at(shown) - frame_ms).round() as i64, Ordering::Relaxed);
        }
        if let Some(first) = first.take() {
            first();
        }
    }
}

async fn audio_loop<S: Sink>(listener: TcpListener, sink: Arc<S>, counters: Arc<Counters>, primed: impl Future<Output = ()>) {
    let Some(mut stream) = accept(listener).await else { return };
    primed.await;
    let mut raw = [0u8; AUDIO_CHUNK_BYTES];
    let mut heard = Heard::start(Instant::now());
    while stream.read_exact(&mut raw).await.is_ok() {
        let samples: Vec<i16> = raw.as_chunks::<2>().0.iter().map(|b| i16::from_le_bytes(*b)).collect();
        if !sink.audio(samples).await {
            return;
        }
        counters.audio_samples.fetch_add(480, Ordering::Relaxed);
        heard = heard.handed(10.0, Instant::now());
        *counters.heard.lock().unwrap_or_else(|e| e.into_inner()) = Some(heard);
        counters.audio_moved.notify_waiters();
    }
}

/// Longest line kept from ffmpeg's stderr or a subtitle stream. Subtitle text comes from the media, so it is untrusted: the
/// rest of a longer line is dropped, never buffered.
const MAX_LINE_BYTES: usize = 8 * 1024;

/// `lines()` with a cap: a line longer than `MAX_LINE_BYTES` is cut there and its rest dropped. Cancel-safe like `next_line`
/// (the partial line lives in `self`), so it can sit under a timeout.
struct CappedLines<R> {
    reader: BufReader<R>,
    line: Vec<u8>,
}

impl<R: AsyncRead + Unpin> CappedLines<R> {
    fn new(reader: R) -> Self {
        Self { reader: BufReader::new(reader), line: Vec::new() }
    }

    async fn next_line(&mut self) -> std::io::Result<Option<String>> {
        loop {
            let chunk = self.reader.fill_buf().await?;
            if chunk.is_empty() {
                return Ok((!self.line.is_empty()).then(|| self.take()));
            }
            let (used, done) = chunk.iter().position(|&b| b == b'\n').map_or((chunk.len(), false), |i| (i + 1, true));
            let room = MAX_LINE_BYTES.saturating_sub(self.line.len());
            self.line.extend_from_slice(&chunk[..used.min(room)]);
            self.reader.consume(used);
            if done {
                return Ok(Some(self.take()));
            }
        }
    }

    fn take(&mut self) -> String {
        let line = String::from_utf8_lossy(&self.line).trim_end_matches(['\n', '\r']).to_owned();
        self.line.clear();
        line
    }
}

/// ffmpeg writes a cue in one flush; this long without another line and the cue is complete.
const CUE_SETTLE: Duration = Duration::from_millis(150);

/// Reads the WebVTT ffmpeg writes for one text subtitle stream and queues its cues. The text is cleaned and capped in `VttReader`.
async fn subtitle_loop(listener: TcpListener, index: u32, start_ms: u64, queue: mpsc::Sender<(u32, StremioCue)>) {
    let Some(stream) = accept(listener).await else { return };
    let mut lines = CappedLines::new(stream);
    let (mut reader, mut budget) = (VttReader::new(start_ms), Budget::new(Instant::now()));
    loop {
        // ffmpeg closes a cue with the blank line it writes before the next one, so a block that has stopped growing is a cue.
        let next = if reader.pending() { tokio::time::timeout(CUE_SETTLE, lines.next_line()).await.ok() } else { Some(lines.next_line().await) };
        let cue = match next {
            Some(Ok(Some(line))) => reader.push_line(&line),
            Some(_) => break,
            None => reader.flush(),
        };
        if let Some(cue) = cue
            && budget.allow(Instant::now())
        {
            let _ = queue.try_send((index, cue));
        }
    }
}

/// Publishes queued cues as reliable data on topic `subs:<stream index>` in the media room.
async fn publish_cues(local: LocalParticipant, mut queue: mpsc::Receiver<(u32, StremioCue)>) {
    while let Some((index, cue)) = queue.recv().await {
        let Ok(payload) = serde_json::to_vec(&cue) else { continue };
        let packet = DataPacket { payload, topic: Some(format!("subs:{index}")), reliable: true, destination_identities: Vec::new() };
        if let Err(e) = local.publish_data(packet).await {
            tracing::debug!(error = %e, "subtitle cue not published");
        }
    }
}

/// When to hand over the next frame: on the beat after the previous one, or now when that beat is long gone (after a network
/// stall), so a late stream is not flushed as a burst.
fn frame_due(next: Option<Instant>, now: Instant, interval: Duration) -> Instant {
    match next {
        Some(due) if due + 10 * interval > now => due,
        _ => now,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn an_overlong_line_is_cut_and_the_next_one_still_read() {
        let input = format!("{}\r\nnext\nlast", "x".repeat(MAX_LINE_BYTES * 4));
        let mut lines = CappedLines::new(input.as_bytes());
        assert_eq!(lines.next_line().await.ok().flatten().map(|l| l.len()), Some(MAX_LINE_BYTES));
        assert_eq!(lines.next_line().await.ok().flatten().as_deref(), Some("next"));
        assert_eq!(lines.next_line().await.ok().flatten().as_deref(), Some("last"));
        assert_eq!(lines.next_line().await.ok().flatten(), None);
    }

    #[test]
    fn frames_keep_their_beat_and_rebase_after_a_stall() {
        let (t0, i) = (Instant::now(), Duration::from_millis(40));
        assert_eq!(frame_due(None, t0, i), t0);
        // A burst: the frame arrived early, it waits for its beat.
        assert_eq!(frame_due(Some(t0 + i), t0, i), t0 + i);
        // Slightly late: still on the old beat, so the clock catches up.
        assert_eq!(frame_due(Some(t0), t0 + 3 * i, i), t0);
        // Long stall: start a new beat now.
        assert_eq!(frame_due(Some(t0), t0 + 11 * i, i), t0 + 11 * i);
    }

    #[test]
    fn a_frame_goes_out_with_its_sound() {
        let (t0, i) = (Instant::now(), Duration::from_millis(40));
        let ms = |n: u64| Duration::from_millis(n);
        // 500 ms handed over just now with a full queue: 400 ms is being sent, the frame at 450 ms is due in 50 ms
        let heard = Heard { handed_ms: 500.0, queued_ms: 100.0, at: t0 };
        assert_eq!(heard.ms_at(t0), 400.0);
        assert_eq!(pace(heard, 450.0, t0, i), Pace::Show(t0 + ms(50)));
        // its sound went out already but only just: show it now
        assert_eq!(pace(heard, 380.0, t0, i), Pace::Show(t0));
        // more than two frames behind the sound: drop it
        assert_eq!(pace(heard, 310.0, t0, i), Pace::Drop);
        // its sound has not been handed over: wait for the audio loop, until the sound has been silent too long
        assert_eq!(pace(heard, 520.0, t0 + ms(30), i), Pace::Wait);
        assert_eq!(pace(heard, 520.0, t0 + AUDIO_SILENT, i), Pace::Beat);
        // the queue runs dry 100 ms after the last chunk: the sound sent stops at what was handed over
        assert_eq!(heard.ms_at(t0 + ms(400)), 500.0);
        // before the first chunk nothing is handed over: wait
        assert_eq!(pace(Heard::start(t0), 0.0, t0, i), Pace::Wait);
    }

    #[test]
    fn the_queue_level_follows_libwebrtc() {
        let t0 = Instant::now();
        let ms = |n: u64| t0 + Duration::from_millis(n);
        // the first chunks go in at once and fill the queue: nothing sent yet
        let mut heard = Heard::start(t0);
        for _ in 0..10 {
            heard = heard.handed(10.0, t0);
        }
        assert_eq!((heard.handed_ms, heard.queued_ms, heard.ms_at(t0)), (100.0, 100.0, 0.0));
        // then one chunk per tick: the queue stays full
        heard = heard.handed(10.0, ms(10));
        assert_eq!((heard.queued_ms, heard.ms_at(ms(10))), (100.0, 10.0));
        // a 300 ms stall runs it dry; the first chunk after it is sent at once, so the frame at 15 ms is due in 5 ms, not 95
        heard = heard.handed(10.0, ms(310));
        assert_eq!((heard.handed_ms, heard.queued_ms, heard.ms_at(ms(310))), (120.0, 10.0, 110.0));
        assert_eq!(pace(heard, 115.0, ms(310), Duration::from_millis(40)), Pace::Show(ms(315)));
    }

    #[test]
    fn the_queue_is_sized_in_frames_and_bytes() {
        assert_eq!(queue_frames(1920 * 1080 * 3 / 2, 24.0), 16);
        assert_eq!(queue_frames(1280 * 720 * 3 / 2, 24.0), 36);
        assert_eq!(queue_frames(320 * 180 * 3 / 2, 24.0), 48, "two seconds of a small picture");
        assert_eq!(queue_frames(4096 * 2160 * 3 / 2, 30.0), 3);
    }

    #[tokio::test]
    async fn the_queue_holds_ffmpeg_back_keeps_order_and_goes_with_the_run() {
        let frames: Vec<u8> = (0..10u8).flat_map(|i| [i; 4]).collect();
        let counters = Arc::new(Counters::default());
        let (tx, mut rx) = mpsc::channel(3);
        let reader = tokio::spawn(read_frames(std::io::Cursor::new(frames), 4, tx, counters.clone()));
        tokio::time::sleep(Duration::from_millis(50)).await;
        // three queued and the fourth read but waiting: the rest stays with ffmpeg
        assert_eq!((rx.len(), counters.video_read.load(Ordering::Relaxed)), (3, 4));
        for i in 0..10u8 {
            assert_eq!(rx.recv().await, Some(vec![i; 4]));
        }
        assert_eq!(rx.recv().await, None, "ffmpeg's end ends the queue");
        assert!(reader.await.is_ok());

        // a stop (pause, seek) drops the queue: the reader ends although ffmpeg's socket is still open
        let (mut ffmpeg, socket) = tokio::io::duplex(1024);
        tokio::io::AsyncWriteExt::write_all(&mut ffmpeg, &[7; 40]).await.expect("write");
        let (tx, rx) = mpsc::channel(3);
        let reader = tokio::spawn(read_frames(socket, 4, tx, Arc::new(Counters::default())));
        tokio::time::sleep(Duration::from_millis(50)).await;
        drop(rx);
        assert!(tokio::time::timeout(Duration::from_secs(1), reader).await.is_ok(), "the reader goes with its queue");
        drop(ffmpeg);
    }

    fn have_ffmpeg() -> bool {
        std::process::Command::new("ffmpeg").arg("-version").output().is_ok_and(|o| o.status.success())
    }

    /// Stands in for the published tracks: audio is taken like libwebrtc takes it (up to `AUDIO_QUEUE_MS` ahead, then in real time,
    /// silence when it runs dry), and the moment each sample and each frame goes out is recorded.
    #[derive(Default)]
    struct Recorder(Mutex<Rec>);

    #[derive(Default)]
    struct Rec {
        /// Every this many chunks the sound stalls for 300 ms (0: never), like an audio path that ran dry.
        stall_every: u32,
        chunks: u32,
        queued_until: Option<Instant>,
        frames: Vec<Instant>,
        /// When a white frame / a beep went out.
        flashes: Vec<Instant>,
        beeps: Vec<Instant>,
        white: bool,
        /// When the run was stopped.
        end: Option<Instant>,
    }

    const W: u32 = 320;
    const H: u32 = 180;

    impl Sink for Recorder {
        fn video(&self, raw: &[u8]) {
            let now = Instant::now();
            let luma = &raw[..(W * H) as usize];
            let white = luma.iter().step_by(97).map(|&y| u64::from(y)).sum::<u64>() / luma.iter().step_by(97).count() as u64 > 128;
            let mut rec = self.0.lock().unwrap_or_else(|e| e.into_inner());
            rec.frames.push(now);
            if white && !rec.white {
                rec.flashes.push(now);
            }
            rec.white = white;
        }

        async fn audio(&self, samples: Vec<i16>) -> bool {
            let stall = {
                let mut rec = self.0.lock().unwrap_or_else(|e| e.into_inner());
                rec.chunks += 1;
                rec.stall_every > 0 && rec.chunks.is_multiple_of(rec.stall_every)
            };
            if stall {
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
            let room = Duration::from_millis(u64::from(AUDIO_QUEUE_MS) - 10);
            loop {
                let wait = {
                    let rec = self.0.lock().unwrap_or_else(|e| e.into_inner());
                    rec.queued_until.map(|q| q.saturating_duration_since(Instant::now())).unwrap_or_default().saturating_sub(room)
                };
                if wait.is_zero() {
                    break;
                }
                tokio::time::sleep(wait).await;
            }
            let mut rec = self.0.lock().unwrap_or_else(|e| e.into_inner());
            let begin = rec.queued_until.map_or_else(Instant::now, |q| q.max(Instant::now()));
            for (i, frame) in samples.chunks(2).enumerate() {
                let at = begin + Duration::from_secs_f64(i as f64 / plan::AUDIO_RATE as f64);
                if frame[0].unsigned_abs() > 8000 && rec.beeps.last().is_none_or(|&b| at - b > Duration::from_millis(500)) {
                    rec.beeps.push(at);
                }
            }
            rec.queued_until = Some(begin + Duration::from_millis(10));
            true
        }
    }

    /// One ffmpeg run of the bot's command line (from the file instead of the read-ahead) for `secs`, its first frame held back like
    /// the read-ahead gate does.
    async fn play(file: &str, start_ms: u64, secs: u64, stall_every: u32) -> Rec {
        let geo = Geometry { width: W, height: H, fps_arg: "24/1".into(), fps: 24.0 };
        let bind = || TcpListener::bind("127.0.0.1:0");
        let (video, audio) = (bind().await.expect("bind"), bind().await.expect("bind"));
        let mut subs = Vec::new();
        for index in 3..7 {
            let l = bind().await.expect("bind");
            subs.push((index, l.local_addr().expect("addr").port(), l));
        }
        let text: Vec<(u32, u16)> = subs.iter().map(|(i, p, _)| (*i, *p)).collect();
        let mut args = plan::ffmpeg_args(&FfmpegPlan {
            media_url: file,
            start_ms,
            geo: &geo,
            hdr: false,
            has_audio: true,
            choice: Choice::default(),
            source_size: (W, H),
            video_port: video.local_addr().expect("addr").port(),
            audio_port: audio.local_addr().expect("addr").port(),
            text_subs: &text,
        });
        // the http input options do not apply to a file
        let input = plan::input_args();
        let at = args.windows(input.len()).position(|w| w == input.as_slice()).expect("input options");
        args.drain(at..at + input.len());
        let mut child = Command::new("ffmpeg").args(&args).stdin(Stdio::null()).kill_on_drop(true).spawn().expect("ffmpeg runs");
        let sink = Arc::new(Recorder(Mutex::new(Rec { stall_every, ..Rec::default() })));
        let counters = Arc::new(Counters::default());
        let gate = || tokio::time::sleep(Duration::from_secs(2));
        let mut tasks = vec![
            tokio::spawn(video_loop(
                video,
                Video { fps: geo.fps, frame_bytes: frame_bytes(&geo), has_audio: true },
                sink.clone(),
                counters.clone(),
                gate(),
                || (),
            )),
            tokio::spawn(audio_loop(audio, sink.clone(), counters, gate())),
        ];
        for (_, _, l) in subs {
            tasks.push(tokio::spawn(async move {
                if let Some(mut s) = accept(l).await {
                    let _ = tokio::io::copy(&mut s, &mut tokio::io::sink()).await;
                }
            }));
        }
        tokio::time::sleep(Duration::from_secs(secs)).await;
        sink.0.lock().unwrap_or_else(|e| e.into_inner()).end = Some(Instant::now());
        let _ = child.kill().await;
        for t in tasks {
            t.abort();
        }
        std::mem::take(&mut *sink.0.lock().unwrap_or_else(|e| e.into_inner()))
    }

    /// A film with what made the live stream stutter (two audio tracks, four sparse subrip tracks, a seek) and a white frame with a beep
    /// every 3 s. From the first frame on, at the start, after a seek and after a pause and resume, every second sends about 24 frames
    /// (24 fps) and the picture and its sound go out within 40 ms of each other; when the sound keeps running dry the picture waits for
    /// it instead of drifting ahead.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn picture_and_sound_go_out_together_after_start_seek_and_resume() {
        if !have_ffmpeg() {
            eprintln!("ffmpeg not installed: skipped");
            return;
        }
        let dir = std::env::temp_dir().join(format!("stremio-pacing-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let mut make = std::process::Command::new("ffmpeg");
        make.args(["-v", "error", "-y"]);
        make.args(["-f", "lavfi", "-i", &format!("color=black:s={W}x{H}:r=24[b];color=white:s={W}x{H}:r=24[w];[b][w]overlay=enable='lt(mod(t,3),0.04)'")]);
        make.args(["-f", "lavfi", "-i", "aevalsrc='if(lt(mod(t,3),0.01),0.8*sin(2*PI*1000*t),0)':s=48000"]);
        make.args(["-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000"]);
        for k in 0..4u32 {
            // a cue every 6 to 25 s, at the same times in every track (translations share timing). ffmpeg's -re stalled the whole read
            // when all of them had a cue just ahead of the clock.
            let mut t = 3u32;
            let mut cues = String::new();
            for n in 0..13u32 {
                cues += &format!("{}\n00:{:02}:{:02},000 --> 00:{:02}:{:02},500\nline {n} {k}\n\n", n + 1, t / 60, t % 60, (t + 1) / 60, (t + 1) % 60);
                t += 6 + (n * 7) % 20;
            }
            let srt = dir.join(format!("{k}.srt"));
            std::fs::write(&srt, cues).expect("srt");
            make.arg("-i").arg(&srt);
        }
        make.args(["-t", "200", "-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3:s", "-map", "4:s", "-map", "5:s", "-map", "6:s"]);
        make.args(["-c:v", "libx264", "-preset", "ultrafast", "-g", "48", "-c:a", "aac", "-c:s", "srt"]);
        let film = dir.join("film.mkv");
        let made = make.arg(&film).output().expect("ffmpeg runs");
        assert!(made.status.success(), "{}", String::from_utf8_lossy(&made.stderr));
        let film = film.to_string_lossy().into_owned();

        // the first start, a seek, and a resume after a pause (each a new ffmpeg run, as in the session)
        for (what, start_ms, secs, stall_every) in
            [("start", 71_250, 40, 0), ("seek", 150_500, 9, 0), ("resume", 100_500, 9, 0), ("sound stalls", 120_500, 9, 70)]
        {
            let rec = play(&film, start_ms, secs, stall_every).await;
            assert!(
                rec.flashes.len() >= 2 && rec.beeps.len() >= 2,
                "{what}: {} flashes, {} beeps, {} frames",
                rec.flashes.len(),
                rec.beeps.len(),
                rec.frames.len()
            );
            let offsets: Vec<i64> = rec
                .flashes
                .iter()
                .map(|&f| {
                    let nearest = rec.beeps.iter().min_by_key(|&&b| if b > f { b - f } else { f - b }).copied().unwrap_or(f);
                    if nearest > f { (nearest - f).as_millis() as i64 } else { -((f - nearest).as_millis() as i64) }
                })
                .collect();
            // frames sent in each whole second from the first one to the end of the run (a stall at the end counts too)
            let first = rec.frames[0];
            let mut per_second = vec![0u32; (rec.end.expect("stopped") - first).as_secs() as usize];
            for f in &rec.frames {
                if let Some(n) = per_second.get_mut((*f - first).as_secs() as usize) {
                    *n += 1;
                }
            }
            eprintln!("{what}: sound minus picture {offsets:?} ms, frames per second {per_second:?}");
            assert!(offsets.iter().all(|o| o.abs() <= 40), "{what}: sound minus picture {offsets:?} ms");
            // 24 fps measures 23 to 25; the slack is for a busy machine, a stall shows 0 to 5
            if stall_every == 0 {
                assert!(per_second.len() >= 5 && per_second.iter().all(|n| (20..=28).contains(n)), "{what}: frames per second {per_second:?}");
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
