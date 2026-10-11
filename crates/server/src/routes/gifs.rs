use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get};
use serde::Deserialize;
use vokko_protocol::api::{Gif, GifCategories, GifPage};

use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::extract::{ApiJson, ApiQuery};
use crate::state::AppState;

const MAX_FAVORITES: i64 = 500;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/gifs/search", get(search))
        .route("/gifs/trending", get(trending))
        .route("/gifs/categories", get(categories))
        .route("/users/@me/gifs/favorites", get(list_favorites).put(put_favorite))
        .route("/users/@me/gifs/favorites/{gif_id}", delete(remove_favorite))
}

#[derive(Deserialize)]
struct ListQuery {
    q: Option<String>,
    limit: Option<u32>,
    pos: Option<String>,
}

fn limit(query: &ListQuery) -> ApiResult<u32> {
    let limit = query.limit.unwrap_or(24);
    if !(1..=50).contains(&limit) {
        return Err(ApiErr::invalid("limit", "Must be between 1 and 50."));
    }
    if query.pos.as_ref().is_some_and(|pos| pos.len() > 128) {
        return Err(ApiErr::invalid("pos", "Must be 128 or fewer in length."));
    }
    Ok(limit)
}

async fn search(State(state): State<AppState>, AuthUser(_): AuthUser, ApiQuery(query): ApiQuery<ListQuery>) -> ApiResult<Json<GifPage>> {
    let limit = limit(&query)?;
    let text = query.q.as_deref().map(str::trim).unwrap_or("");
    if text.is_empty() || text.chars().count() > 100 {
        return Err(ApiErr::invalid("q", "Must be between 1 and 100 in length."));
    }
    Ok(Json(state.gifs.search(text, limit, query.pos.as_deref().filter(|pos| !pos.is_empty())).await?))
}

async fn trending(State(state): State<AppState>, AuthUser(_): AuthUser, ApiQuery(query): ApiQuery<ListQuery>) -> ApiResult<Json<GifPage>> {
    let limit = limit(&query)?;
    Ok(Json(state.gifs.trending(limit, query.pos.as_deref().filter(|pos| !pos.is_empty())).await?))
}

async fn categories(State(state): State<AppState>, AuthUser(_): AuthUser) -> ApiResult<Json<GifCategories>> {
    Ok(Json(state.gifs.categories().await?))
}

async fn list_favorites(State(state): State<AppState>, AuthUser(user_id): AuthUser) -> ApiResult<Json<Vec<Gif>>> {
    let rows: Vec<(String,)> =
        sqlx::query_as("SELECT data::text FROM gif_favorites WHERE user_id = $1 ORDER BY created_at DESC, gif_id").bind(user_id).fetch_all(&state.db).await?;
    Ok(Json(rows.into_iter().filter_map(|(data,)| serde_json::from_str(&data).ok()).collect()))
}

fn http_url(field: &str, value: &str) -> ApiResult<()> {
    if value.len() > 2048 || !(value.starts_with("https://") || value.starts_with("http://")) {
        return Err(ApiErr::invalid(field, "Must be an http(s) URL of at most 2048 characters."));
    }
    Ok(())
}

async fn put_favorite(State(state): State<AppState>, AuthUser(user_id): AuthUser, ApiJson(gif): ApiJson<Gif>) -> ApiResult<Json<Gif>> {
    let valid_id = gif.id.len() <= 100
        && gif.id.split_once(':').is_some_and(|(provider, rest)| {
            !provider.is_empty() && !rest.is_empty() && gif.id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '-' | '.'))
        });
    if !valid_id {
        return Err(ApiErr::invalid("id", "Must look like <provider>:<id>."));
    }
    http_url("url", &gif.url)?;
    http_url("preview_url", &gif.preview_url)?;
    if gif.title.chars().count() > 200 || gif.width > 10_000 || gif.height > 10_000 {
        return Err(ApiErr::invalid("title", "Too long, or the size is out of range."));
    }
    let existing: Option<(i64,)> =
        sqlx::query_as("SELECT 1::bigint FROM gif_favorites WHERE user_id = $1 AND gif_id = $2").bind(user_id).bind(&gif.id).fetch_optional(&state.db).await?;
    if existing.is_none() {
        let (count,): (i64,) = sqlx::query_as("SELECT count(*) FROM gif_favorites WHERE user_id = $1").bind(user_id).fetch_one(&state.db).await?;
        if count >= MAX_FAVORITES {
            return Err(ApiErr::conflict(30092, "Maximum number of favorite GIFs reached"));
        }
    }
    sqlx::query(
        "INSERT INTO gif_favorites (user_id, gif_id, data) VALUES ($1, $2, $3::jsonb) \
         ON CONFLICT (user_id, gif_id) DO UPDATE SET data = EXCLUDED.data, created_at = now()",
    )
    .bind(user_id)
    .bind(&gif.id)
    .bind(serde_json::to_string(&gif).map_err(|_| ApiErr::internal())?)
    .execute(&state.db)
    .await?;
    Ok(Json(gif))
}

async fn remove_favorite(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(gif_id): Path<String>) -> ApiResult<StatusCode> {
    sqlx::query("DELETE FROM gif_favorites WHERE user_id = $1 AND gif_id = $2").bind(user_id).bind(gif_id).execute(&state.db).await?;
    Ok(StatusCode::NO_CONTENT)
}
