//! The server's side of the Spotify bot's internal API (docs/api.md "Bot contract"): `PUT` and `DELETE` on `/session` with the
//! bearer secret. A plain client, like Stremio's: the bot lives on the host (`http://host.internal:8721`), which an SSRF-guarded
//! client would refuse. The bot has one session at most, so the channel travels in the body.
use std::time::Duration;

use serde::Serialize;

use crate::crypto::Secret;
pub use crate::stremio::bot::{BotError, secrets_match};

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

#[derive(Clone)]
pub struct Bot {
    client: reqwest::Client,
    base: String,
    secret: Secret,
}

impl Bot {
    pub fn new(base: &str, secret: &Secret) -> Self {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default();
        Self { client, base: base.trim_end_matches('/').to_owned(), secret: secret.clone() }
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
