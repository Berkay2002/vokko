//! App icons: `POST /app-icons` (any signed-in user, PNG only) and the public, content-addressed `GET /app-icons/{hash}`.
use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::rejection::BytesRejection;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde_json::{Value, json};

use crate::app_icons::{self, MAX_BYTES, MAX_PER_USER};
use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new().route("/app-icons", post(upload).layer(DefaultBodyLimit::max(MAX_BYTES))).route("/app-icons/{hash}", get(image))
}

/// Body: the PNG itself (`Content-Type: image/png`). Answers `{"asset": "app:<hash>"}`, the value for `assets.large_image`.
async fn upload(State(state): State<AppState>, AuthUser(user_id): AuthUser, headers: HeaderMap, body: Result<Bytes, BytesRejection>) -> ApiResult<Json<Value>> {
    if headers.get(CONTENT_TYPE).and_then(|value| value.to_str().ok()).map(|value| value.split(';').next().unwrap_or_default().trim()) != Some("image/png") {
        return Err(ApiErr::invalid("body", "Must be a PNG image (Content-Type: image/png)."));
    }
    let body = body.map_err(|_| ApiErr::payload_too_large())?;
    // Decoding and resizing are CPU work: keep them off the async threads.
    let stored = tokio::task::spawn_blocking(move || app_icons::normalize(&body)).await.map_err(|_| ApiErr::internal())?;
    let Some(png) = stored else { return Err(ApiErr::invalid("body", "Must be a PNG image of at most 512x512 pixels.")) };
    let hash = app_icons::hash_of(&png);
    // Past the per-user cap only new icons are refused: an icon the server already has costs nothing.
    let inserted = sqlx::query(
        "INSERT INTO app_icons (hash, png, uploader_id) SELECT $1, $2, $3 WHERE (SELECT count(*) FROM app_icons WHERE uploader_id = $3) < $4 ON CONFLICT (hash) DO NOTHING",
    )
    .bind(&hash)
    .bind(&png)
    .bind(user_id)
    .bind(MAX_PER_USER)
    .execute(&state.db)
    .await?;
    if inserted.rows_affected() == 0 {
        let known: Option<(i32,)> = sqlx::query_as("SELECT 1 FROM app_icons WHERE hash = $1").bind(&hash).fetch_optional(&state.db).await?;
        if known.is_none() {
            return Err(ApiErr::conflict(30008, "Maximum number of app icons reached (64)"));
        }
    }
    Ok(Json(json!({ "asset": format!("app:{hash}") })))
}

/// The stored PNG, without auth (it is an `<img>` source and the hash is its address, so it never changes).
async fn image(State(state): State<AppState>, Path(hash): Path<String>) -> ApiResult<Response> {
    if !app_icons::is_hash(&hash) {
        return Err(ApiErr::not_found());
    }
    let row: Option<(Vec<u8>,)> = sqlx::query_as("SELECT png FROM app_icons WHERE hash = $1").bind(&hash).fetch_optional(&state.db).await?;
    let Some((png,)) = row else { return Err(ApiErr::not_found()) };
    let mut response = (StatusCode::OK, png.clone()).into_response();
    let headers = response.headers_mut();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("image/png"));
    headers.insert(CONTENT_LENGTH, HeaderValue::from(png.len()));
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("public, max-age=31536000, immutable"));
    headers.insert(HeaderName::from_static("x-content-type-options"), HeaderValue::from_static("nosniff"));
    Ok(response)
}
