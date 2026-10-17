//! Stremio in voice calls (docs/design/stremio-bot.md): each user links their own Stremio account, searches Cinemeta, lists the
//! streams their installed addons offer and plays one in a call (`voice::stremio`). The server holds every secret (authKeys, addon
//! URLs, stream URLs); clients only see titles, labels and an opaque `sid` bound to the user who listed it.
pub mod addons;
pub mod bot;
pub mod client;
pub mod fetch;
pub mod rank;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Deserialize;
use time::OffsetDateTime;
use vokko_protocol::api::{
    StremioAccountStatus, StremioLinkPoll, StremioLinkStart, StremioLoginRequest, StremioMeta, StremioStream, StremioStreamList, StremioTitle,
};

use self::addons::{Addon, valid_kind, valid_title_id, valid_video_id};
use self::bot::Bot;
use self::client::{Account, AccountError};
use self::fetch::{FetchError, Fetcher};
use self::rank::{Candidate, Source};
use crate::auth::AuthUser;
use crate::config::StremioConfig;
use crate::crypto::Secret;
use crate::error::{ApiErr, ApiResult};
use crate::extract::{ApiJson, ApiQuery};
use crate::state::AppState;
use crate::store::iso;
use crate::voice::livekit::{HttpRoomService, NoRoomService, RoomService};

/// How long a listed stream's `sid` stays valid.
const SID_TTL: Duration = Duration::from_secs(30 * 60);
/// Most `sid`s one user holds at once; the oldest go first.
const SIDS_PER_USER: usize = 600;
/// A pending link code (Stremio's own codes live about this long).
const LINK_TTL: Duration = Duration::from_secs(5 * 60);
const ADDONS_TTL: Duration = Duration::from_secs(5 * 60);
const META_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_METAS_CACHED: usize = 500;

/// The outbound clients; they exist only when the feature is configured.
pub struct Clients {
    pub fetcher: Fetcher,
    pub account: Account,
    pub bot: Bot,
}

/// A stream the user listed, kept until it expires.
#[derive(Clone)]
pub struct Listed {
    pub user_id: i64,
    pub candidate: Candidate,
    pub info: TitleInfo,
    created: Instant,
}

/// How a title shows in the call (the `item` of the session state).
#[derive(Clone, Debug)]
pub struct TitleInfo {
    pub title: String,
    pub subtitle: Option<String>,
    pub poster: Option<String>,
    /// `(type, video id)` as the addons know it, for asking them about subtitles.
    pub video: Option<(String, String)>,
}

/// A subtitle file an addon offered to `user_id` for the item `generation` of `channel_id`; its URL never leaves the server.
#[derive(Clone)]
pub(crate) struct ListedSub {
    pub user_id: i64,
    pub channel_id: i64,
    pub generation: u64,
    pub url: Secret,
    created: Instant,
}

/// A cached value and when it was fetched.
/// `wss://host` -> `https://host`, `ws://host` -> `http://host`.
pub(crate) fn http_url(url: &str) -> String {
    url.replacen("wss://", "https://", 1).replacen("ws://", "http://", 1)
}

type Cached<T> = (Instant, Arc<T>);

struct Pending {
    code: String,
    expires: Instant,
}

/// Everything in memory: stream ids, link codes, caches, and the sessions of `voice::stremio`.
pub struct Stremio {
    pub clients: Option<Clients>,
    listed: Mutex<HashMap<String, Listed>>,
    pending: Mutex<HashMap<i64, Pending>>,
    addons: Mutex<HashMap<i64, Cached<Vec<Addon>>>>,
    metas: Mutex<HashMap<String, Cached<StremioMeta>>>,
    subs: Mutex<HashMap<String, ListedSub>>,
    pub(crate) sessions: Mutex<HashMap<i64, crate::voice::stremio::Session>>,
    /// The media LiveKit's RoomService (rooms are closed and viewers removed through it); a fake in tests.
    media_rooms: Mutex<Arc<dyn RoomService>>,
    generation: AtomicU64,
}

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Stremio {
    pub fn new(config: &Option<StremioConfig>) -> Self {
        let clients = config.as_ref().map(|config| {
            let fetcher = Fetcher::new(config.fetch_allow.clone());
            Clients { account: Account::new(fetcher.clone(), &config.api_url, &config.link_url), bot: Bot::new(&config.bot_url, &config.bot_secret), fetcher }
        });
        // The server reaches the media LiveKit the way viewers do (its signalling port also serves the RoomService API).
        let media_rooms: Arc<dyn RoomService> =
            match config.as_ref().map(|c| HttpRoomService::new(&http_url(&c.media_url), &c.media_api_key, c.media_api_secret.expose())) {
                Some(Ok(rooms)) => Arc::new(rooms),
                Some(Err(error)) => {
                    tracing::warn!(%error, "no RoomService for the media LiveKit: viewers are not removed and rooms are not closed");
                    Arc::new(NoRoomService)
                }
                None => Arc::new(NoRoomService),
            };
        Self {
            clients,
            media_rooms: Mutex::new(media_rooms),
            listed: Mutex::default(),
            pending: Mutex::default(),
            addons: Mutex::default(),
            metas: Mutex::default(),
            subs: Mutex::default(),
            sessions: Mutex::default(),
            generation: AtomicU64::new(1),
        }
    }

    pub fn set_media_rooms(&self, rooms: Arc<dyn RoomService>) {
        *lock(&self.media_rooms) = rooms;
    }

    pub(crate) fn media_rooms(&self) -> Arc<dyn RoomService> {
        lock(&self.media_rooms).clone()
    }

    pub(crate) fn next_generation(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::Relaxed)
    }

    /// Remembers the streams `user_id` just listed and returns their `sid`s in order.
    fn remember(&self, user_id: i64, items: Vec<(Candidate, TitleInfo)>) -> Vec<String> {
        let now = Instant::now();
        let mut listed = lock(&self.listed);
        listed.retain(|_, entry| now.duration_since(entry.created) < SID_TTL);
        let mut mine: Vec<(Instant, String)> =
            listed.iter().filter(|(_, entry)| entry.user_id == user_id).map(|(sid, entry)| (entry.created, sid.clone())).collect();
        mine.sort();
        let excess = (mine.len() + items.len()).saturating_sub(SIDS_PER_USER);
        for (_, sid) in mine.into_iter().take(excess) {
            listed.remove(&sid);
        }
        items
            .into_iter()
            .map(|(candidate, info)| {
                let mut bytes = [0_u8; 16];
                rand::fill(&mut bytes);
                let sid = URL_SAFE_NO_PAD.encode(bytes);
                listed.insert(sid.clone(), Listed { user_id, candidate, info, created: now });
                sid
            })
            .collect()
    }

    /// The stream behind `sid`, only for the user who listed it.
    pub(crate) fn listed(&self, sid: &str, user_id: i64) -> Option<Listed> {
        lock(&self.listed).get(sid).filter(|entry| entry.user_id == user_id && entry.created.elapsed() < SID_TTL).cloned()
    }

    /// Remembers the subtitle files `user_id` was just offered for item `generation` of `channel_id`; returns their `sid`s in order.
    pub(crate) fn remember_subs(&self, user_id: i64, channel_id: i64, generation: u64, urls: Vec<Secret>) -> Vec<String> {
        let now = Instant::now();
        let mut subs = lock(&self.subs);
        subs.retain(|_, entry| now.duration_since(entry.created) < SID_TTL);
        let mut mine: Vec<(Instant, String)> =
            subs.iter().filter(|(_, entry)| entry.user_id == user_id).map(|(sid, entry)| (entry.created, sid.clone())).collect();
        mine.sort();
        let excess = (mine.len() + urls.len()).saturating_sub(SIDS_PER_USER);
        for (_, sid) in mine.into_iter().take(excess) {
            subs.remove(&sid);
        }
        urls.into_iter()
            .map(|url| {
                let mut bytes = [0_u8; 16];
                rand::fill(&mut bytes);
                let sid = URL_SAFE_NO_PAD.encode(bytes);
                subs.insert(sid.clone(), ListedSub { user_id, channel_id, generation, url, created: now });
                sid
            })
            .collect()
    }

    /// The subtitle file behind `sid`, only for the user it was offered to, in the channel and for the item it was offered for.
    pub(crate) fn listed_sub(&self, sid: &str, user_id: i64, channel_id: i64, generation: u64) -> Option<ListedSub> {
        let entry = lock(&self.subs).get(sid).cloned()?;
        (entry.user_id == user_id && entry.channel_id == channel_id && entry.generation == generation && entry.created.elapsed() < SID_TTL).then_some(entry)
    }

    /// A user unlinked or relinked: their cached addons and listed streams go.
    fn forget(&self, user_id: i64) {
        lock(&self.addons).remove(&user_id);
        lock(&self.listed).retain(|_, entry| entry.user_id != user_id);
        lock(&self.subs).retain(|_, entry| entry.user_id != user_id);
        lock(&self.pending).remove(&user_id);
    }
}

pub struct Active<'a> {
    pub cfg: &'a StremioConfig,
    pub clients: &'a Clients,
}

/// The feature's configuration, or 404 (the routes do not exist without it).
pub(crate) fn active(state: &AppState) -> ApiResult<Active<'_>> {
    match (&state.config.stremio, &state.stremio.clients) {
        (Some(cfg), Some(clients)) => Ok(Active { cfg, clients }),
        _ => Err(ApiErr::new(StatusCode::NOT_FOUND, 10000, "Unknown")),
    }
}

pub(crate) fn limit(state: &AppState, key: &str, user_id: i64, burst: f64, per_second: f64) -> ApiResult<()> {
    if state.config.rate_limit.is_none() {
        return Ok(());
    }
    state.limiter.check_key(key, user_id, burst, per_second).map_err(ApiErr::rate_limited)
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/users/@me/stremio", get(status).delete(unlink))
        .route("/users/@me/stremio/link", post(link_start))
        .route("/users/@me/stremio/link/poll", post(link_poll))
        .route("/users/@me/stremio/login", post(login))
        .route("/stremio/search", get(search))
        .route("/stremio/catalog", get(browse))
        .route("/stremio/meta/{kind}/{id}", get(meta))
        .route("/stremio/streams/{kind}/{video_id}", get(streams))
}

// ---- the linked account ----

fn aad(user_id: i64) -> Vec<u8> {
    format!("stremio:{user_id}").into_bytes()
}

async fn load_key(state: &AppState, active: &Active<'_>, user_id: i64) -> ApiResult<Option<(Secret, OffsetDateTime)>> {
    let row: Option<(Vec<u8>, OffsetDateTime)> =
        sqlx::query_as("SELECT auth_key_enc, linked_at FROM stremio_accounts WHERE user_id = $1").bind(user_id).fetch_optional(&state.db).await?;
    let Some((sealed, linked_at)) = row else { return Ok(None) };
    let opened = active.cfg.secrets_key.open(&aad(user_id), &sealed).and_then(|bytes| String::from_utf8(bytes).ok());
    if opened.is_none() {
        tracing::warn!("stremio: the stored key of user {user_id} does not open (VOKKO_SECRETS_KEY changed?); treating the account as unlinked");
    }
    Ok(opened.map(|key| (Secret::new(key), linked_at)))
}

async fn store_key(state: &AppState, active: &Active<'_>, user_id: i64, key: &Secret) -> ApiResult<()> {
    let sealed = active.cfg.secrets_key.seal(&aad(user_id), key.expose().as_bytes()).ok_or_else(ApiErr::internal)?;
    sqlx::query(
        "INSERT INTO stremio_accounts (user_id, auth_key_enc) VALUES ($1, $2) \
         ON CONFLICT (user_id) DO UPDATE SET auth_key_enc = EXCLUDED.auth_key_enc, key_version = 1, linked_at = now(), last_used_at = NULL",
    )
    .bind(user_id)
    .bind(sealed)
    .execute(&state.db)
    .await?;
    state.stremio.forget(user_id);
    Ok(())
}

/// Stremio says the key is dead: forget it, so the UI asks for a new link.
async fn drop_key(state: &AppState, user_id: i64) {
    let _ = sqlx::query("DELETE FROM stremio_accounts WHERE user_id = $1").bind(user_id).execute(&state.db).await;
    state.stremio.forget(user_id);
}

fn account_error(error: AccountError) -> ApiErr {
    match error {
        AccountError::Rejected => ApiErr::invalid("account", "Stremio did not accept that."),
        AccountError::SessionGone => ApiErr::missing_permissions(),
        AccountError::Unavailable => ApiErr::conflict(40033, "Stremio could not be reached."),
    }
}

async fn status(State(state): State<AppState>, AuthUser(user_id): AuthUser) -> ApiResult<Json<StremioAccountStatus>> {
    let active = active(&state)?;
    let linked = load_key(&state, &active, user_id).await?;
    Ok(Json(StremioAccountStatus { linked: linked.is_some(), linked_at: linked.map(|(_, at)| iso(at)) }))
}

async fn link_start(State(state): State<AppState>, AuthUser(user_id): AuthUser) -> ApiResult<Json<StremioLinkStart>> {
    let active = active(&state)?;
    limit(&state, "stremio-link", user_id, 5.0, 5.0 / 3600.0)?;
    let (code, link) = active.clients.account.link_create().await.map_err(account_error)?;
    lock(&state.stremio.pending).insert(user_id, Pending { code: code.clone(), expires: Instant::now() + LINK_TTL });
    Ok(Json(StremioLinkStart { code, link, expires_at: iso(OffsetDateTime::now_utc() + LINK_TTL) }))
}

async fn link_poll(State(state): State<AppState>, AuthUser(user_id): AuthUser) -> ApiResult<Json<StremioLinkPoll>> {
    let active = active(&state)?;
    limit(&state, "stremio-poll", user_id, 5.0, 0.5)?;
    let code = {
        let mut pending = lock(&state.stremio.pending);
        match pending.get(&user_id) {
            Some(entry) if entry.expires > Instant::now() => entry.code.clone(),
            Some(_) => {
                pending.remove(&user_id);
                return Err(ApiErr::conflict(40033, "The link code expired."));
            }
            None => return Err(ApiErr::conflict(40033, "No link is waiting for approval.")),
        }
    };
    let Some(key) = active.clients.account.link_read(&code).await.map_err(account_error)? else { return Ok(Json(StremioLinkPoll { linked: false })) };
    active.clients.account.check(&key).await.map_err(account_error)?;
    store_key(&state, &active, user_id, &key).await?;
    Ok(Json(StremioLinkPoll { linked: true }))
}

async fn login(State(state): State<AppState>, AuthUser(user_id): AuthUser, ApiJson(body): ApiJson<StremioLoginRequest>) -> ApiResult<StatusCode> {
    let active = active(&state)?;
    limit(&state, "stremio-link", user_id, 5.0, 5.0 / 3600.0)?;
    if body.email.trim().is_empty() || body.email.len() > 320 || body.password.is_empty() || body.password.len() > 1024 {
        return Err(ApiErr::invalid("email", "Enter the email and password of your Stremio account."));
    }
    // The password goes to Stremio in this one request; only the authKey it returns is kept.
    let key = active.clients.account.login(body.email.trim(), &body.password).await.map_err(account_error)?;
    store_key(&state, &active, user_id, &key).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn unlink(State(state): State<AppState>, AuthUser(user_id): AuthUser) -> ApiResult<StatusCode> {
    let active = active(&state)?;
    if let Some((key, _)) = load_key(&state, &active, user_id).await? {
        let account = active.clients.account.clone();
        tokio::spawn(async move {
            let _ = account.logout(&key).await;
        });
    }
    drop_key(&state, user_id).await;
    crate::voice::stremio::drop_queued_by(&state, user_id).await;
    Ok(StatusCode::NO_CONTENT)
}

// ---- browsing ----

fn browse_error(error: FetchError) -> ApiErr {
    tracing::info!("stremio: Cinemeta call failed: {error:?}");
    ApiErr::conflict(40033, "Stremio's catalog could not be reached.")
}

fn check_kind(kind: &str) -> ApiResult<()> {
    if valid_kind(kind) { Ok(()) } else { Err(ApiErr::invalid("type", "Must be movie or series.")) }
}

#[derive(Deserialize)]
struct SearchQuery {
    #[serde(rename = "type")]
    kind: String,
    q: String,
}

async fn search(State(state): State<AppState>, AuthUser(user_id): AuthUser, ApiQuery(query): ApiQuery<SearchQuery>) -> ApiResult<Json<Vec<StremioTitle>>> {
    let active = active(&state)?;
    check_kind(&query.kind)?;
    let text = rank::clean_text(&query.q, " ", 1000);
    if text.chars().count() != query.q.trim().chars().count() || !(1..=100).contains(&text.chars().count()) {
        return Err(ApiErr::invalid("q", "Must be 1 to 100 characters, without control characters."));
    }
    limit(&state, "stremio-browse", user_id, 10.0, 2.0)?;
    let titles = addons::catalog(&active.clients.fetcher, &active.cfg.cinemeta_url, &query.kind, Some(format!("search={text}"))).await.map_err(browse_error)?;
    Ok(Json(titles))
}

#[derive(Deserialize)]
struct BrowseQuery {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    genre: Option<String>,
    #[serde(default)]
    skip: Option<u32>,
}

async fn browse(State(state): State<AppState>, AuthUser(user_id): AuthUser, ApiQuery(query): ApiQuery<BrowseQuery>) -> ApiResult<Json<Vec<StremioTitle>>> {
    let active = active(&state)?;
    check_kind(&query.kind)?;
    let genre = query.genre.as_deref().map(str::trim).filter(|genre| !genre.is_empty());
    if genre.is_some_and(|genre| genre.len() > 30 || !genre.chars().all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '-')) {
        return Err(ApiErr::invalid("genre", "Must be letters, digits, spaces or hyphens (at most 30)."));
    }
    if query.skip.is_some_and(|skip| skip > 10_000) {
        return Err(ApiErr::invalid("skip", "Must be at most 10000."));
    }
    limit(&state, "stremio-browse", user_id, 10.0, 2.0)?;
    let mut extra: Vec<String> = genre.map(|genre| format!("genre={genre}")).into_iter().collect();
    extra.extend(query.skip.filter(|skip| *skip > 0).map(|skip| format!("skip={skip}")));
    let extra = (!extra.is_empty()).then(|| extra.join("&"));
    let titles = addons::catalog(&active.clients.fetcher, &active.cfg.cinemeta_url, &query.kind, extra).await.map_err(browse_error)?;
    Ok(Json(titles))
}

/// Cinemeta's meta of a title, cached for ten minutes (the title page and the stream list both need it).
async fn cached_meta(state: &AppState, active: &Active<'_>, kind: &str, id: &str) -> Result<Arc<StremioMeta>, FetchError> {
    let key = format!("{kind}/{id}");
    if let Some((at, meta)) = lock(&state.stremio.metas).get(&key)
        && at.elapsed() < META_TTL
    {
        return Ok(meta.clone());
    }
    let meta = Arc::new(addons::meta(&active.clients.fetcher, &active.cfg.cinemeta_url, kind, id).await?);
    let mut metas = lock(&state.stremio.metas);
    if metas.len() >= MAX_METAS_CACHED {
        metas.retain(|_, (at, _)| at.elapsed() < META_TTL);
        if metas.len() >= MAX_METAS_CACHED {
            metas.clear();
        }
    }
    metas.insert(key, (Instant::now(), meta.clone()));
    Ok(meta)
}

async fn meta(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path((kind, id)): Path<(String, String)>) -> ApiResult<Json<StremioMeta>> {
    let active = active(&state)?;
    check_kind(&kind)?;
    if !valid_title_id(&id) {
        return Err(ApiErr::invalid("id", "Must be an IMDb id like tt0111161."));
    }
    limit(&state, "stremio-browse", user_id, 10.0, 2.0)?;
    let meta = cached_meta(&state, &active, &kind, &id).await.map_err(browse_error)?;
    Ok(Json((*meta).clone()))
}

/// The title and, for an episode, `S1E2 · Name`, as shown on the tile.
fn title_info(kind: &str, video_id: &str, meta: Option<&StremioMeta>) -> TitleInfo {
    let video = Some((kind.to_owned(), video_id.to_owned()));
    let Some(meta) = meta else { return TitleInfo { title: video_id.to_owned(), subtitle: None, poster: None, video } };
    let subtitle = meta.videos.iter().find(|video| video.id == video_id).map(|video| format!("S{}E{} · {}", video.season, video.episode, video.name));
    TitleInfo { title: meta.name.clone(), subtitle, poster: meta.poster.clone(), video }
}

pub(crate) async fn user_addons(state: &AppState, active: &Active<'_>, user_id: i64) -> ApiResult<Arc<Vec<Addon>>> {
    if let Some((at, addons)) = lock(&state.stremio.addons).get(&user_id)
        && at.elapsed() < ADDONS_TTL
    {
        return Ok(addons.clone());
    }
    let Some((key, _)) = load_key(state, active, user_id).await? else { return Err(ApiErr::missing_permissions()) };
    match active.clients.account.addons(&key).await {
        Ok(addons) => {
            let addons = Arc::new(addons);
            lock(&state.stremio.addons).insert(user_id, (Instant::now(), addons.clone()));
            let _ = sqlx::query("UPDATE stremio_accounts SET last_used_at = now() WHERE user_id = $1").bind(user_id).execute(&state.db).await;
            Ok(addons)
        }
        Err(AccountError::SessionGone) => {
            drop_key(state, user_id).await;
            Err(ApiErr::missing_permissions())
        }
        Err(error) => Err(account_error(error)),
    }
}

async fn streams(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path((kind, video_id)): Path<(String, String)>,
) -> ApiResult<Json<StremioStreamList>> {
    let active = active(&state)?;
    check_kind(&kind)?;
    if !valid_video_id(&video_id) {
        return Err(ApiErr::invalid("video_id", "Must be an IMDb id like tt0111161, or tt0903747:1:2 for an episode."));
    }
    limit(&state, "stremio-streams", user_id, 5.0, 1.0 / 3.0)?;
    let addons = user_addons(&state, &active, user_id).await?;
    let title_id = video_id.split(':').next().unwrap_or_default();
    let ((mut found, failed), meta) =
        tokio::join!(addons::fetch_streams(&active.clients.fetcher, &addons, &kind, &video_id), cached_meta(&state, &active, &kind, title_id));
    rank::rank(&mut found, active.cfg.max_height, kind == "series");
    let info = title_info(&kind, &video_id, meta.ok().as_deref());
    let sids = state.stremio.remember(user_id, found.iter().map(|candidate| (candidate.clone(), info.clone())).collect());
    let streams = found
        .into_iter()
        .zip(sids)
        .map(|(candidate, sid)| StremioStream {
            sid,
            addon: candidate.addon.clone(),
            playable: candidate.playable(),
            unsupported: match candidate.source {
                Source::Unsupported(kind) => Some(kind.to_owned()),
                Source::Url { .. } => None,
            },
            label: candidate.label,
            details: candidate.details,
            size_bytes: candidate.size_bytes,
            resolution: candidate.resolution,
            flags: candidate.flags.iter().map(|flag| (*flag).to_owned()).collect(),
        })
        .collect();
    Ok(Json(StremioStreamList { streams, addon_errors: failed }))
}
