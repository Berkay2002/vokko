//! Runtime configuration from the environment, falling back to `.env.dev` (looked up from the working directory upwards).
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::account::config::AccountsConfig;
use vokko_protocol::api::{VOICE_BITRATE_CEILING_MAX, VOICE_BITRATE_GUILD_MAX, VOICE_BITRATE_MIN};

use crate::storage::StorageConfig;
use crate::unfurl::UnfurlConfig;

#[derive(Clone, Debug)]
pub struct Config {
    pub database_url: String,
    pub bind: String,
    pub data_dir: PathBuf,
    /// Attachment backend (`VOKKO_STORAGE`, `storage::StorageConfig`); local disk under `data_dir` by default.
    pub storage: StorageConfig,
    /// Database pool size (`VOKKO_DB_MAX_CONNECTIONS`, default 10); lower it for free-tier connection limits.
    pub db_max_connections: u32,
    /// Origin used in absolute attachment URLs.
    pub public_url: String,
    pub heartbeat_interval_ms: u64,
    pub heartbeat_misses: u32,
    pub session_ttl: Duration,
    pub replay_capacity: usize,
    /// `None` disables REST rate limiting.
    pub rate_limit: Option<RateLimit>,
    pub unfurl: UnfurlConfig,
    /// Largest accepted attachment, in bytes (`VOKKO_MAX_UPLOAD_MB`, default and ceiling 500 MiB, Nitro's limit).
    pub max_upload_bytes: usize,
    /// Frames queued per gateway connection before it is dropped as a slow reader (must exceed `replay_capacity`).
    pub outgoing_queue: usize,
    /// A single socket write that takes longer ends the connection.
    pub write_timeout: Duration,
    /// Hello → Identify/Resume window.
    pub handshake_timeout: Duration,
    /// Gateway Identifies per user per minute.
    pub identify_per_minute: u32,
    /// Gateway sockets per client address that have not identified yet.
    pub max_preauth_per_ip: usize,
    /// Take the client address from the last `X-Forwarded-For` entry (only behind a reverse proxy that sets it).
    pub trust_proxy: bool,
    /// `VOKKO_CORS_ORIGINS`: exact origins allowed to call the API from a browser. `None` keeps the dev defaults (localhost on any port).
    /// The Tauri origins are always allowed.
    pub cors_origins: Option<Vec<String>>,
    /// `VOKKO_REGISTRATION=open|closed`: with `closed`, `POST /auth/register` answers 403 (existing users and the seed are unaffected).
    pub registration_open: bool,
    /// Registration, age limit, terms, emailed links and outgoing mail (`account::config`).
    pub accounts: AccountsConfig,
    /// LiveKit (`VOKKO_LIVEKIT_URL`, `VOKKO_LIVEKIT_API_KEY`, `VOKKO_LIVEKIT_API_SECRET`); `None` disables voice.
    pub livekit: Option<LiveKitConfig>,
    /// Highest channel bitrate (`VOKKO_VOICE_BITRATE_MAX`, default 128000, at most 384000).
    pub voice_bitrate_max: u32,
    /// A joined state without LiveKit's `participant_joined` within this window of its token being issued is dropped
    /// (`VOKKO_VOICE_CONNECT_TIMEOUT_SECS`, default 30: slow TURN/TCP connects).
    pub voice_connect_timeout: Duration,
    /// First retry delay when LiveKit cannot be reached for the startup restore (doubles up to 60 s).
    pub voice_restore_backoff: Duration,
    /// A voice state outlives its gateway session (or, after a restart, waits for its client) this long.
    pub voice_gateway_grace: Duration,
    pub voice_reconcile_interval: Duration,
    /// How long a DM call rings a recipient before it shows as missed for them (3 minutes; tests shorten it).
    pub call_ring_timeout: Duration,
    /// Stickers per guild (one owner-editable block instead of boost levels).
    pub max_stickers_per_guild: usize,
    /// GIF proxy: provider, API key and an optional override of the provider's API origin.
    pub gif: GifConfig,
    /// How often due reminders are looked for.
    pub reminder_poll: Duration,
}

/// `VOKKO_GIF_PROVIDER` / `VOKKO_GIF_API_KEY` / `VOKKO_GIF_BASE_URL`.
#[derive(Clone, Debug)]
pub struct GifConfig {
    pub provider: vokko_protocol::api::GifProvider,
    pub api_key: String,
    pub base_url: Option<String>,
}

#[derive(Clone, Debug)]
pub struct LiveKitConfig {
    /// Public signal URL handed to clients (`wss://lk.example.org`).
    pub url: String,
    /// Where vokko-server reaches LiveKit's RoomService (`VOKKO_LIVEKIT_API_URL`, default: `url` with http(s)).
    pub api_url: String,
    pub api_key: String,
    pub api_secret: String,
}

/// `VOKKO_DB_MAX_CONNECTIONS`: 1..=1000.
pub fn parse_db_max_connections(value: &str) -> Result<u32, String> {
    match value.trim().parse::<u32>() {
        Ok(count @ 1..=1000) => Ok(count),
        _ => Err(format!("VOKKO_DB_MAX_CONNECTIONS must be a whole number from 1 to 1000, got {value}")),
    }
}

impl LiveKitConfig {
    /// `wss://host` → `https://host`, `ws://host` → `http://host`.
    pub fn derive_api_url(url: &str) -> String {
        if let Some(rest) = url.strip_prefix("wss://") {
            format!("https://{rest}")
        } else if let Some(rest) = url.strip_prefix("ws://") {
            format!("http://{rest}")
        } else {
            url.to_owned()
        }
    }
}

pub const DEFAULT_BIND: &str = "127.0.0.1:8710";
/// Default of `VOKKO_VOICE_CONNECT_TIMEOUT_SECS`.
pub const DEFAULT_VOICE_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// `VOKKO_VOICE_CONNECT_TIMEOUT_SECS`: whole seconds, 5..=600.
pub fn parse_connect_timeout(value: &str) -> Result<Duration, String> {
    match value.trim().parse::<u64>() {
        Ok(seconds) if (5..=600).contains(&seconds) => Ok(Duration::from_secs(seconds)),
        _ => Err(format!("VOKKO_VOICE_CONNECT_TIMEOUT_SECS must be whole seconds between 5 and 600, got {value}")),
    }
}
/// Default of `VOKKO_DB_MAX_CONNECTIONS`.
pub const DEFAULT_DB_MAX_CONNECTIONS: u32 = 10;
/// Default and ceiling of `VOKKO_MAX_UPLOAD_MB`: Discord Nitro's per-file limit, free for everyone. A self-host may set it lower.
pub const DEFAULT_MAX_UPLOAD_MB: usize = 500;
/// Total size of one user's pending (not attached, not avatar/icon) uploads, raised to the per-file limit when that is larger.
pub const MAX_PENDING_BYTES_PER_USER: i64 = 100 * 1024 * 1024;
/// Pending uploads older than this are deleted by the cleanup task, which runs every `CLEANUP_INTERVAL`.
pub const PENDING_MAX_AGE: Duration = Duration::from_secs(60 * 60);
pub const CLEANUP_INTERVAL: Duration = Duration::from_secs(10 * 60);
pub const MAX_ATTACHMENTS_PER_MESSAGE: usize = 10;

/// Token buckets: one per (caller, route) and one per caller across all routes. Deliberately lenient, except for
/// `/auth/*` which is keyed on the client address and uses the `auth_*` route bucket.
#[derive(Clone, Copy, Debug)]
pub struct RateLimit {
    pub route_burst: f64,
    pub route_per_second: f64,
    pub global_burst: f64,
    pub global_per_second: f64,
    pub auth_burst: f64,
    pub auth_per_second: f64,
}

impl Default for RateLimit {
    fn default() -> Self {
        Self { route_burst: 30.0, route_per_second: 10.0, global_burst: 200.0, global_per_second: 50.0, auth_burst: 10.0, auth_per_second: 0.5 }
    }
}

/// Parsed `KEY=VALUE` lines of the nearest `.env.dev`.
pub struct DotEnv(HashMap<String, String>);

impl DotEnv {
    pub fn discover() -> Self {
        let mut dir = std::env::current_dir().ok();
        while let Some(current) = dir {
            let candidate = current.join(".env.dev");
            if let Ok(text) = std::fs::read_to_string(&candidate) {
                return Self::parse(&text);
            }
            dir = current.parent().map(Path::to_path_buf);
        }
        Self(HashMap::new())
    }

    /// Fixed values (tests); the real environment still wins on lookups.
    pub fn from_pairs(pairs: &[(&str, &str)]) -> Self {
        Self(pairs.iter().map(|(key, value)| ((*key).to_owned(), (*value).to_owned())).collect())
    }

    pub fn from_file(path: &Path) -> Self {
        Self(std::fs::read_to_string(path).map(|text| Self::parse(&text).0).unwrap_or_default())
    }

    fn parse(text: &str) -> Self {
        let mut values = HashMap::new();
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((key, value)) = line.split_once('=') {
                values.insert(key.trim().to_owned(), value.trim().trim_matches('"').to_owned());
            }
        }
        Self(values)
    }

    /// Every key of the environment and the file (the environment wins on lookups).
    pub fn keys(&self) -> Vec<String> {
        std::env::vars().map(|(key, _)| key).chain(self.0.keys().cloned()).collect()
    }

    /// Real environment first, then the file.
    pub fn get(&self, key: &str) -> Option<String> {
        std::env::var(key).ok().filter(|value| !value.is_empty()).or_else(|| self.0.get(key).cloned())
    }
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let env = DotEnv::discover();
        let database_url = env.get("DATABASE_URL").ok_or("DATABASE_URL is not set (environment or .env.dev)")?;
        let bind = env.get("VOKKO_BIND").unwrap_or_else(|| DEFAULT_BIND.to_owned());
        let data_dir = env
            .get("VOKKO_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("data").join("server-dev"));
        let public_url = env.get("VOKKO_PUBLIC_URL").unwrap_or_else(|| format!("http://{bind}"));
        let mut config = Self::new(database_url, bind, data_dir, public_url);
        config.storage = StorageConfig::from_env(&env)?;
        if let Some(value) = env.get("VOKKO_DB_MAX_CONNECTIONS") {
            config.db_max_connections = parse_db_max_connections(&value)?;
        }
        // `VOKKO_UNFURL=off` disables link previews (no outbound requests at all).
        config.unfurl.enabled = !env.get("VOKKO_UNFURL").is_some_and(|value| matches!(value.to_ascii_lowercase().as_str(), "off" | "0" | "false" | "no"));
        if let Some(value) = env.get("VOKKO_MAX_UPLOAD_MB") {
            config.max_upload_bytes = parse_max_upload_mb(&value)?;
        }
        // `VOKKO_TRUST_PROXY=on` behind a reverse proxy that appends the client address to X-Forwarded-For.
        config.trust_proxy = env.get("VOKKO_TRUST_PROXY").is_some_and(|value| matches!(value.to_ascii_lowercase().as_str(), "on" | "1" | "true" | "yes"));
        if let Some(value) = env.get("VOKKO_GIF_PROVIDER") {
            use vokko_protocol::api::GifProvider;
            config.gif.provider = match value.trim().to_ascii_lowercase().as_str() {
                "klipy" => GifProvider::Klipy,
                "giphy" => GifProvider::Giphy,
                "tenor" => GifProvider::Tenor,
                "none" | "" => GifProvider::None,
                other => return Err(format!("VOKKO_GIF_PROVIDER must be klipy, giphy, tenor or none, got {other}")),
            };
        }
        config.gif.api_key = env.get("VOKKO_GIF_API_KEY").unwrap_or_default();
        config.gif.base_url = env.get("VOKKO_GIF_BASE_URL").map(|value| value.trim_end_matches('/').to_owned());
        if config.gif.provider != vokko_protocol::api::GifProvider::None && config.gif.api_key.is_empty() {
            return Err("VOKKO_GIF_API_KEY is required when VOKKO_GIF_PROVIDER is set".to_owned());
        }
        if let Some(value) = env.get("VOKKO_REMINDER_POLL_SECS") {
            let seconds: u64 = value.trim().parse().map_err(|_| format!("VOKKO_REMINDER_POLL_SECS must be a whole number of seconds, got {value}"))?;
            config.reminder_poll = Duration::from_secs(seconds.max(1));
        }
        if let Some(value) = env.get("VOKKO_CORS_ORIGINS") {
            config.cors_origins = parse_cors_origins(&value)?;
        }
        if let Some(value) = env.get("VOKKO_REGISTRATION") {
            config.registration_open = match value.trim().to_ascii_lowercase().as_str() {
                "open" => true,
                "closed" => false,
                _ => return Err(format!("VOKKO_REGISTRATION must be `open` or `closed`, got {value}")),
            };
        }
        config.accounts = AccountsConfig::from_env(&env, &config.public_url)?;
        let livekit = (env.get("VOKKO_LIVEKIT_URL"), env.get("VOKKO_LIVEKIT_API_KEY"), env.get("VOKKO_LIVEKIT_API_SECRET"));
        config.livekit = match livekit {
            (Some(url), Some(api_key), Some(api_secret)) => {
                let url = url.trim_end_matches('/').to_owned();
                let api_url = env.get("VOKKO_LIVEKIT_API_URL").unwrap_or_else(|| LiveKitConfig::derive_api_url(&url));
                Some(LiveKitConfig { url, api_url, api_key, api_secret })
            }
            (None, None, None) => None,
            _ => return Err("voice needs all of VOKKO_LIVEKIT_URL, VOKKO_LIVEKIT_API_KEY and VOKKO_LIVEKIT_API_SECRET (or none of them)".to_owned()),
        };
        if let Some(value) = env.get("VOKKO_VOICE_BITRATE_MAX") {
            let bitrate: u32 = value.trim().parse().map_err(|_| format!("VOKKO_VOICE_BITRATE_MAX must be bps, got {value}"))?;
            if !(VOICE_BITRATE_MIN..=VOICE_BITRATE_CEILING_MAX).contains(&bitrate) {
                return Err(format!("VOKKO_VOICE_BITRATE_MAX must be between {VOICE_BITRATE_MIN} and {VOICE_BITRATE_CEILING_MAX}"));
            }
            config.voice_bitrate_max = bitrate;
        }
        if let Some(value) = env.get("VOKKO_VOICE_CONNECT_TIMEOUT_SECS") {
            config.voice_connect_timeout = parse_connect_timeout(&value)?;
        }
        Ok(config)
    }

    pub fn new(database_url: String, bind: String, data_dir: PathBuf, public_url: String) -> Self {
        let public_url = public_url.trim_end_matches('/').to_owned();
        Self {
            accounts: AccountsConfig::new(&public_url),
            database_url,
            bind,
            data_dir,
            storage: StorageConfig::Local,
            db_max_connections: DEFAULT_DB_MAX_CONNECTIONS,
            public_url,
            heartbeat_interval_ms: 41_250,
            heartbeat_misses: 2,
            session_ttl: Duration::from_secs(300),
            replay_capacity: 1000,
            rate_limit: Some(RateLimit::default()),
            unfurl: UnfurlConfig::default(),
            max_upload_bytes: DEFAULT_MAX_UPLOAD_MB * 1024 * 1024,
            outgoing_queue: 2048,
            write_timeout: Duration::from_secs(10),
            handshake_timeout: Duration::from_secs(30),
            identify_per_minute: 10,
            max_preauth_per_ip: 16,
            trust_proxy: false,
            max_stickers_per_guild: 60,
            gif: GifConfig { provider: vokko_protocol::api::GifProvider::None, api_key: String::new(), base_url: None },
            reminder_poll: Duration::from_secs(15),
            cors_origins: None,
            registration_open: true,
            livekit: None,
            voice_bitrate_max: VOICE_BITRATE_GUILD_MAX,
            voice_connect_timeout: DEFAULT_VOICE_CONNECT_TIMEOUT,
            voice_restore_backoff: Duration::from_secs(1),
            voice_gateway_grace: Duration::from_secs(60),
            voice_reconcile_interval: Duration::from_secs(60),
            call_ring_timeout: Duration::from_secs(vokko_protocol::api::CALL_RING_TIMEOUT_SECS),
        }
    }
}

/// Comma-separated origins (`https://chat.example.com`), trimmed, trailing `/` dropped. An empty list keeps the dev defaults.
fn parse_cors_origins(value: &str) -> Result<Option<Vec<String>>, String> {
    let mut origins = Vec::new();
    for entry in value.split(',').map(str::trim).filter(|entry| !entry.is_empty()) {
        let origin = entry.trim_end_matches('/');
        let has_scheme = origin.split_once("://").is_some_and(|(scheme, host)| !scheme.is_empty() && !host.is_empty() && !host.contains('/'));
        if origin == "*" || !has_scheme || origin.chars().any(char::is_whitespace) {
            return Err(format!("VOKKO_CORS_ORIGINS entries must be exact origins like https://chat.example.com, got {entry}"));
        }
        origins.push(origin.to_owned());
    }
    Ok(if origins.is_empty() { None } else { Some(origins) })
}

/// `VOKKO_MAX_UPLOAD_MB` in bytes: a whole number of MiB, at least 1; values above the Nitro limit (500) are lowered to it.
fn parse_max_upload_mb(value: &str) -> Result<usize, String> {
    let megabytes: usize = value.trim().parse().map_err(|_| format!("VOKKO_MAX_UPLOAD_MB must be a whole number of MiB, got {value}"))?;
    if megabytes == 0 {
        return Err("VOKKO_MAX_UPLOAD_MB must be at least 1".to_owned());
    }
    Ok(megabytes.min(DEFAULT_MAX_UPLOAD_MB) * 1024 * 1024)
}

#[cfg(test)]
mod tests {
    use super::{parse_cors_origins, parse_max_upload_mb};

    #[test]
    fn upload_limit_is_the_lower_of_the_setting_and_the_nitro_limit() {
        assert_eq!(super::Config::new(String::new(), String::new(), "d".into(), String::new()).max_upload_bytes, 500 * 1024 * 1024);
        assert_eq!(parse_max_upload_mb(" 25 "), Ok(25 * 1024 * 1024));
        assert_eq!(parse_max_upload_mb("500"), Ok(500 * 1024 * 1024));
        assert_eq!(parse_max_upload_mb("4096"), Ok(500 * 1024 * 1024));
        assert!(parse_max_upload_mb("0").is_err());
        assert!(parse_max_upload_mb("1.5").is_err());
    }

    #[test]
    fn voice_connect_timeout_defaults_to_30_seconds_and_is_configurable() {
        use std::time::Duration;
        let config = super::Config::new(String::new(), String::new(), "/tmp".into(), String::new());
        assert_eq!(config.voice_connect_timeout, Duration::from_secs(30));
        assert_eq!(super::parse_connect_timeout(" 45 "), Ok(Duration::from_secs(45)));
        for bad in ["0", "4", "601", "ten", ""] {
            assert!(super::parse_connect_timeout(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn livekit_api_url_is_derived_from_the_signal_url() {
        assert_eq!(super::LiveKitConfig::derive_api_url("wss://lk.example.org"), "https://lk.example.org");
        assert_eq!(super::LiveKitConfig::derive_api_url("ws://127.0.0.1:7880"), "http://127.0.0.1:7880");
    }

    #[test]
    fn cors_origins_are_trimmed_and_exact() {
        assert_eq!(
            parse_cors_origins(" https://chat.example.com/ , http://localhost:5173,, "),
            Ok(Some(vec!["https://chat.example.com".to_owned(), "http://localhost:5173".to_owned()]))
        );
        assert_eq!(parse_cors_origins("  , "), Ok(None));
        for bad in ["*", "chat.example.com", "https://chat.example.com/app", "https://", "https://a b"] {
            assert!(parse_cors_origins(bad).is_err(), "{bad}");
        }
    }
}
