//! The internal HTTP API for vokko-server (docs/api.md "Bot contract", design §4.3). Every route but `/healthz` needs the
//! bearer secret.

use std::sync::Arc;

use axum::extract::{Path, Query, Request, State};
use axum::http::{StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::account::Fail;
use crate::catalog::{self, CatalogError};
use crate::plan::Desired;
use crate::session::{self, Manager, PutError};

#[derive(Clone)]
struct App {
    manager: Arc<Manager>,
    secret: Arc<str>,
    market: Arc<str>,
}

pub fn router(manager: Arc<Manager>, secret: &str, market: &str) -> Router {
    let app = App { manager, secret: secret.into(), market: market.into() };
    let guarded = Router::new()
        .route("/session", put(put_session).delete(delete_session))
        .route("/catalog/playlists/{id}", get(playlist))
        .route("/catalog/artists/{id}/top-tracks", get(top_tracks))
        .layer(middleware::from_fn_with_state(app.clone(), auth))
        .with_state(app);
    Router::new().route("/healthz", get(|| async { "ok" })).merge(guarded)
}

/// Constant time on equal lengths; the length of the secret is not a secret.
pub fn secrets_match(given: &[u8], expected: &[u8]) -> bool {
    given.len() == expected.len() && given.iter().zip(expected).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

async fn auth(State(app): State<App>, request: Request, next: Next) -> Response {
    let given = request.headers().get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer "));
    if given.is_some_and(|g| secrets_match(g.as_bytes(), app.secret.as_bytes())) { next.run(request).await } else { StatusCode::UNAUTHORIZED.into_response() }
}

fn bad(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

async fn put_session(State(app): State<App>, Json(mut desired): Json<Desired>) -> Response {
    if let Err(message) = desired.validate() {
        return bad(StatusCode::BAD_REQUEST, message);
    }
    tracing::debug!(seq = desired.seq, playing = desired.playing, position_ms = desired.position_ms, "put session");
    match app.manager.put(desired) {
        Ok(Some(start)) => {
            tokio::spawn(session::run(app.manager.clone(), start));
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(None) => StatusCode::NO_CONTENT.into_response(),
        Err(PutError::Busy) => bad(StatusCode::SERVICE_UNAVAILABLE, "busy"),
    }
}

async fn delete_session(State(app): State<App>) -> StatusCode {
    app.manager.delete();
    StatusCode::NO_CONTENT
}

#[derive(Deserialize)]
struct PageQuery {
    #[serde(default)]
    offset: usize,
    limit: Option<usize>,
    market: Option<String>,
}

#[derive(Deserialize)]
struct MarketQuery {
    market: Option<String>,
}

const OFFSET_MAX: usize = 100_000;

fn checked(app: &App, id: &str, market: Option<String>) -> Result<String, &'static str> {
    if !catalog::valid_id(id) {
        return Err("id must be 22 letters or digits");
    }
    let market = market.unwrap_or_else(|| app.market.to_string());
    if !catalog::valid_market(&market) {
        return Err("market must be two capital letters");
    }
    Ok(market)
}

fn catalog_failure(error: CatalogError) -> Response {
    match error {
        CatalogError::NotFound => bad(StatusCode::NOT_FOUND, "not found"),
        CatalogError::Unavailable => bad(StatusCode::SERVICE_UNAVAILABLE, "unavailable"),
    }
}

fn account_failure(fail: Fail) -> Response {
    bad(StatusCode::SERVICE_UNAVAILABLE, if fail == Fail::Auth { "auth" } else { "unavailable" })
}

async fn playlist(State(app): State<App>, Path(id): Path<String>, Query(q): Query<PageQuery>) -> Response {
    let market = match checked(&app, &id, q.market) {
        Ok(market) => market,
        Err(message) => return bad(StatusCode::BAD_REQUEST, message),
    };
    if q.offset > OFFSET_MAX {
        return bad(StatusCode::BAD_REQUEST, "offset is too large");
    }
    let limit = q.limit.unwrap_or(catalog::PAGE_MAX).clamp(1, catalog::PAGE_MAX);
    let session = match app.manager.account.for_catalog().await {
        Ok(session) => session,
        Err(fail) => return account_failure(fail),
    };
    match catalog::playlist(&session, &id, q.offset, limit, &market).await {
        Ok(page) => Json(page).into_response(),
        Err(error) => catalog_failure(error),
    }
}

async fn top_tracks(State(app): State<App>, Path(id): Path<String>, Query(q): Query<MarketQuery>) -> Response {
    let market = match checked(&app, &id, q.market) {
        Ok(market) => market,
        Err(message) => return bad(StatusCode::BAD_REQUEST, message),
    };
    let session = match app.manager.account.for_catalog().await {
        Ok(session) => session,
        Err(fail) => return account_failure(fail),
    };
    match catalog::top_tracks(&session, &id, &market).await {
        Ok(top) => Json(top).into_response(),
        Err(error) => catalog_failure(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::Account;
    use crate::report::Reporter;

    #[test]
    fn secret_compare() {
        assert!(secrets_match(b"0123456789abcdef", b"0123456789abcdef"));
        assert!(!secrets_match(b"0123456789abcdeg", b"0123456789abcdef"));
        assert!(!secrets_match(b"short", b"0123456789abcdef"));
        assert!(!secrets_match(b"", b"0123456789abcdef"));
    }

    const SECRET: &str = "0123456789abcdef";

    async fn serve() -> String {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let manager = Manager::new(Reporter::new("http://127.0.0.1:9", SECRET), Arc::new(Account::new().expect("account")));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move { axum::serve(listener, router(manager, SECRET, "SE")).await });
        format!("http://{addr}")
    }

    /// Everything here is refused before a Spotify or LiveKit connection would be made.
    #[tokio::test]
    async fn auth_and_validation() {
        let base = serve().await;
        let client = reqwest::Client::new();
        let status = |r: reqwest::Response| r.status().as_u16();
        assert_eq!(status(client.get(format!("{base}/healthz")).send().await.expect("send")), 200);
        assert_eq!(status(client.delete(format!("{base}/session")).send().await.expect("send")), 401);
        assert_eq!(status(client.delete(format!("{base}/session")).bearer_auth("0123456789abcdeX").send().await.expect("send")), 401);
        assert_eq!(status(client.delete(format!("{base}/session")).bearer_auth(SECRET).send().await.expect("send")), 204);

        let body = json!({"channel_id": "42", "livekit_url": "ws://127.0.0.1:27880", "token": "t", "track": "spotify:album:4uLU6hMCjMI75M1A2tKUQC", "seq": 1});
        assert_eq!(status(client.put(format!("{base}/session")).bearer_auth(SECRET).json(&body).send().await.expect("send")), 400);
        let body =
            json!({"channel_id": "../1", "livekit_url": "ws://127.0.0.1:27880", "token": "t", "track": "spotify:track:4uLU6hMCjMI75M1A2tKUQC", "seq": 1});
        assert_eq!(status(client.put(format!("{base}/session")).bearer_auth(SECRET).json(&body).send().await.expect("send")), 400);

        for path in ["catalog/playlists/me", "catalog/playlists/4uLU6hMCjMI75M1A2tKUQC?market=se", "catalog/artists/4uLU6hMCjMI75M1A2tKU%2FC/top-tracks"] {
            assert_eq!(status(client.get(format!("{base}/{path}")).bearer_auth(SECRET).send().await.expect("send")), 400, "{path}");
        }
        assert_eq!(
            status(client.get(format!("{base}/catalog/playlists/4uLU6hMCjMI75M1A2tKUQC?offset=100001")).bearer_auth(SECRET).send().await.expect("send")),
            400
        );
        assert_eq!(status(client.get(format!("{base}/catalog/playlists/4uLU6hMCjMI75M1A2tKUQC")).send().await.expect("send")), 401);
    }
}
