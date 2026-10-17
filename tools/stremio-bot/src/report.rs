//! Events to the server: `POST {server}/internal/stremio/bot` with the bearer secret.

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Started,
    Position,
    Ended,
    Error,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Started => "started",
            Kind::Position => "position",
            Kind::Ended => "ended",
            Kind::Error => "error",
        }
    }
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Event<'a> {
    pub channel_id: &'a str,
    pub event: &'a str,
    pub position_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<&'a str>,
}

#[derive(Clone)]
pub struct Reporter {
    client: reqwest::Client,
    url: Arc<str>,
    secret: Arc<str>,
}

impl Reporter {
    pub fn new(server_url: &str, secret: &str) -> Self {
        let client = reqwest::Client::builder().timeout(Duration::from_secs(5)).build().unwrap_or_default();
        Self { client, url: format!("{server_url}/internal/stremio/bot").into(), secret: secret.into() }
    }

    /// Fire and forget. Everything but `position` is retried a few times, because the server only learns of the end
    /// of a movie from here.
    pub fn send(&self, channel_id: &str, kind: Kind, position_ms: u64, duration_ms: Option<u64>, message: Option<String>) {
        let this = self.clone();
        let channel_id = channel_id.to_owned();
        tokio::spawn(async move {
            let body = Event { channel_id: &channel_id, event: kind.name(), position_ms, duration_ms, message: message.as_deref() };
            let attempts = if kind == Kind::Position { 1 } else { 4 };
            for attempt in 1..=attempts {
                match this.client.post(this.url.as_ref()).bearer_auth(this.secret.as_ref()).json(&body).send().await {
                    Ok(r) if r.status().is_success() => return,
                    Ok(r) => tracing::warn!(channel_id, event = kind.name(), status = %r.status(), "server rejected event"),
                    Err(e) => tracing::warn!(channel_id, event = kind.name(), error = %e.without_url(), "event not delivered"),
                }
                if attempt < attempts {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_json_shape() {
        let e = Event { channel_id: "42", event: Kind::Position.name(), position_ms: 5000, duration_ms: None, message: None };
        assert_eq!(serde_json::to_string(&e).expect("json"), r#"{"channel_id":"42","event":"position","position_ms":5000}"#);
        let e = Event { channel_id: "42", event: Kind::Error.name(), position_ms: 1, duration_ms: Some(9), message: Some("boom") };
        assert_eq!(
            serde_json::to_string(&e).expect("json"),
            r#"{"channel_id":"42","event":"error","position_ms":1,"duration_ms":9,"message":"boom"}"#
        );
    }
}
