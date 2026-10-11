use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, put};
use serde::Deserialize;
use vokko_protocol::api::permissions::{ADD_REACTIONS, READ_MESSAGE_HISTORY};
use vokko_protocol::api::{GatewayEvent, MessageReaction, ReactionEmoji, Snowflake, User};

use crate::access::{self, channel_access};
use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::extract::{ApiQuery, parse_id};
use crate::state::AppState;
use crate::store;

const MAX_DISTINCT_REACTIONS: i64 = 20;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/channels/{id}/messages/{mid}/reactions/{emoji}/@me", put(add_reaction).delete(remove_reaction))
        .route("/channels/{id}/messages/{mid}/reactions/{emoji}", get(list_reactors))
}

/// `😀` for unicode emoji, `name:id` for custom emoji (the path segment is already percent-decoded).
pub fn parse_emoji(raw: &str) -> ApiResult<ReactionEmoji> {
    let invalid = || ApiErr::invalid("emoji", "Unknown Emoji");
    if let Some((name, id)) = raw.split_once(':') {
        let id = parse_id(id).ok_or_else(invalid)?;
        let valid_name = (2..=32).contains(&name.len()) && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !valid_name {
            return Err(invalid());
        }
        return Ok(ReactionEmoji { id: Some(Snowflake::from(id)), name: name.to_owned() });
    }
    let name = raw.trim();
    if name.is_empty() || name.len() > 64 || name.chars().any(|c| c.is_ascii_alphanumeric() || c.is_control() || c.is_whitespace()) {
        return Err(invalid());
    }
    Ok(ReactionEmoji { id: None, name: name.to_owned() })
}

async fn locate(state: &AppState, user_id: i64, channel: &str, message: &str) -> ApiResult<(access::ChannelAccess, i64)> {
    let channel_id = parse_id(channel).ok_or_else(ApiErr::unknown_channel)?;
    let message_id = parse_id(message).ok_or_else(ApiErr::unknown_message)?;
    let access = channel_access(state, user_id, channel_id).await?;
    let found: Option<(i64,)> =
        sqlx::query_as("SELECT id FROM messages WHERE id = $1 AND channel_id = $2").bind(message_id).bind(channel_id).fetch_optional(&state.db).await?;
    if found.is_none() {
        return Err(ApiErr::unknown_message());
    }
    Ok((access, message_id))
}

async fn add_reaction(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path((id, mid, emoji)): Path<(String, String, String)>,
) -> ApiResult<StatusCode> {
    let emoji = parse_emoji(&emoji)?;
    let (access, message_id) = locate(&state, user_id, &id, &mid).await?;
    access.require(READ_MESSAGE_HISTORY)?;
    access.require(ADD_REACTIONS)?;
    let emoji_id = emoji.id.map(Snowflake::db).unwrap_or(0);
    let (distinct, existing): (i64, bool) = sqlx::query_as(
        "SELECT count(DISTINCT (emoji_name, emoji_id)), COALESCE(bool_or(emoji_name = $2 AND emoji_id = $3), FALSE) FROM reactions WHERE message_id = $1",
    )
    .bind(message_id)
    .bind(&emoji.name)
    .bind(emoji_id)
    .fetch_one(&state.db)
    .await?;
    if !existing && distinct >= MAX_DISTINCT_REACTIONS {
        return Err(ApiErr::conflict(30010, "Maximum number of reactions reached (20)"));
    }
    let inserted = sqlx::query("INSERT INTO reactions (message_id, user_id, emoji_name, emoji_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING")
        .bind(message_id)
        .bind(user_id)
        .bind(&emoji.name)
        .bind(emoji_id)
        .execute(&state.db)
        .await?;
    if inserted.rows_affected() > 0 {
        let viewers = access::channel_viewers(&state, &access.channel).await?;
        let event = MessageReaction {
            user_id: Snowflake::from(user_id),
            channel_id: Snowflake::from(access.channel.id),
            message_id: Snowflake::from(message_id),
            emoji,
        };
        state.hub.send(&viewers, &GatewayEvent::MessageReactionAdd(event));
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn remove_reaction(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path((id, mid, emoji)): Path<(String, String, String)>,
) -> ApiResult<StatusCode> {
    let emoji = parse_emoji(&emoji)?;
    let (access, message_id) = locate(&state, user_id, &id, &mid).await?;
    let removed = sqlx::query("DELETE FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji_name = $3 AND emoji_id = $4")
        .bind(message_id)
        .bind(user_id)
        .bind(&emoji.name)
        .bind(emoji.id.map(Snowflake::db).unwrap_or(0))
        .execute(&state.db)
        .await?;
    if removed.rows_affected() > 0 {
        let viewers = access::channel_viewers(&state, &access.channel).await?;
        let event = MessageReaction {
            user_id: Snowflake::from(user_id),
            channel_id: Snowflake::from(access.channel.id),
            message_id: Snowflake::from(message_id),
            emoji,
        };
        state.hub.send(&viewers, &GatewayEvent::MessageReactionRemove(event));
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct ReactorsQuery {
    limit: Option<i64>,
    after: Option<Snowflake>,
}

async fn list_reactors(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path((id, mid, emoji)): Path<(String, String, String)>,
    ApiQuery(query): ApiQuery<ReactorsQuery>,
) -> ApiResult<Json<Vec<User>>> {
    let emoji = parse_emoji(&emoji)?;
    let (access, message_id) = locate(&state, user_id, &id, &mid).await?;
    access.require(READ_MESSAGE_HISTORY)?;
    let limit = query.limit.unwrap_or(25).clamp(1, 100);
    let rows: Vec<(i64,)> =
        sqlx::query_as("SELECT user_id FROM reactions WHERE message_id = $1 AND emoji_name = $2 AND emoji_id = $3 AND user_id > $4 ORDER BY user_id LIMIT $5")
            .bind(message_id)
            .bind(&emoji.name)
            .bind(emoji.id.map(Snowflake::db).unwrap_or(0))
            .bind(query.after.map(Snowflake::db).unwrap_or(0))
            .bind(limit)
            .fetch_all(&state.db)
            .await?;
    let ids: Vec<i64> = rows.into_iter().map(|(id,)| id).collect();
    let mut users = store::users(&state, &ids).await?;
    Ok(Json(ids.into_iter().filter_map(|id| users.remove(&id)).collect()))
}
