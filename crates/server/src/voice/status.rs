//! Voice channel status ("Set channel status"): `PUT /channels/{id}/voice-status` and VOICE_CHANNEL_STATUS_UPDATE.
use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::put;
use vokko_protocol::api::permissions::{MANAGE_CHANNELS, SET_VOICE_CHANNEL_STATUS};
use vokko_protocol::api::{ChannelType, GatewayEvent, Snowflake, VOICE_STATUS_MAX_CHARS, VoiceChannelStatusUpdate, VoiceStatusRequest};

use crate::access::{self, channel_access};
use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::extract::{ApiJson, parse_id};
use crate::state::AppState;
use crate::store;

/// Status changes per channel, shared by everyone who may set it: a burst of 10, then one per 6 s (each change is broadcast to
/// every viewer of the channel, like a channel edit).
pub const STATUS_BURST: f64 = 10.0;
pub const STATUS_PER_SECOND: f64 = 1.0 / 6.0;

pub fn routes() -> Router<AppState> {
    Router::new().route("/channels/{id}/voice-status", put(set_status))
}

/// MANAGE_CHANNELS sets it any time; SET_VOICE_CHANNEL_STATUS only while connected to that channel (Discord's rule).
async fn set_status(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<VoiceStatusRequest>,
) -> ApiResult<Response> {
    let id = parse_id(&id).ok_or_else(ApiErr::unknown_channel)?;
    let access = channel_access(&state, user_id, id).await?;
    let Some(guild_id) = access.channel.guild_id.filter(|_| access.channel.channel_type() == ChannelType::GuildVoice) else {
        return Err(ApiErr::invalid("channel_id", "Only voice channels have a status."));
    };
    let allowed =
        access.permissions & MANAGE_CHANNELS != 0 || (access.permissions & SET_VOICE_CHANNEL_STATUS != 0 && super::state::in_channel(&state, user_id, id));
    if !allowed {
        return Err(ApiErr::missing_permissions());
    }
    let status = body.status.map(|text| text.trim().to_owned()).filter(|text| !text.is_empty());
    if status.as_ref().is_some_and(|text| text.chars().count() > VOICE_STATUS_MAX_CHARS) {
        return Err(ApiErr::invalid("status", &format!("Must be {VOICE_STATUS_MAX_CHARS} or fewer in length.")));
    }
    if state.config.rate_limit.is_some()
        && let Err(limited) = state.limiter.check_resource(id, "voice-status", STATUS_BURST, STATUS_PER_SECOND)
    {
        return Ok(crate::ratelimit::limited_response(limited));
    }
    sqlx::query("UPDATE channels SET voice_status = $2 WHERE id = $1").bind(id).bind(&status).execute(&state.db).await?;
    announce(&state, id, guild_id, status).await;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// VOICE_CHANNEL_STATUS_UPDATE to everyone who can see the channel.
pub(crate) async fn announce(state: &AppState, channel_id: i64, guild_id: i64, status: Option<String>) {
    let Ok(Some(row)) = store::channel_row(state, channel_id).await else { return };
    let Ok(viewers) = access::channel_viewers(state, &row).await else { return };
    let event =
        GatewayEvent::VoiceChannelStatusUpdate(VoiceChannelStatusUpdate { id: Snowflake::from(channel_id), guild_id: Snowflake::from(guild_id), status });
    state.hub.send(&viewers, &event);
}
