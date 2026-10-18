use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{patch, put};
use vokko_protocol::api::permissions::MANAGE_CHANNELS;
use vokko_protocol::api::{AuditLogEvent, Channel, ChannelRecipient, ChannelType, GatewayEvent, Snowflake, UpdateChannelRequest};

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
    Router::new()
        .route("/channels/{id}", patch(update_channel).delete(delete_channel))
        .route("/channels/{id}/recipients/{user_id}", put(add_recipient).delete(remove_recipient))
}

async fn group_access(state: &AppState, user_id: i64, id: &str) -> ApiResult<access::ChannelAccess> {
    let access = channel_access(state, user_id, channel_id(id)?).await?;
    if access.channel.channel_type() != ChannelType::GroupDm {
        return Err(ApiErr::wrong_channel_type());
    }
    Ok(access)
}

/// `PUT /channels/{id}/recipients/{user_id}`: a recipient adds one of their friends to the group DM.
async fn add_recipient(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path((id, target)): Path<(String, String)>) -> ApiResult<StatusCode> {
    let access = group_access(&state, user_id, &id).await?;
    let target = parse_id(&target).ok_or_else(ApiErr::unknown_user)?;
    let channel_id = access.channel.id;
    let Some(user) = store::user(&state, target).await? else { return Err(ApiErr::unknown_user()) };
    let (member,): (bool,) = sqlx::query_as("SELECT EXISTS (SELECT 1 FROM channel_recipients WHERE channel_id = $1 AND user_id = $2)")
        .bind(channel_id)
        .bind(target)
        .fetch_one(&state.db)
        .await?;
    if member {
        return Ok(StatusCode::NO_CONTENT);
    }
    // Friends only; a block either way removes the friendship, so it ends up here too.
    let (friend,): (bool,) = sqlx::query_as("SELECT EXISTS (SELECT 1 FROM relationships WHERE user_id = $1 AND other_id = $2 AND kind = 1)")
        .bind(user_id)
        .bind(target)
        .fetch_one(&state.db)
        .await?;
    if !friend {
        return Err(ApiErr::cannot_message_user());
    }
    // The channel row serializes concurrent adds, so the cap holds.
    let mut tx = state.db.begin().await?;
    // A group that just emptied is gone (unknown channel); a caller removed since group_access may no longer add anyone.
    let locked: Option<i64> = sqlx::query_scalar("SELECT id FROM channels WHERE id = $1 FOR UPDATE").bind(channel_id).fetch_optional(&mut *tx).await?;
    if locked.is_none() {
        return Err(ApiErr::unknown_channel());
    }
    let (still_member,): (bool,) = sqlx::query_as("SELECT EXISTS (SELECT 1 FROM channel_recipients WHERE channel_id = $1 AND user_id = $2)")
        .bind(channel_id)
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await?;
    if !still_member {
        return Err(ApiErr::missing_access());
    }
    let (count,): (i64,) = sqlx::query_as("SELECT count(*) FROM channel_recipients WHERE channel_id = $1").bind(channel_id).fetch_one(&mut *tx).await?;
    let max = state.config.group_dm_max;
    if count >= max {
        return Err(ApiErr::conflict(30004, &format!("Maximum number of group DM recipients reached ({max})")));
    }
    let added = sqlx::query("INSERT INTO channel_recipients (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING")
        .bind(channel_id)
        .bind(target)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO read_states (user_id, channel_id) VALUES ($1, $2) ON CONFLICT DO NOTHING").bind(target).bind(channel_id).execute(&mut *tx).await?;
    tx.commit().await?;
    if added.rows_affected() > 0 {
        let others: Vec<i64> = access::channel_viewers(&state, &access.channel).await?.into_iter().filter(|viewer| *viewer != target).collect();
        state.hub.send(&others, &GatewayEvent::ChannelRecipientAdd(ChannelRecipient { channel_id: Snowflake::from(channel_id), user }));
        if let Some(channel) = store::channel(&state, channel_id, Some(target)).await? {
            state.hub.send(&[target], &GatewayEvent::ChannelCreate(channel));
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `DELETE /channels/{id}/recipients/{user_id}`: the owner removes someone; anyone removes themselves (= leaving).
async fn remove_recipient(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path((id, target)): Path<(String, String)>) -> ApiResult<StatusCode> {
    let access = group_access(&state, user_id, &id).await?;
    let target = parse_id(&target).ok_or_else(ApiErr::unknown_user)?;
    if target != user_id && access.channel.owner_id != Some(user_id) {
        return Err(ApiErr::missing_permissions());
    }
    leave_group(&state, &access.channel, target).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Takes `target` out of the group DM: out of its call and voice room first, then the row; the rest hear CHANNEL_RECIPIENT_REMOVE,
/// `target` CHANNEL_DELETE. An empty group goes away. A non-recipient `target` is a no-op.
async fn leave_group(state: &AppState, row: &store::ChannelRow, target: i64) -> ApiResult<()> {
    let id = row.id;
    let Some(channel) = store::channel(state, id, Some(target)).await? else { return Err(ApiErr::unknown_channel()) };
    let Some(user) = store::user(state, target).await? else { return Err(ApiErr::unknown_user()) };
    let _eviction = crate::voice::state::dm_recipient_removed(state, id, target).await;
    let mut tx = state.db.begin().await?;
    // The channel row lock serializes concurrent leaves and adds: the hand-off below sees the current owner and recipients.
    let owner: Option<i64> = sqlx::query_scalar("SELECT owner_id FROM channels WHERE id = $1 FOR UPDATE").bind(id).fetch_optional(&mut *tx).await?.flatten();
    let removed = sqlx::query("DELETE FROM channel_recipients WHERE channel_id = $1 AND user_id = $2").bind(id).bind(target).execute(&mut *tx).await?;
    if removed.rows_affected() == 0 {
        return Ok(());
    }
    let rest: Vec<i64> =
        sqlx::query_scalar("SELECT user_id FROM channel_recipients WHERE channel_id = $1 ORDER BY user_id").bind(id).fetch_all(&mut *tx).await?;
    // The owner leaving hands the group to the lowest remaining id, so owner_id never points at a non-recipient.
    let new_owner = if owner == Some(target) { rest.first().copied() } else { None };
    if let Some(owner) = new_owner {
        sqlx::query("UPDATE channels SET owner_id = $2 WHERE id = $1").bind(id).bind(owner).execute(&mut *tx).await?;
    }
    if rest.is_empty() {
        sqlx::query("DELETE FROM channels WHERE id = $1").bind(id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    if !rest.is_empty() {
        state.hub.send(&rest, &GatewayEvent::ChannelRecipientRemove(ChannelRecipient { channel_id: Snowflake::from(id), user }));
        if new_owner.is_some()
            && let Some(updated) = store::channel_row(state, id).await?
        {
            events::dispatch_channel(state, &updated, GatewayEvent::ChannelUpdate).await?;
        }
    }
    state.hub.send(&[target], &GatewayEvent::ChannelDelete(channel));
    Ok(())
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
            leave_group(&state, &access.channel, user_id).await?;
            return Ok(Json(channel));
        }
        state.hub.send(&[user_id], &GatewayEvent::ChannelDelete(channel.clone()));
        return Ok(Json(channel));
    }
    access.require(MANAGE_CHANNELS)?;
    // Like Discord: a Community's rules and updates channels can't be deleted while Community is on (400 50074).
    // Checked before the delete, not under a guild row lock: a PATCH enabling Community in between is still cleared by the foreign key.
    let (required,): (bool,) =
        sqlx::query_as("SELECT EXISTS (SELECT 1 FROM guilds WHERE id = $1 AND community AND $2 IN (rules_channel_id, public_updates_channel_id))")
            .bind(access.channel.guild_id)
            .bind(id)
            .fetch_one(&state.db)
            .await?;
    if required {
        return Err(ApiErr::conflict(50074, "Cannot delete a channel required for Community guilds"));
    }
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
        "UPDATE guilds SET system_channel_id = NULLIF(system_channel_id, $2), rules_channel_id = NULLIF(rules_channel_id, $2), \
         public_updates_channel_id = NULLIF(public_updates_channel_id, $2) \
         WHERE id = $1 AND (system_channel_id = $2 OR rules_channel_id = $2 OR public_updates_channel_id = $2) RETURNING id",
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
