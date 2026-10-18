//! Stage channels (type 13, docs/design/voice.md §4.5): stage instances, raise hand, invite to speak / move to the audience,
//! and ending the stage. Audience members are suppressed bindings whose LiveKit grant has no publish source and `hidden`.
use std::collections::HashSet;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{patch, post};
use axum::{Json, Router};
use time::OffsetDateTime;
use vokko_protocol::api::permissions::{REQUEST_TO_SPEAK, VIEW_CHANNEL};
use vokko_protocol::api::{
    ChannelType, CreateStageInstanceRequest, EditStageInstanceRequest, EditVoiceStateRequest, GatewayEvent, STAGE_TOPIC_MAX_CHARS, Snowflake, StageInstance,
    StagePrivacyLevel,
};

use super::state::{self, is_stage_moderator};
use crate::access::{self, ChannelAccess, channel_access};
use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::extract::{ApiJson, parse_id};
use crate::state::AppState;
use crate::store;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/stage-instances", post(create))
        .route("/stage-instances/{channel_id}", patch(edit).get(get).delete(end))
        .route("/guilds/{id}/voice-states/{user}", patch(edit_voice_state))
}

type Row = (i64, i64, i64, String, i16);

fn to_api((id, guild_id, channel_id, topic, _privacy): Row) -> StageInstance {
    StageInstance {
        id: Snowflake::from(id),
        guild_id: Snowflake::from(guild_id),
        channel_id: Snowflake::from(channel_id),
        topic,
        privacy_level: StagePrivacyLevel::GuildOnly,
    }
}

fn unknown_instance() -> ApiErr {
    ApiErr::new(StatusCode::NOT_FOUND, 10067, "Unknown Stage Instance")
}

fn not_in_voice() -> ApiErr {
    ApiErr::conflict(40032, "Target user is not connected to voice.")
}

fn clean_topic(topic: &str) -> ApiResult<String> {
    let topic = topic.trim().to_owned();
    if !(1..=STAGE_TOPIC_MAX_CHARS).contains(&topic.chars().count()) {
        return Err(ApiErr::invalid("topic", &format!("Must be between 1 and {STAGE_TOPIC_MAX_CHARS} in length.")));
    }
    Ok(topic)
}

/// A stage channel the caller can see.
async fn stage_access(state: &AppState, user_id: i64, raw: &str) -> ApiResult<ChannelAccess> {
    let id = parse_id(raw).ok_or_else(ApiErr::unknown_channel)?;
    let access = channel_access(state, user_id, id).await?;
    access.require(VIEW_CHANNEL)?;
    if access.channel.channel_type() != ChannelType::GuildStage {
        return Err(ApiErr::wrong_channel_type());
    }
    Ok(access)
}

fn require_moderator(access: &ChannelAccess) -> ApiResult<()> {
    if is_stage_moderator(access.permissions) { Ok(()) } else { Err(ApiErr::missing_permissions()) }
}

async fn instance(state: &AppState, channel_id: i64) -> ApiResult<Option<StageInstance>> {
    let row: Option<Row> = sqlx::query_as("SELECT id, guild_id, channel_id, topic, privacy_level FROM stage_instances WHERE channel_id = $1")
        .bind(channel_id)
        .fetch_optional(&state.db)
        .await?;
    Ok(row.map(to_api))
}

/// Live stages of the guild in the given (visible) channels, for READY / GUILD_CREATE.
pub async fn instances_in(state: &AppState, guild_id: i64, channel_ids: &HashSet<i64>) -> ApiResult<Vec<StageInstance>> {
    let rows: Vec<Row> = sqlx::query_as("SELECT id, guild_id, channel_id, topic, privacy_level FROM stage_instances WHERE guild_id = $1 ORDER BY id")
        .bind(guild_id)
        .fetch_all(&state.db)
        .await?;
    Ok(rows.into_iter().filter(|row| channel_ids.contains(&row.2)).map(to_api).collect())
}

/// STAGE_INSTANCE_* to everyone who can see the channel.
async fn announce(state: &AppState, instance: &StageInstance, make: fn(StageInstance) -> GatewayEvent) {
    let Ok(Some(row)) = store::channel_row(state, instance.channel_id.db()).await else { return };
    let Ok(viewers) = access::channel_viewers(state, &row).await else { return };
    state.hub.send(&viewers, &make(instance.clone()));
}

async fn create(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    ApiJson(body): ApiJson<CreateStageInstanceRequest>,
) -> ApiResult<Json<StageInstance>> {
    let access = stage_access(&state, user_id, &body.channel_id.to_string()).await?;
    require_moderator(&access)?;
    let topic = clean_topic(&body.topic)?;
    let guild_id = access.channel.guild_id.ok_or_else(ApiErr::unknown_channel)?;
    let instance = open_stage(&state, guild_id, access.channel.id, &topic).await?.ok_or_else(|| ApiErr::conflict(150006, "Stage already open"))?;
    Ok(Json(instance))
}

/// Opens a stage on `channel_id` and announces it; `None` when one is already live there. The topic is already cleaned.
pub async fn open_stage(state: &AppState, guild_id: i64, channel_id: i64, topic: &str) -> ApiResult<Option<StageInstance>> {
    let row: Option<Row> = sqlx::query_as(
        "INSERT INTO stage_instances (id, guild_id, channel_id, topic, privacy_level) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (channel_id) DO NOTHING \
         RETURNING id, guild_id, channel_id, topic, privacy_level",
    )
    .bind(state.ids.next())
    .bind(guild_id)
    .bind(channel_id)
    .bind(topic)
    .bind(i16::from(StagePrivacyLevel::GuildOnly.as_u8()))
    .fetch_optional(&state.db)
    .await?;
    let Some(instance) = row.map(to_api) else { return Ok(None) };
    announce(state, &instance, GatewayEvent::StageInstanceCreate).await;
    Ok(Some(instance))
}

async fn get(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(channel_id): Path<String>) -> ApiResult<Json<StageInstance>> {
    let access = stage_access(&state, user_id, &channel_id).await?;
    instance(&state, access.channel.id).await?.map(Json).ok_or_else(unknown_instance)
}

async fn edit(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(channel_id): Path<String>,
    ApiJson(body): ApiJson<EditStageInstanceRequest>,
) -> ApiResult<Json<StageInstance>> {
    let access = stage_access(&state, user_id, &channel_id).await?;
    require_moderator(&access)?;
    let topic = body.topic.as_deref().map(clean_topic).transpose()?;
    let row: Option<Row> =
        sqlx::query_as("UPDATE stage_instances SET topic = COALESCE($2, topic) WHERE channel_id = $1 RETURNING id, guild_id, channel_id, topic, privacy_level")
            .bind(access.channel.id)
            .bind(topic)
            .fetch_optional(&state.db)
            .await?;
    let instance = row.map(to_api).ok_or_else(unknown_instance)?;
    announce(&state, &instance, GatewayEvent::StageInstanceUpdate).await;
    Ok(Json(instance))
}

async fn end(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(channel_id): Path<String>) -> ApiResult<StatusCode> {
    let access = stage_access(&state, user_id, &channel_id).await?;
    require_moderator(&access)?;
    end_stage(&state, access.channel.id).await?.ok_or_else(unknown_instance)?;
    Ok(StatusCode::NO_CONTENT)
}

/// Ends the stage of `channel_id`, if one is live: STAGE_INSTANCE_DELETE, every speaker back to the audience, hands lowered.
pub async fn end_stage(state: &AppState, channel_id: i64) -> ApiResult<Option<StageInstance>> {
    let row: Option<Row> = sqlx::query_as("DELETE FROM stage_instances WHERE channel_id = $1 RETURNING id, guild_id, channel_id, topic, privacy_level")
        .bind(channel_id)
        .fetch_optional(&state.db)
        .await?;
    let Some(instance) = row.map(to_api) else { return Ok(None) };
    announce(state, &instance, GatewayEvent::StageInstanceDelete).await;
    let inside: Vec<i64> = state.voice.all().into_iter().filter(|entry| entry.channel_id == channel_id && entry.stage).map(|entry| entry.user_id).collect();
    for user_id in inside {
        state::modify(state, user_id, |entry| {
            if entry.channel_id != channel_id {
                return false;
            }
            entry.suppress = true;
            entry.request_to_speak = None;
            true
        })
        .await;
    }
    Ok(Some(instance))
}

/// Called after someone left `channel_id`: with no stage moderator left inside, a live stage ends.
pub(crate) async fn end_if_live(state: &AppState, channel_id: i64) {
    if state.voice.all().iter().any(|entry| entry.channel_id == channel_id && entry.moderator()) {
        return;
    }
    if let Err(error) = end_stage(state, channel_id).await {
        tracing::warn!("stage: cannot end the stage of {channel_id}: {error:?}");
    }
}

/// `PATCH /guilds/{id}/voice-states/@me` (raise / lower hand, become a speaker, back to the audience) and `/{user_id}`
/// (moderators: invite to speak, move to the audience).
async fn edit_voice_state(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path((guild, target)): Path<(String, String)>,
    ApiJson(body): ApiJson<EditVoiceStateRequest>,
) -> ApiResult<StatusCode> {
    let guild_id = parse_id(&guild).ok_or_else(ApiErr::unknown_guild)?;
    let own = target == "@me";
    let target_id = if own { user_id } else { parse_id(&target).ok_or_else(ApiErr::unknown_user)? };
    let access = stage_access(&state, user_id, &body.channel_id.to_string()).await?;
    if access.channel.guild_id != Some(guild_id) {
        return Err(ApiErr::unknown_channel());
    }
    let channel_id = access.channel.id;
    let in_stage = |state: &AppState| state.voice.get(target_id).is_some_and(|entry| entry.channel_id == channel_id && entry.guild_id == Some(guild_id));
    if !in_stage(&state) {
        return Err(not_in_voice());
    }
    let moderator = is_stage_moderator(access.permissions);
    let hand = if own {
        match body.request_to_speak_timestamp {
            Some(Some(_)) => {
                access.require(REQUEST_TO_SPEAK)?;
                Some(Some(OffsetDateTime::now_utc()))
            }
            Some(None) => Some(None),
            None => None,
        }
    } else {
        if !moderator {
            return Err(ApiErr::missing_permissions());
        }
        if body.request_to_speak_timestamp.is_some() {
            return Err(ApiErr::invalid("request_to_speak_timestamp", "Only you can raise or lower your hand."));
        }
        if body.suppress.is_none() {
            return Err(ApiErr::invalid("suppress", "Required."));
        }
        None
    };
    if body.suppress == Some(false) && own && !moderator {
        return Err(ApiErr::missing_permissions());
    }
    let changed = state::modify(&state, target_id, |entry| {
        if entry.channel_id != channel_id {
            return false;
        }
        if let Some(hand) = hand {
            entry.request_to_speak = hand;
        }
        if let Some(suppress) = body.suppress {
            entry.suppress = suppress;
            if !suppress {
                entry.request_to_speak = None;
            }
        }
        true
    })
    .await;
    if changed.is_none() {
        return Err(not_in_voice());
    }
    Ok(StatusCode::NO_CONTENT)
}
