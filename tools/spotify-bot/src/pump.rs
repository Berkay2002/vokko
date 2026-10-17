//! Spotify's stereo 44.1 kHz f64 samples -> 10 ms i16 frames -> a LiveKit audio track.
//!
//! `Pipeline` is the pure part (optional 44.1 -> 48 kHz resampling, then cutting into 10 ms frames). `Publisher` joins a room and
//! drains frames into a `NativeAudioSource`, whose full 100 ms queue is what paces everything upstream.

use std::borrow::Cow;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use livekit::options::{AudioEncoding, TrackPublishOptions};
use livekit::prelude::{LocalAudioTrack, LocalTrack, Room, RoomOptions, TrackSource};
use livekit::webrtc::audio_frame::AudioFrame;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_source::{AudioSourceOptions, RtcAudioSource};
use std::sync::mpsc;

use crate::resample::Resampler;

pub const SPOTIFY_RATE: u32 = 44_100;
/// Frames in the channel between the librespot player thread and the publisher task (about 200 ms).
const QUEUE_FRAMES: usize = 20;

/// Cuts interleaved stereo samples into whole 10 ms frames.
pub struct Chunker {
    frame_len: usize,
    pending: Vec<i16>,
}

impl Chunker {
    pub fn new(rate: u32) -> Self {
        Self { frame_len: (rate / 100) as usize * 2, pending: Vec::new() }
    }

    pub fn push(&mut self, samples: &[i16]) -> Vec<Vec<i16>> {
        self.pending.extend_from_slice(samples);
        let whole = self.pending.len() / self.frame_len * self.frame_len;
        let frames = self.pending[..whole].chunks_exact(self.frame_len).map(<[i16]>::to_vec).collect();
        self.pending.drain(..whole);
        frames
    }
}

fn to_i16(sample: f32) -> i16 {
    (sample * 32768.0).round().clamp(-32768.0, 32767.0) as i16
}

/// 44.1 kHz in; 441-sample frames out at 44.1 kHz (`direct`) or 480-sample frames at 48 kHz (resampled).
pub struct Pipeline {
    resampler: Option<Resampler>,
    chunker: Chunker,
}

impl Pipeline {
    pub fn new(resample_to_48k: bool) -> Self {
        let resampler = resample_to_48k.then(|| Resampler::new(SPOTIFY_RATE, 48_000, 2)).flatten();
        Self { chunker: Chunker::new(if resampler.is_some() { 48_000 } else { SPOTIFY_RATE }), resampler }
    }

    pub fn rate(&self) -> u32 {
        if self.resampler.is_some() { 48_000 } else { SPOTIFY_RATE }
    }

    pub fn process(&mut self, samples: &[f64]) -> Vec<Vec<i16>> {
        let floats: Vec<f32> = samples.iter().map(|s| *s as f32).collect();
        let floats = match &mut self.resampler {
            Some(resampler) => resampler.process(&floats),
            None => floats,
        };
        let ints: Vec<i16> = floats.into_iter().map(to_i16).collect();
        self.chunker.push(&ints)
    }
}

#[derive(Default)]
pub struct Stats {
    pub frames: AtomicU64,
    /// Times the publisher found the channel empty for more than a frame after audio had started.
    pub starved: AtomicU64,
}

pub struct Publisher {
    pub tx: mpsc::SyncSender<Vec<i16>>,
    pub stats: Arc<Stats>,
    room: Room,
    drain: std::thread::JoinHandle<()>,
}

impl Publisher {
    pub async fn join(url: &str, token: &str, rate: u32) -> Result<Self, String> {
        let mut options = RoomOptions::default();
        options.auto_subscribe = false;
        let (room, _events) = tokio::time::timeout(Duration::from_secs(30), Room::connect(url, token, options))
            .await
            .map_err(|_| "LiveKit connect timed out".to_owned())?
            .map_err(|e| format!("LiveKit connect: {e}"))?;
        let source = NativeAudioSource::new(AudioSourceOptions { echo_cancellation: false, noise_suppression: false, auto_gain_control: false }, rate, 2, 100);
        let track = LocalAudioTrack::create_audio_track("Spotify", RtcAudioSource::Native(source.clone()));
        room.local_participant()
            .publish_track(
                LocalTrack::Audio(track),
                TrackPublishOptions {
                    source: TrackSource::ScreenshareAudio,
                    audio_encoding: Some(AudioEncoding { max_bitrate: 160_000 }),
                    dtx: false,
                    red: false,
                    ..Default::default()
                },
            )
            .await
            .map_err(|e| format!("publish audio: {e}"))?;

        // librespot calls the sink from inside its own runtime, where tokio's blocking_send panics, so the queue is a std
        // channel (its blocking send is what slows the player down) drained by a thread.
        let (tx, rx) = mpsc::sync_channel::<Vec<i16>>(QUEUE_FRAMES);
        let stats = Arc::new(Stats::default());
        let counters = stats.clone();
        let handle = tokio::runtime::Handle::current();
        let drain = std::thread::spawn(move || {
            let mut last = Instant::now();
            while let Ok(data) = rx.recv() {
                if counters.frames.load(Ordering::Relaxed) > 0 && last.elapsed() > Duration::from_millis(30) {
                    counters.starved.fetch_add(1, Ordering::Relaxed);
                }
                let samples_per_channel = (data.len() / 2) as u32;
                let frame = AudioFrame { data: Cow::Owned(data), sample_rate: rate, num_channels: 2, samples_per_channel };
                if handle.block_on(source.capture_frame(&frame)).is_err() {
                    return;
                }
                counters.frames.fetch_add(1, Ordering::Relaxed);
                last = Instant::now();
            }
        });
        Ok(Self { tx, stats, room, drain })
    }

    /// Lets the queued audio play out, then leaves the room.
    pub async fn finish(self) {
        drop(self.tx);
        let _ = tokio::task::spawn_blocking(move || self.drain.join()).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        let _ = self.room.close().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunker_keeps_every_sample_in_whole_frames() {
        let mut chunker = Chunker::new(SPOTIFY_RATE);
        let input: Vec<i16> = (0..10_000).map(|n| (n % 3000) as i16).collect();
        let mut out = Vec::new();
        for packet in input.chunks(1237) {
            for frame in chunker.push(packet) {
                assert_eq!(frame.len(), 441 * 2);
                out.extend(frame);
            }
        }
        assert_eq!(out, input[..out.len()]);
        assert_eq!(out.len() + chunker.pending.len(), input.len());
    }

    #[test]
    fn resampled_pipeline_makes_480_sample_frames() {
        let mut pipeline = Pipeline::new(true);
        assert_eq!(pipeline.rate(), 48_000);
        let frames = pipeline.process(&vec![0.25; 4096]);
        assert!(!frames.is_empty() && frames.iter().all(|f| f.len() == 480 * 2));
    }

    #[test]
    fn direct_pipeline_keeps_44100() {
        let mut pipeline = Pipeline::new(false);
        assert_eq!(pipeline.rate(), 44_100);
        assert!(pipeline.process(&vec![0.0; 2048]).iter().all(|f| f.len() == 441 * 2));
    }
}
