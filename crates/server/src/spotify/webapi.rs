//! The server's Spotify Web API client (docs/design/spotify-bot.md section 2.4 and 9.2). It uses a client-credentials token of
//! the "Vokko catalog" app, so there is no user behind it and nothing of the house account can come back. The only requests it can
//! build are the variants of [`Call`]; `Call::path` is the one place a path is made, and a test checks every variant against
//! the allow-list. Everything that leaves this module is already reduced: protocol types with cleaned text and 40-hex art ids.
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use vokko_protocol::api::{SpotifyAlbum, SpotifyAlbumSummary, SpotifyArtistSummary, SpotifyPlaylistSummary, SpotifySearchResults, SpotifyTrack};

use super::{art_id, clean, valid_id};
use crate::config::SpotifyConfig;
use crate::crypto::Secret;
use crate::stremio::lock;

const SEARCH_TTL: Duration = Duration::from_secs(2 * 60);
const ITEM_TTL: Duration = Duration::from_secs(10 * 60);
/// Cache entries per kind; search keys are user text, so the cache is bounded (when full, expired entries go, then everything).
const CACHE_MAX: usize = 500;
/// Longest pause a `Retry-After` can cause.
const PAUSE_MAX: Duration = Duration::from_secs(5 * 60);
const BODY_MAX: u64 = 4 * 1024 * 1024;
const SEARCH_PAGE: u32 = 10;
/// Searched albums an artist page lists.
const ARTIST_ALBUMS: u32 = 20;

#[derive(Debug, PartialEq, Eq)]
pub enum CatalogError {
    /// Spotify does not know the id (or refused the shape of the request).
    NotFound,
    /// Spotify asked us to wait this long.
    RateLimited(Duration),
    /// Not reachable, a server error, or a token we cannot get.
    Unavailable,
}

/// The only requests this client can make: five catalog paths, with their variants.
enum Call<'a> {
    Search {
        q: &'a str,
        types: &'a str,
        offset: u32,
    },
    Album(&'a str),
    /// The header only: the Web API gives a client-credentials token no tracks (the bot reads them, `bot::Bot::playlist`).
    Playlist(&'a str),
    Artist(&'a str),
    ArtistAlbums(&'a str),
    Track(&'a str),
}

impl Call<'_> {
    /// The URL path, or `None` for an id that is not a Spotify id.
    fn path(&self) -> Option<String> {
        let with = |kind: &str, id: &str, tail: &str| valid_id(id).then(|| format!("/v1/{kind}/{id}{tail}"));
        match self {
            Self::Search { .. } => Some("/v1/search".to_owned()),
            Self::Album(id) => with("albums", id, ""),
            Self::Playlist(id) => with("playlists", id, ""),
            Self::Artist(id) => with("artists", id, ""),
            Self::ArtistAlbums(id) => with("artists", id, "/albums"),
            Self::Track(id) => with("tracks", id, ""),
        }
    }

    fn params(&self, market: &str) -> Vec<(&'static str, String)> {
        let mut params = vec![("market", market.to_owned())];
        match self {
            Self::Search { q, types, offset } => {
                params.extend([("q", (*q).to_owned()), ("type", (*types).to_owned()), ("limit", SEARCH_PAGE.to_string()), ("offset", offset.to_string())]);
            }
            Self::Playlist(_) => params.push(("fields", "name,owner(id,display_name),images,tracks.total".to_owned())),
            Self::ArtistAlbums(_) => params.extend([("include_groups", "album,single".to_owned()), ("limit", ARTIST_ALBUMS.to_string())]),
            _ => {}
        }
        params
    }
}

/// Whether `path` is one of the catalog paths (the allow-list the tests check against).
pub fn allowed_path(path: &str) -> bool {
    let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    match parts.as_slice() {
        ["v1", "search"] => true,
        ["v1", "albums" | "playlists" | "artists" | "tracks", id] => valid_id(id),
        ["v1", "artists", id, "albums"] => valid_id(id),
        _ => false,
    }
}

pub(crate) struct Cache<T> {
    ttl: Duration,
    entries: Mutex<HashMap<String, (Instant, T)>>,
}

impl<T: Clone> Cache<T> {
    pub(crate) fn new(ttl: Duration) -> Self {
        Self { ttl, entries: Mutex::default() }
    }

    pub(crate) fn get(&self, key: &str) -> Option<T> {
        lock(&self.entries).get(key).filter(|(at, _)| at.elapsed() < self.ttl).map(|(_, value)| value.clone())
    }

    pub(crate) fn put(&self, key: String, value: T) {
        let mut entries = lock(&self.entries);
        if entries.len() >= CACHE_MAX {
            entries.retain(|_, (at, _)| at.elapsed() < self.ttl);
        }
        if entries.len() >= CACHE_MAX {
            entries.clear();
        }
        entries.insert(key, (Instant::now(), value));
    }
}

pub struct Catalog {
    client: reqwest::Client,
    api_url: String,
    accounts_url: String,
    client_id: String,
    client_secret: Secret,
    market: String,
    token: Mutex<Option<(String, Instant)>>,
    /// A Spotify 429 pauses every catalog call until then.
    paused_until: Mutex<Option<Instant>>,
    searches: Cache<SpotifySearchResults>,
    albums: Cache<SpotifyAlbum>,
    /// `None`: no header (Spotify-owned playlists are 404 for this token).
    playlists: Cache<Option<SpotifyPlaylistSummary>>,
    artists: Cache<SpotifyArtistSummary>,
    artist_albums: Cache<Vec<SpotifyAlbumSummary>>,
    tracks: Cache<SpotifyTrack>,
}

// ---- Spotify's JSON, as far as we read it ----

#[derive(Deserialize, Default)]
struct Image {
    url: Option<String>,
    width: Option<u32>,
}

#[derive(Deserialize, Default)]
struct Named {
    name: Option<String>,
}

#[derive(Deserialize, Default)]
struct Owner {
    id: Option<String>,
    display_name: Option<String>,
}

#[derive(Deserialize, Default)]
struct Page<T> {
    #[serde(default = "Vec::new")]
    items: Vec<Option<T>>,
}

#[derive(Deserialize, Default)]
struct AlbumRef {
    name: Option<String>,
    #[serde(default)]
    images: Vec<Image>,
}

#[derive(Deserialize, Default)]
struct ApiTrack {
    id: Option<String>,
    name: Option<String>,
    #[serde(default)]
    artists: Vec<Named>,
    album: Option<AlbumRef>,
    duration_ms: Option<u64>,
    explicit: Option<bool>,
    is_playable: Option<bool>,
    is_local: Option<bool>,
    #[serde(rename = "type")]
    kind: Option<String>,
}

#[derive(Deserialize, Default)]
struct ApiAlbum {
    id: Option<String>,
    name: Option<String>,
    #[serde(default)]
    artists: Vec<Named>,
    #[serde(default)]
    images: Vec<Image>,
    release_date: Option<String>,
    tracks: Option<Page<ApiTrack>>,
}

#[derive(Deserialize, Default)]
struct ApiArtist {
    id: Option<String>,
    name: Option<String>,
    #[serde(default)]
    images: Vec<Image>,
}

#[derive(Deserialize, Default)]
struct ApiPlaylist {
    id: Option<String>,
    name: Option<String>,
    owner: Option<Owner>,
    #[serde(default)]
    images: Vec<Image>,
}

#[derive(Deserialize, Default)]
struct SearchBody {
    tracks: Option<Page<ApiTrack>>,
    albums: Option<Page<ApiAlbum>>,
    artists: Option<Page<ApiArtist>>,
    playlists: Option<Page<ApiPlaylist>>,
}

#[derive(Deserialize)]
struct TokenBody {
    access_token: String,
    expires_in: Option<u64>,
}

// ---- reduction to protocol types ----

/// The image closest to 300 px wide whose host we trust, as a 40-hex id.
fn pick_art(images: &[Image]) -> Option<String> {
    let mut sorted: Vec<&Image> = images.iter().collect();
    sorted.sort_by_key(|image| image.width.map_or(u32::MAX, |width| width.abs_diff(300)));
    sorted.into_iter().find_map(|image| image.url.as_deref().and_then(art_id))
}

fn names(list: &[Named]) -> Vec<String> {
    list.iter().filter_map(|named| named.name.as_deref()).map(clean).filter(|name| !name.is_empty()).collect()
}

fn year(date: Option<&str>) -> Option<String> {
    let year = date?.get(..4)?;
    year.bytes().all(|byte| byte.is_ascii_digit()).then(|| year.to_owned())
}

/// A playable track; `fallback` is the album it came from when Spotify left it out (album pages list simplified tracks).
fn track_of(raw: ApiTrack, fallback: Option<(&str, Option<&str>)>) -> Option<SpotifyTrack> {
    let id = raw.id.filter(|id| valid_id(id))?;
    if raw.is_local == Some(true) || raw.is_playable == Some(false) || raw.kind.as_deref().is_some_and(|kind| kind != "track") {
        return None;
    }
    let title = clean(raw.name.as_deref()?);
    let (album, art) = match raw.album {
        Some(album) => (album.name.as_deref().map(clean).filter(|name| !name.is_empty()), pick_art(&album.images)),
        None => (fallback.map(|(name, _)| clean(name)), fallback.and_then(|(_, art)| art).map(str::to_owned)),
    };
    Some(SpotifyTrack {
        uri: format!("spotify:track:{id}"),
        title: if title.is_empty() { "Untitled".to_owned() } else { title },
        artists: names(&raw.artists),
        album,
        art,
        duration_ms: raw.duration_ms.unwrap_or(0),
        explicit: raw.explicit.unwrap_or(false),
    })
}

fn album_summary(raw: ApiAlbum) -> Option<SpotifyAlbumSummary> {
    let id = raw.id.filter(|id| valid_id(id))?;
    Some(SpotifyAlbumSummary {
        id,
        name: clean(raw.name.as_deref()?),
        artists: names(&raw.artists),
        art: pick_art(&raw.images),
        year: year(raw.release_date.as_deref()),
    })
}

fn artist_summary(raw: ApiArtist) -> Option<SpotifyArtistSummary> {
    let id = raw.id.filter(|id| valid_id(id))?;
    Some(SpotifyArtistSummary { id, name: clean(raw.name.as_deref()?), art: pick_art(&raw.images) })
}

/// `None` for Spotify's own editorial playlists: a new app gets 404 for them.
fn playlist_summary(raw: ApiPlaylist) -> Option<SpotifyPlaylistSummary> {
    let id = raw.id.filter(|id| valid_id(id))?;
    let owner = raw.owner.unwrap_or_default();
    if owner.id.as_deref() == Some("spotify") {
        return None;
    }
    Some(SpotifyPlaylistSummary {
        id,
        name: clean(raw.name.as_deref()?),
        owner_name: owner.display_name.as_deref().map(clean).filter(|name| !name.is_empty()).unwrap_or_else(|| "Unknown".to_owned()),
        art: pick_art(&raw.images),
    })
}

/// One more attempt when `send` fails (a timeout, or a refused or dropped connection): a single network stall shouldn't fail the
/// request. An HTTP answer, whatever its status, is returned as is.
async fn send_twice(request: reqwest::RequestBuilder, what: &str) -> Result<reqwest::Response, CatalogError> {
    for _ in 0..2 {
        let Some(attempt) = request.try_clone() else { break };
        match attempt.send().await {
            Ok(response) => return Ok(response),
            Err(error) => tracing::warn!("spotify: {what} failed ({})", if error.is_timeout() { "timeout" } else { "connection" }),
        }
    }
    Err(CatalogError::Unavailable)
}

impl Catalog {
    pub fn new(cfg: &SpotifyConfig) -> Self {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(3))
            .timeout(cfg.request_timeout)
            .build()
            .unwrap_or_default();
        Self {
            client,
            api_url: cfg.api_url.trim_end_matches('/').to_owned(),
            accounts_url: cfg.accounts_url.trim_end_matches('/').to_owned(),
            client_id: cfg.client_id.clone(),
            client_secret: cfg.client_secret.clone(),
            market: cfg.market.clone(),
            token: Mutex::default(),
            paused_until: Mutex::default(),
            searches: Cache::new(SEARCH_TTL),
            albums: Cache::new(ITEM_TTL),
            playlists: Cache::new(ITEM_TTL),
            artists: Cache::new(ITEM_TTL),
            artist_albums: Cache::new(ITEM_TTL),
            tracks: Cache::new(ITEM_TTL),
        }
    }

    fn check_paused(&self) -> Result<(), CatalogError> {
        let mut paused = lock(&self.paused_until);
        match *paused {
            Some(until) if until > Instant::now() => Err(CatalogError::RateLimited(until - Instant::now())),
            Some(_) => {
                *paused = None;
                Ok(())
            }
            None => Ok(()),
        }
    }

    fn pause(&self, response: &reqwest::Response) -> CatalogError {
        let wait = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().parse::<u64>().ok())
            .map_or(Duration::from_secs(30), Duration::from_secs)
            .clamp(Duration::from_secs(1), PAUSE_MAX);
        *lock(&self.paused_until) = Some(Instant::now() + wait);
        CatalogError::RateLimited(wait)
    }

    /// A client-credentials token, cached until a minute before it expires. Neither it nor the secret is ever logged.
    async fn token(&self) -> Result<String, CatalogError> {
        if let Some((token, _)) = lock(&self.token).as_ref().filter(|(_, expires)| *expires > Instant::now()) {
            return Ok(token.clone());
        }
        let basic = STANDARD.encode(format!("{}:{}", self.client_id, self.client_secret.expose()));
        let request = self
            .client
            .post(format!("{}/api/token", self.accounts_url))
            .header(reqwest::header::AUTHORIZATION, format!("Basic {basic}"))
            .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body("grant_type=client_credentials");
        let response = send_twice(request, "the token request").await?;
        if response.status().as_u16() == 429 {
            return Err(self.pause(&response));
        }
        if !response.status().is_success() {
            tracing::warn!("spotify: the token request answered {}", response.status().as_u16());
            return Err(CatalogError::Unavailable);
        }
        let body: TokenBody = response.json().await.map_err(|_| CatalogError::Unavailable)?;
        let expires = Instant::now() + Duration::from_secs(body.expires_in.unwrap_or(3600).saturating_sub(60).max(30));
        *lock(&self.token) = Some((body.access_token.clone(), expires));
        Ok(body.access_token)
    }

    async fn get<T: DeserializeOwned>(&self, call: Call<'_>) -> Result<T, CatalogError> {
        let path = call.path().ok_or(CatalogError::NotFound)?;
        debug_assert!(allowed_path(&path));
        let params = call.params(&self.market);
        let url = reqwest::Url::parse_with_params(&format!("{}{path}", self.api_url), &params).map_err(|_| CatalogError::Unavailable)?;
        for attempt in 0..2 {
            self.check_paused()?;
            let token = self.token().await?;
            let response = send_twice(self.client.get(url.clone()).bearer_auth(&token), "a catalog request").await?;
            match response.status().as_u16() {
                200..=299 => {
                    if response.content_length().is_some_and(|length| length > BODY_MAX) {
                        return Err(CatalogError::Unavailable);
                    }
                    // Chunk by chunk with a running cap: a chunked answer has no length to check up front.
                    let mut response = response;
                    let mut bytes = Vec::new();
                    while let Some(chunk) = response.chunk().await.map_err(|_| CatalogError::Unavailable)? {
                        if (bytes.len() + chunk.len()) as u64 > BODY_MAX {
                            return Err(CatalogError::Unavailable);
                        }
                        bytes.extend_from_slice(&chunk);
                    }
                    return serde_json::from_slice(&bytes).map_err(|_| CatalogError::Unavailable);
                }
                // The token was revoked or expired early: get a new one once.
                401 if attempt == 0 => *lock(&self.token) = None,
                429 => return Err(self.pause(&response)),
                400 | 404 => return Err(CatalogError::NotFound),
                _ => return Err(CatalogError::Unavailable),
            }
        }
        Err(CatalogError::Unavailable)
    }

    pub async fn track(&self, id: &str) -> Result<SpotifyTrack, CatalogError> {
        if let Some(hit) = self.tracks.get(id) {
            return Ok(hit);
        }
        let raw: ApiTrack = self.get(Call::Track(id)).await?;
        let track = track_of(raw, None).ok_or(CatalogError::NotFound)?;
        self.tracks.put(id.to_owned(), track.clone());
        Ok(track)
    }

    pub async fn album(&self, id: &str) -> Result<SpotifyAlbum, CatalogError> {
        if let Some(hit) = self.albums.get(id) {
            return Ok(hit);
        }
        // shortcut: the album's own response lists at most its first 50 tracks, which is every album that matters; page it if one is longer.
        let raw: ApiAlbum = self.get(Call::Album(id)).await?;
        let art = pick_art(&raw.images);
        let name = clean(raw.name.as_deref().ok_or(CatalogError::NotFound)?);
        let tracks = raw
            .tracks
            .map(|page| page.items)
            .unwrap_or_default()
            .into_iter()
            .flatten()
            .filter_map(|track| track_of(track, Some((&name, art.as_deref()))))
            .collect();
        let album = SpotifyAlbum { id: id.to_owned(), artists: names(&raw.artists), year: year(raw.release_date.as_deref()), art, name, tracks };
        self.albums.put(id.to_owned(), album.clone());
        Ok(album)
    }

    /// The playlist's name, owner and art. `None` when Spotify has no header for it (a Spotify-owned playlist, or one the token cannot
    /// read); the caller then still has the bot's tracks.
    pub async fn playlist_head(&self, id: &str) -> Result<Option<SpotifyPlaylistSummary>, CatalogError> {
        if let Some(hit) = self.playlists.get(id) {
            return Ok(hit);
        }
        let head = match self.get::<ApiPlaylist>(Call::Playlist(id)).await {
            Ok(meta) => playlist_summary(ApiPlaylist { id: Some(id.to_owned()), ..meta }),
            Err(CatalogError::NotFound) => None,
            Err(error) => return Err(error),
        };
        self.playlists.put(id.to_owned(), head.clone());
        Ok(head)
    }

    pub async fn artist_head(&self, id: &str) -> Result<SpotifyArtistSummary, CatalogError> {
        if let Some(hit) = self.artists.get(id) {
            return Ok(hit);
        }
        let raw: ApiArtist = self.get(Call::Artist(id)).await?;
        let head = artist_summary(ApiArtist { id: Some(id.to_owned()), ..raw }).ok_or(CatalogError::NotFound)?;
        self.artists.put(id.to_owned(), head.clone());
        Ok(head)
    }

    pub async fn artist_albums(&self, id: &str) -> Result<Vec<SpotifyAlbumSummary>, CatalogError> {
        if let Some(hit) = self.artist_albums.get(id) {
            return Ok(hit);
        }
        let albums: Page<ApiAlbum> = self.get(Call::ArtistAlbums(id)).await?;
        let albums: Vec<SpotifyAlbumSummary> = albums.items.into_iter().flatten().filter_map(album_summary).collect();
        self.artist_albums.put(id.to_owned(), albums.clone());
        Ok(albums)
    }

    /// `types` is a comma list of `track,album,artist,playlist`, already checked by the caller.
    pub async fn search(&self, q: &str, types: &str, offset: u32) -> Result<SpotifySearchResults, CatalogError> {
        let key = format!("{types}\n{offset}\n{q}");
        if let Some(hit) = self.searches.get(&key) {
            return Ok(hit);
        }
        let body: SearchBody = self.get(Call::Search { q, types, offset }).await?;
        fn page<T>(page: Option<Page<T>>) -> Vec<T> {
            page.map(|page| page.items).unwrap_or_default().into_iter().flatten().collect()
        }
        let results = SpotifySearchResults {
            tracks: page(body.tracks).into_iter().filter_map(|track| track_of(track, None)).collect(),
            albums: page(body.albums).into_iter().filter_map(album_summary).collect(),
            artists: page(body.artists).into_iter().filter_map(artist_summary).collect(),
            playlists: page(body.playlists).into_iter().filter_map(playlist_summary).collect(),
        };
        self.searches.put(key, results.clone());
        Ok(results)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "4uLU6hMCjMI75M1A2tKUQC";

    #[test]
    fn every_call_builds_an_allowed_path() {
        let calls = [
            Call::Search { q: "me", types: "track", offset: 0 },
            Call::Album(ID),
            Call::Playlist(ID),
            Call::Artist(ID),
            Call::ArtistAlbums(ID),
            Call::Track(ID),
        ];
        for call in calls {
            let path = call.path().expect("valid id");
            assert!(allowed_path(&path), "{path}");
            assert!(!path.contains("/me") || path == "/v1/search", "{path}");
        }
        assert!(Call::Album("../me").path().is_none() && Call::Track("short").path().is_none());
        for bad in [
            "/v1/playlists/4uLU6hMCjMI75M1A2tKUQC/tracks",
            "/v1/artists/4uLU6hMCjMI75M1A2tKUQC/top-tracks",
            "/v1/me",
            "/v1/me/tracks",
            "/v1/me/player",
            "/v1/users/x/playlists",
            "/v1/recommendations",
            "/v1/albums/../me",
            "/v1/tracks",
        ] {
            assert!(!allowed_path(bad), "{bad}");
        }
    }

    #[test]
    fn tracks_are_reduced() {
        let raw = |value: serde_json::Value| serde_json::from_value::<ApiTrack>(value).expect("track");
        let good = raw(serde_json::json!({
            "id": ID, "name": "Song\u{202e}x", "artists": [{"name": "A"}], "duration_ms": 1000, "explicit": true,
            "album": {"name": "Alb", "images": [
                {"url": format!("https://i.scdn.co/image/{}", "a".repeat(40)), "width": 640},
                {"url": format!("https://evil.example/image/{}", "b".repeat(40)), "width": 300}
            ]}
        }));
        let track = track_of(good, None).expect("playable");
        assert_eq!((track.uri.as_str(), track.title.as_str(), track.explicit), (format!("spotify:track:{ID}").as_str(), "Songx", true));
        assert!(track.art.is_some_and(|art| art.len() == 40), "the trusted host wins over the closer size");
        for bad in [
            serde_json::json!({"id": ID, "name": "x", "is_playable": false}),
            serde_json::json!({"id": ID, "name": "x", "is_local": true}),
            serde_json::json!({"id": ID, "name": "x", "type": "episode"}),
            serde_json::json!({"id": "nope", "name": "x"}),
            serde_json::json!({"name": "x"}),
        ] {
            assert!(track_of(raw(bad), None).is_none());
        }
        let owner = |id: &str| {
            serde_json::from_value::<ApiPlaylist>(serde_json::json!({"id": ID, "name": "P", "owner": {"id": id, "display_name": "Ann"}})).expect("playlist")
        };
        assert!(playlist_summary(owner("spotify")).is_none() && playlist_summary(owner("ann")).is_some());
    }
}
