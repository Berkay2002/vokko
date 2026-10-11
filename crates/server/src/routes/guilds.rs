use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get};
use serde::Deserialize;
use vokko_protocol::api::permissions::{DEFAULT_EVERYONE, MANAGE_CHANNELS, MANAGE_GUILD};
use vokko_protocol::api::{
    Channel, ChannelType, CreateChannelRequest, CreateGuildRequest, GatewayEvent, Guild, GuildMember, GuildMemberRemove, IdOnly, Snowflake, UpdateGuildRequest,
};

use crate::access::{self, guild_access};
use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::events;
use crate::extract::{ApiJson, ApiQuery, parse_id};
use crate::media;
use crate::routes::auth::clean_text;
use crate::routes::users::owned_attachment_path;
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
    let name =
        if matches!(kind, ChannelType::GuildText) { trimmed.to_lowercase().split_whitespace().collect::<Vec<_>>().join("-") } else { trimmed.to_owned() };
    if !(1..=100).contains(&name.chars().count()) {
        return Err(ApiErr::invalid("name", "Must be between 1 and 100 in length."));
    }
    Ok(name)
}

async fn create_guild(State(state): State<AppState>, AuthUser(user_id): AuthUser, ApiJson(body): ApiJson<CreateGuildRequest>) -> ApiResult<Json<Guild>> {
    let name = guild_name(&body.name)?;
    let icon_path = match body.icon_attachment_id {
        Some(id) => Some(owned_attachment_path(&state, id.db(), user_id).await?),
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
    if let Some(name) = body.name {
        let name = guild_name(&name)?;
        sqlx::query("UPDATE guilds SET name = $2 WHERE id = $1").bind(id).bind(name).execute(&state.db).await?;
    }
    if let Some(icon) = body.icon_attachment_id {
        let path = owned_attachment_path(&state, icon.db(), user_id).await?;
        sqlx::query("UPDATE guilds SET icon_path = $2 WHERE id = $1").bind(id).bind(path).execute(&state.db).await?;
    }
    if let Some(channel) = body.system_channel_id {
        let found: Option<(i64,)> = sqlx::query_as("SELECT id FROM channels WHERE id = $1 AND guild_id = $2 AND kind = 0")
            .bind(channel.db())
            .bind(id)
            .fetch_optional(&state.db)
            .await?;
        if found.is_none() {
            return Err(ApiErr::invalid("system_channel_id", "Must be a text channel of this guild."));
        }
        sqlx::query("UPDATE guilds SET system_channel_id = $2 WHERE id = $1").bind(id).bind(channel.db()).execute(&state.db).await?;
    }
    let guild = store::guild(&state, id).await?.ok_or_else(ApiErr::unknown_guild)?;
    let members = access::guild_member_ids(&state, id).await?;
    state.hub.send(&members, &GatewayEvent::GuildUpdate(guild.clone()));
    Ok(Json(guild))
}

async fn delete_guild(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<StatusCode> {
    let id = guild_id(&id)?;
    let guild = guild_access(&state, user_id, id).await?;
    if guild.owner_id != user_id {
        return Err(ApiErr::missing_permissions());
    }
    let members = access::guild_member_ids(&state, id).await?;
    let attachments: Vec<(i64,)> = sqlx::query_as("DELETE FROM attachments WHERE channel_id IN (SELECT id FROM channels WHERE guild_id = $1) RETURNING id")
        .bind(id)
        .fetch_all(&state.db)
        .await?;
    sqlx::query("DELETE FROM guilds WHERE id = $1").bind(id).execute(&state.db).await?;
    media::remove_files(&state, &attachments.into_iter().map(|(id,)| id).collect::<Vec<_>>()).await;
    state.hub.send(&members, &GatewayEvent::GuildDelete(IdOnly { id: Snowflake::from(id) }));
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
    guild_access(&state, user_id, id).await?.require(MANAGE_CHANNELS)?;
    if !matches!(body.kind, ChannelType::GuildText | ChannelType::GuildVoice | ChannelType::GuildCategory) {
        return Err(ApiErr::invalid("type", "Unsupported channel type."));
    }
    let name = channel_name(body.kind, &body.name)?;
    let topic = if matches!(body.kind, ChannelType::GuildText) { clean_text(body.topic, 1024, "topic")? } else { None };
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
    let (position,): (i32,) =
        sqlx::query_as("SELECT COALESCE(MAX(position) + 1, 0)::int FROM channels WHERE guild_id = $1 AND kind = $2 AND parent_id IS NOT DISTINCT FROM $3")
            .bind(id)
            .bind(body.kind.as_u8() as i16)
            .bind(parent)
            .fetch_one(&state.db)
            .await?;
    let channel_id = state.ids.next();
    sqlx::query("INSERT INTO channels (id, kind, guild_id, name, topic, position, parent_id) VALUES ($1, $2, $3, $4, $5, $6, $7)")
        .bind(channel_id)
        .bind(body.kind.as_u8() as i16)
        .bind(id)
        .bind(&name)
        .bind(&topic)
        .bind(position)
        .bind(parent)
        .execute(&state.db)
        .await?;
    if !matches!(body.kind, ChannelType::GuildCategory) {
        sqlx::query("INSERT INTO read_states (user_id, channel_id) SELECT user_id, $2 FROM guild_members WHERE guild_id = $1 ON CONFLICT DO NOTHING")
            .bind(id)
            .bind(channel_id)
            .execute(&state.db)
            .await?;
    }
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
    let user = store::user(&state, user_id).await?.ok_or_else(ApiErr::unauthorized)?;
    sqlx::query("DELETE FROM guild_members WHERE guild_id = $1 AND user_id = $2").bind(id).bind(user_id).execute(&state.db).await?;
    sqlx::query("DELETE FROM read_states WHERE user_id = $1 AND channel_id IN (SELECT id FROM channels WHERE guild_id = $2)")
        .bind(user_id)
        .bind(id)
        .execute(&state.db)
        .await?;
    state.hub.send(&[user_id], &GatewayEvent::GuildDelete(IdOnly { id: Snowflake::from(id) }));
    let remaining = access::guild_member_ids(&state, id).await?;
    state.hub.send(&remaining, &GatewayEvent::GuildMemberRemove(GuildMemberRemove { guild_id: Snowflake::from(id), user }));
    Ok(StatusCode::NO_CONTENT)
}
