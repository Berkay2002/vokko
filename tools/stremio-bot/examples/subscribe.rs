//! Headless viewer for the Phase 0 measurements: joins a room, subscribes to everything and prints, once a second, how many
//! video and audio frames arrived. With a flash-and-beep clip (white frame and 1 kHz tone together for 100 ms every second) it also prints the
//! audio-minus-video skew of every flash/beep pair as it reaches the decoder output.
//!
//!   LK_URL=ws://127.0.0.1:7880 LK_TOKEN=$(lk token create --join --room stremio-1 --identity viewer ...) \
//!     cargo run -p stremio-bot --example subscribe

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use futures_util::StreamExt;
use livekit::prelude::{RemoteTrack, Room, RoomEvent, RoomOptions};
use livekit::webrtc::audio_stream::native::NativeAudioStream;
use livekit::webrtc::video_stream::native::NativeVideoStream;

#[derive(Default)]
struct Stats {
    video_frames: AtomicU64,
    audio_frames: AtomicU64,
    width: AtomicU64,
    height: AtomicU64,
    /// Microseconds since start of the last video flash / audio beep rising edge.
    video_edge_us: AtomicU64,
    audio_edge_us: AtomicU64,
}

#[tokio::main]
async fn main() {
    let url = std::env::var("LK_URL").unwrap_or_else(|_| "ws://127.0.0.1:7880".into());
    let token = std::env::var("LK_TOKEN").unwrap_or_default();
    let start = Instant::now();
    let stats = Arc::new(Stats::default());
    let (_room, mut events) = match Room::connect(&url, &token, RoomOptions::default()).await {
        Ok(joined) => joined,
        Err(e) => {
            eprintln!("connect failed: {e}");
            std::process::exit(1);
        }
    };
    println!("joined {url}");

    let report = stats.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(1));
        let (mut last_v, mut last_a) = (0, 0);
        loop {
            tick.tick().await;
            let (v, a) = (report.video_frames.load(Ordering::Relaxed), report.audio_frames.load(Ordering::Relaxed));
            println!(
                "t={:>5.1}s video {:>3} fps {}x{}  audio {:>3} frames/s",
                start.elapsed().as_secs_f32(),
                v - last_v,
                report.width.load(Ordering::Relaxed),
                report.height.load(Ordering::Relaxed),
                a - last_a
            );
            (last_v, last_a) = (v, a);
        }
    });

    while let Some(event) = events.recv().await {
        match event {
            RoomEvent::TrackSubscribed { track: RemoteTrack::Video(track), .. } => {
                println!("subscribed to video track");
                let stats = stats.clone();
                tokio::spawn(async move {
                    let mut stream = NativeVideoStream::new(track.rtc_track());
                    let mut was_bright = false;
                    while let Some(frame) = stream.next().await {
                        stats.video_frames.fetch_add(1, Ordering::Relaxed);
                        stats.width.store(u64::from(frame.buffer.width()), Ordering::Relaxed);
                        stats.height.store(u64::from(frame.buffer.height()), Ordering::Relaxed);
                        let Some(i420) = frame.buffer.as_i420() else { continue };
                        let luma = i420.data().0;
                        let step = (luma.len() / 4096).max(1);
                        let (sum, n) = luma.iter().step_by(step).fold((0u64, 0u64), |(s, n), p| (s + u64::from(*p), n + 1));
                        let bright = sum / n.max(1) > 128;
                        if bright && !was_bright {
                            let now = start.elapsed().as_micros() as u64;
                            stats.video_edge_us.store(now, Ordering::Relaxed);
                            let audio = stats.audio_edge_us.load(Ordering::Relaxed);
                            let skew_ms = (audio as i64 - now as i64) as f64 / 1000.0;
                            if skew_ms.abs() < 500.0 {
                                println!("SYNC audio-minus-video = {skew_ms:+.0} ms");
                            }
                        }
                        was_bright = bright;
                    }
                });
            }
            RoomEvent::TrackSubscribed { track: RemoteTrack::Audio(track), .. } => {
                println!("subscribed to audio track");
                let stats = stats.clone();
                tokio::spawn(async move {
                    let mut stream = NativeAudioStream::new(track.rtc_track(), 48_000, 2);
                    let mut was_loud = false;
                    while let Some(frame) = stream.next().await {
                        stats.audio_frames.fetch_add(1, Ordering::Relaxed);
                        let peak = frame.data.iter().map(|s| i32::from(*s).abs()).max().unwrap_or(0);
                        let loud = peak > 3000;
                        if loud && !was_loud {
                            let now = start.elapsed().as_micros() as u64;
                            stats.audio_edge_us.store(now, Ordering::Relaxed);
                            let video = stats.video_edge_us.load(Ordering::Relaxed);
                            // Pair this beep with the closest flash (the flash and the beep start together in the clip).
                            let skew_ms = (now as i64 - video as i64) as f64 / 1000.0;
                            if skew_ms.abs() < 500.0 {
                                println!("SYNC audio-minus-video = {skew_ms:+.0} ms");
                            }
                        }
                        was_loud = loud;
                    }
                });
            }
            RoomEvent::Disconnected { .. } => break,
            _ => {}
        }
    }
}
