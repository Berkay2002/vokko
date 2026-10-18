//! What a Spotify app on this computer is playing, for the "Listening to Spotify" status. No Spotify login and no Web API (its
//! development mode allows a handful of hand-added users): macOS asks Spotify.app through AppleScript and Spotifast through its
//! control socket, Windows reads Spotify's system media session and Linux the MPRIS players of Spotify and the known third-party
//! Spotify clients ([`CLIENTS`]). Everything is local; nothing here touches the network. Other platforms report nothing.
//!
//! Only music from Spotify's catalog is reported: never a podcast episode or a local file, whose title would otherwise be shown
//! (and sent to the catalog search). A source that cannot tell them apart is left out.

use serde::Serialize;

/// A track that is playing right now.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct NowPlaying {
    pub title: String,
    pub artists: Vec<String>,
    pub album: String,
    /// `spotify:track:<id>` reduced to the 22-character id (macOS and Linux).
    pub track_id: Option<String>,
    /// Spotify's 40-hex image id taken from the artwork URL (macOS and Linux).
    pub image_id: Option<String>,
    pub position_ms: i64,
    pub duration_ms: i64,
    /// The artist to look the track up by in the catalog when it is not `artists[0]`: Spotifast joins several with ", ".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lookup_artist: Option<String>,
}

/// MPRIS players that play Spotify's catalog, by the lowercase name they publish under (`_` read as `-`): Spotify, Spotifast,
/// ncspot, spotify-qt, Psst (psst-gui), spotify-player and spotifyd. Exact names only, so a browser playing open.spotify.com
/// never counts.
#[cfg(any(target_os = "linux", test))]
const CLIENTS: &[&str] = &["spotify", "spotifast", "ncspot", "spotify-qt", "psst", "psst-gui", "spotify-player", "spotifyd"];

#[cfg(any(target_os = "linux", test))]
fn is_client(name: &str) -> bool {
    CLIENTS.contains(&name.trim().to_lowercase().replace('_', "-").as_str())
}

/// Whether a Windows media session's SourceAppUserModelId is Spotify's: the Microsoft Store app or Spotify.exe, exactly. The
/// third-party clients (Spotifast's `spotifast.exe`, Psst, ncspot, spotify-qt, spotify-player) are left out: their sessions say
/// nothing that tells a podcast episode or a local file from a song.
#[cfg(any(windows, test))]
fn is_spotify_session(aumid: &str) -> bool {
    let aumid = aumid.to_lowercase();
    aumid == "spotifyab.spotifymusic_zpdnekdrzrea0!spotify" || aumid.rsplit(['\\', '/']).next() == Some("spotify.exe")
}

/// Whether an MPRIS player is a Spotify client, by the first part of its bus name after `org.mpris.MediaPlayer2.` (spotifyd adds
/// `.instance<pid>`) or by its Identity.
#[cfg(any(target_os = "linux", test))]
fn is_spotify_player(bus_name: &str, identity: &str) -> bool {
    bus_name.strip_prefix("org.mpris.MediaPlayer2.").and_then(|name| name.split('.').next()).is_some_and(is_client) || is_client(identity)
}

/// The track Spotify is playing, `None` when it is not running, paused, on an ad or a podcast, or on an unsupported platform.
#[tauri::command]
pub async fn spotify_now_playing() -> Option<NowPlaying> {
    tauri::async_runtime::spawn_blocking(read).await.ok().flatten()
}

/// Spotify.app, else Spotifast (the other apps of [`CLIENTS`] publish only to the Now Playing panel, which needs a private
/// framework to read).
#[cfg(target_os = "macos")]
fn read() -> Option<NowPlaying> {
    read_spotify_app().or_else(read_spotifast)
}

/// What Spotifast plays, through the control channel its `spotifast now-playing --raw` command uses: a socket in the user's
/// private temporary directory, one `spotifast:nowplaying` line out and one line back.
#[cfg(target_os = "macos")]
fn read_spotifast() -> Option<NowPlaying> {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::os::unix::fs::MetadataExt;
    let dir = std::env::temp_dir().join("spotifast");
    // Only a directory of this user's own that nobody else can enter: with TMPDIR at /tmp another user could plant the socket.
    // std has no getuid, and the home directory is this user's.
    let me = std::fs::metadata(std::env::var_os("HOME")?).ok()?.uid();
    let owned = std::fs::symlink_metadata(&dir).ok()?;
    if !owned.is_dir() || owned.uid() != me || owned.mode() & 0o777 != 0o700 {
        return None;
    }
    let mut stream = std::os::unix::net::UnixStream::connect(dir.join("instance.sock")).ok()?;
    stream.set_read_timeout(Some(TIMEOUT)).ok()?;
    stream.set_write_timeout(Some(TIMEOUT)).ok()?;
    stream.write_all(b"spotifast:nowplaying\n").ok()?;
    let mut reply = String::new();
    BufReader::new(stream.take(4096)).read_line(&mut reply).ok()?;
    parse_spotifast(&reply)
}

/// Spotifast's reply: `spotifast:now ` and tab-separated state, title, artists (joined with ", "), album, position ms,
/// duration ms, volume, shuffle, repeat, art URL, saved, device and kind (`track` or `episode`); or `spotifast:now stopped`.
/// Without the kind (Spotifast does not send it yet) nothing is reported, since an episode's "artists" is its show. There is no
/// track id, so the client looks the track up in the catalog, by the first of the joined artists.
#[cfg(any(target_os = "macos", test))]
fn parse_spotifast(reply: &str) -> Option<NowPlaying> {
    let fields: Vec<&str> = reply.lines().next()?.strip_prefix("spotifast:now ")?.split('\t').collect();
    let [state, title, artists, album, position, duration, _, _, _, art, _, _, kind, ..] = fields[..] else {
        return None;
    };
    if state != "playing" || kind != "track" || title.is_empty() {
        return None;
    }
    let duration_ms: i64 = duration.parse().ok()?;
    let position_ms: i64 = position.parse().ok()?;
    Some(NowPlaying {
        title: title.to_owned(),
        artists: if artists.is_empty() { Vec::new() } else { vec![artists.to_owned()] },
        album: album.to_owned(),
        track_id: None,
        image_id: spotify_image_id(art).map(str::to_owned),
        position_ms: if duration_ms > 0 { position_ms.min(duration_ms) } else { position_ms },
        duration_ms,
        // "Tyler, The Creator" is then looked up as "Tyler" and missed; a multi-artist track is found
        lookup_artist: artists.split_once(", ").map(|(first, _)| first.to_owned()),
    })
}

#[cfg(target_os = "macos")]
fn read_spotify_app() -> Option<NowPlaying> {
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
        GlobalSystemMediaTransportControlsSession as Session, GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };
    let manager = Manager::RequestAsync().ok()?.join().ok()?;
    let app = |session: &Session| session.SourceAppUserModelId().ok().map(|id| id.to_string());
    let playing: Vec<Session> = (manager.GetSessions().ok()?.into_iter())
        .filter(|session| app(session).is_some_and(|id| is_spotify_session(&id)))
        .filter(|session| session.GetPlaybackInfo().and_then(|info| info.PlaybackStatus()).is_ok_and(|status| status == Status::Playing))
        .collect();
    // Two clients playing at once: the one the system's media overlay shows.
    let current = manager.GetCurrentSession().ok().and_then(|session| app(&session));
    let session = playing.iter().find(|&session| current.is_some() && app(session) == current).or(playing.first())?;
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
    Some(NowPlaying {
        title: media.Title().ok()?.to_string(),
        artists: if artist.is_empty() { Vec::new() } else { vec![artist] },
        album: media.AlbumTitle().ok()?.to_string(),
        position_ms,
        duration_ms,
        ..NowPlaying::default()
    })
}

#[cfg(target_os = "linux")]
fn read() -> Option<NowPlaying> {
    use std::collections::HashMap;
    use zbus::blocking::{Connection, Proxy, fdo::DBusProxy, proxy::Builder};
    use zbus::{proxy::CacheProperties, zvariant::OwnedValue};
    let bus = session_bus()?;
    let proxy = |bus: &Connection, name: &str, interface: &'static str| -> Option<Proxy<'static>> {
        Builder::new(bus)
            .destination(name.to_owned())
            .ok()?
            .path("/org/mpris/MediaPlayer2")
            .ok()?
            .interface(interface)
            .ok()?
            .cache_properties(CacheProperties::No)
            .build()
            .ok()
    };
    let Some(names) = DBusProxy::new(&bus).ok().and_then(|dbus| dbus.list_names().ok()) else {
        // a bus that stopped answering is dropped, and the next poll connects again
        if let Ok(mut cached) = BUS.lock() {
            *cached = None;
        }
        return None;
    };
    for name in names {
        let name = name.as_str();
        if !name.starts_with("org.mpris.MediaPlayer2.") {
            continue;
        }
        let identity = proxy(&bus, name, "org.mpris.MediaPlayer2").and_then(|root| root.get_property::<String>("Identity").ok()).unwrap_or_default();
        let Some(player) = proxy(&bus, name, "org.mpris.MediaPlayer2.Player").filter(|_| is_spotify_player(name, &identity)) else {
            continue;
        };
        if player.get_property::<String>("PlaybackStatus").ok().as_deref() != Some("Playing") {
            continue;
        }
        let Ok(metadata) = player.get_property::<HashMap<String, OwnedValue>>("Metadata") else {
            continue;
        };
        let position_us = player.get_property::<OwnedValue>("Position").ok().and_then(|value| mpris::number(&value)).unwrap_or(0);
        if let Some(playing) = mpris::now_playing(&metadata, position_us) {
            return Some(steady_position(playing));
        }
    }
    None
}

/// The session bus connection, kept between polls.
#[cfg(target_os = "linux")]
static BUS: std::sync::Mutex<Option<zbus::blocking::Connection>> = std::sync::Mutex::new(None);

/// The kept session bus, or a new connection. Connecting has no timeout of its own, so it runs on a thread of its own that the
/// poll waits 2 s for (a late connection is kept for the next poll); at most one such thread runs. Calls on the connection give
/// up after 2 s, so a hung player cannot block the poll thread either.
#[cfg(target_os = "linux")]
fn session_bus() -> Option<zbus::blocking::Connection> {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;
    static CONNECTING: AtomicBool = AtomicBool::new(false);
    if let Some(bus) = BUS.lock().ok()?.clone() {
        return Some(bus);
    }
    if CONNECTING.swap(true, Ordering::AcqRel) {
        return None;
    }
    let (sent, answer) = std::sync::mpsc::channel();
    let spawned = std::thread::Builder::new().name("mpris-connect".into()).spawn(move || {
        let bus = zbus::blocking::connection::Builder::session().and_then(|builder| builder.method_timeout(Duration::from_secs(2)).build()).ok();
        if let (Some(bus), Ok(mut cached)) = (&bus, BUS.lock()) {
            *cached = Some(bus.clone());
        }
        CONNECTING.store(false, Ordering::Release);
        let _ = sent.send(bus);
    });
    if spawned.is_err() {
        CONNECTING.store(false, Ordering::Release);
        return None;
    }
    answer.recv_timeout(Duration::from_secs(2)).ok().flatten()
}

/// Spotify's own Linux client has long reported Position 0 all through a track, which would move the activity's start every
/// poll and resend it each time: a position stuck at 0 reads as the time since the track was first seen.
/// ponytail: one remembered track, so a replay of the same song keeps the first start until another track plays.
#[cfg(target_os = "linux")]
fn steady_position(mut playing: NowPlaying) -> NowPlaying {
    use std::{sync::Mutex, time::Instant};
    static FIRST_SEEN: Mutex<Option<(String, Instant)>> = Mutex::new(None);
    let key = format!("{}\u{1f}{}", playing.title, playing.artists.join("\u{1f}"));
    let Ok(mut seen) = FIRST_SEEN.lock() else {
        return playing;
    };
    if seen.as_ref().is_none_or(|(known, _)| *known != key) {
        *seen = Some((key, Instant::now()));
    }
    if let Some((_, at)) = seen.as_ref()
        && playing.position_ms == 0
    {
        let elapsed = i64::try_from(at.elapsed().as_millis()).unwrap_or(i64::MAX);
        playing.position_ms = if playing.duration_ms > 0 { elapsed.min(playing.duration_ms) } else { elapsed };
    }
    playing
}

/// Reading the MPRIS `Metadata` map. Players differ in the D-Bus types they send (Spotify's `mpris:trackid` is a string, not an
/// object path, and its `mpris:length` is unsigned), so values are read loosely.
#[cfg(target_os = "linux")]
mod mpris {
    use super::{Mpris, NowPlaying};
    use std::collections::HashMap;
    use zbus::zvariant::{OwnedValue, Value};

    fn text(value: &Value<'_>) -> String {
        match value {
            Value::Str(text) => text.as_str().to_owned(),
            Value::ObjectPath(path) => path.as_str().to_owned(),
            Value::Value(inner) => text(inner),
            _ => String::new(),
        }
    }

    pub(super) fn number(value: &Value<'_>) -> Option<i64> {
        match value {
            Value::I64(n) => Some(*n),
            Value::U64(n) => i64::try_from(*n).ok(),
            Value::I32(n) => Some(i64::from(*n)),
            Value::U32(n) => Some(i64::from(*n)),
            Value::Value(inner) => number(inner),
            _ => None,
        }
    }

    pub(super) fn now_playing(metadata: &HashMap<String, OwnedValue>, position_us: i64) -> Option<NowPlaying> {
        let get = |key: &str| metadata.get(key).map(|value| text(value)).unwrap_or_default();
        let artists = match metadata.get("xesam:artist").map(|value| &**value) {
            Some(Value::Array(list)) => list.iter().map(text).filter(|artist| !artist.is_empty()).collect(),
            Some(other) => Some(text(other)).filter(|artist| !artist.is_empty()).into_iter().collect(),
            None => Vec::new(),
        };
        super::parse_mpris(Mpris {
            title: get("xesam:title"),
            artists,
            album: get("xesam:album"),
            length_us: metadata.get("mpris:length").and_then(|value| number(value)).unwrap_or(0),
            position_us,
            trackid: get("mpris:trackid"),
            url: get("xesam:url"),
            art_url: get("mpris:artUrl"),
        })
    }
}

/// The MPRIS metadata a Spotify client publishes, already read out of its D-Bus values. Times are in microseconds.
#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Default)]
struct Mpris {
    title: String,
    artists: Vec<String>,
    album: String,
    length_us: i64,
    position_us: i64,
    trackid: String,
    url: String,
    art_url: String,
}

/// The track an MPRIS player plays: only a Spotify catalog track, so `None` for an ad, a podcast episode, a local file, no title
/// or no Spotify track id. The id comes from `xesam:url` (`spotify:track:<id>` from Spotifast,
/// `https://open.spotify.com/track/<id>` from Spotify and others) or `mpris:trackid` (`spotify:track:<id>`,
/// `/com/spotify/track/<id>`).
#[cfg(any(target_os = "linux", test))]
fn parse_mpris(track: Mpris) -> Option<NowPlaying> {
    let ids = [track.url.as_str(), track.trackid.as_str()];
    let not_music = ["spotify:ad:", "spotify:episode:", "spotify:local:", "/ad/", "/episode/", "/local/"];
    if track.title.is_empty() || ids.iter().any(|id| id.starts_with("file:") || not_music.iter().any(|kind| id.contains(kind))) {
        return None;
    }
    let track_id = ids.into_iter().find_map(spotify_track_id)?.to_owned();
    let ms = |us: i64| us.max(0) / 1000;
    let duration_ms = ms(track.length_us);
    let position_ms = ms(track.position_us);
    Some(NowPlaying {
        title: track.title,
        artists: track.artists,
        album: track.album,
        track_id: Some(track_id),
        image_id: spotify_image_id(&track.art_url).map(str::to_owned),
        position_ms: if duration_ms > 0 { position_ms.min(duration_ms) } else { position_ms },
        duration_ms,
        lookup_artist: None,
    })
}

/// The 22-character track id in `spotify:track:<id>` or an address or object path ending in `/track/<id>` (a `?si=` query is
/// dropped).
#[cfg(any(target_os = "linux", test))]
fn spotify_track_id(text: &str) -> Option<&str> {
    let id = match text.strip_prefix("spotify:track:") {
        Some(id) => id,
        None => text.rsplit_once("/track/")?.1.split(['?', '#']).next()?,
    };
    (id.len() == 22 && id.bytes().all(|b| b.is_ascii_alphanumeric())).then_some(id)
}

/// Spotify's 40-hex image id in an artwork address on i.scdn.co (or open.spotify.com/image, which older Linux clients send).
#[cfg(any(target_os = "macos", target_os = "linux", test))]
fn spotify_image_id(url: &str) -> Option<&str> {
    let id = url.strip_prefix("https://i.scdn.co/image/").or_else(|| url.strip_prefix("https://open.spotify.com/image/"))?;
    (id.len() == 40 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))).then_some(id)
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
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
    // Ads (`spotify:ad:…`) and podcast episodes are not music, and a local file (`spotify:local:…`) is not in the catalog: its
    // title would go to the catalog search and pick up another track's id and art.
    if title.is_empty() || ["spotify:ad", "spotify:episode", "spotify:local"].iter().any(|kind| id.starts_with(kind)) {
        return None;
    }
    let track_id = id.strip_prefix("spotify:track:").filter(|id| id.len() == 22 && id.bytes().all(|b| b.is_ascii_alphanumeric()));
    Some(NowPlaying {
        title: title.to_owned(),
        artists: if artist.is_empty() { Vec::new() } else { vec![artist.to_owned()] },
        album: album.to_owned(),
        track_id: track_id.map(str::to_owned),
        image_id: spotify_image_id(artwork).map(str::to_owned),
        position_ms: position.trim().parse().ok()?,
        duration_ms: duration.trim().parse().ok()?,
        lookup_artist: None,
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
            lookup_artist: None,
        };
        assert_eq!(parse_applescript(&line), Some(expected));
    }

    #[test]
    fn drops_ads_podcasts_local_files_and_garbage() {
        assert_eq!(parse_applescript(""), None);
        assert_eq!(parse_applescript("a\u{1f}b"), None);
        assert_eq!(parse_applescript("Ad\u{1f}Spotify\u{1f}\u{1f}spotify:ad:1\u{1f}\u{1f}30000\u{1f}0"), None);
        assert_eq!(parse_applescript("Ep\u{1f}Show\u{1f}\u{1f}spotify:episode:4uLU6hMCjMI75M1A2tKUQC\u{1f}\u{1f}30000\u{1f}0"), None);
        assert_eq!(parse_applescript("Mine\u{1f}Me\u{1f}\u{1f}spotify:local:Me:Album:Mine:180\u{1f}\u{1f}1000\u{1f}5"), None);
        let bad_art =
            parse_applescript("S\u{1f}A\u{1f}\u{1f}spotify:track:4uLU6hMCjMI75M1A2tKUQC\u{1f}https://evil.example/x.png\u{1f}1000\u{1f}5").expect("track");
        assert_eq!(bad_art.image_id, None);
    }

    #[test]
    fn parses_spotifasts_control_reply() {
        let reply = format!(
            "spotifast:now playing\tHeat Waves\tGlass Animals\tDreamland\t12345\t238805\t80\toff\toff\thttps://i.scdn.co/image/{IMAGE}\tyes\tDesk\ttrack\n"
        );
        let expected = NowPlaying {
            title: "Heat Waves".into(),
            artists: vec!["Glass Animals".into()],
            album: "Dreamland".into(),
            track_id: None,
            image_id: Some(IMAGE.into()),
            position_ms: 12_345,
            duration_ms: 238_805,
            lookup_artist: None,
        };
        assert_eq!(parse_spotifast(&reply), Some(expected));
        // several artists: looked up by the first
        let duo = parse_spotifast("spotifast:now playing\tS\tA, B\t\t1\t2\t80\toff\toff\t\tno\tDesk\ttrack").expect("track");
        assert_eq!((duo.artists, duo.lookup_artist, duo.image_id), (vec!["A, B".to_owned()], Some("A".to_owned()), None));
        for reply in [
            // today's twelve-field reply has no kind, so a podcast episode cannot be told apart
            "spotifast:now playing\tS\tA\t\t1\t2\t80\toff\toff\t\tno\tDesk",
            "spotifast:now playing\tS\tA\t\t1\t2\t80\toff\toff",
            "spotifast:now playing\tEp\tShow\t\t1\t2\t80\toff\toff\t\tno\tDesk\tepisode",
            "spotifast:now paused\tS\tA\t\t1\t2\t80\toff\toff\t\tno\tDesk\ttrack",
            "spotifast:now stopped",
            "spotifast!declined",
            "other:now playing\tS\tA\t\t1\t2",
            "",
        ] {
            assert_eq!(parse_spotifast(reply), None, "{reply}");
        }
    }

    #[test]
    fn windows_sessions_match_spotify_only() {
        for aumid in ["Spotify.exe", "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify", r"C:\Users\me\AppData\Roaming\Spotify\Spotify.exe"] {
            assert!(is_spotify_session(aumid), "{aumid}");
        }
        // third-party clients (no episode signal), browsers and other players
        for aumid in [
            "spotifast.exe",
            r"C:\Program Files\Spotifast\spotifast.exe",
            "psst-gui.exe",
            "spotify_player.exe",
            "ncspot.exe",
            "chrome.exe",
            "msedge.exe",
            "308046B0AF4A39CB",
            "Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic",
            "spotify-web.exe",
            "Foo!Spotify",
            "",
        ] {
            assert!(!is_spotify_session(aumid), "{aumid}");
        }
    }

    #[test]
    fn mpris_players_match_by_bus_name_or_identity() {
        assert!(is_spotify_player("org.mpris.MediaPlayer2.spotifast", "Spotifast"));
        assert!(is_spotify_player("org.mpris.MediaPlayer2.spotify", "Spotify"));
        assert!(is_spotify_player("org.mpris.MediaPlayer2.spotifyd.instance4242", ""));
        assert!(is_spotify_player("org.mpris.MediaPlayer2.spotify_player", ""));
        assert!(is_spotify_player("org.mpris.MediaPlayer2.Psst", ""));
        assert!(is_spotify_player("org.mpris.MediaPlayer2.custom", "ncspot"));
        // a browser playing open.spotify.com, or another player
        assert!(!is_spotify_player("org.mpris.MediaPlayer2.chromium.instance42", "Chromium"));
        assert!(!is_spotify_player("org.mpris.MediaPlayer2.firefox.instance_1_23", "Mozilla Firefox"));
        assert!(!is_spotify_player("org.mpris.MediaPlayer2.vlc", "VLC media player"));
        assert!(!is_spotify_player("org.example.spotify", ""));
    }

    #[test]
    fn mpris_metadata_gives_spotify_ids() {
        let spotifast = Mpris {
            title: "Heat Waves".into(),
            artists: vec!["Glass Animals".into()],
            album: "Dreamland".into(),
            length_us: 238_805_000,
            position_us: 12_345_678,
            trackid: "/spotifast/Track/t73706f74696679".into(),
            url: "spotify:track:3USxtqRwSYz57Ewm6wWRMp".into(),
            art_url: format!("https://i.scdn.co/image/{IMAGE}"),
        };
        let expected = NowPlaying {
            title: "Heat Waves".into(),
            artists: vec!["Glass Animals".into()],
            album: "Dreamland".into(),
            track_id: Some("3USxtqRwSYz57Ewm6wWRMp".into()),
            image_id: Some(IMAGE.into()),
            position_ms: 12_345,
            duration_ms: 238_805,
            lookup_artist: None,
        };
        assert_eq!(parse_mpris(spotifast), Some(expected));
        // Spotify's Linux client: an open.spotify.com address and a /com/spotify object path.
        let spotify = parse_mpris(Mpris {
            title: "S".into(),
            trackid: "/com/spotify/track/3USxtqRwSYz57Ewm6wWRMp".into(),
            art_url: format!("https://open.spotify.com/image/{IMAGE}"),
            ..Mpris::default()
        })
        .expect("track");
        assert_eq!((spotify.track_id.as_deref(), spotify.image_id.as_deref()), (Some("3USxtqRwSYz57Ewm6wWRMp"), Some(IMAGE)));
        let shared = parse_mpris(Mpris { title: "S".into(), url: "https://open.spotify.com/track/3USxtqRwSYz57Ewm6wWRMp?si=abc".into(), ..Mpris::default() });
        assert_eq!(shared.and_then(|track| track.track_id).as_deref(), Some("3USxtqRwSYz57Ewm6wWRMp"));
    }

    #[test]
    fn mpris_drops_ads_podcasts_and_bad_ids() {
        assert_eq!(parse_mpris(Mpris::default()), None);
        assert_eq!(parse_mpris(Mpris { title: "Ad".into(), trackid: "spotify:ad:000000000000000000000000".into(), ..Mpris::default() }), None);
        assert_eq!(parse_mpris(Mpris { title: "Ad".into(), trackid: "/com/spotify/ad/abc".into(), ..Mpris::default() }), None);
        assert_eq!(parse_mpris(Mpris { title: "Ep".into(), url: "spotify:episode:4uLU6hMCjMI75M1A2tKUQC".into(), ..Mpris::default() }), None);
        assert_eq!(parse_mpris(Mpris { title: "Ep".into(), url: "https://open.spotify.com/episode/4uLU6hMCjMI75M1A2tKUQC".into(), ..Mpris::default() }), None);
        // local files, a bad id and no id: nothing to show from the catalog
        let id = "spotify:track:3USxtqRwSYz57Ewm6wWRMp".to_owned();
        assert_eq!(parse_mpris(Mpris { title: "Mine".into(), trackid: "spotify:local:Me:Album:Mine:180".into(), ..Mpris::default() }), None);
        assert_eq!(parse_mpris(Mpris { title: "Mine".into(), trackid: "/com/spotify/local/abc".into(), ..Mpris::default() }), None);
        assert_eq!(parse_mpris(Mpris { title: "Mine".into(), url: "file:///home/me/x.mp3".into(), trackid: id.clone(), ..Mpris::default() }), None);
        assert_eq!(parse_mpris(Mpris { title: "Mine".into(), trackid: "spotify:track:short".into(), ..Mpris::default() }), None);
        assert_eq!(parse_mpris(Mpris { title: "Mine".into(), ..Mpris::default() }), None);
        // the position is kept within the length, and art that is not Spotify's is dropped
        let late = parse_mpris(Mpris {
            title: "S".into(),
            trackid: id,
            art_url: "file:///home/me/.cache/art.jpg".into(),
            length_us: 1_000_000,
            position_us: 5_000_000,
            ..Mpris::default()
        })
        .expect("track");
        assert_eq!((late.position_ms, late.image_id), (1_000, None));
    }
}
