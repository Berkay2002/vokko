//! Spotify's stereo 44.1 kHz f64 samples -> 10 ms i16 frames at 48 kHz -> a LiveKit audio track.
//!
//! `Pipeline` is the pure part (44.1 -> 48 kHz resampling, then cutting into 10 ms frames). `Publisher` joins a room and drains
//! frames into a `NativeAudioSource`, whose full 100 ms queue is what paces everything upstream.

use std::borrow::Cow;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use livekit::options::{AudioEncoding, TrackPublishOptions};
use livekit::prelude::{LocalAudioTrack, LocalTrack, Room, RoomEvent, RoomOptions, TrackSource};
use livekit::webrtc::audio_frame::AudioFrame;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_source::{AudioSourceOptions, RtcAudioSource};
use tokio::sync::mpsc::UnboundedReceiver;

use crate::resample::Resampler;

pub const SPOTIFY_RATE: u32 = 44_100;
const OUT_RATE: u32 = 48_000;
/// Frames in the channel between the librespot player thread and the publisher thread (about 200 ms).
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

/// 44.1 kHz in, resampled to 48 kHz (design §6: libwebrtc's own conversion is worse), 480-sample frames out.
pub struct Pipeline {
    resampler: Option<Resampler>,
    chunker: Chunker,
}

impl Pipeline {
    pub fn new() -> Self {
        Self { resampler: Resampler::new(SPOTIFY_RATE, OUT_RATE, 2), chunker: Chunker::new(OUT_RATE) }
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

/// The room and the published track. Frames go in through `tx`, whose blocking send paces the librespot player thread. Each
/// frame carries the `epoch` it was written in; `flush` moves the epoch on, and the drain thread drops frames from before it.
pub struct Publisher {
    pub tx: mpsc::SyncSender<(u64, Vec<i16>)>,
    pub epoch: Arc<AtomicU64>,
    source: NativeAudioSource,
    room: Room,
    drain: std::thread::JoinHandle<()>,
}

impl Publisher {
    pub async fn join(url: &str, token: &str) -> Result<(Self, UnboundedReceiver<RoomEvent>), String> {
        let mut options = RoomOptions::default();
        options.auto_subscribe = false;
        let (room, events) = tokio::time::timeout(Duration::from_secs(30), Room::connect(url, token, options))
            .await
            .map_err(|_| "LiveKit connect timed out".to_owned())?
            .map_err(|e| format!("LiveKit connect: {e}"))?;
        let source =
            NativeAudioSource::new(AudioSourceOptions { echo_cancellation: false, noise_suppression: false, auto_gain_control: false }, OUT_RATE, 2, 100);
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
        // channel drained by a thread.
        let (tx, rx) = mpsc::sync_channel::<(u64, Vec<i16>)>(QUEUE_FRAMES);
        let epoch = Arc::new(AtomicU64::new(0));
        let (current, out) = (epoch.clone(), source.clone());
        let handle = tokio::runtime::Handle::current();
        let drain = std::thread::spawn(move || {
            while let Ok((written, data)) = rx.recv() {
                if written < current.load(Ordering::Acquire) {
                    continue;
                }
                let samples_per_channel = (data.len() / 2) as u32;
                let frame = AudioFrame { data: Cow::Owned(data), sample_rate: OUT_RATE, num_channels: 2, samples_per_channel };
                if handle.block_on(out.capture_frame(&frame)).is_err() {
                    return;
                }
            }
        });
        Ok((Self { tx, epoch, source, room, drain }, events))
    }

    /// Drops the audio queued for the old position, so a pause or a seek is heard at once. Call it before the player command.
    pub fn flush(&self) {
        self.epoch.fetch_add(1, Ordering::AcqRel);
        self.source.clear_buffer();
    }

    /// Leaves the room. Drop the player first: its sink holds a sender too.
    pub async fn close(self) {
        drop(self.tx);
        let _ = tokio::task::spawn_blocking(move || self.drain.join()).await;
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
    fn pipeline_makes_480_sample_frames() {
        let mut pipeline = Pipeline::new();
        let frames = pipeline.process(&vec![0.25; 4096]);
        assert!(!frames.is_empty() && frames.iter().all(|f| f.len() == 480 * 2));
    }
}
