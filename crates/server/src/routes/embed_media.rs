//! `GET /embed-media/{sig}/{target}`: the public, signed image proxy of embeds (`crate::embed_media`). No auth: these are
//! <img> loads, which carry no token; the signature limits it to URLs the server itself put in an embed.
use axum::Router;
use axum::extract::{Path, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_LENGTH, CONTENT_SECURITY_POLICY, CONTENT_TYPE, X_CONTENT_TYPE_OPTIONS};
use axum::http::{HeaderValue, StatusCode};
use axum::response::Response;
use axum::routing::get;

use crate::error::{ApiErr, ApiResult};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new().route("/embed-media/{sig}/{target}", get(image))
}

async fn image(State(state): State<AppState>, Path((sig, target)): Path<(String, String)>) -> ApiResult<Response> {
    let url = crate::embed_media::verify(&state, &sig, &target).ok_or_else(ApiErr::not_found)?;
    let served = state.embed_media.get(url).await?;
    let mut response = Response::new(served.body);
    *response.status_mut() = StatusCode::OK;
    let headers = response.headers_mut();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static(served.content_type));
    headers.insert(CONTENT_LENGTH, HeaderValue::from(served.length));
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("public, max-age=86400"));
    headers.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(CONTENT_SECURITY_POLICY, HeaderValue::from_static("sandbox"));
    Ok(response)
}
