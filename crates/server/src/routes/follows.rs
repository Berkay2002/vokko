//! Announcement channels: following one into another channel, and publishing (crossposting) a message to the followers.
use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, post};
use vokko_protocol::api::permissions::{MANAGE_MESSAGES, MANAGE_WEBHOOKS, SEND_MESSAGES};
use vokko_protocol::api::{ChannelFollower, ChannelType, FollowChannelRequest, FollowedChannel, Message, MessageType, Snowflake, message_flags};

use crate::access::channel_access;
use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::extract::{ApiJson, parse_id};
use crate::routes::messages::{Draft, Extras, Resolved, broadcast_update, insert_message_with};
use crate::state::AppState;
use crate::store::{self, ChannelRow, MESSAGE_SELECT, MessageRow};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/channels/{id}/followers", post(follow_channel).get(list_followers))
        .route("/channels/{id}/followers/{follow_id}", delete(unfollow))
        .route("/channels/{id}/messages/{mid}/crosspost", post(crosspost))
}

fn channel_id(raw: &str) -> ApiResult<i64> {
    parse_id(raw).ok_or_else(ApiErr::unknown_channel)
}

fn is_follow_target(kind: ChannelType) -> bool {
    matches!(kind, ChannelType::GuildText | ChannelType::GuildAnnouncement)
}

/// `POST /channels/{source}/followers`: deliver the source's published messages into `webhook_channel_id`.
async fn follow_channel(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<FollowChannelRequest>,
) -> ApiResult<Json<FollowedChannel>> {
    let source = channel_access(&state, user_id, channel_id(&id)?).await?;
    if source.channel.channel_type() != ChannelType::GuildAnnouncement {
        return Err(ApiErr::invalid("channel_id", "Only announcement channels can be followed."));
    }
    let target_id = body.webhook_channel_id.db();
    let target = channel_access(&state, user_id, target_id).await?;
    if !is_follow_target(target.channel.channel_type()) || target_id == source.channel.id {
        return Err(ApiErr::invalid("webhook_channel_id", "Must be another text or announcement channel."));
    }
    target.require(MANAGE_WEBHOOKS)?;
    let (follow_id,): (i64,) = sqlx::query_as(
        "INSERT INTO channel_follows (id, source_channel_id, target_channel_id, created_by) VALUES ($1, $2, $3, $4) \
         ON CONFLICT (source_channel_id, target_channel_id) DO UPDATE SET source_channel_id = EXCLUDED.source_channel_id RETURNING id",
    )
    .bind(state.ids.next())
    .bind(source.channel.id)
    .bind(target_id)
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(FollowedChannel { channel_id: Snowflake::from(source.channel.id), webhook_id: Snowflake::from(follow_id) }))
}

/// `GET /channels/{target}/followers`: the follows delivering into this channel.
async fn list_followers(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Vec<ChannelFollower>>> {
    let target = channel_access(&state, user_id, channel_id(&id)?).await?;
    target.require(MANAGE_WEBHOOKS)?;
    let rows: Vec<(i64, i64, i64, String, i64, String)> = sqlx::query_as(
        "SELECT f.id, f.source_channel_id, s.guild_id, COALESCE(s.name, ''), g.id, g.name \
         FROM channel_follows f JOIN channels s ON s.id = f.source_channel_id JOIN guilds g ON g.id = s.guild_id \
         WHERE f.target_channel_id = $1 ORDER BY f.id",
    )
    .bind(target.channel.id)
    .fetch_all(&state.db)
    .await?;
    let guild_id = target.channel.guild_id.map(Snowflake::from).ok_or_else(ApiErr::internal)?;
    Ok(Json(
        rows.into_iter()
            .map(|(id, source_channel, source_guild, source_name, _, source_guild_name)| ChannelFollower {
                id: Snowflake::from(id),
                channel_id: Snowflake::from(target.channel.id),
                guild_id,
                source_channel_id: Snowflake::from(source_channel),
                source_channel_name: source_name,
                source_guild_id: Snowflake::from(source_guild),
                source_guild_name,
            })
            .collect(),
    ))
}

async fn unfollow(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path((id, follow)): Path<(String, String)>) -> ApiResult<StatusCode> {
    let target = channel_access(&state, user_id, channel_id(&id)?).await?;
    target.require(MANAGE_WEBHOOKS)?;
    let follow_id = parse_id(&follow).ok_or_else(ApiErr::not_found)?;
    let removed =
        sqlx::query("DELETE FROM channel_follows WHERE id = $1 AND target_channel_id = $2").bind(follow_id).bind(target.channel.id).execute(&state.db).await?;
    if removed.rows_affected() == 0 {
        return Err(ApiErr::not_found());
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Copies `source` into a follower channel as a regular message by the original author: content and embeds, no attachments.
async fn deliver_copy(state: &AppState, target: &ChannelRow, source: &MessageRow, source_guild: Option<i64>) -> ApiResult<()> {
    let draft = Draft {
        content: source.content.clone(),
        kind: MessageType::Default,
        reference: Some(source.id),
        attachments: Vec::new(),
        nonce: None,
        mentions: Resolved { users: Vec::new(), roles: Vec::new(), everyone: false },
        ping_replied: false,
    };
    let extras = Extras {
        flags: message_flags::IS_CROSSPOST as i32,
        reference_channel: Some(source.channel_id),
        reference_guild: source_guild,
        embeds: Some(source.embeds.clone()),
        ..Extras::default()
    };
    insert_message_with(state, target, source.author_id, draft, extras).await?;
    Ok(())
}

/// `POST /channels/{id}/messages/{mid}/crosspost`: publish an announcement message to every follower.
async fn crosspost(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path((id, mid)): Path<(String, String)>) -> ApiResult<Json<Message>> {
    let access = channel_access(&state, user_id, channel_id(&id)?).await?;
    if access.channel.channel_type() != ChannelType::GuildAnnouncement {
        return Err(ApiErr::wrong_channel_type());
    }
    let mid = parse_id(&mid).ok_or_else(ApiErr::unknown_message)?;
    let source: MessageRow = sqlx::query_as(&format!("{MESSAGE_SELECT} WHERE m.id = $1 AND m.channel_id = $2"))
        .bind(mid)
        .bind(access.channel.id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(ApiErr::unknown_message)?;
    if !matches!(MessageType::from_u8(source.kind as u8), Some(MessageType::Default | MessageType::Reply)) {
        return Err(ApiErr::invalid("message_id", "Only user messages can be published."));
    }
    if source.author_id == user_id {
        access.require(SEND_MESSAGES)?
    } else {
        access.require(MANAGE_MESSAGES)?
    }
    let crossposted = message_flags::CROSSPOSTED as i32;
    if source.flags & message_flags::IS_CROSSPOST as i32 != 0 {
        return Err(ApiErr::invalid("message_id", "A published copy cannot be published again."));
    }
    // The flag flips once, atomically: concurrent publishes cannot both deliver.
    let claimed = sqlx::query("UPDATE messages SET flags = flags | $2 WHERE id = $1 AND flags & $2 = 0").bind(mid).bind(crossposted).execute(&state.db).await?;
    if claimed.rows_affected() == 0 {
        return Err(ApiErr::already_published());
    }
    let targets: Vec<(i64,)> = sqlx::query_as("SELECT target_channel_id FROM channel_follows WHERE source_channel_id = $1 ORDER BY id")
        .bind(access.channel.id)
        .fetch_all(&state.db)
        .await?;
    for (target_id,) in targets {
        let Some(target) = store::channel_row(&state, target_id).await? else { continue };
        if let Err(error) = deliver_copy(&state, &target, &source, access.channel.guild_id).await {
            tracing::warn!("publishing {mid} into {target_id} failed: {error:?}");
        }
    }
    broadcast_update(&state, &access.channel, mid).await?;
    store::message_view(&state, mid, Some(user_id)).await?.map(|view| Json(view.message)).ok_or_else(ApiErr::unknown_message)
}
