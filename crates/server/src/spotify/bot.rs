//! The server's side of the Spotify bot's internal API (docs/api.md "Bot contract"): `PUT` and `DELETE` on `/session` with the
//! bearer secret. A plain client, like Stremio's: the bot lives on the host (`http://host.internal:8721`), which an SSRF-guarded
//! client would refuse. The bot has one session at most, so the channel travels in the body.
use std::time::Duration;

use serde::{Deserialize, Serialize};
use vokko_protocol::api::SpotifyTrack;

use super::webapi::{Cache, CatalogError};
use super::{Kind, clean, parse_uri, valid_art_id, valid_id};
use crate::crypto::Secret;
pub use crate::stremio::bot::{BotError, secrets_match};

const READ_TTL: Duration = Duration::from_secs(10 * 60);
const BODY_MAX: usize = 4 * 1024 * 1024;
/// Tracks the server takes from one bot answer (a page is 100).
const PAGE_MAX: usize = 100;

/// What the bot should be doing. Holds the room token, so it has no `Debug`.
#[derive(Serialize)]
pub struct Desired {
    pub channel_id: String,
    pub livekit_url: String,
    pub token: String,
    pub track: String,
    /// What plays after this track (gapless preload); absent when nothing follows.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<String>,
    pub position_ms: u64,
    pub playing: bool,
    pub seq: u64,
}

/// One page of a playlist as the bot read it (`GET /catalog/playlists/{id}`): its name, the whole length, the tracks of that page.
#[derive(Clone)]
pub struct BotPlaylist {
    pub name: String,
    pub total: u32,
    pub tracks: Vec<SpotifyTrack>,
}

/// The bot's JSON is untrusted like Spotify's: it is reduced again here (ids, text, the art id) before anything is stored or shown.
#[derive(Deserialize, Default)]
struct RawTrack {
    uri: Option<String>,
    title: Option<String>,
    #[serde(default)]
    artists: Vec<String>,
    album: Option<String>,
    art: Option<String>,
    duration_ms: Option<u64>,
    explicit: Option<bool>,
}

#[derive(Deserialize, Default)]
struct RawPlaylist {
    name: Option<String>,
    total: Option<u32>,
    #[serde(default)]
    tracks: Vec<RawTrack>,
}

#[derive(Deserialize, Default)]
struct RawTop {
    #[serde(default)]
    tracks: Vec<RawTrack>,
}

fn reduce(raw: RawTrack) -> Option<SpotifyTrack> {
    let (kind, id) = parse_uri(raw.uri.as_deref()?)?;
    if kind != Kind::Track {
        return None;
    }
    let title = clean(raw.title.as_deref().unwrap_or(""));
    Some(SpotifyTrack {
        uri: format!("spotify:track:{id}"),
        title: if title.is_empty() { "Untitled".to_owned() } else { title },
        artists: raw.artists.iter().map(|name| clean(name)).filter(|name| !name.is_empty()).collect(),
        album: raw.album.as_deref().map(clean).filter(|name| !name.is_empty()),
        art: raw.art.filter(|art| valid_art_id(art)),
        duration_ms: raw.duration_ms.unwrap_or(0),
        explicit: raw.explicit.unwrap_or(false),
    })
}

#[derive(Clone)]
pub struct Bot {
    client: reqwest::Client,
    base: String,
    secret: Secret,
    market: String,
    playlists: std::sync::Arc<Cache<BotPlaylist>>,
    top_tracks: std::sync::Arc<Cache<Vec<SpotifyTrack>>>,
}

impl Bot {
    pub fn new(base: &str, secret: &Secret, market: &str) -> Self {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default();
        Self {
            client,
            base: base.trim_end_matches('/').to_owned(),
            secret: secret.clone(),
            market: market.to_owned(),
            playlists: std::sync::Arc::new(Cache::new(READ_TTL)),
            top_tracks: std::sync::Arc::new(Cache::new(READ_TTL)),
        }
    }

    /// `GET {bot}/catalog/...` (docs/api.md "Bot contract"): the two reads the Web API refuses a client-credentials token. A 404 is an
    /// id Spotify does not know; every other failure (down, busy, `auth`) is "unavailable".
    async fn read<T: serde::de::DeserializeOwned>(&self, path: String) -> Result<T, CatalogError> {
        let response = self.client.get(format!("{}{path}", self.base)).bearer_auth(self.secret.expose()).send().await.map_err(|error| {
            tracing::warn!("spotify bot: a catalog read failed ({})", if error.is_timeout() { "timeout" } else { "connection" });
            CatalogError::Unavailable
        })?;
        match response.status().as_u16() {
            200..=299 => {}
            404 => return Err(CatalogError::NotFound),
            status => {
                tracing::warn!("spotify bot: a catalog read answered {status}");
                return Err(CatalogError::Unavailable);
            }
        }
        if response.content_length().is_some_and(|length| length > BODY_MAX as u64) {
            return Err(CatalogError::Unavailable);
        }
        // Read chunk by chunk and stop at the cap: a chunked answer has no length to check up front.
        let mut response = response;
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| CatalogError::Unavailable)? {
            if bytes.len() + chunk.len() > BODY_MAX {
                return Err(CatalogError::Unavailable);
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| CatalogError::Unavailable)
    }

    /// The tracks of a playlist, 100 from `offset`.
    pub async fn playlist(&self, id: &str, offset: u32) -> Result<BotPlaylist, CatalogError> {
        if !valid_id(id) {
            return Err(CatalogError::NotFound);
        }
        let key = format!("{id}:{offset}");
        if let Some(hit) = self.playlists.get(&key) {
            return Ok(hit);
        }
        let raw: RawPlaylist = self.read(format!("/catalog/playlists/{id}?offset={offset}&limit={PAGE_MAX}")).await?;
        let tracks: Vec<SpotifyTrack> = raw.tracks.into_iter().filter_map(reduce).take(PAGE_MAX).collect();
        let playlist = BotPlaylist { name: clean(raw.name.as_deref().unwrap_or("")), total: raw.total.unwrap_or(0), tracks };
        self.playlists.put(key, playlist.clone());
        Ok(playlist)
    }

    pub async fn top_tracks(&self, id: &str) -> Result<Vec<SpotifyTrack>, CatalogError> {
        if !valid_id(id) {
            return Err(CatalogError::NotFound);
        }
        if let Some(hit) = self.top_tracks.get(id) {
            return Ok(hit);
        }
        let raw: RawTop = self.read(format!("/catalog/artists/{id}/top-tracks?market={}", self.market)).await?;
        let tracks: Vec<SpotifyTrack> = raw.tracks.into_iter().filter_map(reduce).take(PAGE_MAX).collect();
        self.top_tracks.put(id.to_owned(), tracks.clone());
        Ok(tracks)
    }

    async fn send(&self, request: reqwest::RequestBuilder) -> Result<(), BotError> {
        let response = request.bearer_auth(self.secret.expose()).send().await.map_err(|error| {
            // Never the URL: reqwest errors can carry it.
            tracing::warn!("spotify bot: request failed ({})", if error.is_timeout() { "timeout" } else { "connection" });
            BotError::Down
        })?;
        match response.status().as_u16() {
            200..=299 => Ok(()),
            503 => Err(BotError::Busy),
            status @ 400..=499 => Err(BotError::Rejected(status)),
            _ => Err(BotError::Down),
        }
    }

    pub async fn put(&self, desired: &Desired) -> Result<(), BotError> {
        self.send(self.client.put(format!("{}/session", self.base)).json(desired)).await
    }

    pub async fn delete(&self) -> Result<(), BotError> {
        self.send(self.client.delete(format!("{}/session", self.base))).await
    }
}
