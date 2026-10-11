use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::routing::{patch, post};
use vokko_protocol::api::permissions::{CREATE_INSTANT_INVITE, MANAGE_CHANNELS};
use vokko_protocol::api::{Channel, ChannelType, CreateInviteRequest, GatewayEvent, Invite, InviteChannel, InviteGuild, Snowflake, UpdateChannelRequest};

use crate::access::{self, channel_access};
use crate::auth::{AuthUser, random_hex};
use crate::error::{ApiErr, ApiResult};
use crate::events;
use crate::extract::{ApiJson, parse_id};
use crate::routes::auth::clean_text;
use crate::routes::guilds::channel_name;
use crate::routes::overwrites;
use crate::state::AppState;
use crate::store::{self, iso};

pub fn routes() -> Router<AppState> {
    Router::new().route("/channels/{id}", patch(update_channel).delete(delete_channel)).route("/channels/{id}/invites", post(create_invite))
}

fn channel_id(raw: &str) -> ApiResult<i64> {
    parse_id(raw).ok_or_else(ApiErr::unknown_channel)
}

async fn update_channel(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<UpdateChannelRequest>,
) -> ApiResult<Json<Channel>> {
    let id = channel_id(&id)?;
    let access = channel_access(&state, user_id, id).await?;
    let kind = access.channel.channel_type();
    if access.is_dm() {
        if kind != ChannelType::GroupDm || body.topic.is_some() || body.position.is_some() || body.parent_id.is_some() {
            return Err(ApiErr::missing_permissions());
        }
    } else {
        access.require(MANAGE_CHANNELS)?;
    }
    if let Some(name) = &body.name {
        let name = if access.is_dm() {
            let trimmed = name.trim();
            if trimmed.chars().count() > 100 {
                return Err(ApiErr::invalid("name", "Must be 100 or fewer in length."));
            }
            trimmed.to_owned()
        } else {
            channel_name(kind, name)?
        };
        sqlx::query("UPDATE channels SET name = $2 WHERE id = $1").bind(id).bind((!name.is_empty()).then_some(name)).execute(&state.db).await?;
    }
    if body.topic.is_some() {
        let topic = clean_text(body.topic, 1024, "topic")?;
        sqlx::query("UPDATE channels SET topic = $2 WHERE id = $1").bind(id).bind(topic).execute(&state.db).await?;
    }
    if let Some(position) = body.position {
        sqlx::query("UPDATE channels SET position = $2 WHERE id = $1").bind(id).bind(position).execute(&state.db).await?;
    }
    let mut viewers_before = None;
    if let Some(parent) = body.parent_id {
        let parent = if parent.0 == 0 {
            None
        } else {
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
            Some(parent.db())
        };
        // Moving under a category with lock_permissions adopts its overwrites; without a parent there is nothing to adopt.
        let lock_to = parent.filter(|_| body.lock_permissions == Some(true));
        if let Some(parent) = lock_to {
            viewers_before = Some(access::channel_viewers(&state, &access.channel).await?);
            let mut tx = state.db.begin().await?;
            sqlx::query("UPDATE channels SET parent_id = $2 WHERE id = $1").bind(id).bind(parent).execute(&mut *tx).await?;
            overwrites::copy_overwrites(&mut tx, parent, id).await?;
            tx.commit().await?;
        } else {
            sqlx::query("UPDATE channels SET parent_id = $2 WHERE id = $1").bind(id).bind(parent).execute(&state.db).await?;
        }
    }
    let row = store::channel_row(&state, id).await?.ok_or_else(ApiErr::unknown_channel)?;
    match viewers_before {
        Some(before) => overwrites::dispatch_visibility(&state, &row, &before).await?,
        None => events::dispatch_channel(&state, &row, GatewayEvent::ChannelUpdate).await?,
    }
    store::channel(&state, id, Some(user_id)).await?.map(Json).ok_or_else(ApiErr::unknown_channel)
}

async fn delete_channel(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Channel>> {
    let id = channel_id(&id)?;
    let access = channel_access(&state, user_id, id).await?;
    let channel = store::channel(&state, id, Some(user_id)).await?.ok_or_else(ApiErr::unknown_channel)?;
    if access.is_dm() {
        // Closing a DM hides it for this user only; leaving a group DM removes the user.
        if access.channel.channel_type() == ChannelType::Dm {
            sqlx::query("UPDATE channel_recipients SET closed = TRUE WHERE channel_id = $1 AND user_id = $2").bind(id).bind(user_id).execute(&state.db).await?;
        } else {
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
    let viewers = access::channel_viewers(&state, &access.channel).await?;
    let guild_id = access.channel.guild_id;
    let attachments: Vec<(i64,)> = sqlx::query_as("DELETE FROM attachments WHERE channel_id = $1 RETURNING id").bind(id).fetch_all(&state.db).await?;
    // Children of a deleted category move to the top level.
    sqlx::query("UPDATE channels SET parent_id = NULL WHERE parent_id = $1").bind(id).execute(&state.db).await?;
    sqlx::query("UPDATE guilds SET system_channel_id = NULL WHERE id = $1 AND system_channel_id = $2").bind(guild_id).bind(id).execute(&state.db).await?;
    sqlx::query("DELETE FROM channels WHERE id = $1").bind(id).execute(&state.db).await?;
    crate::media::remove_files(&state, &attachments.into_iter().map(|(id,)| id).collect::<Vec<_>>()).await;
    state.hub.send(&viewers, &GatewayEvent::ChannelDelete(channel.clone()));
    Ok(Json(channel))
}

pub fn invite_code() -> String {
    // 8 alphanumerics drawn from random hex pairs mapped onto the alphabet.
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    let hex = random_hex(8);
    (0..8)
        .map(|index| {
            let byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).unwrap_or(0);
            ALPHABET[byte as usize % ALPHABET.len()] as char
        })
        .collect()
}

pub async fn invite_view(state: &AppState, code: &str) -> ApiResult<Option<Invite>> {
    #[derive(sqlx::FromRow)]
    struct Row {
        guild_id: i64,
        channel_id: i64,
        guild_name: String,
        icon_path: Option<String>,
        channel_name: Option<String>,
        expires_at: Option<time::OffsetDateTime>,
    }
    let row: Option<Row> = sqlx::query_as(
        "SELECT i.guild_id, i.channel_id, g.name AS guild_name, g.icon_path, c.name AS channel_name, i.expires_at \
         FROM invites i JOIN guilds g ON g.id = i.guild_id LEFT JOIN channels c ON c.id = i.channel_id WHERE i.code = $1",
    )
    .bind(code)
    .fetch_optional(&state.db)
    .await?;
    let Some(row) = row else { return Ok(None) };
    let member_count = store::member_count(state, row.guild_id).await?;
    Ok(Some(Invite {
        code: code.to_owned(),
        guild: InviteGuild { id: Snowflake::from(row.guild_id), name: row.guild_name, icon: row.icon_path.map(|path| state.asset_url(&path)), member_count },
        channel: InviteChannel { id: Snowflake::from(row.channel_id), name: row.channel_name },
        expires_at: row.expires_at.map(iso),
    }))
}

async fn create_invite(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>, body: axum::body::Bytes) -> ApiResult<Json<Invite>> {
    let id = channel_id(&id)?;
    let access = channel_access(&state, user_id, id).await?;
    let Some(guild_id) = access.channel.guild_id else { return Err(ApiErr::invalid("channel_id", "Invites need a guild channel.")) };
    access.require(CREATE_INSTANT_INVITE)?;
    let request: CreateInviteRequest = if body.is_empty() {
        CreateInviteRequest::default()
    } else {
        serde_json::from_slice(&body).map_err(|error| ApiErr::invalid("body", &error.to_string()))?
    };
    let max_age = request.max_age.unwrap_or(86_400).min(604_800) as i32;
    let max_uses = request.max_uses.unwrap_or(0).min(100) as i32;
    let code = invite_code();
    sqlx::query(
        "INSERT INTO invites (code, guild_id, channel_id, inviter_id, max_age, max_uses, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $5::int > 0 THEN now() + ($5::int * interval '1 second') END)",
    )
    .bind(&code)
    .bind(guild_id)
    .bind(id)
    .bind(user_id)
    .bind(max_age)
    .bind(max_uses)
    .execute(&state.db)
    .await?;
    invite_view(&state, &code).await?.map(Json).ok_or_else(ApiErr::internal)
}
