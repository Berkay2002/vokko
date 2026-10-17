//! The impure media side: ffprobe, the ffmpeg child with its two loopback streams, and publishing into a LiveKit room.

use std::borrow::Cow;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
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
use crate::plan::{self, Choice, Desired, FfmpegPlan, Geometry, Probe};
use crate::report::{Kind, Reporter};
use crate::subs::{Budget, VttReader};

const CONNECT_WAIT: Duration = Duration::from_secs(45);
/// 10 ms of 48 kHz stereo s16le.
const AUDIO_CHUNK_BYTES: usize = 480 * 2 * 2;

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
        100,
    );
    let local = room.local_participant();
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
                simulcast: cfg.simulcast,
                // The SDK's screenshare defaults are a 3 fps low layer and dropping frames under load; a film wants full motion.
                simulcast_layers: Some(vec![VideoPreset::new(geo.width / 4 * 2, geo.height / 4 * 2, u64::from(d.bitrate) * 1000 / 4, geo.fps)]),
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
    video_frames: AtomicU64,
    audio_samples: AtomicU64,
}

/// What a pipeline needs to tell the server.
#[derive(Clone)]
pub struct Notify {
    pub reporter: Reporter,
    pub channel_id: String,
    pub duration_ms: Option<u64>,
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
        d: &Desired,
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
        let args = plan::ffmpeg_args(&FfmpegPlan {
            media_url: &d.media_url,
            headers: &d.headers,
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
        let stderr = Arc::new(Mutex::new(String::new()));
        let mut tasks = Vec::new();

        if let Some(pipe) = child.stderr.take() {
            let (stderr, url) = (stderr.clone(), d.media_url.clone());
            tasks.push(tokio::spawn(async move {
                let mut lines = CappedLines::new(pipe);
                while let Ok(Some(line)) = lines.next_line().await {
                    if let (false, Ok(mut last)) = (line.trim().is_empty(), stderr.lock()) {
                        *last = scrub(&line, &url);
                    }
                }
            }));
        }
        let began = Instant::now();
        tasks.push(tokio::spawn(video_loop(video_listener, geo.clone(), out.video.clone(), out.last.clone(), counters.clone(), notify, start_ms, began)));
        if probe.has_audio {
            tasks.push(tokio::spawn(audio_loop(audio_listener, out.audio.clone(), counters.clone())));
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

    /// Lets the readers drain what ffmpeg already wrote.
    pub async fn drain(&mut self) {
        for mut task in self.tasks.drain(..) {
            if tokio::time::timeout(Duration::from_secs(3), &mut task).await.is_err() {
                task.abort();
            }
        }
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

#[allow(clippy::too_many_arguments)]
async fn video_loop(
    listener: TcpListener,
    geo: Geometry,
    source: NativeVideoSource,
    last: Arc<Mutex<Option<I420Buffer>>>,
    counters: Arc<Counters>,
    notify: Notify,
    start_ms: u64,
    began: Instant,
) {
    let Some(mut stream) = accept(listener).await else { return };
    let (w, h) = (geo.width as usize, geo.height as usize);
    let (luma, chroma) = (w * h, (w / 2) * (h / 2));
    let mut raw = vec![0u8; luma + 2 * chroma];
    let mut first = true;
    let interval = Duration::from_secs_f64(1.0 / geo.fps);
    let mut next: Option<Instant> = None;
    while stream.read_exact(&mut raw).await.is_ok() {
        // ffmpeg writes video in bursts (it blocks on the real-time audio socket in between), and libwebrtc drops frames that
        // arrive closer together than max_framerate allows, so each frame is handed over on its own beat.
        let due = frame_due(next, Instant::now(), interval);
        tokio::time::sleep_until(due.into()).await;
        next = Some(due + interval);
        let mut buffer = I420Buffer::new(geo.width, geo.height);
        {
            let (y, u, v) = buffer.data_mut();
            if y.len() != luma || u.len() != chroma || v.len() != chroma {
                tracing::error!("unexpected I420 plane sizes");
                return;
            }
            y.copy_from_slice(&raw[..luma]);
            u.copy_from_slice(&raw[luma..luma + chroma]);
            v.copy_from_slice(&raw[luma + chroma..]);
        }
        let frame = VideoFrame::new(VideoRotation::VideoRotation0, buffer);
        source.capture_frame(&frame);
        if let Ok(mut slot) = last.lock() {
            *slot = Some(frame.buffer);
        }
        counters.video_frames.fetch_add(1, Ordering::Relaxed);
        if std::mem::take(&mut first) {
            tracing::info!(first_frame_ms = began.elapsed().as_millis() as u64, start_ms, "first video frame");
            notify.reporter.send(&notify.channel_id, Kind::Started, start_ms, notify.duration_ms, None);
        }
    }
}

async fn audio_loop(listener: TcpListener, source: NativeAudioSource, counters: Arc<Counters>) {
    let Some(mut stream) = accept(listener).await else { return };
    let mut raw = [0u8; AUDIO_CHUNK_BYTES];
    while stream.read_exact(&mut raw).await.is_ok() {
        let samples: Vec<i16> = raw.as_chunks::<2>().0.iter().map(|b| i16::from_le_bytes(*b)).collect();
        let frame = AudioFrame { data: Cow::Owned(samples), sample_rate: plan::AUDIO_RATE as u32, num_channels: 2, samples_per_channel: 480 };
        if source.capture_frame(&frame).await.is_err() {
            return;
        }
        counters.audio_samples.fetch_add(480, Ordering::Relaxed);
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
}
