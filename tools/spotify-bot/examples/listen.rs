//! Headless listener for the Phase 0 audio comparison: joins a room, subscribes to the first audio track, decodes it at 48 kHz stereo
//! and writes a 16-bit WAV, then exits after `LISTEN_SECS` (default 20) or when the track ends.
//!
//!   LK_URL=ws://127.0.0.1:27880 LK_TOKEN=<join token> LISTEN_OUT=out.wav cargo run -p spotify-bot --example listen

use std::time::{Duration, Instant};

use futures_util::StreamExt;
use livekit::prelude::{RemoteTrack, Room, RoomEvent, RoomOptions};
use livekit::webrtc::audio_stream::native::NativeAudioStream;

fn wav(samples: &[i16]) -> Vec<u8> {
    let data = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data as usize);
    out.extend(b"RIFF");
    out.extend((36 + data).to_le_bytes());
    out.extend(b"WAVEfmt ");
    out.extend(16u32.to_le_bytes());
    out.extend(1u16.to_le_bytes());
    out.extend(2u16.to_le_bytes());
    out.extend(48_000u32.to_le_bytes());
    out.extend((48_000u32 * 4).to_le_bytes());
    out.extend(4u16.to_le_bytes());
    out.extend(16u16.to_le_bytes());
    out.extend(b"data");
    out.extend(data.to_le_bytes());
    for s in samples {
        out.extend(s.to_le_bytes());
    }
    out
}

#[tokio::main]
async fn main() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let url = std::env::var("LK_URL").unwrap_or_else(|_| "ws://127.0.0.1:27880".into());
    let token = std::env::var("LK_TOKEN").unwrap_or_default();
    let out = std::env::var("LISTEN_OUT").unwrap_or_else(|_| "listen.wav".into());
    let secs: u64 = std::env::var("LISTEN_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(20);

    let (_room, mut events) = match Room::connect(&url, &token, RoomOptions::default()).await {
        Ok(joined) => joined,
        Err(e) => {
            eprintln!("connect failed: {e}");
            std::process::exit(1);
        }
    };
    println!("joined {url}");
    let mut samples: Vec<i16> = Vec::new();
    let began = Instant::now();
    let deadline = tokio::time::sleep(Duration::from_secs(secs));
    tokio::pin!(deadline);
    let mut stream: Option<NativeAudioStream> = None;
    loop {
        tokio::select! {
            event = events.recv() => match event {
                Some(RoomEvent::TrackSubscribed { track: RemoteTrack::Audio(track), .. }) if stream.is_none() => {
                    println!("t={:.1}s subscribed", began.elapsed().as_secs_f32());
                    stream = Some(NativeAudioStream::new(track.rtc_track(), 48_000, 2));
                }
                Some(RoomEvent::Disconnected { .. }) | None => break,
                _ => {}
            },
            frame = async { match stream.as_mut() { Some(s) => s.next().await, None => std::future::pending().await } } => match frame {
                Some(frame) => samples.extend_from_slice(&frame.data),
                None => break,
            },
            _ = &mut deadline => break,
        }
    }
    std::fs::write(&out, wav(&samples)).expect("write wav");
    println!("wrote {out}: {:.2}s", samples.len() as f32 / 2.0 / 48_000.0);
}
