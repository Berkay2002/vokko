//! Runtime configuration from the environment, falling back to `.env.dev` (looked up from the working directory upwards).
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::unfurl::UnfurlConfig;

#[derive(Clone, Debug)]
pub struct Config {
    pub database_url: String,
    pub bind: String,
    pub data_dir: PathBuf,
    /// Origin used in absolute attachment URLs.
    pub public_url: String,
    pub heartbeat_interval_ms: u64,
    pub heartbeat_misses: u32,
    pub session_ttl: Duration,
    pub replay_capacity: usize,
    /// `None` disables REST rate limiting.
    pub rate_limit: Option<RateLimit>,
    pub unfurl: UnfurlConfig,
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
}

pub const DEFAULT_BIND: &str = "127.0.0.1:8710";
pub const MAX_UPLOAD_BYTES: usize = 10 * 1024 * 1024;
/// Total size of one user's pending (not attached, not avatar/icon) uploads.
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
        // `VOKKO_UNFURL=off` disables link previews (no outbound requests at all).
        config.unfurl.enabled = !env.get("VOKKO_UNFURL").is_some_and(|value| matches!(value.to_ascii_lowercase().as_str(), "off" | "0" | "false" | "no"));
        // `VOKKO_TRUST_PROXY=on` behind a reverse proxy that appends the client address to X-Forwarded-For.
        config.trust_proxy = env.get("VOKKO_TRUST_PROXY").is_some_and(|value| matches!(value.to_ascii_lowercase().as_str(), "on" | "1" | "true" | "yes"));
        Ok(config)
    }

    pub fn new(database_url: String, bind: String, data_dir: PathBuf, public_url: String) -> Self {
        Self {
            database_url,
            bind,
            data_dir,
            public_url: public_url.trim_end_matches('/').to_owned(),
            heartbeat_interval_ms: 41_250,
            heartbeat_misses: 2,
            session_ttl: Duration::from_secs(300),
            replay_capacity: 1000,
            rate_limit: Some(RateLimit::default()),
            unfurl: UnfurlConfig::default(),
            outgoing_queue: 2048,
            write_timeout: Duration::from_secs(10),
            handshake_timeout: Duration::from_secs(30),
            identify_per_minute: 10,
            max_preauth_per_ip: 16,
            trust_proxy: false,
        }
    }
}
