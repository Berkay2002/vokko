//! Phase 0 subcommands: `tone`, `play`, `meta`. They answer design questions and are not part of the final bot.
//!
//!   LK_URL=ws://127.0.0.1:27880 LK_TOKEN=<join token> spotify-bot tone direct|resample
//!   LK_URL=... LK_TOKEN=... spotify-bot play <track id> direct|resample [seconds]
//!   spotify-bot meta playlist|artist|track <id>

use std::f64::consts::PI;
use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use librespot_core::{Session, SessionConfig, SpotifyId, SpotifyUri, cache::Cache};
use librespot_metadata::{Artist, Metadata, Playlist, Track};
use librespot_playback::audio_backend::{Sink, SinkError, SinkResult};
use librespot_playback::config::{Bitrate, NormalisationType, PlayerConfig};
use librespot_playback::convert::Converter;
use librespot_playback::decoder::AudioPacket;
use librespot_playback::mixer::NoOpVolume;
use librespot_playback::player::Player;

use crate::login::config_dir;
use crate::pump::{Pipeline, Publisher, SPOTIFY_RATE};

fn livekit_env() -> Result<(String, String), String> {
    let url = std::env::var("LK_URL").map_err(|_| "set LK_URL (ws://127.0.0.1:27880 for the dev server)")?;
    let token = std::env::var("LK_TOKEN").map_err(|_| "set LK_TOKEN (lk token create --join --room .. --identity ..)")?;
    Ok((url, token))
}

/// The test signal at 44.1 kHz stereo: 1, 10 and 18 kHz tones, a log sweep 20 Hz to 20 kHz, then 1 kHz again.
/// Segment times (s): 1k 0-3, 10k 3-6, 18k 6-9, sweep 9-15, 1k 15-17. Level -6 dBFS.
pub fn test_signal() -> Vec<f64> {
    let mut out = Vec::new();
    let amp = 0.5;
    let tone = |out: &mut Vec<f64>, hz: f64, secs: f64| {
        for n in 0..(secs * f64::from(SPOTIFY_RATE)) as usize {
            let s = amp * (2.0 * PI * hz * n as f64 / f64::from(SPOTIFY_RATE)).sin();
            out.extend([s, s]);
        }
    };
    tone(&mut out, 1000.0, 3.0);
    tone(&mut out, 10_000.0, 3.0);
    tone(&mut out, 18_000.0, 3.0);
    let (f0, f1, secs) = (20.0_f64, 20_000.0_f64, 6.0_f64);
    let k = (f1 / f0).ln();
    for n in 0..(secs * f64::from(SPOTIFY_RATE)) as usize {
        let t = n as f64 / f64::from(SPOTIFY_RATE);
        let phase = 2.0 * PI * f0 * secs / k * ((t / secs * k).exp() - 1.0);
        let s = amp * phase.sin();
        out.extend([s, s]);
    }
    tone(&mut out, 1000.0, 2.0);
    out
}

fn resample_flag(arg: Option<String>) -> Result<bool, String> {
    match arg.as_deref() {
        Some("direct") => Ok(false),
        Some("resample") => Ok(true),
        _ => Err("second argument must be direct or resample".into()),
    }
}

pub async fn tone(mode: Option<String>) -> Result<(), String> {
    let (url, token) = livekit_env()?;
    let mut pipeline = Pipeline::new(resample_flag(mode)?);
    let publisher = Publisher::join(&url, &token, pipeline.rate()).await?;
    let tx = publisher.tx.clone();
    tokio::task::spawn_blocking(move || {
        // Same packet size as librespot's decoder (about 2048 frames), so the chunker sees realistic remainders.
        for packet in test_signal().chunks(2048 * 2) {
            for frame in pipeline.process(packet) {
                if tx.send(frame).is_err() {
                    return;
                }
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    println!("sent {} frames, {} starved", publisher.stats.frames.load(Ordering::Relaxed), publisher.stats.starved.load(Ordering::Relaxed));
    publisher.finish().await;
    Ok(())
}

struct LiveSink {
    tx: std::sync::mpsc::SyncSender<Vec<i16>>,
    pipeline: Pipeline,
}

impl Sink for LiveSink {
    fn write(&mut self, packet: AudioPacket, _converter: &mut Converter) -> SinkResult<()> {
        let AudioPacket::Samples(samples) = packet else { return Err(SinkError::OnWrite("raw packets are not supported".into())) };
        for frame in self.pipeline.process(&samples) {
            self.tx.send(frame).map_err(|_| SinkError::OnWrite("publisher closed".into()))?;
        }
        Ok(())
    }
}

fn track_uri(id: &str) -> Result<SpotifyUri, String> {
    Ok(SpotifyUri::Track { id: SpotifyId::from_base62(id).map_err(|e| format!("bad track id: {e}"))? })
}

/// A session from the stored credentials. Refuses a credentials file others can read (design §2.4).
async fn stored_session() -> Result<Session, String> {
    let dir = config_dir()?;
    let file = dir.join("credentials.json");
    let mode = std::fs::metadata(&file).map_err(|_| "no credentials: run spotify-bot login".to_owned())?.permissions().mode() & 0o777;
    if mode & 0o077 != 0 {
        return Err(format!("{} has mode {mode:o}; chmod 600 it", file.display()));
    }
    let cache = Cache::new(Some(&dir), None, None, None).map_err(|e| e.to_string())?;
    let credentials = cache.credentials().ok_or("credentials.json is unreadable")?;
    let session = Session::new(SessionConfig::default(), Some(cache));
    session.connect(credentials, false).await.map_err(|e| e.to_string())?;
    Ok(session)
}

/// First word of a Debug string, so event logs carry the variant and never a payload.
fn variant(event: &impl std::fmt::Debug) -> String {
    format!("{event:?}").split([' ', '{', '(']).next().unwrap_or("").to_owned()
}

pub async fn play(track: Option<String>, mode: Option<String>, secs: Option<String>) -> Result<(), String> {
    let (url, token) = livekit_env()?;
    let uri = track_uri(&track.ok_or("usage: play <track id> direct|resample [seconds]")?)?;
    let pipeline = Pipeline::new(resample_flag(mode)?);
    let limit = secs.and_then(|s| s.parse::<u64>().ok()).map(Duration::from_secs);

    let session = stored_session().await?;
    let publisher = Publisher::join(&url, &token, pipeline.rate()).await?;
    let sink = LiveSink { tx: publisher.tx.clone(), pipeline };
    let config = PlayerConfig {
        bitrate: Bitrate::Bitrate320,
        gapless: true,
        normalisation: true,
        normalisation_type: NormalisationType::Auto,
        position_update_interval: Some(Duration::from_secs(5)),
        ..PlayerConfig::default()
    };
    let player = Player::new(config, session.clone(), Box::new(NoOpVolume), move || Box::new(sink));
    let mut events = player.get_player_event_channel();
    let began = Instant::now();
    player.load(uri, true, 0);

    let mut tick = tokio::time::interval(Duration::from_secs(1));
    let (mut last_frames, mut was_invalid) = (0, false);
    loop {
        tokio::select! {
            event = events.recv() => {
                let Some(event) = event else { break };
                println!("t={:>6.1}s event {}", began.elapsed().as_secs_f32(), variant(&event));
                if variant(&event) == "EndOfTrack" { break }
            }
            _ = tick.tick() => {
                let frames = publisher.stats.frames.load(Ordering::Relaxed);
                let invalid = session.is_invalid();
                println!(
                    "t={:>6.1}s frames/s {:>3} starved {} session_invalid {}",
                    began.elapsed().as_secs_f32(), frames - last_frames, publisher.stats.starved.load(Ordering::Relaxed), invalid
                );
                last_frames = frames;
                if invalid && !was_invalid { println!("t={:>6.1}s SESSION INVALID", began.elapsed().as_secs_f32()) }
                was_invalid = invalid;
                if limit.is_some_and(|l| began.elapsed() > l) { break }
            }
            _ = tokio::signal::ctrl_c() => break,
        }
    }
    player.stop();
    drop(player);
    session.shutdown();
    publisher.finish().await;
    Ok(())
}

/// Catalog reads through librespot (spclient), the fallback for what a client-credentials token cannot get.
pub async fn meta(kind: Option<String>, id: Option<String>) -> Result<(), String> {
    let (kind, id) = (kind.ok_or("usage: meta playlist|artist|track <id>")?, id.ok_or("missing id")?);
    let session = stored_session().await?;
    let base62 = SpotifyId::from_base62(&id).map_err(|e| e.to_string())?;
    match kind.as_str() {
        "playlist" => {
            let uri = SpotifyUri::Playlist { id: base62, user: None };
            let playlist = Playlist::get(&session, &uri).await.map_err(|e| e.to_string())?;
            let tracks: Vec<_> = playlist.tracks().collect();
            println!("playlist: {} tracks (length field {}), name {:?}", tracks.len(), playlist.length, playlist.name());
            for t in tracks.iter().take(3) {
                let track = Track::get(&session, t).await.map_err(|e| e.to_string())?;
                println!("  {} - {}", track.name, track.artists.iter().map(|a| a.name.as_str()).collect::<Vec<_>>().join(", "));
            }
        }
        "artist" => {
            let artist = Artist::get(&session, &SpotifyUri::Artist { id: base62 }).await.map_err(|e| e.to_string())?;
            println!("artist {:?}: popularity {}, top-track countries {}", artist.name, artist.popularity, artist.top_tracks.len());
            for top in artist.top_tracks.iter().filter(|t| t.country == "SE" || t.country.is_empty()).take(1) {
                println!("  country {:?}: {} top tracks", top.country, top.tracks.len());
                for t in top.tracks.iter().take(3) {
                    let track = Track::get(&session, t).await.map_err(|e| e.to_string())?;
                    println!("  {} (popularity {})", track.name, track.popularity);
                }
            }
        }
        "track" => {
            let track = Track::get(&session, &track_uri(&id)?).await.map_err(|e| e.to_string())?;
            println!("track {:?}: {} ms, popularity {}", track.name, track.duration, track.popularity);
        }
        _ => return Err("kind must be playlist, artist or track".into()),
    }
    session.shutdown();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_signal_is_17_seconds_of_stereo() {
        let signal = test_signal();
        assert_eq!(signal.len(), 17 * SPOTIFY_RATE as usize * 2);
        assert!(signal.iter().all(|s| s.abs() <= 0.5 + 1e-9));
    }
}
