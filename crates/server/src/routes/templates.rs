//! Guild templates (Discord's): one per guild, a snapshot of settings, roles and channels that anyone with the code can make a new guild from.
use std::collections::HashMap;

use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::routing::{get, put};
use vokko_protocol::api::permissions::MANAGE_GUILD;
use vokko_protocol::api::{
    ChannelType, CreateGuildRequest, CreateTemplateRequest, DefaultMessageNotifications, ExplicitContentFilter, Guild, GuildTemplate, OverwriteType, Snowflake,
    TemplateChannel, TemplateGuild, TemplateOverwrite, TemplateRole, UpdateTemplateRequest, VerificationLevel,
};

use crate::access::guild_access;
use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::extract::{ApiJson, parse_id};
use crate::routes::auth::clean_text;
use crate::routes::guilds::{guild_name, open_new_guild};
use crate::routes::invites::invite_code;
use crate::routes::users::{ImageKind, image_path_on};
use crate::state::AppState;
use crate::store::{self, iso};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/guilds/{id}/templates", get(list).post(create))
        .route("/guilds/{id}/templates/{code}", put(sync).patch(update).delete(remove))
        .route("/guilds/templates/{code}", get(preview).post(create_guild))
}

/// Channel kinds a template carries: text, voice, category, announcement, stage, forum (never threads or DMs).
const TEMPLATE_KINDS: [i16; 6] = [0, 2, 4, 5, 13, 15];
const DESCRIPTION_MAX: usize = 120;

fn unknown_template() -> ApiErr {
    ApiErr::new_unknown("Unknown Guild Template", 10057)
}

fn template_name(value: &str) -> ApiResult<String> {
    let name = value.trim().to_owned();
    if !(1..=100).contains(&name.chars().count()) {
        return Err(ApiErr::invalid("name", "Must be between 1 and 100 in length."));
    }
    Ok(name)
}

#[derive(sqlx::FromRow)]
struct TemplateRow {
    code: String,
    guild_id: i64,
    name: String,
    description: Option<String>,
    creator_id: i64,
    usage_count: i32,
    source: String,
    created_at: time::OffsetDateTime,
    updated_at: time::OffsetDateTime,
}

const TEMPLATE_COLS: &str = "code, guild_id, name, description, creator_id, usage_count, source, created_at, updated_at";

async fn row_by_code(state: &AppState, code: &str) -> ApiResult<TemplateRow> {
    sqlx::query_as(&format!("SELECT {TEMPLATE_COLS} FROM guild_templates WHERE code = $1"))
        .bind(code)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(unknown_template)
}

/// The template `code` of guild `guild_id`, for its managers.
async fn managed_row(state: &AppState, user_id: i64, raw_guild: &str, code: &str) -> ApiResult<TemplateRow> {
    let guild_id = parse_id(raw_guild).ok_or_else(ApiErr::unknown_guild)?;
    guild_access(state, user_id, guild_id).await?.require(MANAGE_GUILD)?;
    let row = row_by_code(state, code).await?;
    if row.guild_id != guild_id {
        return Err(unknown_template());
    }
    Ok(row)
}

fn parse_source(raw: &str) -> ApiResult<TemplateGuild> {
    serde_json::from_str(raw).map_err(|error| {
        tracing::error!("unreadable template snapshot: {error}");
        ApiErr::internal()
    })
}

/// `is_dirty` is only worked out for managers: anyone else holding the code would get a live view of whether the guild changed.
async fn to_api(state: &AppState, row: TemplateRow, with_dirty: bool) -> ApiResult<GuildTemplate> {
    let source = parse_source(&row.source)?;
    let is_dirty = if with_dirty { Some(snapshot(state, row.guild_id).await? != source) } else { None };
    let creator = store::users(state, &[row.creator_id]).await?.remove(&row.creator_id);
    Ok(GuildTemplate {
        is_dirty,
        code: row.code,
        name: row.name,
        description: row.description,
        usage_count: row.usage_count.max(0) as u32,
        creator_id: Snowflake::from(row.creator_id),
        creator,
        created_at: iso(row.created_at),
        updated_at: iso(row.updated_at),
        source_guild_id: Snowflake::from(row.guild_id),
        serialized_source_guild: source,
    })
}

#[derive(sqlx::FromRow)]
struct GuildSettings {
    name: String,
    verification_level: i16,
    default_message_notifications: i16,
    explicit_content_filter: i16,
    system_channel_id: Option<i64>,
}

#[derive(sqlx::FromRow)]
struct RoleRow {
    id: i64,
    name: String,
    permissions: i64,
    color: i32,
    hoist: bool,
    mentionable: bool,
    unicode_emoji: Option<String>,
}

#[derive(sqlx::FromRow)]
struct ChannelSnap {
    id: i64,
    kind: i16,
    name: Option<String>,
    position: i32,
    topic: Option<String>,
    bitrate: Option<i32>,
    user_limit: Option<i32>,
    nsfw: bool,
    rate_limit_per_user: i32,
    parent_id: Option<i64>,
}

/// The guild as a template sees it now. Deterministic (same guild state, same value), so `is_dirty` is a plain comparison.
async fn snapshot(state: &AppState, guild_id: i64) -> ApiResult<TemplateGuild> {
    let guild: GuildSettings =
        sqlx::query_as("SELECT name, verification_level, default_message_notifications, explicit_content_filter, system_channel_id FROM guilds WHERE id = $1")
            .bind(guild_id)
            .fetch_optional(&state.db)
            .await?
            .ok_or_else(ApiErr::unknown_guild)?;
    // @everyone (id = guild id) first, then the role list bottom to top.
    let roles: Vec<RoleRow> = sqlx::query_as(
        "SELECT id, name, permissions, color, hoist, mentionable, unicode_emoji FROM roles WHERE guild_id = $1 ORDER BY (id <> guild_id), position, id",
    )
    .bind(guild_id)
    .fetch_all(&state.db)
    .await?;
    // Categories first, so a guild made from the template inserts every parent before its children.
    let channels: Vec<ChannelSnap> = sqlx::query_as(
        "SELECT id, kind, name, position, topic, bitrate, user_limit, nsfw, rate_limit_per_user, parent_id FROM channels \
         WHERE guild_id = $1 AND kind = ANY($2) ORDER BY (kind <> 4), position, id",
    )
    .bind(guild_id)
    .bind(&TEMPLATE_KINDS[..])
    .fetch_all(&state.db)
    .await?;
    let overwrites: Vec<(i64, i64, i64, i64)> = sqlx::query_as(
        "SELECT o.channel_id, o.target_id, o.allow, o.deny FROM permission_overwrites o JOIN channels c ON c.id = o.channel_id \
         WHERE c.guild_id = $1 AND o.target_type = 0",
    )
    .bind(guild_id)
    .fetch_all(&state.db)
    .await?;

    let role_ids: HashMap<i64, u32> = roles.iter().enumerate().map(|(index, role)| (role.id, index as u32)).collect();
    let channel_ids: HashMap<i64, u32> = channels.iter().enumerate().map(|(index, channel)| (channel.id, index as u32 + 1)).collect();
    let mut by_channel: HashMap<i64, Vec<TemplateOverwrite>> = HashMap::new();
    for (channel, target, allow, deny) in overwrites {
        let Some(&id) = role_ids.get(&target) else { continue };
        by_channel.entry(channel).or_default().push(TemplateOverwrite {
            id,
            kind: OverwriteType::Role,
            allow: (allow as u64).to_string(),
            deny: (deny as u64).to_string(),
        });
    }
    let channels = channels
        .into_iter()
        .map(|channel| {
            let mut permission_overwrites = by_channel.remove(&channel.id).unwrap_or_default();
            permission_overwrites.sort_by_key(|overwrite| overwrite.id);
            TemplateChannel {
                id: channel_ids.get(&channel.id).copied().unwrap_or_default(),
                kind: ChannelType::from_u8(channel.kind as u8).unwrap_or(ChannelType::GuildText),
                name: channel.name.unwrap_or_default(),
                position: channel.position,
                topic: channel.topic,
                bitrate: channel.bitrate.map(|value| value.max(0) as u32),
                user_limit: channel.user_limit.map(|value| value.max(0) as u32),
                nsfw: channel.nsfw,
                rate_limit_per_user: channel.rate_limit_per_user.max(0) as u32,
                parent_id: channel.parent_id.and_then(|parent| channel_ids.get(&parent).copied()),
                permission_overwrites,
            }
        })
        .collect();
    Ok(TemplateGuild {
        name: guild.name,
        verification_level: VerificationLevel::from_u8(guild.verification_level as u8).unwrap_or_default(),
        default_message_notifications: DefaultMessageNotifications::from_u8(guild.default_message_notifications as u8).unwrap_or_default(),
        explicit_content_filter: ExplicitContentFilter::from_u8(guild.explicit_content_filter as u8).unwrap_or_default(),
        system_channel_id: guild.system_channel_id.and_then(|channel| channel_ids.get(&channel).copied()),
        roles: roles
            .into_iter()
            .map(|role| TemplateRole {
                id: role_ids.get(&role.id).copied().unwrap_or_default(),
                name: role.name,
                permissions: (role.permissions as u64).to_string(),
                color: role.color as u32,
                hoist: role.hoist,
                mentionable: role.mentionable,
                unicode_emoji: role.unicode_emoji,
            })
            .collect(),
        channels,
    })
}

fn source_json(source: &TemplateGuild) -> ApiResult<String> {
    serde_json::to_string(source).map_err(|_| ApiErr::internal())
}

async fn list(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Vec<GuildTemplate>>> {
    let guild_id = parse_id(&id).ok_or_else(ApiErr::unknown_guild)?;
    guild_access(&state, user_id, guild_id).await?.require(MANAGE_GUILD)?;
    let rows: Vec<TemplateRow> =
        sqlx::query_as(&format!("SELECT {TEMPLATE_COLS} FROM guild_templates WHERE guild_id = $1")).bind(guild_id).fetch_all(&state.db).await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        out.push(to_api(&state, row, true).await?);
    }
    Ok(Json(out))
}

async fn create(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<CreateTemplateRequest>,
) -> ApiResult<Json<GuildTemplate>> {
    let guild_id = parse_id(&id).ok_or_else(ApiErr::unknown_guild)?;
    guild_access(&state, user_id, guild_id).await?.require(MANAGE_GUILD)?;
    let name = template_name(&body.name)?;
    let description = clean_text(body.description, DESCRIPTION_MAX, "description")?;
    let source = source_json(&snapshot(&state, guild_id).await?)?;
    // Twelve characters like Discord's template codes.
    let code = format!("{}{}", invite_code(), &invite_code()[..4]);
    let inserted = sqlx::query(
        "INSERT INTO guild_templates (code, guild_id, name, description, creator_id, source) VALUES ($1, $2, $3, $4, $5, $6) \
         ON CONFLICT (guild_id) DO NOTHING",
    )
    .bind(&code)
    .bind(guild_id)
    .bind(&name)
    .bind(&description)
    .bind(user_id)
    .bind(&source)
    .execute(&state.db)
    .await?;
    if inserted.rows_affected() == 0 {
        return Err(ApiErr::conflict(30031, "A server template already exists for this server."));
    }
    Ok(Json(to_api(&state, row_by_code(&state, &code).await?, true).await?))
}

/// `PUT`: replaces the snapshot with the guild as it is now.
async fn sync(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path((id, code)): Path<(String, String)>) -> ApiResult<Json<GuildTemplate>> {
    let row = managed_row(&state, user_id, &id, &code).await?;
    let source = source_json(&snapshot(&state, row.guild_id).await?)?;
    sqlx::query("UPDATE guild_templates SET source = $2, updated_at = now() WHERE code = $1").bind(&code).bind(&source).execute(&state.db).await?;
    Ok(Json(to_api(&state, row_by_code(&state, &code).await?, true).await?))
}

async fn update(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path((id, code)): Path<(String, String)>,
    ApiJson(body): ApiJson<UpdateTemplateRequest>,
) -> ApiResult<Json<GuildTemplate>> {
    let row = managed_row(&state, user_id, &id, &code).await?;
    let name = body.name.as_deref().map(template_name).transpose()?.unwrap_or(row.name);
    let description = match body.description {
        None => row.description,
        Some(text) => clean_text(text, DESCRIPTION_MAX, "description")?,
    };
    sqlx::query("UPDATE guild_templates SET name = $2, description = $3 WHERE code = $1").bind(&code).bind(&name).bind(&description).execute(&state.db).await?;
    Ok(Json(to_api(&state, row_by_code(&state, &code).await?, true).await?))
}

async fn remove(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path((id, code)): Path<(String, String)>) -> ApiResult<Json<GuildTemplate>> {
    let row = managed_row(&state, user_id, &id, &code).await?;
    let template = to_api(&state, row, true).await?;
    sqlx::query("DELETE FROM guild_templates WHERE code = $1").bind(&code).execute(&state.db).await?;
    Ok(Json(template))
}

/// Any signed-in user with the code may look at a template (the landing page and the Create Your Server modal).
async fn preview(State(state): State<AppState>, _user: AuthUser, Path(code): Path<String>) -> ApiResult<Json<GuildTemplate>> {
    Ok(Json(to_api(&state, row_by_code(&state, &code).await?, false).await?))
}

/// Discord's "Create Guild from Guild Template": a new guild owned by the caller, built from the stored snapshot (not the live source guild).
async fn create_guild(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(code): Path<String>,
    ApiJson(body): ApiJson<CreateGuildRequest>,
) -> ApiResult<Json<Guild>> {
    let name = guild_name(&body.name)?;
    let row = row_by_code(&state, &code).await?;
    let source = parse_source(&row.source)?;
    let mut tx = state.db.begin().await?;
    let icon_path = match body.icon_attachment_id {
        Some(id) => Some(image_path_on(&mut tx, id.db(), user_id, ImageKind::Avatar, "icon_attachment_id", false).await?),
        None => None,
    };
    let guild_id = state.ids.next();
    sqlx::query(
        "INSERT INTO guilds (id, name, icon_path, owner_id, verification_level, default_message_notifications, explicit_content_filter) \
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(guild_id)
    .bind(&name)
    .bind(&icon_path)
    .bind(user_id)
    .bind(source.verification_level.as_u8() as i16)
    .bind(source.default_message_notifications.as_u8() as i16)
    .bind(source.explicit_content_filter.as_u8() as i16)
    .execute(&mut *tx)
    .await?;
    // Template ids become fresh snowflakes; @everyone's id is the guild id, as everywhere else.
    let mut roles: HashMap<u32, i64> = HashMap::new();
    let mut has_everyone = false;
    for (position, role) in source.roles.iter().enumerate() {
        let id = if role.id == 0 { guild_id } else { state.ids.next() };
        has_everyone |= role.id == 0;
        roles.insert(role.id, id);
        sqlx::query(
            "INSERT INTO roles (id, guild_id, name, position, permissions, color, hoist, mentionable, unicode_emoji) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        )
        .bind(id)
        .bind(guild_id)
        .bind(&role.name)
        .bind(position as i32)
        .bind(role.permissions.parse::<u64>().unwrap_or(0) as i64)
        .bind(role.color as i32)
        .bind(role.hoist)
        .bind(role.mentionable)
        .bind(&role.unicode_emoji)
        .execute(&mut *tx)
        .await?;
    }
    if !has_everyone {
        return Err(ApiErr::internal());
    }
    let mut channels: HashMap<u32, i64> = HashMap::new();
    for channel in &source.channels {
        let id = state.ids.next();
        channels.insert(channel.id, id);
        sqlx::query(
            "INSERT INTO channels (id, kind, guild_id, name, topic, position, parent_id, bitrate, user_limit, nsfw, rate_limit_per_user) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
        )
        .bind(id)
        .bind(channel.kind.as_u8() as i16)
        .bind(guild_id)
        .bind(&channel.name)
        .bind(&channel.topic)
        .bind(channel.position)
        .bind(channel.parent_id.and_then(|parent| channels.get(&parent).copied()))
        .bind(channel.bitrate.map(|value| value as i32))
        .bind(channel.user_limit.map(|value| value as i32))
        .bind(channel.nsfw)
        .bind(channel.rate_limit_per_user as i32)
        .execute(&mut *tx)
        .await?;
        for overwrite in &channel.permission_overwrites {
            let Some(&target) = roles.get(&overwrite.id) else { continue };
            sqlx::query("INSERT INTO permission_overwrites (channel_id, target_id, target_type, allow, deny) VALUES ($1, $2, 0, $3, $4)")
                .bind(id)
                .bind(target)
                .bind(overwrite.allow.parse::<u64>().unwrap_or(0) as i64)
                .bind(overwrite.deny.parse::<u64>().unwrap_or(0) as i64)
                .execute(&mut *tx)
                .await?;
        }
    }
    let system_channel = source.system_channel_id.and_then(|channel| channels.get(&channel).copied());
    sqlx::query("UPDATE guilds SET system_channel_id = $2 WHERE id = $1").bind(guild_id).bind(system_channel).execute(&mut *tx).await?;
    sqlx::query("UPDATE guild_templates SET usage_count = usage_count + 1 WHERE code = $1").bind(&code).execute(&mut *tx).await?;
    open_new_guild(&state, tx, guild_id, user_id).await
}
