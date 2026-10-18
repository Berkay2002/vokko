//! Inbox > Mentions: `GET /users/@me/mentions` and `DELETE /users/@me/mentions/{message_id}` (Discord's recent mentions, see docs/api.md).
use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get};
use serde::Deserialize;
use vokko_protocol::api::{GatewayEvent, Message, RecentMentionDelete, Snowflake};

use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::extract::{ApiQuery, parse_id};
use crate::state::AppState;
use crate::store::{self, MESSAGE_SELECT, MessageRow};

pub fn routes() -> Router<AppState> {
    Router::new().route("/users/@me/mentions", get(list)).route("/users/@me/mentions/{id}", delete(dismiss))
}

#[derive(Deserialize)]
struct MentionsQuery {
    limit: Option<i64>,
    before: Option<Snowflake>,
    guild_id: Option<Snowflake>,
    roles: Option<bool>,
    everyone: Option<bool>,
}

/// Server messages that mention the caller (directly, or by @everyone/@here and their roles unless turned off), newest first, in
/// channels they can still read; their own messages and dismissed ones are left out.
async fn list(State(state): State<AppState>, AuthUser(user_id): AuthUser, ApiQuery(query): ApiQuery<MentionsQuery>) -> ApiResult<Json<Vec<Message>>> {
    let limit = query.limit.unwrap_or(25);
    if !(1..=100).contains(&limit) {
        return Err(ApiErr::invalid("limit", "Must be between 1 and 100."));
    }
    let guilds: Vec<(i64,)> = match query.guild_id {
        Some(guild) => sqlx::query_as("SELECT guild_id FROM guild_members WHERE user_id = $1 AND guild_id = $2").bind(user_id).bind(guild.db()),
        None => sqlx::query_as("SELECT guild_id FROM guild_members WHERE user_id = $1").bind(user_id),
    }
    .fetch_all(&state.db)
    .await?;
    let mut channels = Vec::new();
    for (guild_id,) in guilds {
        channels.extend(super::search::readable_guild_channels(&state, user_id, guild_id).await?);
    }
    if channels.is_empty() {
        return Ok(Json(Vec::new()));
    }
    let rows: Vec<MessageRow> = sqlx::query_as(&format!(
        "{MESSAGE_SELECT} WHERE m.channel_id = ANY($1) AND m.author_id IS DISTINCT FROM $2 AND ($3::bigint IS NULL OR m.id < $3) \
         AND NOT EXISTS (SELECT 1 FROM mention_dismissals d WHERE d.user_id = $2 AND d.message_id = m.id) \
         AND (EXISTS (SELECT 1 FROM message_mentions mm WHERE mm.message_id = m.id AND mm.user_id = $2) \
           OR ($4 AND m.mention_everyone) \
           OR ($5 AND EXISTS (SELECT 1 FROM message_role_mentions rm JOIN member_roles mr ON mr.role_id = rm.role_id AND mr.user_id = $2 \
                              WHERE rm.message_id = m.id))) \
         ORDER BY m.id DESC LIMIT $6"
    ))
    .bind(&channels)
    .bind(user_id)
    .bind(query.before.map(Snowflake::db))
    .bind(query.everyone.unwrap_or(true))
    .bind(query.roles.unwrap_or(true))
    .bind(limit)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(store::load_messages(&state, rows, Some(user_id)).await?.into_iter().map(|view| view.message).collect()))
}

/// Removes a message from the caller's recent mentions. Always 204 (an unknown id too), so the answer says nothing about other channels.
/// Every call is echoed as RECENT_MENTION_DELETE to the caller's sessions so their other devices drop the row (unknown ids too, so the
/// event says nothing either).
async fn dismiss(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<StatusCode> {
    let message_id = parse_id(&id).ok_or_else(ApiErr::unknown_message)?;
    sqlx::query("INSERT INTO mention_dismissals (user_id, message_id) SELECT $1, id FROM messages WHERE id = $2 ON CONFLICT DO NOTHING")
        .bind(user_id)
        .bind(message_id)
        .execute(&state.db)
        .await?;
    let event = GatewayEvent::RecentMentionDelete(RecentMentionDelete { message_id: Snowflake::from(message_id) });
    state.hub.send(&[user_id], &event);
    Ok(StatusCode::NO_CONTENT)
}
