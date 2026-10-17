//! The internal HTTP API for vokko-server (design §3.3). Every route but `/healthz` needs the bearer secret.

use std::sync::Arc;

use axum::extract::{Path, Request, State};
use axum::http::{StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, put};
use axum::{Json, Router};
use serde_json::json;

use crate::plan::{Desired, host_of};
use crate::session::{Manager, PutError};

#[derive(Clone)]
struct App {
    manager: Arc<Manager>,
    secret: Arc<str>,
}

pub fn router(manager: Arc<Manager>, secret: &str) -> Router {
    let app = App { manager, secret: secret.into() };
    let guarded = Router::new()
        .route("/sessions", delete(delete_all))
        .route("/sessions/{channel_id}", put(put_session).delete(delete_session))
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

fn valid_channel_id(id: &str) -> bool {
    (1..=20).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit())
}

async fn put_session(State(app): State<App>, Path(channel_id): Path<String>, Json(mut desired): Json<Desired>) -> Response {
    if !valid_channel_id(&channel_id) {
        return bad(StatusCode::BAD_REQUEST, "channel_id must be a number");
    }
    if let Err(message) = desired.validate() {
        return bad(StatusCode::BAD_REQUEST, &message);
    }
    tracing::debug!(channel_id, media_host = host_of(&desired.media_url), "put session");
    match app.manager.put(&channel_id, desired) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(PutError::Busy) => bad(StatusCode::SERVICE_UNAVAILABLE, "the bot is busy"),
    }
}

async fn delete_session(State(app): State<App>, Path(channel_id): Path<String>) -> StatusCode {
    app.manager.delete(&channel_id);
    StatusCode::NO_CONTENT
}

async fn delete_all(State(app): State<App>) -> StatusCode {
    app.manager.delete_all();
    StatusCode::NO_CONTENT
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_compare() {
        assert!(secrets_match(b"0123456789abcdef", b"0123456789abcdef"));
        assert!(!secrets_match(b"0123456789abcdeg", b"0123456789abcdef"));
        assert!(!secrets_match(b"short", b"0123456789abcdef"));
        assert!(!secrets_match(b"", b"0123456789abcdef"));
    }

    #[test]
    fn channel_ids_are_numbers() {
        assert!(valid_channel_id("123456789012345678"));
        assert!(!valid_channel_id(""));
        assert!(!valid_channel_id("12a"));
        assert!(!valid_channel_id("../x"));
        assert!(!valid_channel_id("123456789012345678901"));
    }
}
