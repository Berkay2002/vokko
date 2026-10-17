//! The server's side of the bot's internal API (tools/stremio-bot, docs/design/stremio-bot.md section 3.3): `PUT` and `DELETE`
//! on `/sessions` with the bearer secret. The client is deliberately a plain one: the bot lives on the host
//! (`http://host.internal:8720`), which the SSRF-guarded client used for Stremio would refuse.
use std::collections::BTreeMap;
use std::time::Duration;

use serde::Serialize;

use crate::crypto::Secret;

/// What one session should be doing; the bot compares it with what it is doing and reconciles. Holds secrets (LiveKit token, media
/// URL), so it has no `Debug`.
#[derive(Serialize)]
pub struct Desired {
    pub livekit_url: String,
    pub token: String,
    pub media_url: String,
    pub headers: BTreeMap<String, String>,
    pub position_ms: u64,
    pub playing: bool,
    pub max_height: u32,
    /// kbit/s.
    pub bitrate: u32,
    /// Changes with every item; the bot echoes it in its `tracks` event so a late report of an older item is ignored.
    pub generation: u64,
    /// The audio stream index to play; `None` lets the bot pick (the default one).
    pub audio: Option<u32>,
    /// The bitmap subtitle stream index to burn in, if any.
    pub burned_subtitle: Option<u32>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum BotError {
    /// The bot is at its session limit (503).
    Busy,
    /// The bot refused the request (a 4xx).
    Rejected(u16),
    /// Not reachable, or answered with a server error.
    Down,
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
            tracing::warn!("stremio bot: request failed ({})", if error.is_timeout() { "timeout" } else { "connection" });
            BotError::Down
        })?;
        match response.status().as_u16() {
            200..=299 => Ok(()),
            503 => Err(BotError::Busy),
            status @ 400..=499 => Err(BotError::Rejected(status)),
            _ => Err(BotError::Down),
        }
    }

    pub async fn put(&self, channel_id: i64, desired: &Desired) -> Result<(), BotError> {
        self.send(self.client.put(format!("{}/sessions/{channel_id}", self.base)).json(desired)).await
    }

    pub async fn delete(&self, channel_id: i64) -> Result<(), BotError> {
        self.send(self.client.delete(format!("{}/sessions/{channel_id}", self.base))).await
    }

    pub async fn delete_all(&self) -> Result<(), BotError> {
        self.send(self.client.delete(format!("{}/sessions", self.base))).await
    }
}

/// Constant time on equal lengths; the length of the secret is not a secret.
pub fn secrets_match(given: &[u8], expected: &[u8]) -> bool {
    given.len() == expected.len() && given.iter().zip(expected).fold(0_u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_compare() {
        assert!(secrets_match(b"0123456789abcdef", b"0123456789abcdef"));
        assert!(!secrets_match(b"0123456789abcdeg", b"0123456789abcdef"));
        assert!(!secrets_match(b"short", b"0123456789abcdef") && !secrets_match(b"", b"0123456789abcdef"));
    }
}
