//! Synced user settings (`/users/@me/settings`) and "Request my data" (`/users/@me/export`).
use std::time::Duration;

use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde_json::{Map, Value, json};
use sqlx::FromRow;
use time::OffsetDateTime;
use vokko_protocol::api::user_settings::{self, EXPORT_MAX_MESSAGES, MAX_BYTES, VERSION_CONFLICT};
use vokko_protocol::api::{
    ChannelType, ExportedChannel, ExportedGuild, ExportedMessage, GatewayEvent, PatchUserSettingsRequest, Snowflake, UserDataExport, UserSettings,
    UserSettingsConflict,
};

use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::extract::ApiJson;
use crate::ratelimit::{Limited, limited_response};
use crate::routes::relationships::relationships_of;
use crate::state::AppState;
use crate::store;

/// One export per user per this long.
pub const EXPORT_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

pub fn routes() -> Router<AppState> {
    Router::new().route("/users/@me/settings", get(get_settings).patch(patch_settings)).route("/users/@me/export", get(export))
}

fn as_map(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// The stored blob (`version` 0 and no keys before the first save).
pub async fn load(state: &AppState, user_id: i64) -> ApiResult<UserSettings> {
    let row: Option<(i64, Value)> =
        sqlx::query_as("SELECT version, settings FROM user_settings WHERE user_id = $1").bind(user_id).fetch_optional(&state.db).await?;
    Ok(row.map(|(version, settings)| UserSettings { version: version.max(0) as u64, settings: as_map(settings) }).unwrap_or_default())
}

/// A server-enforced boolean privacy setting of `user_id` (`default` when unset).
pub async fn privacy_flag(state: &AppState, user_id: i64, key: &str, default: bool) -> ApiResult<bool> {
    Ok(user_settings::flag(&load(state, user_id).await?.settings, key, default))
}

async fn get_settings(State(state): State<AppState>, AuthUser(user_id): AuthUser) -> ApiResult<Json<UserSettings>> {
    Ok(Json(load(&state, user_id).await?))
}

/// Validates every key of the patch; the error lists each rejected key like Discord's form errors.
fn validate_patch(patch: &Map<String, Value>) -> ApiResult<()> {
    let mut errors = Map::new();
    for (key, value) in patch {
        let result = if value.is_null() && user_settings::kind(key).is_some() { Ok(()) } else { user_settings::validate(key, value) };
        if let Err(message) = result {
            errors.insert(key.clone(), json!({ "_errors": [{ "code": "INVALID", "message": message }] }));
        }
    }
    if errors.is_empty() { Ok(()) } else { Err(ApiErr::invalid("settings", "Invalid settings.").with_errors(json!({ "settings": errors }))) }
}

async fn patch_settings(State(state): State<AppState>, AuthUser(user_id): AuthUser, ApiJson(body): ApiJson<PatchUserSettingsRequest>) -> ApiResult<Response> {
    validate_patch(&body.settings)?;
    let mut tx = state.db.begin().await?;
    sqlx::query("INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING").bind(user_id).execute(&mut *tx).await?;
    let (version, current): (i64, Value) =
        sqlx::query_as("SELECT version, settings FROM user_settings WHERE user_id = $1 FOR UPDATE").bind(user_id).fetch_one(&mut *tx).await?;
    let version = version.max(0) as u64;
    let mut settings = as_map(current);
    let sharing_changed = crate::presence::SHARING_KEYS.iter().any(|key| body.settings.contains_key(*key));
    if body.version != version {
        tx.rollback().await?;
        let conflict = UserSettingsConflict { code: VERSION_CONFLICT, message: "Settings version conflict".to_owned(), version, settings };
        return Ok((StatusCode::CONFLICT, Json(conflict)).into_response());
    }
    for (key, value) in body.settings {
        if value.is_null() {
            settings.remove(&key);
        } else {
            settings.insert(key, value);
        }
    }
    let blob = Value::Object(settings);
    if serde_json::to_vec(&blob).map(|bytes| bytes.len()).unwrap_or(usize::MAX) > MAX_BYTES {
        return Err(ApiErr::invalid("settings", "Settings must be at most 64 KiB."));
    }
    let next = version + 1;
    sqlx::query("UPDATE user_settings SET version = $2, settings = $3, updated_at = now() WHERE user_id = $1")
        .bind(user_id)
        .bind(next as i64)
        .bind(&blob)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let saved = UserSettings { version: next, settings: as_map(blob) };
    state.hub.send(&[user_id], &GatewayEvent::UserSettingsUpdate(Box::new(saved.clone())));
    if sharing_changed {
        crate::presence::reapply_sharing(&state, user_id).await?;
    }
    Ok(Json(saved).into_response())
}

#[derive(FromRow)]
struct GuildRow {
    id: i64,
    name: String,
    nick: Option<String>,
    joined_at: OffsetDateTime,
}

#[derive(FromRow)]
struct ChannelExportRow {
    id: i64,
    kind: i16,
    guild_id: Option<i64>,
    name: Option<String>,
}

#[derive(FromRow)]
struct MessageExportRow {
    id: i64,
    channel_id: i64,
    content: String,
    created_at: OffsetDateTime,
    edited_at: Option<OffsetDateTime>,
    attachments: Vec<String>,
}

/// Claims today's export slot; `Err(seconds)` while the last export is under 24 h old.
async fn claim_export(state: &AppState, user_id: i64) -> ApiResult<Result<(), f64>> {
    let interval = EXPORT_INTERVAL.as_secs_f64();
    let claimed: Option<(i64,)> = sqlx::query_as(
        "INSERT INTO user_settings (user_id, last_export_at) VALUES ($1, now()) \
         ON CONFLICT (user_id) DO UPDATE SET last_export_at = now() \
         WHERE user_settings.last_export_at IS NULL OR user_settings.last_export_at <= now() - make_interval(secs => $2) RETURNING user_id",
    )
    .bind(user_id)
    .bind(interval)
    .fetch_optional(&state.db)
    .await?;
    if claimed.is_some() {
        return Ok(Ok(()));
    }
    let (waited,): (f64,) = sqlx::query_as("SELECT EXTRACT(EPOCH FROM now() - last_export_at)::float8 FROM user_settings WHERE user_id = $1")
        .bind(user_id)
        .fetch_one(&state.db)
        .await?;
    Ok(Err((interval - waited).max(1.0)))
}

async fn export(State(state): State<AppState>, AuthUser(user_id): AuthUser) -> ApiResult<Response> {
    if let Err(retry_after) = claim_export(&state, user_id).await? {
        return Ok(limited_response(Limited { retry_after, global: false }));
    }
    match build_export(&state, user_id).await {
        Ok(body) => Ok(Json(body).into_response()),
        Err(error) => {
            // A failed export must not use up the day's slot ("counted from the last successful export").
            if let Err(release) = sqlx::query("UPDATE user_settings SET last_export_at = NULL WHERE user_id = $1").bind(user_id).execute(&state.db).await {
                tracing::warn!(user_id, error = %release, "could not release the export slot");
            }
            Err(error)
        }
    }
}

async fn build_export(state: &AppState, user_id: i64) -> ApiResult<UserDataExport> {
    let user = store::user(state, user_id).await?.ok_or_else(ApiErr::unauthorized)?;
    let settings = load(state, user_id).await?;
    let relationships = relationships_of(state, user_id).await?;
    let guilds: Vec<GuildRow> = sqlx::query_as(
        "SELECT g.id, g.name, m.nick, m.joined_at FROM guild_members m JOIN guilds g ON g.id = m.guild_id WHERE m.user_id = $1 ORDER BY m.joined_at",
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;
    let mut messages: Vec<MessageExportRow> = sqlx::query_as(
        "SELECT m.id, m.channel_id, m.content, m.created_at, m.edited_at, \
                COALESCE(ARRAY(SELECT a.filename FROM attachments a WHERE a.message_id = m.id AND NOT a.snapshot ORDER BY a.id), '{}') AS attachments \
         FROM messages m WHERE m.author_id = $1 ORDER BY m.id DESC LIMIT $2",
    )
    .bind(user_id)
    .bind(EXPORT_MAX_MESSAGES + 1)
    .fetch_all(&state.db)
    .await?;
    let messages_truncated = messages.len() as i64 > EXPORT_MAX_MESSAGES;
    messages.truncate(EXPORT_MAX_MESSAGES as usize);
    let channels: Vec<ChannelExportRow> = sqlx::query_as(
        "SELECT c.id, c.kind, c.guild_id, c.name FROM channels c \
         WHERE c.id IN (SELECT DISTINCT channel_id FROM messages WHERE author_id = $1) \
            OR c.id IN (SELECT channel_id FROM channel_recipients WHERE user_id = $1 AND NOT closed) ORDER BY c.id",
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;
    let channel_ids: Vec<i64> = channels.iter().map(|row| row.id).collect();
    let recipients: Vec<(i64, i64)> =
        sqlx::query_as("SELECT channel_id, user_id FROM channel_recipients WHERE channel_id = ANY($1) AND user_id <> $2 ORDER BY user_id")
            .bind(&channel_ids)
            .bind(user_id)
            .fetch_all(&state.db)
            .await?;
    let restricted: Vec<(i64,)> =
        sqlx::query_as("SELECT guild_id FROM guild_dm_restrictions WHERE user_id = $1 ORDER BY guild_id").bind(user_id).fetch_all(&state.db).await?;
    let body = UserDataExport {
        exported_at: store::iso(OffsetDateTime::now_utc()),
        user,
        settings,
        relationships,
        guilds: guilds
            .into_iter()
            .map(|row| ExportedGuild { id: Snowflake::from(row.id), name: row.name, nick: row.nick, joined_at: store::iso(row.joined_at) })
            .collect(),
        channels: channels
            .into_iter()
            .filter_map(|row| {
                Some(ExportedChannel {
                    id: Snowflake::from(row.id),
                    kind: ChannelType::from_u8(row.kind as u8)?,
                    guild_id: row.guild_id.map(Snowflake::from),
                    name: row.name,
                    recipient_ids: recipients.iter().filter(|(channel, _)| *channel == row.id).map(|(_, user)| Snowflake::from(*user)).collect(),
                })
            })
            .collect(),
        messages: messages
            .into_iter()
            .map(|row| ExportedMessage {
                id: Snowflake::from(row.id),
                channel_id: Snowflake::from(row.channel_id),
                content: row.content,
                timestamp: store::iso(row.created_at),
                edited_timestamp: row.edited_at.map(store::iso),
                attachments: row.attachments,
            })
            .collect(),
        messages_truncated,
        dm_restricted_guild_ids: restricted.into_iter().map(|(id,)| Snowflake::from(id)).collect(),
    };
    Ok(body)
}
