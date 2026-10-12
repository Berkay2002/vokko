use std::collections::{HashMap, HashSet};

use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get};
use serde::Deserialize;
use vokko_protocol::api::permissions::{DEFAULT_EVERYONE, MANAGE_CHANNELS, MANAGE_GUILD, MANAGE_ROLES, VIEW_CHANNEL};
use vokko_protocol::api::{
    AuditLogEvent, Channel, ChannelType, CreateChannelRequest, CreateGuildRequest, GatewayEvent, Guild, GuildMember, GuildTag, GuildTheme, IdOnly,
    ModifyChannelPosition, Snowflake, UpdateGuildRequest,
};

use crate::access::{self, ChannelAccess, guild_access};
use crate::audit::{self, AuditReason, Entry};
use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::events;
use crate::extract::{ApiJson, ApiQuery, parse_id};
use crate::media;
use crate::routes::auth::clean_text;
use crate::routes::forums;
use crate::routes::moderation;
use crate::routes::overwrites;
use crate::routes::users::{self, ImageKind, image_path_on};
use crate::state::AppState;
use crate::store::{self, ChannelRow};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/guilds", axum::routing::post(create_guild))
        .route("/guilds/{id}", get(get_guild).patch(update_guild).delete(delete_guild))
        .route("/guilds/{id}/channels", get(list_channels).post(create_channel).patch(modify_channel_positions))
        .route("/guilds/{id}/members", get(list_members))
        .route("/users/@me/guilds", get(my_guilds))
        .route("/users/@me/guilds/{id}", delete(leave_guild))
}

fn guild_id(raw: &str) -> ApiResult<i64> {
    parse_id(raw).ok_or_else(ApiErr::unknown_guild)
}

fn guild_name(value: &str) -> ApiResult<String> {
    let name = value.trim().to_owned();
    if !(2..=100).contains(&name.chars().count()) {
        return Err(ApiErr::invalid("name", "Must be between 2 and 100 in length."));
    }
    Ok(name)
}

/// Text channel names follow Discord's rules: lowercase, spaces become dashes.
pub fn channel_name(kind: ChannelType, value: &str) -> ApiResult<String> {
    let trimmed = value.trim();
    let name = if matches!(kind, ChannelType::GuildText | ChannelType::GuildAnnouncement | ChannelType::GuildForum) {
        trimmed.to_lowercase().split_whitespace().collect::<Vec<_>>().join("-")
    } else {
        trimmed.to_owned()
    };
    if !(1..=100).contains(&name.chars().count()) {
        return Err(ApiErr::invalid("name", "Must be between 1 and 100 in length."));
    }
    Ok(name)
}

async fn create_guild(State(state): State<AppState>, AuthUser(user_id): AuthUser, ApiJson(body): ApiJson<CreateGuildRequest>) -> ApiResult<Json<Guild>> {
    let name = guild_name(&body.name)?;
    let mut tx = state.db.begin().await?;
    let icon_path = match body.icon_attachment_id {
        Some(id) => Some(image_path_on(&mut tx, id.db(), user_id, ImageKind::Avatar, "icon_attachment_id", false).await?),
        None => None,
    };
    let guild_id = state.ids.next();
    let text_category = state.ids.next();
    let voice_category = state.ids.next();
    let general = state.ids.next();
    let voice = state.ids.next();
    sqlx::query("INSERT INTO guilds (id, name, icon_path, owner_id, system_channel_id) VALUES ($1, $2, $3, $4, $5)")
        .bind(guild_id)
        .bind(&name)
        .bind(&icon_path)
        .bind(user_id)
        .bind(general)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO roles (id, guild_id, name, position, permissions) VALUES ($1, $1, '@everyone', 0, $2)")
        .bind(guild_id)
        .bind(DEFAULT_EVERYONE as i64)
        .execute(&mut *tx)
        .await?;
    let channels: [(i64, ChannelType, &str, Option<i64>, i32); 4] = [
        (text_category, ChannelType::GuildCategory, "Text Channels", None, 0),
        (voice_category, ChannelType::GuildCategory, "Voice Channels", None, 1),
        (general, ChannelType::GuildText, "general", Some(text_category), 0),
        (voice, ChannelType::GuildVoice, "General", Some(voice_category), 0),
    ];
    for (id, kind, channel, parent, position) in channels {
        sqlx::query("INSERT INTO channels (id, kind, guild_id, name, position, parent_id) VALUES ($1, $2, $3, $4, $5, $6)")
            .bind(id)
            .bind(kind.as_u8() as i16)
            .bind(guild_id)
            .bind(channel)
            .bind(position)
            .bind(parent)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("INSERT INTO guild_members (guild_id, user_id) VALUES ($1, $2)").bind(guild_id).bind(user_id).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO read_states (user_id, channel_id) SELECT $1, id FROM channels WHERE guild_id = $2 AND kind IN (0, 2)")
        .bind(user_id)
        .bind(guild_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    let full = events::guild_with_state(&state, guild_id, user_id).await?;
    let guild = full.guild.clone();
    state.hub.send(&[user_id], &GatewayEvent::GuildCreate(Box::new(full)));
    Ok(Json(guild))
}

async fn my_guilds(State(state): State<AppState>, AuthUser(user_id): AuthUser) -> ApiResult<Json<Vec<Guild>>> {
    Ok(Json(store::guilds_of_user(&state, user_id).await?))
}

async fn get_guild(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Guild>> {
    let id = guild_id(&id)?;
    guild_access(&state, user_id, id).await?;
    store::guild(&state, id).await?.map(Json).ok_or_else(ApiErr::unknown_guild)
}

async fn update_guild(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    AuditReason(reason): AuditReason,
    ApiJson(body): ApiJson<UpdateGuildRequest>,
) -> ApiResult<Json<Guild>> {
    let id = guild_id(&id)?;
    guild_access(&state, user_id, id).await?.require(MANAGE_GUILD)?;
    let before = store::guild(&state, id).await?.ok_or_else(ApiErr::unknown_guild)?;
    // Validate every key first so a rejected request changes nothing.
    let name = body.name.as_deref().map(guild_name).transpose()?;
    if let Some(channel) = body.system_channel_id {
        let found: Option<(i64,)> = sqlx::query_as("SELECT id FROM channels WHERE id = $1 AND guild_id = $2 AND kind = 0")
            .bind(channel.db())
            .bind(id)
            .fetch_optional(&state.db)
            .await?;
        if found.is_none() {
            return Err(ApiErr::invalid("system_channel_id", "Must be a text channel of this guild."));
        }
    }
    let tag = match body.tag {
        None => None,
        Some(None) => Some(None),
        Some(Some(tag)) => Some(Some(guild_tag(tag)?)),
    };
    let theme = match body.theme {
        None => None,
        Some(None) => Some(None),
        Some(Some(theme)) => Some(Some(guild_theme(theme)?)),
    };

    // Claims and writes share one transaction: a rejected upload (or any failed write) leaves nothing claimed and nothing changed.
    let mut tx = state.db.begin().await?;
    let icon_path = match body.icon_attachment_id {
        Some(icon) => Some(image_path_on(&mut tx, icon.db(), user_id, ImageKind::Avatar, "icon_attachment_id", false).await?),
        None => None,
    };
    let banner = match body.banner_attachment_id {
        None => None,
        Some(None) => Some(None),
        Some(Some(banner)) => Some(Some(image_path_on(&mut tx, banner.db(), user_id, ImageKind::Banner, "banner_attachment_id", false).await?)),
    };
    let mut replaced_banner: Option<String> = None;
    if let Some(name) = name {
        sqlx::query("UPDATE guilds SET name = $2 WHERE id = $1").bind(id).bind(name).execute(&mut *tx).await?;
    }
    if let Some(path) = icon_path {
        sqlx::query("UPDATE guilds SET icon_path = $2 WHERE id = $1").bind(id).bind(path).execute(&mut *tx).await?;
    }
    if let Some(banner) = banner {
        // Swapped in one statement that hands back the banner it replaced, so concurrent edits each release what they actually replaced.
        let (old,): (Option<String>,) = sqlx::query_as(
            "UPDATE guilds g SET banner_path = $2 FROM (SELECT banner_path FROM guilds WHERE id = $1 FOR UPDATE) o WHERE g.id = $1 RETURNING o.banner_path",
        )
        .bind(id)
        .bind(&banner)
        .fetch_one(&mut *tx)
        .await?;
        replaced_banner = old.filter(|old| Some(old) != banner.as_ref());
    }
    if let Some(channel) = body.system_channel_id {
        sqlx::query("UPDATE guilds SET system_channel_id = $2 WHERE id = $1").bind(id).bind(channel.db()).execute(&mut *tx).await?;
    }
    if let Some(level) = body.verification_level {
        sqlx::query("UPDATE guilds SET verification_level = $2 WHERE id = $1").bind(id).bind(level.as_u8() as i16).execute(&mut *tx).await?;
    }
    if let Some(filter) = body.explicit_content_filter {
        sqlx::query("UPDATE guilds SET explicit_content_filter = $2 WHERE id = $1").bind(id).bind(filter.as_u8() as i16).execute(&mut *tx).await?;
    }
    if let Some(theme) = theme {
        sqlx::query("UPDATE guilds SET theme_preset = $2, theme_primary = $3, theme_accent = $4 WHERE id = $1")
            .bind(id)
            .bind(theme.as_ref().and_then(|theme| theme.0.clone()))
            .bind(theme.as_ref().map(|theme| theme.1))
            .bind(theme.as_ref().map(|theme| theme.2))
            .execute(&mut *tx)
            .await?;
    }
    // Members who show this guild's tag carry it inside their user object, so a tag edit is a USER_UPDATE for each of them.
    let mut adopters: Vec<i64> = Vec::new();
    if let Some(tag) = tag {
        sqlx::query("UPDATE guilds SET tag = $2, tag_badge = $3, tag_color_primary = $4, tag_color_secondary = $5 WHERE id = $1")
            .bind(id)
            .bind(tag.as_ref().map(|tag| tag.0.clone()))
            .bind(tag.as_ref().map(|tag| tag.1.clone()))
            .bind(tag.as_ref().map(|tag| tag.2))
            .bind(tag.as_ref().map(|tag| tag.3))
            .execute(&mut *tx)
            .await?;
        let rows: Vec<(i64,)> = if tag.is_some() {
            sqlx::query_as("SELECT id FROM users WHERE primary_guild_id = $1").bind(id).fetch_all(&mut *tx).await?
        } else {
            // Without a tag nobody can keep it as their primary guild.
            sqlx::query_as("UPDATE users SET primary_guild_id = NULL WHERE primary_guild_id = $1 RETURNING id").bind(id).fetch_all(&mut *tx).await?
        };
        adopters = rows.into_iter().map(|(user,)| user).collect();
    }
    tx.commit().await?;
    if let Some(old) = replaced_banner {
        release_upload(&state, &old).await;
    }
    let guild = store::guild(&state, id).await?.ok_or_else(ApiErr::unknown_guild)?;
    let members = access::guild_member_ids(&state, id).await?;
    state.hub.send(&members, &GatewayEvent::GuildUpdate(guild.clone()));
    for adopter in adopters {
        users::publish_user(&state, adopter).await?;
    }
    let entry = Entry::new(id, user_id, AuditLogEvent::GuildUpdate, id)
        .reason(reason)
        .change("name", &before.name, &guild.name)
        .change("icon", &before.icon, &guild.icon)
        .change("banner", &before.banner, &guild.banner)
        .change("system_channel_id", before.system_channel_id, guild.system_channel_id)
        .change("verification_level", before.verification_level.as_u8(), guild.verification_level.as_u8())
        .change("explicit_content_filter", before.explicit_content_filter.as_u8(), guild.explicit_content_filter.as_u8())
        .change("tag", before.tag.as_ref().map(|tag| &tag.tag), guild.tag.as_ref().map(|tag| &tag.tag));
    if !entry.changes.is_empty() {
        audit::record(&state, entry).await?;
    }
    Ok(Json(guild))
}

/// Deletes the upload behind a replaced or cleared guild banner (row and file) unless something else still shows it: another banner,
/// an icon, an avatar, an event cover or a sticker.
async fn release_upload(state: &AppState, path: &str) {
    let Some(upload) = path.split('/').next().and_then(|id| id.parse::<i64>().ok()) else { return };
    // Lock the row first: a claim racing with us either commits before the DELETE below (its fresh snapshot then sees the new
    // reference) or waits for our delete and fails to claim.
    let deleted: Result<Vec<(i64,)>, sqlx::Error> = async {
        let mut tx = state.db.begin().await?;
        sqlx::query("SELECT id FROM attachments WHERE id = $1 FOR UPDATE").bind(upload).execute(&mut *tx).await?;
        let rows = sqlx::query_as(&format!(
            "DELETE FROM attachments a WHERE a.id = $1 AND a.message_id IS NULL AND NOT a.sticker_asset AND NOT a.event_cover AND NOT {} RETURNING a.id",
            media::IN_USE
        ))
        .bind(upload)
        .fetch_all(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(rows)
    }
    .await;
    match deleted {
        Ok(rows) => media::remove_files(state, &rows.into_iter().map(|(id,)| id).collect::<Vec<_>>()).await,
        Err(error) => tracing::warn!("releasing a guild banner failed: {error}"),
    }
}

/// (tag, badge, primary colour, secondary colour) as stored.
type TagColumns = (String, String, i32, i32);

fn guild_tag(tag: GuildTag) -> ApiResult<TagColumns> {
    let text = tag.tag.trim().to_owned();
    if !(1..=4).contains(&text.chars().count()) || text.chars().any(char::is_whitespace) {
        return Err(ApiErr::invalid("tag", "Must be 1-4 characters without spaces."));
    }
    let Some(badge) = users::asset_id(Some(tag.badge), "tag.badge")? else {
        return Err(ApiErr::invalid("tag.badge", "Required."));
    };
    Ok((text, badge, users::rgb(tag.color_primary, "tag.color_primary")?, users::rgb(tag.color_secondary, "tag.color_secondary")?))
}

/// (preset id, primary, accent) as stored.
type ThemeColumns = (Option<String>, i32, i32);

fn guild_theme(theme: GuildTheme) -> ApiResult<ThemeColumns> {
    let preset = users::asset_id(theme.preset, "theme.preset")?;
    let (primary, accent) = users::theme_pair([theme.primary, theme.accent], "theme")?;
    Ok((preset, primary, accent))
}

async fn delete_guild(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<StatusCode> {
    let id = guild_id(&id)?;
    let guild = guild_access(&state, user_id, id).await?;
    if guild.owner_id != user_id {
        return Err(ApiErr::missing_permissions());
    }
    let members = access::guild_member_ids(&state, id).await?;
    // The FK clears their primary guild; their audience hears about it as USER_UPDATE once the guild is gone.
    let adopters: Vec<(i64,)> = sqlx::query_as("SELECT id FROM users WHERE primary_guild_id = $1").bind(id).fetch_all(&state.db).await?;
    crate::routes::scheduled_events::release_guild_covers(&state, id).await;
    let attachments: Vec<(i64,)> =
        sqlx::query_as("DELETE FROM attachments WHERE channel_id IN (SELECT id FROM channels WHERE guild_id = $1) AND NOT sticker_asset AND NOT (message_id IS NULL AND claimed_at IS NOT NULL) RETURNING id")
            .bind(id)
            .fetch_all(&state.db)
            .await?;
    // emoji images are claimed uploads, so nothing else would ever sweep them once the guild's rows cascade away
    let emoji_attachments: Vec<(i64,)> = sqlx::query_as("SELECT attachment_id FROM emojis WHERE guild_id = $1").bind(id).fetch_all(&state.db).await?;
    let emoji_attachments: Vec<i64> = emoji_attachments.into_iter().map(|(attachment,)| attachment).collect();
    let _eviction = crate::voice::state::guild_deleted(&state, id).await;
    let banner: Option<(Option<String>,)> = sqlx::query_as("DELETE FROM guilds WHERE id = $1 RETURNING banner_path").bind(id).fetch_optional(&state.db).await?;
    if let Some(path) = banner.and_then(|(path,)| path) {
        release_upload(&state, &path).await;
    }
    let removed: Vec<(i64,)> = sqlx::query_as("DELETE FROM attachments WHERE id = ANY($1) RETURNING id").bind(&emoji_attachments).fetch_all(&state.db).await?;
    let mut files: Vec<i64> = attachments.into_iter().map(|(id,)| id).collect();
    files.extend(removed.into_iter().map(|(attachment,)| attachment));
    media::remove_files(&state, &files).await;
    crate::stickers::sweep_assets(&state).await;
    crate::soundboard::sweep_assets(&state).await;
    state.hub.send(&members, &GatewayEvent::GuildDelete(IdOnly { id: Snowflake::from(id) }));
    for (adopter,) in adopters {
        users::publish_user(&state, adopter).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn list_channels(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Vec<Channel>>> {
    let id = guild_id(&id)?;
    let rows = access::visible_guild_channels(&state, user_id, id).await?;
    Ok(Json(store::channels_to_api(&state, rows, Some(user_id)).await?))
}

/// Discord's "Modify Guild Channel Positions": validates every entry first, then applies all of them in one transaction.
async fn modify_channel_positions(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    AuditReason(reason): AuditReason,
    ApiJson(body): ApiJson<Vec<ModifyChannelPosition>>,
) -> ApiResult<StatusCode> {
    let id = guild_id(&id)?;
    let guild = guild_access(&state, user_id, id).await?;
    guild.require(MANAGE_CHANNELS)?;
    if body.is_empty() || body.len() > 500 {
        return Err(ApiErr::invalid("channels", "Must contain between 1 and 500 channels."));
    }
    // One load of the guild's non-thread channels with what the caller may do in each (threads and other guilds' channels are not in it).
    let known: HashMap<i64, (ChannelRow, u64)> =
        access::guild_channels_resolved(&state, user_id, id, &guild).await?.into_iter().map(|(row, permissions)| (row.id, (row, permissions))).collect();
    let mut seen = HashSet::new();
    let mut parents = Vec::new();
    let mut targets = Vec::with_capacity(body.len());
    for entry in &body {
        if !seen.insert(entry.id.db()) {
            return Err(ApiErr::invalid("id", "Duplicate channel id."));
        }
        let (row, permissions) = known.get(&entry.id.db()).ok_or_else(|| ApiErr::invalid("id", "Must be a channel of this guild."))?;
        let channel_access = ChannelAccess { channel: row.clone(), permissions: *permissions, parent: None };
        if permissions & VIEW_CHANNEL == 0 {
            return Err(ApiErr::missing_access());
        }
        channel_access.require(MANAGE_CHANNELS)?;
        let parent = match entry.parent_id {
            Some(Some(parent)) if parent.0 != 0 => {
                if row.kind == ChannelType::GuildCategory.as_u8() as i16 {
                    return Err(ApiErr::invalid("parent_id", "Categories cannot be nested."));
                }
                match known.get(&parent.db()) {
                    Some((parent_row, _)) if parent_row.kind == ChannelType::GuildCategory.as_u8() as i16 => {}
                    _ => return Err(ApiErr::invalid("parent_id", "Must be a category of this guild.")),
                }
                // A category the caller cannot see is not theirs to put channels into (or to copy overwrites from).
                if known.get(&parent.db()).is_some_and(|(_, permissions)| permissions & VIEW_CHANNEL == 0) {
                    return Err(ApiErr::missing_access());
                }
                parents.push(parent.db());
                Some(Some(parent.db()))
            }
            Some(_) => Some(None),
            None => None,
        };
        let lock_to = parent.flatten().filter(|_| entry.lock_permissions == Some(true));
        let viewers_before = match lock_to {
            Some(_) => Some(access::channel_viewers(&state, row).await?),
            None => None,
        };
        let changed =
            entry.position.is_some_and(|position| position != row.position) || parent.is_some_and(|parent| parent != row.parent_id) || lock_to.is_some();
        targets.push(Target { access: channel_access, position: entry.position, parent, lock_to, viewers_before, changed });
    }
    // Ordered by id so concurrent reorders take their row locks in the same order.
    targets.sort_by_key(|target| target.access.channel.id);
    parents.sort_unstable();
    parents.dedup();
    let ids: Vec<i64> = targets.iter().map(|target| target.access.channel.id).collect();

    let mut tx = state.db.begin().await?;
    // The categories stay categories of this guild until commit (`parent_id` has no foreign key), the targets stay put while we write.
    // One lock pass over parents and targets in id order, so concurrent edits and category deletes cannot deadlock.
    let mut lock_ids = ids.clone();
    lock_ids.extend(&parents);
    lock_ids.sort_unstable();
    lock_ids.dedup();
    let locked: Vec<(i64, Option<i64>, i16)> =
        sqlx::query_as("SELECT id, guild_id, kind FROM channels WHERE id = ANY($1) ORDER BY id FOR UPDATE").bind(&lock_ids).fetch_all(&mut *tx).await?;
    let categories = locked.iter().filter(|(row_id, guild, kind)| parents.contains(row_id) && *guild == Some(id) && *kind == 4).count();
    if categories != parents.len() || locked.len() != lock_ids.len() {
        return Err(ApiErr::invalid("parent_id", "Must be a category of this guild."));
    }
    let positions: Vec<Option<i32>> = targets.iter().map(|target| target.position).collect();
    let set_parent: Vec<bool> = targets.iter().map(|target| target.parent.is_some()).collect();
    let new_parents: Vec<Option<i64>> = targets.iter().map(|target| target.parent.flatten()).collect();
    sqlx::query(
        "UPDATE channels c SET position = COALESCE(u.position, c.position), parent_id = CASE WHEN u.set_parent THEN u.parent_id ELSE c.parent_id END \
         FROM UNNEST($1::bigint[], $2::int[], $3::bool[], $4::bigint[]) AS u(id, position, set_parent, parent_id) WHERE c.id = u.id",
    )
    .bind(&ids)
    .bind(&positions)
    .bind(&set_parent)
    .bind(&new_parents)
    .execute(&mut *tx)
    .await?;
    for target in &targets {
        if let Some(parent) = target.lock_to {
            overwrites::lock_to_parent(&mut tx, &target.access, parent).await?;
        }
    }
    tx.commit().await?;
    let changed: Vec<i64> = targets.iter().filter(|target| target.changed).map(|target| target.access.channel.id).collect();
    let rows: Vec<ChannelRow> =
        sqlx::query_as(&format!("SELECT {} FROM channels WHERE id = ANY($1) ORDER BY id", store::CHANNEL_COLS)).bind(&changed).fetch_all(&state.db).await?;
    // One ChannelUpdate audit entry per channel whose position or parent actually changed.
    let old_rows: Vec<ChannelRow> = targets.iter().filter(|target| target.changed).map(|target| target.access.channel.clone()).collect();
    let old_api: HashMap<_, _> = store::channels_to_api(&state, old_rows, None).await?.into_iter().map(|channel| (channel.id.db(), channel)).collect();
    for channel in store::channels_to_api(&state, rows.clone(), None).await? {
        let Some(old) = old_api.get(&channel.id.db()) else { continue };
        let entry =
            audit::channel_changes(Entry::new(id, user_id, AuditLogEvent::ChannelUpdate, channel.id.db()).reason(reason.clone()), Some(old), Some(&channel));
        if !entry.changes.is_empty() {
            audit::record(&state, entry).await?;
        }
    }
    let mut before: HashMap<i64, Option<Vec<i64>>> = targets.into_iter().map(|target| (target.access.channel.id, target.viewers_before)).collect();
    for row in rows {
        match before.remove(&row.id).flatten() {
            Some(viewers) => overwrites::dispatch_visibility(&state, &row, &viewers).await?,
            None => events::dispatch_channel(&state, &row, GatewayEvent::ChannelUpdate).await?,
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

/// One validated entry of `modify_channel_positions`.
struct Target {
    access: ChannelAccess,
    position: Option<i32>,
    /// `Some(None)` clears the category.
    parent: Option<Option<i64>>,
    lock_to: Option<i64>,
    viewers_before: Option<Vec<i64>>,
    changed: bool,
}

async fn create_channel(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    AuditReason(reason): AuditReason,
    ApiJson(body): ApiJson<CreateChannelRequest>,
) -> ApiResult<Json<Channel>> {
    let id = guild_id(&id)?;
    let guild = guild_access(&state, user_id, id).await?;
    guild.require(MANAGE_CHANNELS)?;
    if !matches!(
        body.kind,
        ChannelType::GuildText
            | ChannelType::GuildVoice
            | ChannelType::GuildCategory
            | ChannelType::GuildAnnouncement
            | ChannelType::GuildStage
            | ChannelType::GuildForum
    ) {
        return Err(ApiErr::invalid("type", "Unsupported channel type."));
    }
    if body.nsfw.is_some() && !matches!(body.kind, ChannelType::GuildText | ChannelType::GuildAnnouncement | ChannelType::GuildForum | ChannelType::GuildVoice)
    {
        return Err(ApiErr::invalid("nsfw", "Only text, announcement, forum and voice channels can be age-restricted."));
    }
    let name = channel_name(body.kind, &body.name)?;
    crate::voice::validate_channel_settings(&state.config, body.kind == ChannelType::GuildVoice, body.bitrate, body.user_limit)?;
    let forum_fields = forums::ParentFields::from_create(&body)?;
    let topic = if matches!(body.kind, ChannelType::GuildText | ChannelType::GuildAnnouncement | ChannelType::GuildForum) {
        clean_text(body.topic, 1024, "topic")?
    } else {
        None
    };
    let parent = match body.parent_id {
        Some(parent) if parent.0 != 0 => {
            if matches!(body.kind, ChannelType::GuildCategory) {
                return Err(ApiErr::invalid("parent_id", "Categories cannot be nested."));
            }
            let found: Option<(i64,)> = sqlx::query_as("SELECT id FROM channels WHERE id = $1 AND guild_id = $2 AND kind = 4")
                .bind(parent.db())
                .bind(id)
                .fetch_optional(&state.db)
                .await?;
            if found.is_none() {
                return Err(ApiErr::invalid("parent_id", "Must be a category of this guild."));
            }
            Some(parent.db())
        }
        _ => None,
    };
    // Explicit overwrites follow the PUT rules (MANAGE_ROLES, nothing beyond the creator's own permissions); the channel does
    // not exist yet, so the creator's guild-wide permissions stand in for "in that channel".
    let mut explicit = Vec::new();
    if let Some(requested) = &body.permission_overwrites
        && !requested.is_empty()
    {
        guild.require(MANAGE_ROLES)?;
        for overwrite in requested {
            explicit.push(overwrites::validate(&state, id, guild.permissions, overwrite.id.db(), overwrite.kind, &overwrite.allow, &overwrite.deny).await?);
        }
    }
    let (position,): (i32,) =
        sqlx::query_as("SELECT COALESCE(MAX(position) + 1, 0)::int FROM channels WHERE guild_id = $1 AND kind = $2 AND parent_id IS NOT DISTINCT FROM $3")
            .bind(id)
            .bind(body.kind.as_u8() as i16)
            .bind(parent)
            .fetch_one(&state.db)
            .await?;
    let channel_id = state.ids.next();
    let mut tx = state.db.begin().await?;
    sqlx::query("INSERT INTO channels (id, kind, guild_id, name, topic, position, parent_id, bitrate, user_limit, nsfw) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)")
        .bind(channel_id)
        .bind(body.kind.as_u8() as i16)
        .bind(id)
        .bind(&name)
        .bind(&topic)
        .bind(position)
        .bind(parent)
        .bind(body.bitrate.map(|value| value as i32))
        .bind(body.user_limit.map(|value| value as i32))
        .bind(body.nsfw.unwrap_or(false))
        .execute(&mut *tx)
        .await?;
    match (&body.permission_overwrites, parent) {
        (Some(_), _) => {
            for write in &explicit {
                overwrites::store_overwrite(&mut tx, channel_id, write).await?;
            }
        }
        (None, Some(parent)) => overwrites::copy_overwrites(&mut tx, parent, channel_id).await?,
        (None, None) => {}
    }
    if !matches!(body.kind, ChannelType::GuildCategory) {
        sqlx::query("INSERT INTO read_states (user_id, channel_id) SELECT user_id, $2 FROM guild_members WHERE guild_id = $1 ON CONFLICT DO NOTHING")
            .bind(id)
            .bind(channel_id)
            .execute(&mut *tx)
            .await?;
    }
    forum_fields.apply(&state, &mut tx, channel_id).await?;
    tx.commit().await?;
    let row = store::channel_row(&state, channel_id).await?.ok_or_else(ApiErr::internal)?;
    events::dispatch_channel(&state, &row, GatewayEvent::ChannelCreate).await?;
    let channel = store::channel(&state, channel_id, Some(user_id)).await?.ok_or_else(ApiErr::internal)?;
    audit::record(&state, audit::channel_changes(Entry::new(id, user_id, AuditLogEvent::ChannelCreate, channel_id).reason(reason), None, Some(&channel)))
        .await?;
    Ok(Json(channel))
}

#[derive(Deserialize)]
struct MembersQuery {
    limit: Option<i64>,
    after: Option<Snowflake>,
}

async fn list_members(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    ApiQuery(query): ApiQuery<MembersQuery>,
) -> ApiResult<Json<Vec<GuildMember>>> {
    let id = guild_id(&id)?;
    guild_access(&state, user_id, id).await?;
    let limit = query.limit.unwrap_or(100).clamp(1, 1000);
    Ok(Json(store::members(&state, id, limit, query.after.map(Snowflake::db)).await?))
}

async fn leave_guild(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<StatusCode> {
    let id = guild_id(&id)?;
    let guild = guild_access(&state, user_id, id).await?;
    if guild.owner_id == user_id {
        return Err(ApiErr::invalid("guild_id", "Guild owners cannot leave; delete the guild instead."));
    }
    // Same removal as a kick, so a running timeout is kept for a rejoin.
    moderation::remove_member(&state, id, user_id).await?;
    Ok(StatusCode::NO_CONTENT)
}
