//! Spotify in voice calls (docs/design/spotify-bot.md): people in a call search the public Spotify catalog and play tracks through
//! one server-wide "house" account in a native bot (`voice::spotify` holds the session). This module is the catalog side: the
//! browse routes, the id / URI / link rules and the state. The server only ever calls Spotify with a client-credentials token
//! (`webapi`), so nothing about the house account, or anybody's library or history, can pass through it.
pub mod bot;
pub mod queue;
pub mod webapi;

use std::collections::HashSet;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use vokko_protocol::api::{SpotifyAlbum, SpotifyAlbumSummary, SpotifyArtist, SpotifyPlaylist, SpotifyPlaylistSummary, SpotifySearchResults, SpotifyTrack};

use self::bot::Bot;
use self::webapi::{Catalog, CatalogError};
use crate::access;
use crate::acting::Actor;
use crate::config::SpotifyConfig;
use crate::error::{ApiErr, ApiResult};
use crate::extract::ApiQuery;
use crate::state::AppState;
use crate::store::{self, ChannelRow};
use crate::stremio::{http_url, limit, lock};
use crate::voice::livekit::{HttpRoomService, NoRoomService, RoomService};
use crate::voice::watch::hidden_char;

/// Longest title, artist or album name passed on from Spotify.
const TEXT_MAX_CHARS: usize = 200;
const SEARCH_OFFSET_MAX: u32 = 1000;
const PLAYLIST_OFFSET_MAX: u32 = 100_000;

/// Everything in memory: the clients, and the one session of `voice::spotify`.
pub struct Spotify {
    pub catalog: Option<Catalog>,
    pub bot: Option<Bot>,
    pub(crate) session: Mutex<Option<crate::voice::spotify::Session>>,
    /// The media LiveKit's RoomService (rooms are closed and listeners removed through it); a fake in tests.
    media_rooms: Mutex<Arc<dyn RoomService>>,
    seq: AtomicU64,
    /// `VOKKO_SPOTIFY_OWNER_ID` (0 = unset); tests set it once the owner has registered.
    owner: AtomicI64,
}

impl Spotify {
    pub fn new(config: &Option<SpotifyConfig>) -> Self {
        let media_rooms: Arc<dyn RoomService> =
            match config.as_ref().map(|c| HttpRoomService::new(&http_url(&c.media_url), &c.media_api_key, c.media_api_secret.expose())) {
                Some(Ok(rooms)) => Arc::new(rooms),
                Some(Err(error)) => {
                    tracing::warn!(%error, "spotify: no RoomService for the media LiveKit: listeners are not removed and rooms are not closed");
                    Arc::new(NoRoomService)
                }
                None => Arc::new(NoRoomService),
            };
        let owner = config.as_ref().and_then(|c| c.owner_id);
        if config.is_some() && owner.is_none() {
            tracing::warn!("spotify: VOKKO_SPOTIFY_OWNER_ID is not set, so Spotify plays nowhere and the catalog answers nobody");
        }
        Self {
            catalog: config.as_ref().map(Catalog::new),
            bot: config.as_ref().map(|c| Bot::new(&c.bot_url, &c.bot_secret, &c.market)),
            session: Mutex::default(),
            media_rooms: Mutex::new(media_rooms),
            seq: AtomicU64::new(1),
            owner: AtomicI64::new(owner.unwrap_or(0)),
        }
    }

    pub fn set_owner(&self, owner: Option<i64>) {
        self.owner.store(owner.unwrap_or(0), Ordering::Relaxed);
    }

    /// The house account's owner, if Spotify is configured with one.
    pub fn owner(&self) -> Option<i64> {
        Some(self.owner.load(Ordering::Relaxed)).filter(|id| *id > 0 && self.bot.is_some())
    }

    pub fn set_media_rooms(&self, rooms: Arc<dyn RoomService>) {
        *lock(&self.media_rooms) = rooms;
    }

    pub(crate) fn media_rooms(&self) -> Arc<dyn RoomService> {
        lock(&self.media_rooms).clone()
    }

    /// A number no earlier call returned: the `seq` of a change.
    pub(crate) fn next_seq(&self) -> u64 {
        self.seq.fetch_add(1, Ordering::Relaxed)
    }
}

pub struct Active<'a> {
    pub cfg: &'a SpotifyConfig,
    pub catalog: &'a Catalog,
    pub bot: &'a Bot,
}

/// The feature's configuration, or 404 (the routes do not exist without it).
pub(crate) fn active(state: &AppState) -> ApiResult<Active<'_>> {
    match (&state.config.spotify, &state.spotify.catalog, &state.spotify.bot) {
        (Some(cfg), Some(catalog), Some(bot)) => Ok(Active { cfg, catalog, bot }),
        _ => Err(ApiErr::new(StatusCode::NOT_FOUND, 10000, "Unknown")),
    }
}

// ---- where the house account may be used (docs/design/spotify-bot.md section 2.3) ----

/// In a guild's `features` where the house account plays: its owner is a member.
pub const FEATURE: &str = "VOKKO_SPOTIFY";

/// Startup: `VOKKO_SPOTIFY_OWNER_ID` must name an existing person (not a bot or webhook, which any guild admin could add, and
/// not a deleted account); otherwise it counts as unset (fail closed, also when the lookup fails).
pub async fn check_owner(state: &AppState) {
    let Some(owner) = state.spotify.owner() else { return };
    let person: Result<Option<(i64,)>, _> =
        sqlx::query_as("SELECT id FROM users WHERE id = $1 AND NOT bot AND deleted_at IS NULL").bind(owner).fetch_optional(&state.db).await;
    if !matches!(person, Ok(Some(_))) {
        state.spotify.set_owner(None);
        tracing::warn!("spotify: VOKKO_SPOTIFY_OWNER_ID is not an existing person's account, so Spotify plays nowhere");
    }
}

/// Whether the owner is a member of `guild_id`.
async fn owner_in_guild(state: &AppState, owner: i64, guild_id: i64) -> ApiResult<bool> {
    let row: Option<(i64,)> =
        sqlx::query_as("SELECT user_id FROM guild_members WHERE guild_id = $1 AND user_id = $2").bind(guild_id).bind(owner).fetch_optional(&state.db).await?;
    Ok(row.is_some())
}

/// Which of `guild_ids` carry `FEATURE`.
pub(crate) async fn guilds_with_feature(state: &AppState, guild_ids: &[i64]) -> ApiResult<HashSet<i64>> {
    let Some(owner) = state.spotify.owner() else { return Ok(HashSet::new()) };
    let rows: Vec<(i64,)> =
        sqlx::query_as("SELECT guild_id FROM guild_members WHERE user_id = $1 AND guild_id = ANY($2)").bind(owner).bind(guild_ids).fetch_all(&state.db).await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// Whether the house account may play in `row`: a guild channel of a guild the owner is a member of, or a DM / group DM call the
/// owner is in right now (anyone can DM the owner, so being a recipient is not enough).
pub(crate) async fn usable_in(state: &AppState, row: &ChannelRow) -> ApiResult<bool> {
    let Some(owner) = state.spotify.owner() else { return Ok(false) };
    if row.is_dm() {
        return Ok(crate::voice::state::in_channel(state, owner, row.id));
    }
    match row.guild_id {
        Some(guild_id) => owner_in_guild(state, owner, guild_id).await,
        None => Ok(false),
    }
}

/// 403 50013 unless the house account may play in `channel_id`.
pub(crate) async fn require_usable(state: &AppState, channel_id: i64) -> ApiResult<()> {
    let row = store::channel_row(state, channel_id).await?.ok_or_else(ApiErr::missing_permissions)?;
    if usable_in(state, &row).await? { Ok(()) } else { Err(ApiErr::missing_permissions()) }
}

/// The catalog shares one quota and one server-wide 429 pause, so it answers only the owner and people who share a guild with
/// them (a bot: the member it acts for, or itself without `X-Vokko-Acting-For`); else 403 50013.
async fn browsing(state: &AppState, user_id: i64) -> ApiResult<Active<'_>> {
    let active = active(state)?;
    let Some(owner) = state.spotify.owner() else { return Err(ApiErr::missing_permissions()) };
    if user_id != owner {
        let shared: Option<(i64,)> = sqlx::query_as(
            "SELECT a.guild_id FROM guild_members a JOIN guild_members b ON b.guild_id = a.guild_id WHERE a.user_id = $1 AND b.user_id = $2 LIMIT 1",
        )
        .bind(user_id)
        .bind(owner)
        .fetch_optional(&state.db)
        .await?;
        if shared.is_none() {
            return Err(ApiErr::missing_permissions());
        }
    }
    Ok(active)
}

/// The owner joined or left `guild_id`: its members get a GUILD_UPDATE (the feature flag changed), and a session that may no
/// longer play stops.
pub async fn membership_changed(state: &AppState, guild_id: i64, user_id: i64) {
    if state.spotify.owner() != Some(user_id) {
        return;
    }
    if let (Ok(Some(guild)), Ok(members)) = (store::guild(state, guild_id).await, access::guild_member_ids(state, guild_id).await) {
        state.hub.send(&members, &vokko_protocol::api::GatewayEvent::GuildUpdate(guild));
    }
    crate::voice::spotify::recheck(state).await;
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/spotify/search", get(search))
        .route("/spotify/albums/{id}", get(album))
        .route("/spotify/playlists/{id}", get(playlist))
        .route("/spotify/artists/{id}", get(artist))
        .route("/spotify/tracks/{id}", get(track))
}

// ---- ids, URIs, links, text ----

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Track,
    Album,
    Artist,
    Playlist,
}

impl Kind {
    fn parse(text: &str) -> Option<Self> {
        match text {
            "track" => Some(Self::Track),
            "album" => Some(Self::Album),
            "artist" => Some(Self::Artist),
            "playlist" => Some(Self::Playlist),
            _ => None,
        }
    }
}

/// 22 letters or digits.
pub fn valid_id(id: &str) -> bool {
    id.len() == 22 && id.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

/// `spotify:{track|album|artist|playlist}:{id}`.
pub fn parse_uri(text: &str) -> Option<(Kind, String)> {
    let rest = text.strip_prefix("spotify:")?;
    let (kind, id) = rest.split_once(':')?;
    valid_id(id).then(|| Kind::parse(kind).map(|kind| (kind, id.to_owned()))).flatten()
}

/// `https://open.spotify.com/(intl-xx/)?{type}/{id}` with an optional query or fragment, which is dropped.
pub fn parse_link(text: &str) -> Option<(Kind, String)> {
    let rest = text.strip_prefix("https://open.spotify.com/")?;
    let path = rest.split(['?', '#']).next()?;
    let mut parts = path.split('/');
    let mut first = parts.next()?;
    if first.strip_prefix("intl-").is_some_and(|code| (2..=5).contains(&code.len()) && code.bytes().all(|byte| byte.is_ascii_alphabetic() || byte == b'-')) {
        first = parts.next()?;
    }
    let (kind, id) = (Kind::parse(first)?, parts.next()?);
    (valid_id(id) && parts.next().is_none()).then(|| (kind, id.to_owned()))
}

/// A pasted link or URI of a pasteable kind; `Err` when it looks like one but is not valid.
fn pasted(text: &str) -> Result<Option<(Kind, String)>, ()> {
    if !text.starts_with("spotify:") && !text.contains("open.spotify.com") {
        return Ok(None);
    }
    parse_uri(text).or_else(|| parse_link(text)).map(Some).ok_or(())
}

/// A Spotify image URL reduced to its 40-hex id, if it is on one of the three hosts we trust (anything else is dropped).
pub fn art_id(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://")?;
    let (host, path) = rest.split_once('/')?;
    if !matches!(host, "i.scdn.co" | "image-cdn-ak.spotifycdn.com" | "image-cdn-fa.spotifycdn.com") {
        return None;
    }
    let id = path.strip_prefix("image/")?.split(['?', '#']).next()?;
    valid_art_id(id).then(|| id.to_owned())
}

/// A cover id: 40 lowercase hex digits.
pub fn valid_art_id(id: &str) -> bool {
    id.len() == 40 && id.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Text from Spotify: control and invisible characters removed, cut to 200 characters.
pub fn clean(text: &str) -> String {
    text.chars().filter(|c| !hidden_char(*c)).collect::<String>().trim().chars().take(TEXT_MAX_CHARS).collect()
}

fn check_id(id: &str) -> ApiResult<()> {
    if valid_id(id) { Ok(()) } else { Err(ApiErr::invalid("id", "Must be a Spotify id (22 letters or digits).")) }
}

pub(crate) fn catalog_error(error: CatalogError) -> ApiErr {
    match error {
        CatalogError::NotFound => ApiErr::new_unknown("Unknown Spotify item", 10200),
        CatalogError::RateLimited(wait) => ApiErr::rate_limited(wait.as_secs_f64().ceil().max(1.0)),
        CatalogError::Unavailable => ApiErr::conflict(40033, "Spotify could not be reached."),
    }
}

fn browse_limit(state: &AppState, user_id: i64) -> ApiResult<()> {
    limit(state, "spotify-browse", user_id, 10.0, 2.0)
}

// ---- playlist and artist pages: the Web API gives the header, the bot the tracks ----

/// A playlist page. The header (name, owner, art) is Spotify's; the tracks and the length are the bot's, because a client-credentials
/// token gets none. With no header (Spotify-owned playlists are 404 for it) the bot's name stands, owned by "Spotify", without art.
pub(crate) async fn playlist_page(active: &Active<'_>, id: &str, offset: u32) -> Result<SpotifyPlaylist, CatalogError> {
    let head = active.catalog.playlist_head(id).await?;
    let page = active.bot.playlist(id, offset).await?;
    let (name, owner_name, art) = match head {
        Some(head) => (head.name, head.owner_name, head.art),
        // The bot reads with the house account, which can see private playlists the Web API hides: only Spotify's own are shown.
        None if page.spotify_owned => (page.name, "Spotify".to_owned(), None),
        None => return Err(CatalogError::NotFound),
    };
    Ok(SpotifyPlaylist { id: id.to_owned(), name, owner_name, art, total: page.total, tracks: page.tracks })
}

/// An artist page. Top tracks come from the bot; if it cannot give them the page shows its albums without them.
async fn artist_page(active: &Active<'_>, id: &str) -> Result<SpotifyArtist, CatalogError> {
    let head = active.catalog.artist_head(id).await?;
    let albums = active.catalog.artist_albums(id).await?;
    let top_tracks = active.bot.top_tracks(id).await.unwrap_or_default();
    Ok(SpotifyArtist { id: head.id, name: head.name, art: head.art, top_tracks, albums })
}

// ---- browse routes ----

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
    #[serde(default, rename = "type")]
    kinds: Option<String>,
    #[serde(default)]
    offset: Option<u32>,
}

fn album_summary(album: SpotifyAlbum) -> SpotifyAlbumSummary {
    SpotifyAlbumSummary { id: album.id, name: album.name, artists: album.artists, art: album.art, year: album.year }
}

fn playlist_summary(playlist: SpotifyPlaylist) -> SpotifyPlaylistSummary {
    SpotifyPlaylistSummary { id: playlist.id, name: playlist.name, owner_name: playlist.owner_name, art: playlist.art }
}

async fn search(State(state): State<AppState>, Actor { user_id, .. }: Actor, ApiQuery(query): ApiQuery<SearchQuery>) -> ApiResult<Json<SpotifySearchResults>> {
    let active = browsing(&state, user_id).await?;
    let q = query.q.trim();
    if !(1..=100).contains(&q.chars().count()) || q.chars().any(hidden_char) {
        return Err(ApiErr::invalid("q", "Must be 1 to 100 characters, without control or invisible characters."));
    }
    let mut kinds: Vec<&str> = Vec::new();
    for kind in query.kinds.as_deref().unwrap_or("track,album,artist,playlist").split(',') {
        if Kind::parse(kind).is_none() {
            return Err(ApiErr::invalid("type", "Must be a comma list of track, album, artist and playlist."));
        }
        if !kinds.contains(&kind) {
            kinds.push(kind);
        }
    }
    let offset = query.offset.unwrap_or(0);
    if offset > SEARCH_OFFSET_MAX {
        return Err(ApiErr::invalid("offset", &format!("Must be at most {SEARCH_OFFSET_MAX}.")));
    }
    let pasted = pasted(q).map_err(|()| ApiErr::invalid("q", "That is not a Spotify link."))?;
    browse_limit(&state, user_id)?;
    let catalog = active.catalog;
    let Some((kind, id)) = pasted else {
        return Ok(Json(catalog.search(q, &kinds.join(","), offset).await.map_err(catalog_error)?));
    };
    // A pasted link is one direct lookup, whatever `type` says.
    let mut results = SpotifySearchResults::default();
    match kind {
        Kind::Track => results.tracks.push(catalog.track(&id).await.map_err(catalog_error)?),
        Kind::Album => results.albums.push(album_summary(catalog.album(&id).await.map_err(catalog_error)?)),
        Kind::Artist => results.artists.push(catalog.artist_head(&id).await.map_err(catalog_error)?),
        Kind::Playlist => results.playlists.push(playlist_summary(playlist_page(&active, &id, 0).await.map_err(catalog_error)?)),
    }
    Ok(Json(results))
}

async fn album(State(state): State<AppState>, Actor { user_id, .. }: Actor, Path(id): Path<String>) -> ApiResult<Json<SpotifyAlbum>> {
    let active = browsing(&state, user_id).await?;
    check_id(&id)?;
    browse_limit(&state, user_id)?;
    Ok(Json(active.catalog.album(&id).await.map_err(catalog_error)?))
}

#[derive(Deserialize)]
struct PageQuery {
    #[serde(default)]
    offset: Option<u32>,
}

async fn playlist(
    State(state): State<AppState>,
    Actor { user_id, .. }: Actor,
    Path(id): Path<String>,
    ApiQuery(query): ApiQuery<PageQuery>,
) -> ApiResult<Json<SpotifyPlaylist>> {
    let active = browsing(&state, user_id).await?;
    check_id(&id)?;
    let offset = query.offset.unwrap_or(0);
    if offset > PLAYLIST_OFFSET_MAX {
        return Err(ApiErr::invalid("offset", &format!("Must be at most {PLAYLIST_OFFSET_MAX}.")));
    }
    browse_limit(&state, user_id)?;
    Ok(Json(playlist_page(&active, &id, offset).await.map_err(catalog_error)?))
}

async fn artist(State(state): State<AppState>, Actor { user_id, .. }: Actor, Path(id): Path<String>) -> ApiResult<Json<SpotifyArtist>> {
    let active = browsing(&state, user_id).await?;
    check_id(&id)?;
    browse_limit(&state, user_id)?;
    Ok(Json(artist_page(&active, &id).await.map_err(catalog_error)?))
}

async fn track(State(state): State<AppState>, Actor { user_id, .. }: Actor, Path(id): Path<String>) -> ApiResult<Json<SpotifyTrack>> {
    let active = browsing(&state, user_id).await?;
    check_id(&id)?;
    browse_limit(&state, user_id)?;
    Ok(Json(active.catalog.track(&id).await.map_err(catalog_error)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "4uLU6hMCjMI75M1A2tKUQC";

    #[test]
    fn ids_uris_and_links() {
        assert!(valid_id(ID) && !valid_id("short") && !valid_id(&format!("{ID}x")) && !valid_id("4uLU6hMCjMI75M1A2tKU!C"));
        assert_eq!(parse_uri(&format!("spotify:track:{ID}")), Some((Kind::Track, ID.to_owned())));
        assert_eq!(parse_uri(&format!("spotify:playlist:{ID}")), Some((Kind::Playlist, ID.to_owned())));
        for bad in [
            format!("spotify:user:{ID}"),
            format!("spotify:track:{ID}:x"),
            "spotify:track:".to_owned(),
            format!("Spotify:track:{ID}"),
            format!(" spotify:track:{ID}"),
        ] {
            assert_eq!(parse_uri(&bad), None, "{bad}");
        }
        let link = |tail: &str| parse_link(&format!("https://open.spotify.com/{tail}"));
        assert_eq!(link(&format!("album/{ID}")), Some((Kind::Album, ID.to_owned())));
        assert_eq!(link(&format!("album/{ID}?si=abc#x")), Some((Kind::Album, ID.to_owned())), "the query is dropped");
        assert_eq!(link(&format!("intl-sv/artist/{ID}")), Some((Kind::Artist, ID.to_owned())));
        for bad in [format!("track/{ID}/x"), format!("user/{ID}"), "track/short".to_owned(), format!("intl-sv/{ID}"), format!("embed/track/{ID}")] {
            assert_eq!(link(&bad), None, "{bad}");
        }
        assert_eq!(parse_link(&format!("http://open.spotify.com/track/{ID}")), None, "https only");
        assert_eq!(parse_link(&format!("https://open.spotify.com.evil.example/track/{ID}")), None);
        assert_eq!(pasted("daft punk"), Ok(None));
        assert!(pasted("https://open.spotify.com/track/x").is_err() && pasted(&format!("spotify:me:{ID}")).is_err());
    }

    #[test]
    fn art_is_reduced_to_a_known_host_and_a_hex_id() {
        let hex = "ab67616d00001e02".to_owned() + &"0f".repeat(12);
        assert_eq!(hex.len(), 40);
        for host in ["i.scdn.co", "image-cdn-ak.spotifycdn.com", "image-cdn-fa.spotifycdn.com"] {
            assert_eq!(art_id(&format!("https://{host}/image/{hex}")), Some(hex.clone()));
        }
        assert_eq!(art_id(&format!("https://i.scdn.co/image/{hex}?x=1")), Some(hex.clone()));
        for bad in [
            format!("http://i.scdn.co/image/{hex}"),
            format!("https://evil.example/image/{hex}"),
            format!("https://i.scdn.co.evil.example/image/{hex}"),
            format!("https://mosaic.scdn.co/image/{hex}"),
            format!("https://i.scdn.co/image/{}", hex.to_uppercase()),
            "https://i.scdn.co/image/abc".to_owned(),
            format!("https://i.scdn.co/other/{hex}"),
        ] {
            assert_eq!(art_id(&bad), None, "{bad}");
        }
    }

    #[test]
    fn text_is_cleaned_and_cut() {
        assert_eq!(clean("  Hi\u{202e}\n there\u{200b} "), "Hi there");
        assert_eq!(clean(&"é".repeat(300)).chars().count(), TEXT_MAX_CHARS);
    }
}
