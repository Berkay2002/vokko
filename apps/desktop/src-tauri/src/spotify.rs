//! What the Spotify desktop app on this computer is playing, for the "Listening to Spotify" status. No Spotify login and no Web
//! API (its development mode allows a handful of hand-added users): macOS asks the app through AppleScript, Windows reads the
//! system media session. Everything is local; nothing here touches the network. Other platforms report nothing.

use serde::Serialize;

/// A track that is playing right now.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct NowPlaying {
    pub title: String,
    pub artists: Vec<String>,
    pub album: String,
    /// `spotify:track:<id>` reduced to the 22-character id (macOS only).
    pub track_id: Option<String>,
    /// Spotify's 40-hex image id taken from the artwork URL (macOS only).
    pub image_id: Option<String>,
    pub position_ms: i64,
    pub duration_ms: i64,
}

/// The track Spotify is playing, `None` when it is not running, paused, on an ad or a podcast, or on an unsupported platform.
#[tauri::command]
pub async fn spotify_now_playing() -> Option<NowPlaying> {
    tauri::async_runtime::spawn_blocking(read).await.ok().flatten()
}

#[cfg(target_os = "macos")]
fn read() -> Option<NowPlaying> {
    use std::process::Command;
    // Asking an app that is not running would launch it, so look at the process list first.
    if !run(Command::new("pgrep").args(["-x", "Spotify"]), TIMEOUT)?.status.success() {
        return None;
    }
    // `is running` again inside the script: Spotify may quit after pgrep, and a bare `tell` would launch it again.
    let script = r#"if application "Spotify" is not running then return ""
tell application "Spotify"
  if player state is not playing then return ""
  set t to current track
  set d to ASCII character 31
  return (name of t) & d & (artist of t) & d & (album of t) & d & (id of t) & d & (artwork url of t) & d & ((duration of t) as text) & d & ((round ((player position) * 1000)) as text)
end tell"#;
    let output = run(Command::new("osascript").args(["-e", script]), TIMEOUT)?;
    output.status.success().then(|| parse_applescript(&String::from_utf8_lossy(&output.stdout))).flatten()
}

#[cfg(target_os = "macos")]
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// Runs `command` and collects its output, killing it after `timeout`: a hung Spotify must not block the poll thread forever.
#[cfg(target_os = "macos")]
fn run(command: &mut std::process::Command, timeout: std::time::Duration) -> Option<std::process::Output> {
    use std::process::Stdio;
    use std::time::{Duration, Instant};
    // The output is one short line, far below the pipe buffer, so waiting before reading cannot deadlock.
    let mut child = command.stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let deadline = Instant::now() + timeout;
    while child.try_wait().ok()?.is_none() {
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    child.wait_with_output().ok()
}

#[cfg(windows)]
fn read() -> Option<NowPlaying> {
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSessionManager as Manager, GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };
    let manager = Manager::RequestAsync().ok()?.join().ok()?;
    for session in manager.GetSessions().ok()? {
        let app = session.SourceAppUserModelId().ok()?.to_string().to_lowercase();
        if !app.contains("spotify") || session.GetPlaybackInfo().ok()?.PlaybackStatus().ok()? != Status::Playing {
            continue;
        }
        let media = session.TryGetMediaPropertiesAsync().ok()?.join().ok()?;
        let timeline = session.GetTimelineProperties().ok()?;
        // TimeSpan is in 100 ns ticks. The position is as of `LastUpdatedTime`, so add the time since then.
        let ms = |ticks: i64| ticks / 10_000;
        let duration_ms = ms(timeline.EndTime().ok()?.Duration - timeline.StartTime().ok()?.Duration);
        let now_ticks = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos() as i64 / 100 + 116_444_736_000_000_000;
        let since_update_ms = ms(now_ticks - timeline.LastUpdatedTime().ok()?.UniversalTime).max(0);
        let position_ms = ms(timeline.Position().ok()?.Duration) + since_update_ms;
        // an unknown length (0) must not pin the position to 0: the start would move every poll and resend every time
        let position_ms = if duration_ms > 0 { position_ms.min(duration_ms) } else { position_ms };
        let artist = media.Artist().ok()?.to_string();
        return Some(NowPlaying {
            title: media.Title().ok()?.to_string(),
            artists: if artist.is_empty() { Vec::new() } else { vec![artist] },
            album: media.AlbumTitle().ok()?.to_string(),
            position_ms,
            duration_ms,
            ..NowPlaying::default()
        });
    }
    None
}

#[cfg(not(any(target_os = "macos", windows)))]
fn read() -> Option<NowPlaying> {
    None
}

/// The AppleScript result: title, artist, album, id, artwork URL, duration ms and position ms, separated by ASCII 31.
#[cfg(any(target_os = "macos", test))]
fn parse_applescript(output: &str) -> Option<NowPlaying> {
    let fields: Vec<&str> = output.trim_end_matches(['\n', '\r']).split('\u{1f}').collect();
    let [title, artist, album, id, artwork, duration, position] = fields[..] else {
        return None;
    };
    // Ads (`spotify:ad:…`) and podcast episodes are not music; local files have no Spotify id.
    if title.is_empty() || id.starts_with("spotify:ad") || id.starts_with("spotify:episode") {
        return None;
    }
    let track_id = id.strip_prefix("spotify:track:").filter(|id| id.len() == 22 && id.bytes().all(|b| b.is_ascii_alphanumeric()));
    let image_id = artwork.strip_prefix("https://i.scdn.co/image/").filter(|id| id.len() == 40 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')));
    Some(NowPlaying {
        title: title.to_owned(),
        artists: if artist.is_empty() { Vec::new() } else { vec![artist.to_owned()] },
        album: album.to_owned(),
        track_id: track_id.map(str::to_owned),
        image_id: image_id.map(str::to_owned),
        position_ms: position.trim().parse().ok()?,
        duration_ms: duration.trim().parse().ok()?,
    })
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn run_kills_a_hung_command() {
        use std::{process::Command, time::Duration, time::Instant};
        let start = Instant::now();
        assert!(run(Command::new("sleep").arg("10"), Duration::from_millis(200)).is_none());
        assert!(start.elapsed() < Duration::from_secs(2));
        let output = run(Command::new("echo").arg("hi"), TIMEOUT).expect("echo runs");
        assert_eq!(output.stdout, b"hi\n");
    }

    const IMAGE: &str = "ab67616d00001e02e0f5c2a1b3d4e5f60718293a";

    #[test]
    fn parses_a_playing_track() {
        let line =
            format!("Song\u{1f}Some Artist\u{1f}Album\u{1f}spotify:track:4uLU6hMCjMI75M1A2tKUQC\u{1f}https://i.scdn.co/image/{IMAGE}\u{1f}215000\u{1f}12345\n");
        let expected = NowPlaying {
            title: "Song".into(),
            artists: vec!["Some Artist".into()],
            album: "Album".into(),
            track_id: Some("4uLU6hMCjMI75M1A2tKUQC".into()),
            image_id: Some(IMAGE.into()),
            position_ms: 12_345,
            duration_ms: 215_000,
        };
        assert_eq!(parse_applescript(&line), Some(expected));
    }

    #[test]
    fn drops_ads_podcasts_and_garbage_and_keeps_local_files_without_ids() {
        assert_eq!(parse_applescript(""), None);
        assert_eq!(parse_applescript("a\u{1f}b"), None);
        assert_eq!(parse_applescript("Ad\u{1f}Spotify\u{1f}\u{1f}spotify:ad:1\u{1f}\u{1f}30000\u{1f}0"), None);
        assert_eq!(parse_applescript("Ep\u{1f}Show\u{1f}\u{1f}spotify:episode:4uLU6hMCjMI75M1A2tKUQC\u{1f}\u{1f}30000\u{1f}0"), None);
        let local = parse_applescript("Mine\u{1f}Me\u{1f}\u{1f}spotify:local:x\u{1f}\u{1f}1000\u{1f}5").expect("local file");
        assert_eq!((local.track_id, local.image_id), (None, None));
        let bad_art =
            parse_applescript("S\u{1f}A\u{1f}\u{1f}spotify:track:4uLU6hMCjMI75M1A2tKUQC\u{1f}https://evil.example/x.png\u{1f}1000\u{1f}5").expect("track");
        assert_eq!(bad_art.image_id, None);
    }
}
