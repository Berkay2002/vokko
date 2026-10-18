//! Per-guild privacy (the guild menu's Privacy Settings): whether members of a guild who are not your friends may DM you.
//! Discord's rule: a non-friend may open or write to a 1:1 DM with you when your global `dms_from_server_members` is on and
//! you share at least one guild you have not restricted.
use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::routing::get;
use vokko_protocol::api::GuildPrivacySettings;

use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::extract::{ApiJson, parse_id};
use crate::routes::settings::privacy_flag;
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new().route("/users/@me/guilds/{id}/privacy", get(get_privacy).patch(update_privacy))
}

/// Whether `sender` may open a 1:1 DM with, or send a message in one to, `target`.
pub async fn may_dm(state: &AppState, sender: i64, target: i64) -> ApiResult<bool> {
    let (friend,): (bool,) = sqlx::query_as("SELECT EXISTS (SELECT 1 FROM relationships WHERE user_id = $1 AND other_id = $2 AND kind = 1)")
        .bind(sender)
        .bind(target)
        .fetch_one(&state.db)
        .await?;
    if friend {
        return Ok(true);
    }
    if !privacy_flag(state, target, "dms_from_server_members", true).await? {
        return Ok(false);
    }
    let (open,): (bool,) = sqlx::query_as(
        "SELECT EXISTS (SELECT 1 FROM guild_members a JOIN guild_members b ON b.guild_id = a.guild_id AND b.user_id = $2 WHERE a.user_id = $1 \
         AND NOT EXISTS (SELECT 1 FROM guild_dm_restrictions r WHERE r.user_id = $2 AND r.guild_id = a.guild_id))",
    )
    .bind(sender)
    .bind(target)
    .fetch_one(&state.db)
    .await?;
    Ok(open)
}

/// The guild id when the caller is a member (404 Unknown Guild otherwise, so it does not tell which guilds exist).
pub(crate) async fn member_guild(state: &AppState, user_id: i64, guild: &str) -> ApiResult<i64> {
    let guild = parse_id(guild).ok_or_else(ApiErr::unknown_guild)?;
    let (member,): (bool,) = sqlx::query_as("SELECT EXISTS (SELECT 1 FROM guild_members WHERE guild_id = $1 AND user_id = $2)")
        .bind(guild)
        .bind(user_id)
        .fetch_one(&state.db)
        .await?;
    if member { Ok(guild) } else { Err(ApiErr::unknown_guild()) }
}

async fn current(state: &AppState, user_id: i64, guild: i64) -> ApiResult<GuildPrivacySettings> {
    let (restricted,): (bool,) = sqlx::query_as("SELECT EXISTS (SELECT 1 FROM guild_dm_restrictions WHERE user_id = $1 AND guild_id = $2)")
        .bind(user_id)
        .bind(guild)
        .fetch_one(&state.db)
        .await?;
    Ok(GuildPrivacySettings { direct_messages: !restricted })
}

async fn get_privacy(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(guild): Path<String>) -> ApiResult<Json<GuildPrivacySettings>> {
    let guild = member_guild(&state, user_id, &guild).await?;
    Ok(Json(current(&state, user_id, guild).await?))
}

async fn update_privacy(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(guild): Path<String>,
    ApiJson(body): ApiJson<GuildPrivacySettings>,
) -> ApiResult<Json<GuildPrivacySettings>> {
    let guild = member_guild(&state, user_id, &guild).await?;
    let query = if body.direct_messages {
        "DELETE FROM guild_dm_restrictions WHERE user_id = $1 AND guild_id = $2"
    } else {
        "INSERT INTO guild_dm_restrictions (user_id, guild_id) VALUES ($1, $2) ON CONFLICT DO NOTHING"
    };
    sqlx::query(query).bind(user_id).bind(guild).execute(&state.db).await?;
    Ok(Json(current(&state, user_id, guild).await?))
}
