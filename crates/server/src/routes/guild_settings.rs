//! Per-user notification settings of a guild or of DMs (`/users/@me/guilds/{guild.id|@me}/settings`): mutes, notification
//! levels, @everyone/role suppression and per-channel overrides, in Discord's user guild settings shape.
use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::routing::get;
use serde_json::Value;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use vokko_protocol::api::notification_level::{NULL, UNREADS_ONLY_MENTIONS};
use vokko_protocol::api::{ChannelOverride, ChannelOverridePatch, GatewayEvent, MuteConfig, Snowflake, UpdateUserGuildSettingsRequest, UserGuildSettings};

use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::extract::ApiJson;
use crate::routes::guild_privacy::member_guild;
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new().route("/users/@me/guilds/{id}/settings", get(get_settings).patch(update_settings))
}

/// Channel overrides one guild's settings may hold.
const MAX_OVERRIDES: usize = 500;
/// The `guild_id` column value of the DM settings.
const DMS: i64 = 0;

fn guild_snowflake(guild: i64) -> Option<Snowflake> {
    (guild != DMS).then(|| Snowflake::from(guild))
}

/// `@me` (DMs, stored as 0) or a guild the caller is a member of.
async fn target(state: &AppState, user_id: i64, guild: &str) -> ApiResult<i64> {
    if guild == "@me" { Ok(DMS) } else { member_guild(state, user_id, guild).await }
}

fn from_row(guild: i64, raw: Value) -> UserGuildSettings {
    // Only validated settings are ever written; a broken value reads as the defaults rather than failing READY.
    let mut settings: UserGuildSettings = serde_json::from_value(raw).unwrap_or_else(|_| UserGuildSettings::new(None));
    settings.guild_id = guild_snowflake(guild);
    settings
}

async fn load(state: &AppState, user_id: i64, guild: i64) -> ApiResult<UserGuildSettings> {
    let row: Option<(Value,)> = sqlx::query_as("SELECT settings FROM user_guild_settings WHERE user_id = $1 AND guild_id = $2")
        .bind(user_id)
        .bind(guild)
        .fetch_optional(&state.db)
        .await?;
    Ok(row.map(|(raw,)| from_row(guild, raw)).unwrap_or_else(|| UserGuildSettings::new(guild_snowflake(guild))))
}

/// READY `user_guild_settings`: every saved entry for DMs and for the guilds the user is still in.
pub async fn all(state: &AppState, user_id: i64) -> ApiResult<Vec<UserGuildSettings>> {
    let rows: Vec<(i64, Value)> = sqlx::query_as(
        "SELECT s.guild_id, s.settings FROM user_guild_settings s WHERE s.user_id = $1 \
         AND (s.guild_id = 0 OR EXISTS (SELECT 1 FROM guild_members m WHERE m.guild_id = s.guild_id AND m.user_id = $1)) ORDER BY s.guild_id",
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;
    Ok(rows.into_iter().map(|(guild, raw)| from_row(guild, raw)).collect())
}

async fn get_settings(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(guild): Path<String>) -> ApiResult<Json<UserGuildSettings>> {
    let guild = target(&state, user_id, &guild).await?;
    Ok(Json(load(&state, user_id, guild).await?))
}

fn check_level(level: Option<u8>, flags: Option<u32>) -> ApiResult<()> {
    if level.is_some_and(|level| level > NULL) {
        return Err(ApiErr::invalid("message_notifications", "Must be 0 (all), 1 (mentions), 2 (nothing) or 3 (default)."));
    }
    if flags.is_some_and(|flags| flags & !UNREADS_ONLY_MENTIONS != 0) {
        return Err(ApiErr::invalid("flags", "Unknown flag bits."));
    }
    Ok(())
}

fn check_mute_config(config: &Option<Option<MuteConfig>>) -> ApiResult<()> {
    if let Some(Some(MuteConfig { end_time: Some(raw) })) = config {
        OffsetDateTime::parse(raw.trim(), &Rfc3339).map_err(|_| ApiErr::invalid("mute_config", "Must be an ISO 8601 timestamp."))?;
    }
    Ok(())
}

fn apply_override(current: ChannelOverride, patch: ChannelOverridePatch) -> ChannelOverride {
    let muted = patch.muted.unwrap_or(current.muted);
    ChannelOverride {
        channel_id: current.channel_id,
        muted,
        mute_config: if muted { patch.mute_config.unwrap_or(current.mute_config) } else { None },
        message_notifications: patch.message_notifications.unwrap_or(current.message_notifications),
        flags: patch.flags.unwrap_or(current.flags),
        collapsed: patch.collapsed.unwrap_or(current.collapsed),
    }
}

fn is_default(entry: &ChannelOverride) -> bool {
    !entry.muted && entry.message_notifications == NULL && entry.flags == 0 && !entry.collapsed
}

/// The settings after `body`, or the validation error (nothing is saved then).
fn apply(mut settings: UserGuildSettings, body: UpdateUserGuildSettingsRequest) -> ApiResult<UserGuildSettings> {
    check_level(body.message_notifications, body.flags)?;
    check_mute_config(&body.mute_config)?;
    settings.muted = body.muted.unwrap_or(settings.muted);
    settings.mute_config = if settings.muted { body.mute_config.unwrap_or(settings.mute_config) } else { None };
    settings.message_notifications = body.message_notifications.unwrap_or(settings.message_notifications);
    settings.flags = body.flags.unwrap_or(settings.flags);
    settings.suppress_everyone = body.suppress_everyone.unwrap_or(settings.suppress_everyone);
    settings.suppress_roles = body.suppress_roles.unwrap_or(settings.suppress_roles);
    settings.hide_muted_channels = body.hide_muted_channels.unwrap_or(settings.hide_muted_channels);
    let patches = body.channel_overrides.unwrap_or_default();
    // Checked before merging so an oversized map costs nothing (the scan below is O(overrides) per entry).
    if patches.len() > MAX_OVERRIDES {
        return Err(ApiErr::invalid("channel_overrides", &format!("At most {MAX_OVERRIDES} channel overrides.")));
    }
    for (channel_id, patch) in patches {
        check_level(patch.message_notifications, patch.flags).map_err(|_| ApiErr::invalid("channel_overrides", "Invalid notification level or flags."))?;
        check_mute_config(&patch.mute_config)?;
        let index = settings.channel_overrides.iter().position(|entry| entry.channel_id == channel_id);
        let current = match index {
            Some(index) => settings.channel_overrides.remove(index),
            None => ChannelOverride { channel_id, muted: false, mute_config: None, message_notifications: NULL, flags: 0, collapsed: false },
        };
        let next = apply_override(current, patch);
        if !is_default(&next) {
            settings.channel_overrides.push(next);
        }
    }
    if settings.channel_overrides.len() > MAX_OVERRIDES {
        return Err(ApiErr::invalid("channel_overrides", &format!("At most {MAX_OVERRIDES} channel overrides.")));
    }
    Ok(settings)
}

async fn update_settings(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(guild): Path<String>,
    ApiJson(body): ApiJson<UpdateUserGuildSettingsRequest>,
) -> ApiResult<Json<UserGuildSettings>> {
    let guild = target(&state, user_id, &guild).await?;
    let mut tx = state.db.begin().await?;
    // The row lock makes concurrent PATCHes (two devices, or overrides of different channels) merge instead of overwriting.
    sqlx::query("INSERT INTO user_guild_settings (user_id, guild_id, settings) VALUES ($1, $2, '{}') ON CONFLICT DO NOTHING")
        .bind(user_id)
        .bind(guild)
        .execute(&mut *tx)
        .await?;
    let (raw,): (Value,) = sqlx::query_as("SELECT settings FROM user_guild_settings WHERE user_id = $1 AND guild_id = $2 FOR UPDATE")
        .bind(user_id)
        .bind(guild)
        .fetch_one(&mut *tx)
        .await?;
    let settings = apply(from_row(guild, raw), body)?;
    let blob = serde_json::to_value(&settings).map_err(|_| ApiErr::internal())?;
    sqlx::query("UPDATE user_guild_settings SET settings = $3 WHERE user_id = $1 AND guild_id = $2")
        .bind(user_id)
        .bind(guild)
        .bind(&blob)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    state.hub.send(&[user_id], &GatewayEvent::UserGuildSettingsUpdate(Box::new(settings.clone())));
    Ok(Json(settings))
}
