//! The impure media side: ffprobe, the ffmpeg child with its two loopback streams, and publishing into a LiveKit room.

use std::borrow::Cow;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use livekit::options::{AudioEncoding, TrackPublishOptions, VideoCodec, VideoEncoding};
use livekit::prelude::{LocalAudioTrack, LocalTrack, LocalVideoTrack, Room, TrackSid, TrackSource};
use livekit::webrtc::audio_frame::AudioFrame;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_source::{AudioSourceOptions, RtcAudioSource};
use livekit::webrtc::rtp_sender::VideoEncoderBackend;
use livekit::webrtc::video_frame::{I420Buffer, VideoFrame, VideoRotation};
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_source::{RtcVideoSource, VideoResolution};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{Child, Command};
use tokio::task::JoinHandle;

use crate::config::{Codec, Config, Encoder};
use crate::plan::{self, Desired, FfmpegPlan, Geometry, Probe};
use crate::report::{Kind, Reporter};

const CONNECT_WAIT: Duration = Duration::from_secs(45);
/// 10 ms of 48 kHz stereo s16le.
const AUDIO_CHUNK_BYTES: usize = 480 * 2 * 2;

pub async fn probe(cfg: &Config, d: &Desired) -> Result<Probe, String> {
    let out = tokio::time::timeout(
        Duration::from_secs(30),
        Command::new(&cfg.ffprobe)
            .args(plan::probe_args(&d.media_url, &d.headers))
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output(),
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
    video_sid: TrackSid,
    audio_sid: TrackSid,
}

pub async fn publish(room: &Room, geo: &Geometry, d: &Desired, cfg: &Config) -> Result<Published, String> {
    let video = NativeVideoSource::new(VideoResolution { width: geo.width, height: geo.height }, true);
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
            LocalTrack::Video(video_track),
            TrackPublishOptions {
                source: TrackSource::Screenshare,
                video_codec: match cfg.codec {
                    Codec::Vp8 => VideoCodec::VP8,
                    Codec::H264 => VideoCodec::H264,
                },
                video_encoding: Some(VideoEncoding { max_bitrate: u64::from(d.bitrate) * 1000, max_framerate: geo.fps }),
                simulcast: cfg.simulcast,
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
    Ok(Published {
        video,
        audio,
        last: Arc::default(),
        video_sid: video_pub.sid(),
        audio_sid: audio_pub.sid(),
    })
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
    pub async fn spawn(
        cfg: &Config,
        d: &Desired,
        probe: &Probe,
        geo: &Geometry,
        start_ms: u64,
        out: &Published,
        notify: Notify,
    ) -> Result<Self, String> {
        let video_listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
        let audio_listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
        let port = |l: &TcpListener| l.local_addr().map(|a| a.port()).map_err(|e| e.to_string());
        let args = plan::ffmpeg_args(&FfmpegPlan {
            media_url: &d.media_url,
            headers: &d.headers,
            start_ms,
            geo,
            hdr: probe.hdr,
            has_audio: probe.has_audio,
            video_port: port(&video_listener)?,
            audio_port: port(&audio_listener)?,
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
                let mut lines = BufReader::new(pipe).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if let (false, Ok(mut last)) = (line.trim().is_empty(), stderr.lock()) {
                        *last = scrub(&line, &url);
                    }
                }
            }));
        }
        let began = Instant::now();
        tasks.push(tokio::spawn(video_loop(
            video_listener,
            geo.clone(),
            out.video.clone(),
            out.last.clone(),
            counters.clone(),
            notify,
            start_ms,
            began,
        )));
        if probe.has_audio {
            tasks.push(tokio::spawn(audio_loop(audio_listener, out.audio.clone(), counters.clone())));
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
    while stream.read_exact(&mut raw).await.is_ok() {
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
