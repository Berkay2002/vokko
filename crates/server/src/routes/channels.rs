use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::routing::patch;
use vokko_protocol::api::permissions::MANAGE_CHANNELS;
use vokko_protocol::api::{AuditLogEvent, Channel, ChannelType, GatewayEvent, UpdateChannelRequest};

use crate::access::{self, channel_access};
use crate::audit::{self, AuditReason, Entry};
use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::events;
use crate::extract::{ApiJson, parse_id};
use crate::routes::auth::clean_text;
use crate::routes::forums;
use crate::routes::guilds::channel_name;
use crate::routes::overwrites;
use crate::routes::threads as threads_routes;
use crate::state::AppState;
use crate::store;
use crate::threads;

pub fn routes() -> Router<AppState> {
    Router::new().route("/channels/{id}", patch(update_channel).delete(delete_channel))
}

/// Discord's slowmode ceiling: 6 hours.
const MAX_SLOWMODE_SECONDS: u32 = 21600;

fn channel_id(raw: &str) -> ApiResult<i64> {
    parse_id(raw).ok_or_else(ApiErr::unknown_channel)
}

async fn update_channel(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    AuditReason(reason): AuditReason,
    ApiJson(body): ApiJson<UpdateChannelRequest>,
) -> ApiResult<Json<Channel>> {
    let id = channel_id(&id)?;
    let access = channel_access(&state, user_id, id).await?;
    let kind = access.channel.channel_type();
    if body.nsfw.is_some() && !matches!(kind, ChannelType::GuildText | ChannelType::GuildAnnouncement | ChannelType::GuildForum | ChannelType::GuildVoice) {
        return Err(ApiErr::invalid("nsfw", "Only text, announcement, forum and voice channels can be age-restricted."));
    }
    if kind.is_thread() {
        return threads_routes::edit_thread(&state, user_id, access, body).await;
    }
    if access.is_dm() {
        if kind != ChannelType::GroupDm
            || body.topic.is_some()
            || body.position.is_some()
            || body.parent_id.is_some()
            || body.bitrate.is_some()
            || body.user_limit.is_some()
            || body.rate_limit_per_user.is_some()
        {
            return Err(ApiErr::missing_permissions());
        }
    } else {
        access.require(MANAGE_CHANNELS)?;
    }
    let before = match access.channel.guild_id {
        Some(_) => store::channel(&state, id, Some(user_id)).await?,
        None => None,
    };
    // Validate everything first, then write in one transaction: a rejected request (including a lock_permissions the actor
    // may not apply) changes nothing.
    let name = match &body.name {
        Some(name) => Some(if access.is_dm() {
            let trimmed = name.trim();
            if trimmed.chars().count() > 100 {
                return Err(ApiErr::invalid("name", "Must be 100 or fewer in length."));
            }
            trimmed.to_owned()
        } else {
            channel_name(kind, name)?
        }),
        None => None,
    };
    crate::voice::validate_channel_settings(&state.config, kind == ChannelType::GuildVoice, body.bitrate, body.user_limit)?;
    if let Some(seconds) = body.rate_limit_per_user {
        if !matches!(kind, ChannelType::GuildText | ChannelType::GuildVoice) {
            return Err(ApiErr::invalid("rate_limit_per_user", "Slowmode is only available in text and voice channels."));
        }
        if seconds > MAX_SLOWMODE_SECONDS {
            return Err(ApiErr::invalid("rate_limit_per_user", "Must be between 0 and 21600."));
        }
    }
    let parent_fields = forums::ParentFields::from_update(kind, &body)?;
    let topic = if body.topic.is_some() { Some(clean_text(body.topic, 1024, "topic")?) } else { None };
    let parent = match body.parent_id {
        Some(parent) if parent.0 == 0 => Some(None),
        Some(parent) => {
            if kind == ChannelType::GuildCategory {
                return Err(ApiErr::invalid("parent_id", "Categories cannot be nested."));
            }
            let found: Option<(i64,)> = sqlx::query_as("SELECT id FROM channels WHERE id = $1 AND guild_id = $2 AND kind = 4")
                .bind(parent.db())
                .bind(access.channel.guild_id)
                .fetch_optional(&state.db)
                .await?;
            if found.is_none() {
                return Err(ApiErr::invalid("parent_id", "Must be a category of this guild."));
            }
            // A category the caller cannot see is not theirs to put channels into (403 50001).
            access::channel_access(&state, user_id, parent.db()).await?;
            Some(Some(parent.db()))
        }
        None => None,
    };
    // Moving under a category with lock_permissions adopts its overwrites; without a parent there is nothing to adopt.
    let lock_to = parent.flatten().filter(|_| body.lock_permissions == Some(true));
    let viewers_before = match lock_to {
        Some(_) => Some(access::channel_viewers(&state, &access.channel).await?),
        None => None,
    };
    let mut tx = state.db.begin().await?;
    // Lock the channel and its new category in id order before any write (`parent_id` has no foreign key, so a concurrent delete of the
    // category would otherwise leave a dangling parent; the same order as the bulk route avoids deadlocks).
    let mut lock_ids = vec![id];
    lock_ids.extend(parent.flatten());
    lock_ids.sort_unstable();
    lock_ids.dedup();
    let locked: Vec<(i64, Option<i64>, i16)> =
        sqlx::query_as("SELECT id, guild_id, kind FROM channels WHERE id = ANY($1) ORDER BY id FOR UPDATE").bind(&lock_ids).fetch_all(&mut *tx).await?;
    if let Some(Some(parent)) = parent
        && !locked.iter().any(|(row_id, guild, kind)| *row_id == parent && *guild == access.channel.guild_id && *kind == 4)
    {
        return Err(ApiErr::invalid("parent_id", "Must be a category of this guild."));
    }
    if let Some(name) = name {
        sqlx::query("UPDATE channels SET name = $2 WHERE id = $1").bind(id).bind((!name.is_empty()).then_some(name)).execute(&mut *tx).await?;
    }
    if let Some(topic) = topic {
        sqlx::query("UPDATE channels SET topic = $2 WHERE id = $1").bind(id).bind(topic).execute(&mut *tx).await?;
    }
    if let Some(bitrate) = body.bitrate {
        sqlx::query("UPDATE channels SET bitrate = $2 WHERE id = $1").bind(id).bind(bitrate as i32).execute(&mut *tx).await?;
    }
    if let Some(user_limit) = body.user_limit {
        sqlx::query("UPDATE channels SET user_limit = $2 WHERE id = $1").bind(id).bind(user_limit as i32).execute(&mut *tx).await?;
    }
    if let Some(seconds) = body.rate_limit_per_user {
        sqlx::query("UPDATE channels SET rate_limit_per_user = $2 WHERE id = $1").bind(id).bind(seconds as i32).execute(&mut *tx).await?;
    }
    if let Some(position) = body.position {
        sqlx::query("UPDATE channels SET position = $2 WHERE id = $1").bind(id).bind(position).execute(&mut *tx).await?;
    }
    if let Some(nsfw) = body.nsfw {
        sqlx::query("UPDATE channels SET nsfw = $2 WHERE id = $1").bind(id).bind(nsfw).execute(&mut *tx).await?;
    }
    if let Some(parent) = parent {
        sqlx::query("UPDATE channels SET parent_id = $2 WHERE id = $1").bind(id).bind(parent).execute(&mut *tx).await?;
    }
    if let Some(parent) = lock_to {
        overwrites::lock_to_parent(&mut tx, &access, parent).await?;
    }
    let changed_posts = parent_fields.apply(&state, &mut tx, id).await?;
    tx.commit().await?;
    let row = store::channel_row(&state, id).await?.ok_or_else(ApiErr::unknown_channel)?;
    match viewers_before {
        Some(before) => overwrites::dispatch_visibility(&state, &row, &before).await?,
        None => events::dispatch_channel(&state, &row, GatewayEvent::ChannelUpdate).await?,
    }
    forums::announce_changed_posts(&state, &changed_posts).await?;
    let channel = store::channel(&state, id, Some(user_id)).await?.ok_or_else(ApiErr::unknown_channel)?;
    if let (Some(guild_id), Some(before)) = (row.guild_id, before) {
        let entry = audit::channel_changes(Entry::new(guild_id, user_id, AuditLogEvent::ChannelUpdate, id).reason(reason), Some(&before), Some(&channel));
        if !entry.changes.is_empty() {
            audit::record(&state, entry).await?;
        }
    }
    Ok(Json(channel))
}

async fn delete_channel(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    AuditReason(reason): AuditReason,
) -> ApiResult<Json<Channel>> {
    let id = channel_id(&id)?;
    let access = channel_access(&state, user_id, id).await?;
    if access.channel.is_thread() {
        return threads_routes::delete_thread(&state, user_id, access).await;
    }
    let channel = store::channel(&state, id, Some(user_id)).await?.ok_or_else(ApiErr::unknown_channel)?;
    if access.is_dm() {
        // Closing a DM hides it for this user only; leaving a group DM removes the user.
        if access.channel.channel_type() == ChannelType::Dm {
            sqlx::query("UPDATE channel_recipients SET closed = TRUE WHERE channel_id = $1 AND user_id = $2").bind(id).bind(user_id).execute(&state.db).await?;
        } else {
            // Out of the group's call first, so the leaver still hears about it.
            let _eviction = crate::voice::state::dm_recipient_removed(&state, id, user_id).await;
            sqlx::query("DELETE FROM channel_recipients WHERE channel_id = $1 AND user_id = $2").bind(id).bind(user_id).execute(&state.db).await?;
            let (left,): (i64,) = sqlx::query_as("SELECT count(*) FROM channel_recipients WHERE channel_id = $1").bind(id).fetch_one(&state.db).await?;
            if left == 0 {
                sqlx::query("DELETE FROM channels WHERE id = $1").bind(id).execute(&state.db).await?;
            } else {
                events::dispatch_channel(&state, &access.channel, GatewayEvent::ChannelUpdate).await?;
            }
        }
        state.hub.send(&[user_id], &GatewayEvent::ChannelDelete(channel.clone()));
        return Ok(Json(channel));
    }
    access.require(MANAGE_CHANNELS)?;
    // The threads of a channel go with it, each announced before the channel itself.
    threads::delete_children(&state, id).await?;
    let viewers = access::channel_viewers(&state, &access.channel).await?;
    let guild_id = access.channel.guild_id;
    let _eviction = crate::voice::state::channel_deleted(&state, id).await;
    // Uploads in use as an avatar, icon or event cover (claimed, not on a message) outlive the channel they came through.
    // Locked first in one statement by ascending id; the delete touches only the rows locked here.
    let mut tx = state.db.begin().await?;
    let locked: Vec<i64> = sqlx::query_scalar(
        "SELECT id FROM attachments WHERE channel_id = $1 AND NOT sticker_asset AND NOT (message_id IS NULL AND claimed_at IS NOT NULL) \
         ORDER BY id FOR UPDATE",
    )
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;
    let attachments: Vec<(i64,)> = sqlx::query_as(&format!(
        "DELETE FROM attachments a WHERE a.id = ANY($2) AND channel_id = $1 AND NOT sticker_asset \
         AND NOT (message_id IS NULL AND (claimed_at IS NOT NULL OR {})) RETURNING id",
        crate::media::IN_USE
    ))
    .bind(id)
    .bind(&locked)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    // Members learn of a cleared system or rules channel through GUILD_UPDATE, after the CHANNEL_DELETE below.
    let cleared: Option<(i64,)> = sqlx::query_as(
        "UPDATE guilds SET system_channel_id = NULLIF(system_channel_id, $2), rules_channel_id = NULLIF(rules_channel_id, $2) \
         WHERE id = $1 AND (system_channel_id = $2 OR rules_channel_id = $2) RETURNING id",
    )
    .bind(guild_id)
    .bind(id)
    .fetch_optional(&state.db)
    .await?;
    crate::routes::scheduled_events::channel_removed(&state, id).await?;
    // Its invites lead nowhere now (no INVITE_DELETE: CHANNEL_DELETE already tells the same audience). One transaction with the
    // channel delete, so no invite outlives its channel.
    let mut tx = state.db.begin().await?;
    sqlx::query("DELETE FROM channels WHERE id = $1").bind(id).execute(&mut *tx).await?;
    // Children of a deleted category move to the top level; after the delete (which waits for any move into it) so none is missed.
    sqlx::query("UPDATE channels SET parent_id = NULL WHERE parent_id = $1").bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM invites WHERE channel_id = $1").bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    crate::media::remove_files(&state, &attachments.into_iter().map(|(id,)| id).collect::<Vec<_>>()).await;
    crate::stickers::sweep_assets(&state).await;
    state.hub.send(&viewers, &GatewayEvent::ChannelDelete(channel.clone()));
    if let Some((guild,)) = cleared
        && let Some(updated) = store::guild(&state, guild).await?
    {
        state.hub.send(&access::guild_member_ids(&state, guild).await?, &GatewayEvent::GuildUpdate(updated));
    }
    if let Some(guild_id) = guild_id {
        audit::record(&state, audit::channel_changes(Entry::new(guild_id, user_id, AuditLogEvent::ChannelDelete, id).reason(reason), Some(&channel), None))
            .await?;
    }
    Ok(Json(channel))
}
