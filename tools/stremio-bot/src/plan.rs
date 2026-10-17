//! The pure parts of the bot: request validation, ffprobe parsing, output geometry, ffmpeg arguments,
//! position math, lease expiry and the reconcile rule for a re-sent `PUT`. No I/O, so all of it is unit-tested.

use std::collections::BTreeMap;
use std::fmt;
use std::time::{Duration, Instant};

use serde::Deserialize;

/// A session is dropped when the server has not renewed it for this long (design §3.3).
pub const LEASE_TTL: Duration = Duration::from_secs(150);
/// A re-sent `PUT` with the same media only seeks when the bot is further than this from `position_ms`.
/// It has to exceed the ffmpeg start-up time after a seek, or every lease would trigger another seek.
pub const DRIFT_MS: u64 = 3_000;
pub const AUDIO_RATE: u64 = 48_000;
const MAX_POSITION_MS: u64 = 48 * 3_600_000;

/// What the server wants one session to be doing (`PUT /sessions/{channel_id}`, design §3.3).
#[derive(Clone, Deserialize, PartialEq, Eq)]
pub struct Desired {
    pub livekit_url: String,
    pub token: String,
    pub media_url: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub position_ms: u64,
    #[serde(default = "yes")]
    pub playing: bool,
    #[serde(default = "default_height")]
    pub max_height: u32,
    /// Video bitrate in kbit/s (same unit as `VOKKO_STREMIO_BITRATE_KBPS`).
    #[serde(default = "default_bitrate")]
    pub bitrate: u32,
}

fn yes() -> bool {
    true
}
fn default_height() -> u32 {
    1080
}
fn default_bitrate() -> u32 {
    6000
}

/// The token and the media URL are secrets, so they never reach a log line.
impl fmt::Debug for Desired {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Desired")
            .field("livekit_host", &host_of(&self.livekit_url))
            .field("media_host", &host_of(&self.media_url))
            .field("position_ms", &self.position_ms)
            .field("playing", &self.playing)
            .field("max_height", &self.max_height)
            .field("bitrate", &self.bitrate)
            .finish_non_exhaustive()
    }
}

pub fn host_of(url: &str) -> String {
    reqwest::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_owned)).unwrap_or_else(|| "?".into())
}

impl Desired {
    /// Checks and normalises a request. The media URL must be https (ffmpeg's protocol whitelist is the second wall),
    /// only `User-Agent` and `Referer` pass through and clamps keep a bad value from reaching ffmpeg or libwebrtc.
    pub fn validate(&mut self) -> Result<(), String> {
        let lk = reqwest::Url::parse(&self.livekit_url).map_err(|_| "livekit_url is not a URL")?;
        if !matches!(lk.scheme(), "ws" | "wss" | "http" | "https") || lk.host_str().is_none() {
            return Err("livekit_url must be ws(s) or http(s)".into());
        }
        let media = reqwest::Url::parse(&self.media_url).map_err(|_| "media_url is not a URL")?;
        if media.scheme() != "https" || media.host_str().is_none() {
            return Err("media_url must be https".into());
        }
        if !crate::guard::host_ok(&media) {
            return Err("media_url must be a public host".into());
        }
        if !media.username().is_empty() || media.password().is_some() {
            return Err("media_url must not carry credentials".into());
        }
        // ffmpeg gets the exact string that was checked, so a parser difference cannot point it at another host
        self.media_url = media.into();
        if self.token.is_empty() || self.token.len() > 4096 {
            return Err("token missing or too long".into());
        }
        let mut headers = BTreeMap::new();
        for (name, value) in &self.headers {
            let name = match name.to_ascii_lowercase().as_str() {
                "user-agent" => "User-Agent",
                "referer" => "Referer",
                _ => return Err("only User-Agent and Referer headers are allowed".into()),
            };
            if value.len() > 1024 || value.chars().any(char::is_control) {
                return Err("bad header value".into());
            }
            headers.insert(name.to_owned(), value.clone());
        }
        self.headers = headers;
        self.position_ms = self.position_ms.min(MAX_POSITION_MS);
        self.max_height = self.max_height.clamp(144, 1440);
        self.bitrate = self.bitrate.clamp(100, 20_000);
        Ok(())
    }
}

/// What `ffprobe` told us about the file.
#[derive(Debug, Clone, PartialEq)]
pub struct Probe {
    pub width: u32,
    pub height: u32,
    /// `(numerator, denominator)` of the average frame rate.
    pub fps: Option<(u32, u32)>,
    pub duration_ms: Option<u64>,
    pub hdr: bool,
    pub has_audio: bool,
}

pub fn parse_probe(json: &str) -> Result<Probe, String> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(|e| format!("ffprobe output: {e}"))?;
    let streams = v["streams"].as_array().map(Vec::as_slice).unwrap_or_default();
    let video = streams.iter().find(|s| s["codec_type"] == "video" && s["width"].as_u64().unwrap_or(0) > 0).ok_or("the file has no video stream")?;
    let dim = |key: &str| video[key].as_u64().and_then(|n| u32::try_from(n).ok()).filter(|n| *n > 0);
    let (width, height) = dim("width").zip(dim("height")).ok_or("bad video size")?;
    let rate = |key: &str| {
        let (n, d) = video[key].as_str()?.split_once('/')?;
        let (n, d) = (n.parse::<u32>().ok()?, d.parse::<u32>().ok()?);
        (n > 0 && d > 0).then_some((n, d))
    };
    let transfer = video["color_transfer"].as_str().unwrap_or("");
    Ok(Probe {
        width,
        height,
        fps: rate("avg_frame_rate").or_else(|| rate("r_frame_rate")),
        duration_ms: v["format"]["duration"].as_str().and_then(|d| d.parse::<f64>().ok()).filter(|d| d.is_finite() && *d > 0.0).map(|d| (d * 1000.0) as u64),
        hdr: matches!(transfer, "smpte2084" | "arib-std-b67"),
        has_audio: streams.iter().any(|s| s["codec_type"] == "audio"),
    })
}

/// Output frame size and rate for one source: scaled down to `max_height`, never up, both sides even.
#[derive(Debug, Clone, PartialEq)]
pub struct Geometry {
    pub width: u32,
    pub height: u32,
    /// The value for ffmpeg's `fps=` filter.
    pub fps_arg: String,
    pub fps: f64,
}

pub fn geometry(probe: &Probe, max_height: u32) -> Geometry {
    let height = (probe.height.min(max_height) & !1).max(2);
    let width = ((u64::from(probe.width) * u64::from(height) + u64::from(probe.height) / 2) / u64::from(probe.height)) as u32;
    let width = (width & !1).max(2);
    // Keep the source rate when it is at most 30 (24 stays 24); faster sources are capped at 30.
    let (fps_arg, fps) = match probe.fps {
        Some((n, d)) if f64::from(n) / f64::from(d) <= 30.5 && n >= d => (format!("{n}/{d}"), f64::from(n) / f64::from(d)),
        _ => ("30".to_owned(), 30.0),
    };
    Geometry { width, height, fps_arg, fps }
}

pub fn probe_args(media_url: &str, headers: &BTreeMap<String, String>) -> Vec<String> {
    let mut a = strings(&["-v", "error", "-protocol_whitelist", "https,tls,tcp", "-max_redirects", "0", "-rw_timeout", "15000000"]);
    push_headers(&mut a, headers);
    a.extend(strings(&["-show_entries", "stream=codec_type,width,height,avg_frame_rate,r_frame_rate,color_transfer:format=duration", "-of", "json"]));
    a.push(media_url.to_owned());
    a
}

pub struct FfmpegPlan<'a> {
    pub media_url: &'a str,
    pub headers: &'a BTreeMap<String, String>,
    pub start_ms: u64,
    pub geo: &'a Geometry,
    pub hdr: bool,
    pub has_audio: bool,
    /// ffmpeg connects to these two loopback listeners (one raw yuv420p video, one s16le stereo audio).
    pub video_port: u16,
    pub audio_port: u16,
}

const TONEMAP: &str = "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv";

/// The §5 command: one ffmpeg process so audio and video share a clock, `-re` paces both, only https/tls/tcp may be opened
/// and `-ss` before `-i` seeks by HTTP range. Deviation from §5: the raw streams go to loopback TCP, not FIFOs, because a
/// reader blocked in `open()` on a FIFO cannot be cancelled when ffmpeg dies early.
pub fn ffmpeg_args(p: &FfmpegPlan<'_>) -> Vec<String> {
    let mut a = strings(&[
        "-nostdin",
        "-loglevel",
        "error",
        "-protocol_whitelist",
        "https,tls,tcp",
        // The server already followed the redirects to this file; one that appears now (say, only for ffmpeg's user agent) is not followed.
        "-max_redirects",
        "0",
        "-reconnect",
        "1",
        "-reconnect_on_network_error",
        "1",
        "-rw_timeout",
        "15000000",
    ]);
    push_headers(&mut a, p.headers);
    a.push("-re".into());
    if p.start_ms > 0 {
        a.extend(["-ss".to_owned(), format!("{}.{:03}", p.start_ms / 1000, p.start_ms % 1000)]);
    }
    a.extend(["-i".to_owned(), p.media_url.to_owned(), "-map".into(), "0:v:0".into()]);
    let tonemap = if p.hdr { format!("{TONEMAP},") } else { String::new() };
    a.extend([
        "-vf".to_owned(),
        format!("{tonemap}scale={}:{}:flags=bicubic,fps={},format=yuv420p", p.geo.width, p.geo.height, p.geo.fps_arg),
        "-f".into(),
        "rawvideo".into(),
        format!("tcp://127.0.0.1:{}", p.video_port),
    ]);
    if p.has_audio {
        a.extend(strings(&["-map", "0:a:0", "-ac", "2", "-ar", "48000", "-f", "s16le"]));
        a.push(format!("tcp://127.0.0.1:{}", p.audio_port));
    }
    a
}

fn push_headers(args: &mut Vec<String>, headers: &BTreeMap<String, String>) {
    if !headers.is_empty() {
        let joined: String = headers.iter().map(|(k, v)| format!("{k}: {v}\r\n")).collect();
        args.extend(["-headers".to_owned(), joined]);
    }
}

fn strings(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|s| (*s).to_owned()).collect()
}

/// Media position: the seek offset plus how much has been pushed. Audio is the clock when there is any (design §5).
pub fn position_ms(start_ms: u64, audio_samples: u64, video_frames: u64, fps: f64, has_audio: bool) -> u64 {
    let elapsed = if has_audio { audio_samples * 1000 / AUDIO_RATE } else { (video_frames as f64 * 1000.0 / fps) as u64 };
    start_ms + elapsed
}

/// The lease the server renews with every `PUT`.
#[derive(Debug, Clone, Copy)]
pub struct Lease {
    renewed: Instant,
}

impl Lease {
    pub fn new(now: Instant) -> Self {
        Self { renewed: now }
    }
    pub fn renew(&mut self, now: Instant) {
        self.renewed = now;
    }
    pub fn expired(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.renewed) >= LEASE_TTL
    }
}

/// What a re-sent `PUT` means for a running session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// Nothing to do (a plain lease renewal).
    Keep,
    /// The LiveKit URL changed (room moved to another backend): leave and join again.
    Reconnect,
    /// New media or new quality: restart ffmpeg at `position_ms`.
    Restart,
    Pause,
    /// Resume (or start) playing at this position.
    Resume(u64),
    /// Playing, but further than `DRIFT_MS` from the server: seek.
    Seek(u64),
    /// Paused with a new position: remember it for the next resume.
    Hold(u64),
}

/// `current_ms` is where the bot is now. A token that changes alone does not matter: it only has to be valid at join time.
pub fn reconcile(prev: &Desired, next: &Desired, current_ms: u64, playing_now: bool) -> Action {
    if prev.livekit_url != next.livekit_url {
        return Action::Reconnect;
    }
    if prev.media_url != next.media_url || prev.max_height != next.max_height || prev.bitrate != next.bitrate {
        return Action::Restart;
    }
    match (playing_now, next.playing) {
        (true, false) => Action::Pause,
        (false, true) => Action::Resume(next.position_ms),
        (true, true) if current_ms.abs_diff(next.position_ms) > DRIFT_MS => Action::Seek(next.position_ms),
        (false, false) if current_ms.abs_diff(next.position_ms) > 500 => Action::Hold(next.position_ms),
        _ => Action::Keep,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn desired() -> Desired {
        serde_json::from_str(
            r#"{"livekit_url":"ws://127.0.0.1:7880","token":"t","media_url":"https://cdn.example/v.mp4","position_ms":1000,"playing":true,"max_height":720,"bitrate":2000}"#,
        )
        .expect("parses")
    }

    #[test]
    fn validate_accepts_and_clamps() {
        let mut d = desired();
        d.max_height = 99_999;
        d.bitrate = 1;
        d.position_ms = u64::MAX;
        d.headers.insert("user-agent".into(), "Mozilla".into());
        assert!(d.validate().is_ok());
        assert_eq!((d.max_height, d.bitrate, d.position_ms), (1440, 100, MAX_POSITION_MS));
        assert_eq!(d.headers.get("User-Agent").map(String::as_str), Some("Mozilla"));
    }

    fn bad_url(url: &str) -> bool {
        let mut d = desired();
        d.media_url = url.into();
        d.validate().is_err()
    }

    #[test]
    fn validate_rejects_bad_input() {
        let bad = |edit: fn(&mut Desired)| {
            let mut d = desired();
            edit(&mut d);
            d.validate().is_err()
        };
        assert!(bad(|d| d.media_url = "http://cdn.example/v.mp4".into()));
        assert!(bad(|d| d.media_url = "file:///etc/passwd".into()));
        assert!(bad(|d| d.media_url = "not a url".into()));
        assert!(bad(|d| d.media_url = "https://user:pw@cdn.example/v.mp4".into()));
        assert!(bad(|d| d.media_url = "https://8.8.8.8@127.0.0.1/v.mp4".into()));
        for private in [
            "https://localhost/v",
            "https://127.0.0.1/v",
            "https://192.168.0.1/v",
            "https://10.1.2.3/v",
            "https://169.254.169.254/v",
            "https://[::1]/v",
            "https://[fd00::1]/v",
            "https://[::ffff:10.0.0.1]/v",
            "https://nas.local/v",
            "https://x.internal/v",
        ] {
            assert!(bad_url(private), "{private}");
        }
        assert!(!bad_url("https://8.8.8.8/v") && !bad_url("https://[2606:4700::1]/v"));
        assert!(bad(|d| d.livekit_url = "ftp://x".into()));
        assert!(bad(|d| d.token.clear()));
        assert!(bad(|d| {
            d.headers.insert("Authorization".into(), "x".into());
        }));
        assert!(bad(|d| {
            d.headers.insert("Referer".into(), "a\r\nHost: evil".into());
        }));
    }

    #[test]
    fn debug_hides_secrets() {
        let d = desired();
        let shown = format!("{d:?}");
        assert!(!shown.contains("v.mp4") && !shown.contains("\"t\""));
        assert!(shown.contains("cdn.example"));
    }

    const PROBE: &str = r#"{"streams":[{"codec_type":"audio"},{"codec_type":"video","width":1920,"height":1080,
        "avg_frame_rate":"24000/1001","r_frame_rate":"24000/1001","color_transfer":"smpte2084"}],"format":{"duration":"596.474195"}}"#;

    #[test]
    fn probe_parses() {
        let p = parse_probe(PROBE).expect("probe");
        assert_eq!((p.width, p.height, p.fps), (1920, 1080, Some((24000, 1001))));
        assert_eq!(p.duration_ms, Some(596_474));
        assert!(p.hdr && p.has_audio);
        assert!(parse_probe(r#"{"streams":[{"codec_type":"audio"}]}"#).is_err());
        assert!(parse_probe("nope").is_err());
        let no_rate = r#"{"streams":[{"codec_type":"video","width":640,"height":360,"avg_frame_rate":"0/0","r_frame_rate":"25/1"}],"format":{}}"#;
        let p = parse_probe(no_rate).expect("probe");
        assert_eq!((p.fps, p.duration_ms, p.hdr, p.has_audio), (Some((25, 1)), None, false, false));
    }

    fn probe(w: u32, h: u32, fps: Option<(u32, u32)>) -> Probe {
        Probe { width: w, height: h, fps, duration_ms: None, hdr: false, has_audio: true }
    }

    #[test]
    fn geometry_scales_down_only_and_stays_even() {
        let g = geometry(&probe(1920, 1080, Some((24, 1))), 720);
        assert_eq!((g.width, g.height, g.fps_arg.as_str()), (1280, 720, "24/1"));
        let g = geometry(&probe(3840, 2160, Some((60000, 1001))), 1080);
        assert_eq!((g.width, g.height, g.fps_arg.as_str()), (1920, 1080, "30"));
        let g = geometry(&probe(1280, 536, None), 1080);
        assert_eq!((g.width, g.height, g.fps), (1280, 536, 30.0));
        // 2.39:1 scope source capped at 720: 1920x804 -> 1718.2x720 -> even
        let g = geometry(&probe(1920, 804, Some((25, 1))), 720);
        assert_eq!((g.width % 2, g.height % 2, g.height), (0, 0, 720));
        assert_eq!(g.width, 1718);
    }

    #[test]
    fn ffmpeg_command_line() {
        let mut headers = BTreeMap::new();
        headers.insert("Referer".to_owned(), "https://x/".to_owned());
        let geo = geometry(&probe(1920, 1080, Some((24, 1))), 720);
        let plan = FfmpegPlan {
            media_url: "https://cdn.example/v.mp4",
            headers: &headers,
            start_ms: 61_500,
            geo: &geo,
            hdr: false,
            has_audio: true,
            video_port: 5001,
            audio_port: 5002,
        };
        let a = ffmpeg_args(&plan);
        let at = |flag: &str| a.iter().position(|x| x == flag).unwrap_or_else(|| panic!("{flag} missing"));
        assert_eq!(a[at("-protocol_whitelist") + 1], "https,tls,tcp");
        assert_eq!(a[at("-ss") + 1], "61.500");
        assert!(at("-re") < at("-ss") && at("-ss") < at("-i"), "-re and -ss are input options");
        assert_eq!(a[at("-i") + 1], "https://cdn.example/v.mp4");
        assert_eq!(a[at("-headers") + 1], "Referer: https://x/\r\n");
        assert_eq!(a[at("-vf") + 1], "scale=1280:720:flags=bicubic,fps=24/1,format=yuv420p");
        assert!(a.contains(&"tcp://127.0.0.1:5001".to_owned()) && a.contains(&"tcp://127.0.0.1:5002".to_owned()));
        assert!(a.windows(2).any(|w| w[0] == "-map" && w[1] == "0:a:0"));

        let no_audio = FfmpegPlan { has_audio: false, start_ms: 0, ..plan };
        let a = ffmpeg_args(&no_audio);
        assert!(!a.contains(&"-ss".to_owned()) && !a.contains(&"-ac".to_owned()));

        let hdr = FfmpegPlan { hdr: true, ..no_audio };
        assert!(ffmpeg_args(&hdr).iter().any(|x| x.starts_with("zscale=t=linear") && x.ends_with("format=yuv420p")));
    }

    #[test]
    fn position_uses_audio_then_video() {
        assert_eq!(position_ms(10_000, 48_000 * 3, 0, 24.0, true), 13_000);
        assert_eq!(position_ms(10_000, 0, 48, 24.0, false), 12_000);
        assert_eq!(position_ms(0, 480, 999, 24.0, true), 10);
    }

    #[test]
    fn lease_expires_after_150_seconds() {
        let t0 = Instant::now();
        let mut lease = Lease::new(t0);
        assert!(!lease.expired(t0 + Duration::from_secs(149)));
        assert!(lease.expired(t0 + Duration::from_secs(150)));
        lease.renew(t0 + Duration::from_secs(100));
        assert!(!lease.expired(t0 + Duration::from_secs(249)));
        assert!(lease.expired(t0 + Duration::from_secs(250)));
        assert!(!lease.expired(t0), "a clock that goes backwards never expires");
    }

    #[test]
    fn reconcile_rules() {
        let a = desired();
        let with = |edit: fn(&mut Desired)| {
            let mut d = a.clone();
            edit(&mut d);
            d
        };
        assert_eq!(reconcile(&a, &a, 1000, true), Action::Keep);
        assert_eq!(reconcile(&a, &with(|d| d.token = "fresh".into()), 1000, true), Action::Keep);
        assert_eq!(reconcile(&a, &with(|d| d.livekit_url = "wss://other.example".into()), 1000, true), Action::Reconnect);
        assert_eq!(reconcile(&a, &with(|d| d.media_url = "https://cdn.example/w.mp4".into()), 1000, true), Action::Restart);
        assert_eq!(reconcile(&a, &with(|d| d.max_height = 1080), 1000, true), Action::Restart);
        assert_eq!(reconcile(&a, &with(|d| d.playing = false), 1000, true), Action::Pause);
        let paused = with(|d| d.playing = false);
        assert_eq!(reconcile(&paused, &with(|d| d.position_ms = 5000), 1000, false), Action::Resume(5000));
        assert_eq!(reconcile(&a, &with(|d| d.position_ms = 1000 + DRIFT_MS), 1000, true), Action::Keep);
        assert_eq!(reconcile(&a, &with(|d| d.position_ms = 1001 + DRIFT_MS), 1000, true), Action::Seek(4001));
        let still = with(|d| d.playing = false);
        assert_eq!(reconcile(&paused, &still, 1000, false), Action::Keep);
        assert_eq!(
            reconcile(
                &paused,
                &with(|d| {
                    d.playing = false;
                    d.position_ms = 9000;
                }),
                1000,
                false
            ),
            Action::Hold(9000)
        );
    }
}
