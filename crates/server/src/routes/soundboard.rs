//! Soundboard REST: default sounds, guild sounds, playing a sound in a voice channel, entrance sounds.
use std::time::Instant;

use axum::Json;
use axum::Router;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use vokko_protocol::api::permissions::{CREATE_GUILD_EXPRESSIONS, MANAGE_GUILD_EXPRESSIONS};
use vokko_protocol::api::{
    ChannelType, CreateSoundboardSoundRequest, EditSoundboardSoundRequest, EntranceSounds, GatewayEvent, SOUNDBOARD_MAX_BYTES, SOUNDBOARD_MAX_DURATION_MS,
    SOUNDBOARD_SOUNDS_PER_GUILD, SendSoundboardSoundRequest, SetEntranceSoundRequest, Snowflake, SoundboardSound, SoundboardSoundDelete, SoundboardSoundList,
};

use crate::access::{channel_access, guild_access};
use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::extract::{ApiJson, parse_id};
use crate::media;
use crate::ratelimit::{Limited, limited_response};
use crate::soundboard::{self, audio, defaults, unknown_sound};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/soundboard-default-sounds", get(list_defaults))
        .route("/soundboard-default-sounds/{id}/file", get(default_file))
        .route("/guilds/{id}/soundboard-sounds", get(list).post(create))
        .route("/guilds/{id}/soundboard-sounds/{sid}", get(get_one).patch(edit).delete(remove))
        .route("/channels/{id}/send-soundboard-sound", post(send))
        .route("/users/@me/entrance-sounds", get(get_entrance).put(set_entrance))
}

fn guild_id(raw: &str) -> ApiResult<i64> {
    parse_id(raw).ok_or_else(ApiErr::unknown_guild)
}

fn sound_id(raw: &str) -> ApiResult<i64> {
    parse_id(raw).ok_or_else(unknown_sound)
}

fn name(raw: &str) -> ApiResult<String> {
    let name = raw.trim().to_owned();
    if !(2..=32).contains(&name.chars().count()) {
        return Err(ApiErr::invalid("name", "Must be between 2 and 32 in length."));
    }
    Ok(name)
}

fn volume(value: f64) -> ApiResult<f64> {
    if !value.is_finite() || !(0.0..=1.0).contains(&value) {
        return Err(ApiErr::invalid("volume", "Must be between 0 and 1."));
    }
    Ok(value)
}

/// A unicode emoji: 1-32 characters, no whitespace, letters or digits (rules out names and markup).
fn emoji_name(raw: &str) -> ApiResult<Option<String>> {
    let text = raw.trim();
    if text.is_empty() {
        return Ok(None);
    }
    if text.chars().count() > 32 || text.chars().any(|c| c.is_whitespace() || c.is_ascii_alphanumeric() || c.is_control()) {
        return Err(ApiErr::invalid("emoji_name", "Must be a unicode emoji."));
    }
    Ok(Some(text.to_owned()))
}

/// Vokko has no custom emoji yet, so only `null` is accepted.
fn emoji_id(value: Option<Snowflake>) -> ApiResult<()> {
    match value {
        Some(_) => Err(ApiErr::invalid("emoji_id", "Unknown emoji.")),
        None => Ok(()),
    }
}

async fn list_defaults(State(state): State<AppState>, AuthUser(_): AuthUser) -> Json<Vec<SoundboardSound>> {
    Json(soundboard::default_sounds(&state))
}

/// The default sounds are the instance's own synthesized tones: public, like the client's bundled assets.
async fn default_file(Path(id): Path<String>) -> ApiResult<Response> {
    let bytes = parse_id(&id).and_then(defaults::file).ok_or_else(unknown_sound)?;
    let mut response = Response::new(Body::from(bytes));
    let headers = response.headers_mut();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("audio/wav"));
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("public, max-age=86400"));
    Ok(response)
}

async fn list(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<Json<SoundboardSoundList>> {
    let id = guild_id(&id)?;
    guild_access(&state, user_id, id).await?;
    Ok(Json(SoundboardSoundList { items: soundboard::of_guild(&state, id).await? }))
}

async fn get_one(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path((id, sid)): Path<(String, String)>) -> ApiResult<Json<SoundboardSound>> {
    let id = guild_id(&id)?;
    guild_access(&state, user_id, id).await?;
    let found = soundboard::find(&state, id, sound_id(&sid)?).await?;
    found.map(|(sound, _)| Json(sound)).ok_or_else(unknown_sound)
}

async fn create(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<CreateSoundboardSoundRequest>,
) -> ApiResult<Json<SoundboardSound>> {
    let id = guild_id(&id)?;
    let access = guild_access(&state, user_id, id).await?;
    if access.permissions & (CREATE_GUILD_EXPRESSIONS | MANAGE_GUILD_EXPRESSIONS) == 0 {
        return Err(ApiErr::missing_permissions());
    }
    let name = name(&body.name)?;
    let volume = volume(body.volume.unwrap_or(1.0))?;
    emoji_id(body.emoji_id)?;
    let emoji = match body.emoji_name.as_deref() {
        Some(raw) => emoji_name(raw)?,
        None => None,
    };
    let attachment = body.attachment_id.db();
    let unknown = || ApiErr::invalid("attachment_id", "Unknown attachment.");
    let upload: Option<(String, String, i64)> = sqlx::query_as(
        "SELECT filename, key, size FROM attachments \
         WHERE id = $1 AND uploader_id = $2 AND key IS NOT NULL AND message_id IS NULL AND claimed_at IS NULL",
    )
    .bind(attachment)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;
    let Some((filename, key, size)) = upload else { return Err(unknown()) };
    if size as u64 > SOUNDBOARD_MAX_BYTES {
        return Err(ApiErr::invalid("attachment_id", "A sound can be at most 512 KiB."));
    }
    let bytes = state.storage.read(attachment).await.map_err(|_| unknown())?;
    let probe = audio::probe(&bytes).ok_or_else(|| ApiErr::invalid("attachment_id", "A sound must be an MP3, OGG or WAV file."))?;
    if probe.duration_ms > u64::from(SOUNDBOARD_MAX_DURATION_MS) {
        return Err(ApiErr::invalid("attachment_id", "A sound can be at most 5.2 seconds long."));
    }

    let id_new = state.ids.next();
    let path = media::asset_path(attachment, &key, &filename);
    let mut tx = state.db.begin().await?;
    // Serialise creates per guild so concurrent ones cannot go past the limit.
    sqlx::query("SELECT id FROM guilds WHERE id = $1 FOR UPDATE").bind(id).fetch_optional(&mut *tx).await?;
    let (count,): (i64,) = sqlx::query_as("SELECT count(*) FROM soundboard_sounds WHERE guild_id = $1").bind(id).fetch_one(&mut *tx).await?;
    if count as usize >= SOUNDBOARD_SOUNDS_PER_GUILD {
        return Err(ApiErr::conflict(30045, "Maximum number of soundboard sounds reached"));
    }
    let claimed = sqlx::query(
        "UPDATE attachments SET claimed_at = now(), sound_asset = TRUE, content_type = $2 WHERE id = $1 AND claimed_at IS NULL AND message_id IS NULL",
    )
    .bind(attachment)
    .bind(probe.format.content_type())
    .execute(&mut *tx)
    .await?;
    if claimed.rows_affected() != 1 {
        return Err(unknown());
    }
    sqlx::query(
        "INSERT INTO soundboard_sounds (id, guild_id, name, volume, emoji_name, attachment_id, asset_path, duration_ms, creator_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(id_new)
    .bind(id)
    .bind(&name)
    .bind(volume)
    .bind(&emoji)
    .bind(attachment)
    .bind(&path)
    .bind(probe.duration_ms as i32)
    .bind(user_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    let (sound, _) = soundboard::find(&state, id, id_new).await?.ok_or_else(ApiErr::internal)?;
    soundboard::announce(&state, id, &GatewayEvent::GuildSoundboardSoundCreate(Box::new(sound.clone()))).await?;
    Ok(Json(sound))
}

/// MANAGE_GUILD_EXPRESSIONS, or CREATE_GUILD_EXPRESSIONS on your own upload (Discord's rule).
fn may_manage(permissions: u64, creator: Option<i64>, user_id: i64) -> ApiResult<()> {
    if permissions & MANAGE_GUILD_EXPRESSIONS != 0 || (permissions & CREATE_GUILD_EXPRESSIONS != 0 && creator == Some(user_id)) {
        Ok(())
    } else {
        Err(ApiErr::missing_permissions())
    }
}

async fn edit(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path((id, sid)): Path<(String, String)>,
    ApiJson(body): ApiJson<EditSoundboardSoundRequest>,
) -> ApiResult<Json<SoundboardSound>> {
    let id = guild_id(&id)?;
    let sid = sound_id(&sid)?;
    let access = guild_access(&state, user_id, id).await?;
    let (current, creator) = soundboard::find(&state, id, sid).await?.ok_or_else(unknown_sound)?;
    may_manage(access.permissions, creator, user_id)?;
    let name = match body.name.as_deref() {
        Some(raw) => name(raw)?,
        None => current.name,
    };
    let volume = match body.volume {
        Some(value) => volume(value)?,
        None => current.volume,
    };
    if let Some(value) = body.emoji_id {
        emoji_id(value)?;
    }
    let emoji = match body.emoji_name {
        Some(Some(raw)) => emoji_name(&raw)?,
        Some(None) => None,
        None => current.emoji_name,
    };
    sqlx::query("UPDATE soundboard_sounds SET name = $3, volume = $4, emoji_name = $5 WHERE id = $1 AND guild_id = $2")
        .bind(sid)
        .bind(id)
        .bind(&name)
        .bind(volume)
        .bind(&emoji)
        .execute(&state.db)
        .await?;
    let (sound, _) = soundboard::find(&state, id, sid).await?.ok_or_else(unknown_sound)?;
    soundboard::announce(&state, id, &GatewayEvent::GuildSoundboardSoundUpdate(Box::new(sound.clone()))).await?;
    Ok(Json(sound))
}

async fn remove(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path((id, sid)): Path<(String, String)>) -> ApiResult<StatusCode> {
    let id = guild_id(&id)?;
    let sid = sound_id(&sid)?;
    let access = guild_access(&state, user_id, id).await?;
    let (_, creator) = soundboard::find(&state, id, sid).await?.ok_or_else(unknown_sound)?;
    may_manage(access.permissions, creator, user_id)?;
    sqlx::query("DELETE FROM soundboard_sounds WHERE id = $1 AND guild_id = $2").bind(sid).bind(id).execute(&state.db).await?;
    soundboard::sweep_assets(&state).await;
    let event = GatewayEvent::GuildSoundboardSoundDelete(SoundboardSoundDelete { sound_id: Snowflake::from(sid), guild_id: Snowflake::from(id) });
    soundboard::announce(&state, id, &event).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Plays a sound for everyone connected to the voice channel (each client plays the file itself).
async fn send(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<SendSoundboardSoundRequest>,
) -> ApiResult<Response> {
    let channel_id = parse_id(&id).ok_or_else(ApiErr::unknown_channel)?;
    let access = channel_access(&state, user_id, channel_id).await?;
    let Some(guild_id) = access.channel.guild_id.filter(|_| access.channel.channel_type() == ChannelType::GuildVoice) else {
        return Err(ApiErr::wrong_channel_type());
    };
    // Connected to this very channel, and able to be heard there.
    let entry = state.voice.get(user_id).filter(|entry| entry.channel_id == channel_id).ok_or_else(ApiErr::missing_permissions)?;
    if entry.self_deaf || entry.suppress {
        return Err(ApiErr::missing_permissions());
    }
    let source = match body.source_guild_id {
        Some(guild) => Some(guild.db()),
        None if defaults::find(body.sound_id.db()).is_some() => None,
        None => Some(guild_id),
    };
    let sound = soundboard::playable(&state, user_id, body.sound_id.db(), source).await?.ok_or_else(unknown_sound)?;
    if !soundboard::may_play(access.permissions, guild_id, &sound) {
        return Err(ApiErr::missing_permissions());
    }
    if let Err(wait) = state.soundboard.try_play(user_id, channel_id, Instant::now()) {
        return Ok(limited_response(Limited { retry_after: wait.as_secs_f64(), global: false }));
    }
    soundboard::send_effect(&state, channel_id, guild_id, user_id, sound, false);
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn get_entrance(State(state): State<AppState>, AuthUser(user_id): AuthUser) -> ApiResult<Json<EntranceSounds>> {
    Ok(Json(soundboard::entrance_sounds(&state, user_id).await?))
}

async fn set_entrance(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    ApiJson(body): ApiJson<SetEntranceSoundRequest>,
) -> ApiResult<Json<EntranceSounds>> {
    let scope = match body.guild_id {
        Some(guild) => {
            guild_access(&state, user_id, guild.db()).await?;
            guild.db()
        }
        None => 0,
    };
    match body.sound_id {
        None => {
            sqlx::query("DELETE FROM entrance_sounds WHERE user_id = $1 AND scope_guild_id = $2").bind(user_id).bind(scope).execute(&state.db).await?;
        }
        Some(sound_id) => {
            let source = body.source_guild_id.map(Snowflake::db);
            soundboard::playable(&state, user_id, sound_id.db(), source).await?.ok_or_else(unknown_sound)?;
            sqlx::query(
                "INSERT INTO entrance_sounds (user_id, scope_guild_id, sound_id, source_guild_id) VALUES ($1, $2, $3, $4) \
                 ON CONFLICT (user_id, scope_guild_id) DO UPDATE SET sound_id = $3, source_guild_id = $4, updated_at = now()",
            )
            .bind(user_id)
            .bind(scope)
            .bind(sound_id.db())
            .bind(source)
            .execute(&state.db)
            .await?;
        }
    }
    let sounds = soundboard::entrance_sounds(&state, user_id).await?;
    state.hub.send(&[user_id], &GatewayEvent::EntranceSoundsUpdate(sounds.clone()));
    Ok(Json(sounds))
}
