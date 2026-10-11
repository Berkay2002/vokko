use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::routing::get;
use vokko_protocol::api::{GatewayEvent, UpdateUserRequest, User};

use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::events;
use crate::extract::{ApiJson, parse_id};
use crate::routes::auth::clean_text;
use crate::state::AppState;
use crate::store;

pub fn routes() -> Router<AppState> {
    Router::new().route("/users/@me", get(me).patch(update_me)).route("/users/{id}", get(get_user))
}

async fn me(State(state): State<AppState>, AuthUser(user_id): AuthUser) -> ApiResult<Json<User>> {
    store::user(&state, user_id).await?.map(Json).ok_or_else(ApiErr::unauthorized)
}

fn valid_color(value: &str) -> bool {
    value.len() == 7 && value.starts_with('#') && value[1..].chars().all(|c| c.is_ascii_hexdigit())
}

async fn update_me(State(state): State<AppState>, AuthUser(user_id): AuthUser, ApiJson(body): ApiJson<UpdateUserRequest>) -> ApiResult<Json<User>> {
    if body.global_name.is_some() {
        let global_name = clean_text(body.global_name, 32, "global_name")?;
        sqlx::query("UPDATE users SET global_name = $2 WHERE id = $1").bind(user_id).bind(global_name).execute(&state.db).await?;
    }
    if body.bio.is_some() {
        let bio = clean_text(body.bio, 190, "bio")?;
        sqlx::query("UPDATE users SET bio = $2 WHERE id = $1").bind(user_id).bind(bio).execute(&state.db).await?;
    }
    if let Some(color) = body.banner_color {
        let color = color.trim().to_lowercase();
        if !color.is_empty() && !valid_color(&color) {
            return Err(ApiErr::invalid("banner_color", "Must be a #rrggbb colour."));
        }
        sqlx::query("UPDATE users SET banner_color = $2 WHERE id = $1").bind(user_id).bind((!color.is_empty()).then_some(color)).execute(&state.db).await?;
    }
    if let Some(attachment_id) = body.avatar_attachment_id {
        let path = owned_attachment_path(&state, attachment_id.db(), user_id).await?;
        sqlx::query("UPDATE users SET avatar_path = $2 WHERE id = $1").bind(user_id).bind(path).execute(&state.db).await?;
    }
    let user = store::user(&state, user_id).await?.ok_or_else(ApiErr::unauthorized)?;
    let audience = events::user_audience(&state, user_id).await?;
    state.hub.send(&audience, &GatewayEvent::UserUpdate(user.clone()));
    Ok(Json(user))
}

/// `<id>/<filename>` of an attachment uploaded by `user_id` (used for avatars and guild icons).
pub async fn owned_attachment_path(state: &AppState, attachment_id: i64, user_id: i64) -> ApiResult<String> {
    let row: Option<(String,)> = sqlx::query_as("SELECT filename FROM attachments WHERE id = $1 AND uploader_id = $2")
        .bind(attachment_id)
        .bind(user_id)
        .fetch_optional(&state.db)
        .await?;
    match row {
        Some((filename,)) => Ok(format!("{attachment_id}/{filename}")),
        None => Err(ApiErr::invalid("attachment_id", "Unknown attachment.")),
    }
}

async fn get_user(State(state): State<AppState>, AuthUser(_): AuthUser, Path(id): Path<String>) -> ApiResult<Json<User>> {
    let id = parse_id(&id).ok_or_else(ApiErr::unknown_user)?;
    store::user(&state, id).await?.map(Json).ok_or_else(ApiErr::unknown_user)
}
