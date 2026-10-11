use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get};
use serde::Deserialize;
use vokko_protocol::api::permissions::{DEFAULT_EVERYONE, MANAGE_CHANNELS, MANAGE_GUILD, MANAGE_ROLES};
use vokko_protocol::api::{
    Channel, ChannelType, CreateChannelRequest, CreateGuildRequest, GatewayEvent, Guild, GuildMember, GuildTag, GuildTheme, IdOnly, Snowflake,
    UpdateGuildRequest,
};

use crate::access::{self, guild_access};
use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::events;
use crate::extract::{ApiJson, ApiQuery, parse_id};
use crate::media;
use crate::routes::auth::clean_text;
use crate::routes::forums;
use crate::routes::moderation;
use crate::routes::overwrites;
use crate::routes::users::{self, ImageKind, owned_image_path};
use crate::state::AppState;
use crate::store;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/guilds", axum::routing::post(create_guild))
        .route("/guilds/{id}", get(get_guild).patch(update_guild).delete(delete_guild))
        .route("/guilds/{id}/channels", get(list_channels).post(create_channel))
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
    let icon_path = match body.icon_attachment_id {
        Some(id) => Some(owned_image_path(&state, id.db(), user_id, ImageKind::Avatar, "icon_attachment_id").await?),
        None => None,
    };
    let guild_id = state.ids.next();
    let text_category = state.ids.next();
    let voice_category = state.ids.next();
    let general = state.ids.next();
    let voice = state.ids.next();
    let mut tx = state.db.begin().await?;
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
    ApiJson(body): ApiJson<UpdateGuildRequest>,
) -> ApiResult<Json<Guild>> {
    let id = guild_id(&id)?;
    guild_access(&state, user_id, id).await?.require(MANAGE_GUILD)?;
    // Validate every key first so a rejected request changes nothing.
    let name = body.name.as_deref().map(guild_name).transpose()?;
    let icon_path = match body.icon_attachment_id {
        Some(icon) => Some(owned_image_path(&state, icon.db(), user_id, ImageKind::Avatar, "icon_attachment_id").await?),
        None => None,
    };
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

    if let Some(name) = name {
        sqlx::query("UPDATE guilds SET name = $2 WHERE id = $1").bind(id).bind(name).execute(&state.db).await?;
    }
    if let Some(path) = icon_path {
        sqlx::query("UPDATE guilds SET icon_path = $2 WHERE id = $1").bind(id).bind(path).execute(&state.db).await?;
    }
    if let Some(channel) = body.system_channel_id {
        sqlx::query("UPDATE guilds SET system_channel_id = $2 WHERE id = $1").bind(id).bind(channel.db()).execute(&state.db).await?;
    }
    if let Some(theme) = theme {
        sqlx::query("UPDATE guilds SET theme_preset = $2, theme_primary = $3, theme_accent = $4 WHERE id = $1")
            .bind(id)
            .bind(theme.as_ref().and_then(|theme| theme.0.clone()))
            .bind(theme.as_ref().map(|theme| theme.1))
            .bind(theme.as_ref().map(|theme| theme.2))
            .execute(&state.db)
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
            .execute(&state.db)
            .await?;
        let rows: Vec<(i64,)> = if tag.is_some() {
            sqlx::query_as("SELECT id FROM users WHERE primary_guild_id = $1").bind(id).fetch_all(&state.db).await?
        } else {
            // Without a tag nobody can keep it as their primary guild.
            sqlx::query_as("UPDATE users SET primary_guild_id = NULL WHERE primary_guild_id = $1 RETURNING id").bind(id).fetch_all(&state.db).await?
        };
        adopters = rows.into_iter().map(|(user,)| user).collect();
    }
    let guild = store::guild(&state, id).await?.ok_or_else(ApiErr::unknown_guild)?;
    let members = access::guild_member_ids(&state, id).await?;
    state.hub.send(&members, &GatewayEvent::GuildUpdate(guild.clone()));
    for adopter in adopters {
        users::publish_user(&state, adopter).await?;
    }
    Ok(Json(guild))
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
    let attachments: Vec<(i64,)> = sqlx::query_as("DELETE FROM attachments WHERE channel_id IN (SELECT id FROM channels WHERE guild_id = $1) RETURNING id")
        .bind(id)
        .fetch_all(&state.db)
        .await?;
    let _eviction = crate::voice::state::guild_deleted(&state, id).await;
    sqlx::query("DELETE FROM guilds WHERE id = $1").bind(id).execute(&state.db).await?;
    media::remove_files(&state, &attachments.into_iter().map(|(id,)| id).collect::<Vec<_>>()).await;
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

async fn create_channel(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
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
    sqlx::query("INSERT INTO channels (id, kind, guild_id, name, topic, position, parent_id, bitrate, user_limit) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)")
        .bind(channel_id)
        .bind(body.kind.as_u8() as i16)
        .bind(id)
        .bind(&name)
        .bind(&topic)
        .bind(position)
        .bind(parent)
        .bind(body.bitrate.map(|value| value as i32))
        .bind(body.user_limit.map(|value| value as i32))
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
