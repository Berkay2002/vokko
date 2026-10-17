//! Events to the server: `POST {server}/internal/spotify/bot` with the bearer secret. One task sends them in order, because the
//! server needs `ended {track}` before `started {next}` to advance its queue.

use std::time::Duration;

use serde::Serialize;
use tokio::sync::mpsc;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Started,
    Position,
    Ended,
    Error,
}

/// `kicked` is in the server's list but has no cause: the bot is not a Connect device, so another device playing does not end the session (Phase 0).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Reason {
    Unavailable,
    Auth,
    Io,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Event {
    pub channel_id: String,
    pub event: Kind,
    pub track: String,
    pub position_ms: u64,
    pub seq: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<Reason>,
}

#[derive(Clone)]
pub struct Reporter {
    tx: mpsc::UnboundedSender<Event>,
}

impl Reporter {
    pub fn new(server_url: &str, secret: &str) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let client = reqwest::Client::builder().timeout(Duration::from_secs(5)).build().unwrap_or_default();
        tokio::spawn(deliver(client, format!("{server_url}/internal/spotify/bot"), secret.to_owned(), rx));
        Self { tx }
    }

    pub fn send(&self, event: Event) {
        let _ = self.tx.send(event);
    }
}

/// Everything but `position` is retried a few times: the server only learns of the end of a track from here.
async fn deliver(client: reqwest::Client, url: String, secret: String, mut rx: mpsc::UnboundedReceiver<Event>) {
    while let Some(event) = rx.recv().await {
        let attempts = if event.event == Kind::Position { 1 } else { 4 };
        for attempt in 1..=attempts {
            match client.post(&url).bearer_auth(&secret).json(&event).send().await {
                Ok(r) if r.status().is_success() => break,
                Ok(r) => tracing::warn!(event = ?event.event, status = %r.status(), "server rejected event"),
                Err(e) => tracing::warn!(event = ?event.event, error = %e.without_url(), "event not delivered"),
            }
            if attempt < attempts {
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use axum::Router;
    use axum::http::{HeaderMap, StatusCode};
    use axum::routing::post;

    use super::*;

    fn event(kind: Kind, track: &str, reason: Option<Reason>) -> Event {
        Event { channel_id: "42".into(), event: kind, track: track.into(), position_ms: 5000, seq: 7, reason }
    }

    #[test]
    fn event_json_shape() {
        let e = event(Kind::Position, "spotify:track:4uLU6hMCjMI75M1A2tKUQC", None);
        assert_eq!(
            serde_json::to_string(&e).expect("json"),
            r#"{"channel_id":"42","event":"position","track":"spotify:track:4uLU6hMCjMI75M1A2tKUQC","position_ms":5000,"seq":7}"#
        );
        let e = event(Kind::Error, "spotify:track:4uLU6hMCjMI75M1A2tKUQC", Some(Reason::Unavailable));
        assert!(serde_json::to_string(&e).expect("json").ends_with(r#""seq":7,"reason":"unavailable"}"#));
    }

    #[tokio::test]
    async fn events_arrive_in_order_with_the_secret() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let seen: Arc<Mutex<Vec<(String, String)>>> = Arc::default();
        let log = seen.clone();
        let app = Router::new().route(
            "/internal/spotify/bot",
            post(move |headers: HeaderMap, body: String| {
                let log = log.clone();
                async move {
                    let auth = headers.get("authorization").and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
                    // The first delivery of `ended` fails once: the retry must still come before `started`.
                    let mut log = log.lock().expect("lock");
                    let first_ended = body.contains("\"ended\"") && !log.iter().any(|(_, b)| b.contains("\"ended\""));
                    log.push((auth, body));
                    if first_ended { StatusCode::INTERNAL_SERVER_ERROR } else { StatusCode::NO_CONTENT }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move { axum::serve(listener, app).await });

        let reporter = Reporter::new(&format!("http://{addr}"), "0123456789abcdef");
        reporter.send(event(Kind::Ended, "spotify:track:aaaaaaaaaaaaaaaaaaaaaa", None));
        reporter.send(event(Kind::Started, "spotify:track:bbbbbbbbbbbbbbbbbbbbbb", None));
        for _ in 0..50 {
            if seen.lock().expect("lock").len() >= 3 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let seen = seen.lock().expect("lock");
        let kinds: Vec<&str> = seen.iter().map(|(_, b)| if b.contains("\"ended\"") { "ended" } else { "started" }).collect();
        assert_eq!(kinds, ["ended", "ended", "started"]);
        assert!(seen.iter().all(|(auth, _)| auth == "Bearer 0123456789abcdef"));
    }
}
