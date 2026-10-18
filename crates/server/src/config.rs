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
    /// LiveKit backends in failover order: backend 0 is `VOKKO_LIVEKIT_URL` / `_API_KEY` / `_API_SECRET`, further ones carry a
    /// `_2`, `_3`, ... suffix (see `parse_livekit`). Empty disables voice.
    pub livekit: Vec<LiveKitConfig>,
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
    /// How long a LiveKit backend whose API answered with a quota, limit or auth error (or was unreachable) is passed over
    /// for new rooms before it is tried again.
    pub voice_backend_cooldown: Duration,
    /// How long a DM call rings a recipient before it shows as missed for them (3 minutes; tests shorten it).
    pub call_ring_timeout: Duration,
    /// Stickers per guild (one owner-editable block instead of boost levels).
    pub max_stickers_per_guild: usize,
    /// GIF proxy: provider, API key and an optional override of the provider's API origin.
    pub gif: GifConfig,
    /// How often due reminders are looked for.
    pub reminder_poll: Duration,
    /// Stremio in voice calls; `None` (every `/stremio` route answers 404) unless it is fully configured.
    pub stremio: Option<StremioConfig>,
    /// Spotify in voice calls; `None` (every `/spotify` route answers 404) unless it is fully configured.
    pub spotify: Option<SpotifyConfig>,
    /// Key of the per-game app ids (docs/design/games-host.md section 5): derived from `VOKKO_SECRETS_KEY`, else random per process
    /// (app ids then change on every restart).
    pub games_app_key: crate::crypto::SecretsKey,
    /// Signs embed image proxy URLs (`crate::embed_media`): derived from `VOKKO_SECRETS_KEY`, else random per process (proxy URLs
    /// then change on every restart, which only costs clients their image cache).
    pub embed_media_key: crate::crypto::SecretsKey,
    /// `VOKKO_DESKTOP_LATEST_JSON`: the desktop updater's `latest.json` in the downloads directory. Its `version` goes to clients
    /// in READY and DESKTOP_VERSION so installed apps check for the update right away (`crate::desktop_version`). `None`: off.
    pub desktop_latest_json: Option<PathBuf>,
    /// How often that file is read again (60 s).
    pub desktop_version_poll: Duration,
    /// `VOKKO_DEV=1`: game manifests may also point at `http://127.0.0.1` / `http://localhost`.
    pub dev: bool,
}

/// Stremio in voice calls (docs/design/stremio-bot.md): `VOKKO_SECRETS_KEY`, the media LiveKit (`VOKKO_MEDIA_LIVEKIT_URL`,
/// `_API_KEY`, `_API_SECRET`), the bot (`VOKKO_STREMIO_BOT_URL`, `_BOT_SECRET`) and the optional `VOKKO_STREMIO_*` settings. The
/// feature is off unless all of those are set, or when `VOKKO_STREMIO=off`.
#[derive(Clone, Debug)]
pub struct StremioConfig {
    pub secrets_key: crate::crypto::SecretsKey,
    /// Public signalling URL of the media LiveKit, handed to viewers (`wss://live.vokko.example.com`).
    pub media_url: String,
    pub media_api_key: String,
    pub media_api_secret: crate::crypto::Secret,
    /// Signalling URL the native bot connects to (`VOKKO_MEDIA_LIVEKIT_BOT_URL`): the home server reaches its own LiveKit locally,
    /// `ws://127.0.0.1:7880`, instead of going out through the tunnel. Defaults to `media_url`.
    pub bot_media_url: String,
    /// Where the native bot listens, as the server (in docker) reaches it: `http://host.internal:8720`.
    pub bot_url: String,
    pub bot_secret: crate::crypto::Secret,
    /// Output height cap and video bitrate (kbit/s) the bot is asked for.
    pub max_height: u32,
    pub bitrate_kbps: u32,
    /// A session paused this long stops.
    pub pause_timeout: Duration,
    /// Self-hosted addons and resolvers may live in these ranges (`VOKKO_STREMIO_FETCH_ALLOW`, empty by default).
    pub fetch_allow: Vec<Cidr>,
    /// Stremio's account API, its link service and the Cinemeta addon (tests point them at a mock).
    pub api_url: String,
    pub link_url: String,
    pub cinemeta_url: String,
    /// The bot drops a session not renewed for 150 s, so the server re-sends its `PUT` this often.
    pub lease_interval: Duration,
    /// How often sessions are checked for lease, pause timeout and error hold.
    pub tick: Duration,
    /// How long an `error` stays on the tile before the session stops.
    pub error_hold: Duration,
    /// Bot events this soon after an item started or was changed are stale (they describe the previous item or position).
    pub event_grace: Duration,
}

/// Spotify in voice calls (docs/design/spotify-bot.md): the catalog app (`VOKKO_SPOTIFY_CLIENT_ID`, `_CLIENT_SECRET`), the bot
/// (`VOKKO_SPOTIFY_BOT_URL`, `_BOT_SECRET`) and the media LiveKit (`VOKKO_MEDIA_LIVEKIT_*`, the same one Stremio uses, but this
/// feature does not need Stremio's `VOKKO_SECRETS_KEY`). Off unless all of those are set.
#[derive(Clone, Debug)]
pub struct SpotifyConfig {
    pub client_id: String,
    pub client_secret: crate::crypto::Secret,
    pub bot_url: String,
    pub bot_secret: crate::crypto::Secret,
    /// Public signalling URL of the media LiveKit, handed to listeners.
    pub media_url: String,
    pub media_api_key: String,
    pub media_api_secret: crate::crypto::Secret,
    /// Signalling URL the native bot connects to (`VOKKO_MEDIA_LIVEKIT_BOT_URL`); defaults to `media_url`.
    pub bot_media_url: String,
    /// The house account's country (`VOKKO_SPOTIFY_MARKET`), so catalog results are playable for it.
    pub market: String,
    /// A session paused this long stops (`VOKKO_SPOTIFY_IDLE_MIN`).
    pub pause_timeout: Duration,
    /// Spotify's Web API and token endpoints (tests point them at a mock).
    pub api_url: String,
    pub accounts_url: String,
    /// The bot drops a session not renewed for 150 s, so the server re-sends its `PUT` this often.
    pub lease_interval: Duration,
    /// How often the session is checked for lease, pause timeout, error hold and notice expiry.
    pub tick: Duration,
    /// How long an `error` stays on the tile before the session stops, and how long an unreachable bot is waited for.
    pub error_hold: Duration,
    /// A session with nothing left to play stops after this long.
    pub empty_timeout: Duration,
    /// How long a `notice` stays in the state.
    pub notice_ttl: Duration,
}

impl SpotifyConfig {
    pub fn new(
        client_id: String,
        client_secret: String,
        bot_url: String,
        bot_secret: String,
        media_url: String,
        media_api_key: String,
        media_api_secret: String,
    ) -> Self {
        Self {
            client_id,
            client_secret: crate::crypto::Secret::new(client_secret),
            bot_url,
            bot_secret: crate::crypto::Secret::new(bot_secret),
            bot_media_url: media_url.clone(),
            media_url,
            media_api_key,
            media_api_secret: crate::crypto::Secret::new(media_api_secret),
            market: "SE".to_owned(),
            pause_timeout: Duration::from_secs(15 * 60),
            api_url: "https://api.spotify.com".to_owned(),
            accounts_url: "https://accounts.spotify.com".to_owned(),
            lease_interval: Duration::from_secs(60),
            tick: Duration::from_secs(1),
            error_hold: Duration::from_secs(30),
            empty_timeout: Duration::from_secs(5 * 60),
            notice_ttl: Duration::from_secs(5),
        }
    }
}

/// `Ok(None)` when Spotify is not (fully) configured; an error for values that are set but wrong.
pub fn parse_spotify(env: &DotEnv) -> Result<Option<SpotifyConfig>, String> {
    let [client_id, client_secret, bot_url, bot_secret, media_url, media_api_key, media_api_secret] = [
        "VOKKO_SPOTIFY_CLIENT_ID",
        "VOKKO_SPOTIFY_CLIENT_SECRET",
        "VOKKO_SPOTIFY_BOT_URL",
        "VOKKO_SPOTIFY_BOT_SECRET",
        "VOKKO_MEDIA_LIVEKIT_URL",
        "VOKKO_MEDIA_LIVEKIT_API_KEY",
        "VOKKO_MEDIA_LIVEKIT_API_SECRET",
    ]
    .map(|name| env.get(name).filter(|value| !value.trim().is_empty()));
    let (Some(client_id), Some(client_secret), Some(bot_url), Some(bot_secret), Some(media_url), Some(media_api_key), Some(media_api_secret)) =
        (client_id, client_secret, bot_url, bot_secret, media_url, media_api_key, media_api_secret)
    else {
        return Ok(None);
    };
    if bot_secret.len() < 16 {
        return Err("VOKKO_SPOTIFY_BOT_SECRET must be at least 16 characters".to_owned());
    }
    let mut config = SpotifyConfig::new(
        client_id.trim().to_owned(),
        client_secret.trim().to_owned(),
        bot_url.trim().trim_end_matches('/').to_owned(),
        bot_secret,
        media_url.trim().trim_end_matches('/').to_owned(),
        media_api_key,
        media_api_secret,
    );
    if let Some(url) = env.get("VOKKO_MEDIA_LIVEKIT_BOT_URL").filter(|url| !url.trim().is_empty()) {
        config.bot_media_url = url.trim().trim_end_matches('/').to_owned();
    }
    if let Some(market) = env.get("VOKKO_SPOTIFY_MARKET").filter(|value| !value.trim().is_empty()) {
        let market = market.trim().to_ascii_uppercase();
        if market.len() != 2 || !market.bytes().all(|byte| byte.is_ascii_uppercase()) {
            return Err(format!("VOKKO_SPOTIFY_MARKET must be a two-letter country code, got {market}"));
        }
        config.market = market;
    }
    if let Some(value) = env.get("VOKKO_SPOTIFY_IDLE_MIN").filter(|value| !value.trim().is_empty()) {
        let minutes: u64 = value
            .trim()
            .parse()
            .ok()
            .filter(|minutes| (1..=1440).contains(minutes))
            .ok_or_else(|| format!("VOKKO_SPOTIFY_IDLE_MIN must be a whole number from 1 to 1440, got {value}"))?;
        config.pause_timeout = Duration::from_secs(minutes * 60);
    }
    Ok(Some(config))
}

/// An IP range (`10.0.0.0/8`, `fd00::/8`, or a bare address).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cidr {
    network: std::net::IpAddr,
    bits: u8,
}

impl Cidr {
    pub fn parse(text: &str) -> Result<Self, String> {
        let text = text.trim();
        let (address, bits) = text.split_once('/').map_or((text, None), |(address, bits)| (address, Some(bits)));
        let network: std::net::IpAddr = address.parse().map_err(|_| format!("{text} is not an IP range"))?;
        let max = if network.is_ipv4() { 32 } else { 128 };
        let bits = match bits {
            Some(bits) => bits.parse::<u8>().ok().filter(|bits| *bits <= max).ok_or_else(|| format!("{text} is not an IP range"))?,
            None => max,
        };
        Ok(Self { network, bits })
    }

    pub fn contains(&self, ip: std::net::IpAddr) -> bool {
        fn leading_equal(a: &[u8], b: &[u8], bits: u8) -> bool {
            let whole = usize::from(bits / 8);
            a[..whole] == b[..whole] && ((bits).is_multiple_of(8) || (a[whole] ^ b[whole]) >> (8 - bits % 8) == 0)
        }
        match (self.network, ip) {
            (std::net::IpAddr::V4(network), std::net::IpAddr::V4(ip)) => leading_equal(&network.octets(), &ip.octets(), self.bits),
            (std::net::IpAddr::V6(network), std::net::IpAddr::V6(ip)) => leading_equal(&network.octets(), &ip.octets(), self.bits),
            _ => false,
        }
    }
}

/// `VOKKO_STREMIO_FETCH_ALLOW`: comma-separated ranges.
pub fn parse_cidr_list(value: &str) -> Result<Vec<Cidr>, String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(Cidr::parse)
        .collect::<Result<_, _>>()
        .map_err(|error| format!("VOKKO_STREMIO_FETCH_ALLOW: {error}"))
}

/// `Ok(None)` when Stremio is not (fully) configured or `VOKKO_STREMIO=off`; an error for values that are set but wrong.
pub fn parse_stremio(env: &DotEnv) -> Result<Option<StremioConfig>, String> {
    if env.get("VOKKO_STREMIO").is_some_and(|value| matches!(value.to_ascii_lowercase().as_str(), "off" | "0" | "false" | "no")) {
        return Ok(None);
    }
    let [key, media_url, media_api_key, media_api_secret, bot_url, bot_secret] = [
        "VOKKO_SECRETS_KEY",
        "VOKKO_MEDIA_LIVEKIT_URL",
        "VOKKO_MEDIA_LIVEKIT_API_KEY",
        "VOKKO_MEDIA_LIVEKIT_API_SECRET",
        "VOKKO_STREMIO_BOT_URL",
        "VOKKO_STREMIO_BOT_SECRET",
    ]
    .map(|name| env.get(name));
    let (Some(key), Some(media_url), Some(media_api_key), Some(media_api_secret), Some(bot_url), Some(bot_secret)) =
        (key, media_url, media_api_key, media_api_secret, bot_url, bot_secret)
    else {
        return Ok(None);
    };
    if bot_secret.len() < 16 {
        return Err("VOKKO_STREMIO_BOT_SECRET must be at least 16 characters".to_owned());
    }
    let number = |name: &str, default: u32, range: std::ops::RangeInclusive<u32>| -> Result<u32, String> {
        let Some(value) = env.get(name) else { return Ok(default) };
        value
            .trim()
            .parse()
            .ok()
            .filter(|number| range.contains(number))
            .ok_or_else(|| format!("{name} must be a whole number from {} to {}, got {value}", range.start(), range.end()))
    };
    let mut config = StremioConfig::new(
        crate::crypto::SecretsKey::parse(&key)?,
        media_url.trim_end_matches('/').to_owned(),
        media_api_key,
        media_api_secret,
        bot_url.trim_end_matches('/').to_owned(),
        bot_secret,
    );
    if let Some(url) = env.get("VOKKO_MEDIA_LIVEKIT_BOT_URL").filter(|url| !url.trim().is_empty()) {
        config.bot_media_url = url.trim().trim_end_matches('/').to_owned();
    }
    config.max_height = number("VOKKO_STREMIO_MAX_HEIGHT", config.max_height, 144..=1440)?;
    config.bitrate_kbps = number("VOKKO_STREMIO_BITRATE_KBPS", config.bitrate_kbps, 100..=20_000)?;
    config.pause_timeout = Duration::from_secs(u64::from(number("VOKKO_STREMIO_PAUSE_TIMEOUT_MIN", 15, 1..=1440)?) * 60);
    config.fetch_allow = env.get("VOKKO_STREMIO_FETCH_ALLOW").map(|value| parse_cidr_list(&value)).transpose()?.unwrap_or_default();
    Ok(Some(config))
}

impl StremioConfig {
    pub fn new(
        secrets_key: crate::crypto::SecretsKey,
        media_url: String,
        media_api_key: String,
        media_api_secret: String,
        bot_url: String,
        bot_secret: String,
    ) -> Self {
        Self {
            secrets_key,
            bot_media_url: media_url.clone(),
            media_url,
            media_api_key,
            media_api_secret: crate::crypto::Secret::new(media_api_secret),
            bot_url,
            bot_secret: crate::crypto::Secret::new(bot_secret),
            max_height: 1080,
            bitrate_kbps: 6000,
            pause_timeout: Duration::from_secs(15 * 60),
            fetch_allow: Vec::new(),
            api_url: "https://api.strem.io".to_owned(),
            link_url: "https://link.stremio.com".to_owned(),
            cinemeta_url: "https://v3-cinemeta.strem.io".to_owned(),
            lease_interval: Duration::from_secs(60),
            tick: Duration::from_secs(1),
            error_hold: Duration::from_secs(30),
            event_grace: Duration::from_secs(5),
        }
    }
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
    /// Name in logs (`VOKKO_LIVEKIT_LABEL[_N]`).
    pub label: String,
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
/// How long a LiveKit backend that failed with a quota, limit or auth error is passed over for new rooms.
pub const DEFAULT_VOICE_BACKEND_COOLDOWN: Duration = Duration::from_secs(5 * 60);

/// Names of the LiveKit variables of backend `index` (0-based): backend 0 has no suffix, backend 1 is `_2`, and so on.
fn livekit_var(name: &str, index: usize) -> String {
    if index == 0 { format!("VOKKO_LIVEKIT_{name}") } else { format!("VOKKO_LIVEKIT_{name}_{}", index + 1) }
}

/// Backend 0 (`VOKKO_LIVEKIT_URL`, `_API_KEY`, `_API_SECRET`, optional `_API_URL` and `_LABEL`) and the backends after it
/// (`_2`, `_3`, ... until the first index with none of URL, API_KEY and API_SECRET set). A backend with only some of the three
/// set, or one numbered after a gap, is an error rather than silently ignored.
pub fn parse_livekit(env: &DotEnv) -> Result<Vec<LiveKitConfig>, String> {
    let mut backends = Vec::new();
    loop {
        let index = backends.len();
        let [url, api_key, api_secret] = ["URL", "API_KEY", "API_SECRET"].map(|name| env.get(&livekit_var(name, index)));
        if url.is_none() && api_key.is_none() && api_secret.is_none() {
            // Anything numbered after the gap would be ignored without a word.
            let later = env.keys().into_iter().filter_map(|key| {
                let (name, number) = key.strip_prefix("VOKKO_LIVEKIT_")?.rsplit_once('_')?;
                let number: usize = number.parse().ok()?;
                (number > index + 1 && matches!(name, "URL" | "API_KEY" | "API_SECRET")).then_some((key, number))
            });
            if let Some((key, _)) = later.filter(|(key, _)| env.get(key).is_some()).min_by_key(|(_, number)| *number) {
                let missing = livekit_var("URL", index);
                return Err(format!("{key} is set but LiveKit backend {} is not ({missing} is missing): number backends without gaps", index + 1));
            }
            return Ok(backends);
        }
        let (Some(url), Some(api_key), Some(api_secret)) = (url, api_key, api_secret) else {
            let (url, key, secret) = (livekit_var("URL", index), livekit_var("API_KEY", index), livekit_var("API_SECRET", index));
            return Err(if index == 0 {
                format!("voice needs all of {url}, {key} and {secret} (or none of them)")
            } else {
                format!("LiveKit backend {} needs all of {url}, {key} and {secret} (or none of them)", index + 1)
            });
        };
        if let Some(same) = backends.iter().position(|other: &LiveKitConfig| other.api_key == api_key && other.api_secret == api_secret) {
            // Webhooks are told apart by the key and secret that signed them.
            return Err(format!(
                "{} and {} repeat the API key and secret of LiveKit backend {}: give each backend its own key pair",
                livekit_var("API_KEY", index),
                livekit_var("API_SECRET", index),
                same + 1
            ));
        }
        let url = url.trim_end_matches('/').to_owned();
        let api_url = env.get(&livekit_var("API_URL", index)).unwrap_or_else(|| LiveKitConfig::derive_api_url(&url));
        let label = env.get(&livekit_var("LABEL", index)).unwrap_or_else(|| format!("livekit-{}", index + 1));
        backends.push(LiveKitConfig { url, api_url, api_key, api_secret, label });
    }
}

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
        // How long a DM call rings before it counts as missed (default 180); the real e2e shortens it.
        if let Some(value) = env.get("VOKKO_CALL_RING_TIMEOUT_SECS") {
            let seconds: u64 = value.trim().parse().map_err(|_| format!("VOKKO_CALL_RING_TIMEOUT_SECS must be a whole number of seconds, got {value}"))?;
            config.call_ring_timeout = Duration::from_secs(seconds.max(1));
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
        config.livekit = parse_livekit(&env)?;
        config.stremio = parse_stremio(&env)?;
        config.spotify = parse_spotify(&env)?;
        if let Some(key) = env.get("VOKKO_SECRETS_KEY").filter(|key| !key.trim().is_empty()) {
            let key = crate::crypto::SecretsKey::parse(&key)?;
            config.games_app_key = key.derive(crate::voice::games::APP_ID_LABEL);
            config.embed_media_key = key.derive(crate::embed_media::KEY_LABEL);
        } else {
            tracing::warn!("VOKKO_SECRETS_KEY is not set: game app ids and embed image URLs change on every restart");
        }
        config.desktop_latest_json = env.get("VOKKO_DESKTOP_LATEST_JSON").filter(|path| !path.trim().is_empty()).map(PathBuf::from);
        config.dev = env.get("VOKKO_DEV").is_some_and(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "on" | "true" | "yes"));
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
            stremio: None,
            spotify: None,
            games_app_key: crate::crypto::SecretsKey::random(),
            embed_media_key: crate::crypto::SecretsKey::random(),
            desktop_latest_json: None,
            desktop_version_poll: Duration::from_secs(60),
            dev: false,
            cors_origins: None,
            registration_open: true,
            livekit: Vec::new(),
            voice_bitrate_max: VOICE_BITRATE_GUILD_MAX,
            voice_connect_timeout: DEFAULT_VOICE_CONNECT_TIMEOUT,
            voice_restore_backoff: Duration::from_secs(1),
            voice_gateway_grace: Duration::from_secs(60),
            voice_reconcile_interval: Duration::from_secs(60),
            voice_backend_cooldown: DEFAULT_VOICE_BACKEND_COOLDOWN,
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
    use super::{DotEnv, parse_cors_origins, parse_livekit, parse_max_upload_mb};

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

    fn livekit(pairs: &[(&str, &str)]) -> Result<Vec<(String, String, String, String)>, String> {
        let backends = parse_livekit(&DotEnv::from_pairs(pairs))?;
        Ok(backends.into_iter().map(|b| (b.url, b.api_url, b.api_key, b.label)).collect())
    }

    const BACKEND_0: [(&str, &str); 3] = [("VOKKO_LIVEKIT_URL", "wss://a.example/"), ("VOKKO_LIVEKIT_API_KEY", "ka"), ("VOKKO_LIVEKIT_API_SECRET", "sa")];

    #[test]
    fn livekit_backends_parse_in_order() {
        assert_eq!(livekit(&[]), Ok(Vec::new()), "no backends: voice off");
        let one = livekit(&BACKEND_0).expect("one backend");
        assert_eq!(one, [("wss://a.example".into(), "https://a.example".into(), "ka".into(), "livekit-1".into())]);
        let mut two = BACKEND_0.to_vec();
        two.extend([
            ("VOKKO_LIVEKIT_URL_2", "ws://127.0.0.1:7880"),
            ("VOKKO_LIVEKIT_API_KEY_2", "kb"),
            ("VOKKO_LIVEKIT_API_SECRET_2", "sb"),
            ("VOKKO_LIVEKIT_LABEL_2", "home"),
            ("VOKKO_LIVEKIT_API_URL_2", "http://livekit:7880"),
        ]);
        let two = livekit(&two).expect("two backends");
        assert_eq!(two.len(), 2);
        assert_eq!(two[1], ("ws://127.0.0.1:7880".into(), "http://livekit:7880".into(), "kb".into(), "home".into()));
    }

    #[test]
    fn partial_or_gapped_livekit_backends_are_errors() {
        let mut partial = BACKEND_0.to_vec();
        partial.push(("VOKKO_LIVEKIT_URL_2", "wss://b.example"));
        let error = livekit(&partial).expect_err("partial backend 2");
        assert!(error.contains("VOKKO_LIVEKIT_API_KEY_2") && error.contains("VOKKO_LIVEKIT_API_SECRET_2"), "{error}");
        assert!(livekit(&[("VOKKO_LIVEKIT_URL", "wss://a.example")]).is_err(), "partial backend 0");
        let gap = [BACKEND_0.to_vec(), vec![("VOKKO_LIVEKIT_URL_3", "x"), ("VOKKO_LIVEKIT_API_KEY_3", "x"), ("VOKKO_LIVEKIT_API_SECRET_3", "x")]].concat();
        assert!(livekit(&gap).expect_err("gap").contains("_3 is set but LiveKit backend 2 is not"));
        let only_second = [("VOKKO_LIVEKIT_URL_2", "x"), ("VOKKO_LIVEKIT_API_KEY_2", "x"), ("VOKKO_LIVEKIT_API_SECRET_2", "x")];
        assert!(livekit(&only_second).is_err(), "backend 2 without backend 1");
        let same_pair =
            [BACKEND_0.to_vec(), vec![("VOKKO_LIVEKIT_URL_2", "x"), ("VOKKO_LIVEKIT_API_KEY_2", "ka"), ("VOKKO_LIVEKIT_API_SECRET_2", "sa")]].concat();
        assert!(livekit(&same_pair).expect_err("same key pair").contains("repeat the API key and secret of LiveKit backend 1"));
        let same_key =
            [BACKEND_0.to_vec(), vec![("VOKKO_LIVEKIT_URL_2", "x"), ("VOKKO_LIVEKIT_API_KEY_2", "ka"), ("VOKKO_LIVEKIT_API_SECRET_2", "other")]].concat();
        assert_eq!(livekit(&same_key).map(|backends| backends.len()), Ok(2), "the same key name with another secret is fine");
    }

    #[test]
    fn stremio_needs_every_key_and_can_be_switched_off() {
        let key = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, [3_u8; 32]);
        let all = [
            ("VOKKO_SECRETS_KEY", key.as_str()),
            ("VOKKO_MEDIA_LIVEKIT_URL", "wss://vokko-live.example/"),
            ("VOKKO_MEDIA_LIVEKIT_API_KEY", "mk"),
            ("VOKKO_MEDIA_LIVEKIT_API_SECRET", "ms"),
            ("VOKKO_STREMIO_BOT_URL", "http://host.internal:8720/"),
            ("VOKKO_STREMIO_BOT_SECRET", "0123456789abcdef"),
        ];
        let parse = |pairs: &[(&str, &str)]| super::parse_stremio(&DotEnv::from_pairs(pairs));
        let config = parse(&all).expect("valid").expect("on");
        assert_eq!(
            (config.media_url.as_str(), config.bot_url.as_str(), config.max_height, config.bitrate_kbps),
            ("wss://vokko-live.example", "http://host.internal:8720", 1080, 6000)
        );
        for skip in 0..all.len() {
            let partial: Vec<_> = all.iter().enumerate().filter(|(index, _)| *index != skip).map(|(_, pair)| *pair).collect();
            assert!(parse(&partial).expect("valid").is_none(), "without {}", all[skip].0);
        }
        assert!(parse(&[all.as_slice(), &[("VOKKO_STREMIO", "off")]].concat()).expect("valid").is_none());
        assert!(parse(&[all.as_slice(), &[("VOKKO_STREMIO_MAX_HEIGHT", "9000")]].concat()).is_err());
        assert!(parse(&[all.as_slice(), &[("VOKKO_STREMIO_FETCH_ALLOW", "10.0.0.0/33")]].concat()).is_err());
        let mut short = all.to_vec();
        short[5] = ("VOKKO_STREMIO_BOT_SECRET", "short");
        assert!(parse(&short).is_err());
        assert!(!format!("{config:?}").contains("0123456789abcdef"), "secrets stay out of Debug");
    }

    #[test]
    fn spotify_needs_every_key() {
        let all = [
            ("VOKKO_SPOTIFY_CLIENT_ID", "cid"),
            ("VOKKO_SPOTIFY_CLIENT_SECRET", "csecret"),
            ("VOKKO_SPOTIFY_BOT_URL", "http://host.internal:8721/"),
            ("VOKKO_SPOTIFY_BOT_SECRET", "0123456789abcdef"),
            ("VOKKO_MEDIA_LIVEKIT_URL", "wss://vokko-live.example/"),
            ("VOKKO_MEDIA_LIVEKIT_API_KEY", "mk"),
            ("VOKKO_MEDIA_LIVEKIT_API_SECRET", "ms"),
        ];
        let parse = |pairs: &[(&str, &str)]| super::parse_spotify(&DotEnv::from_pairs(pairs));
        let config = parse(&all).expect("valid").expect("on");
        assert_eq!(
            (config.media_url.as_str(), config.bot_url.as_str(), config.market.as_str()),
            ("wss://vokko-live.example", "http://host.internal:8721", "SE")
        );
        for skip in 0..all.len() {
            let partial: Vec<_> = all.iter().enumerate().filter(|(index, _)| *index != skip).map(|(_, pair)| *pair).collect();
            assert!(parse(&partial).expect("valid").is_none(), "without {}", all[skip].0);
        }
        let with = |extra: (&'static str, &'static str)| parse(&[all.as_slice(), &[extra]].concat());
        assert_eq!(with(("VOKKO_SPOTIFY_MARKET", "de")).expect("valid").expect("on").market, "DE");
        assert!(with(("VOKKO_SPOTIFY_MARKET", "SWE")).is_err());
        assert!(with(("VOKKO_SPOTIFY_IDLE_MIN", "0")).is_err());
        assert_eq!(with(("VOKKO_SPOTIFY_IDLE_MIN", "3")).expect("valid").expect("on").pause_timeout, std::time::Duration::from_secs(180));
        let mut short = all.to_vec();
        short[3] = ("VOKKO_SPOTIFY_BOT_SECRET", "short");
        assert!(parse(&short).is_err());
        let debug = format!("{config:?}");
        assert!(!debug.contains("0123456789abcdef") && !debug.contains("csecret") && !debug.contains("\"ms\""), "secrets stay out of Debug");
    }

    #[test]
    fn cidr_ranges() {
        use super::{Cidr, parse_cidr_list};
        let ip = |text: &str| text.parse::<std::net::IpAddr>().expect("ip");
        let net = Cidr::parse("10.1.0.0/16").expect("cidr");
        assert!(net.contains(ip("10.1.255.9")) && !net.contains(ip("10.2.0.1")) && !net.contains(ip("::1")));
        assert!(Cidr::parse("127.0.0.1").expect("cidr").contains(ip("127.0.0.1")));
        assert!(!Cidr::parse("127.0.0.1/32").expect("cidr").contains(ip("127.0.0.2")));
        assert!(Cidr::parse("10.0.0.0/13").expect("cidr").contains(ip("10.7.0.1")) && !Cidr::parse("10.0.0.0/13").expect("cidr").contains(ip("10.8.0.1")));
        assert!(Cidr::parse("fd00::/8").expect("cidr").contains(ip("fd12::1")));
        assert!(Cidr::parse("0.0.0.0/0").expect("cidr").contains(ip("8.8.8.8")));
        assert_eq!(parse_cidr_list(" 10.0.0.0/8 , ,127.0.0.1/32").map(|list| list.len()), Ok(2));
        for bad in ["x", "10.0.0.0/33", "10.0.0.0/", "::1/129"] {
            assert!(Cidr::parse(bad).is_err(), "{bad}");
        }
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
