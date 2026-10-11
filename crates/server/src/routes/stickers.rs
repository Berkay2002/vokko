use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::get;
use vokko_protocol::api::permissions::MANAGE_GUILD_EXPRESSIONS;
use vokko_protocol::api::{CreateStickerRequest, EditStickerRequest, Sticker};

use crate::access::guild_access;
use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::extract::{ApiJson, parse_id};
use crate::media;
use crate::state::AppState;
use crate::stickers::{self, MAX_STICKER_BYTES, MAX_STICKER_DIMENSION};

pub fn routes() -> Router<AppState> {
    Router::new().route("/guilds/{id}/stickers", get(list).post(create)).route("/guilds/{id}/stickers/{sid}", get(get_one).patch(edit).delete(remove))
}

fn guild_id(raw: &str) -> ApiResult<i64> {
    parse_id(raw).ok_or_else(ApiErr::unknown_guild)
}

fn sticker_id(raw: &str) -> ApiResult<i64> {
    parse_id(raw).ok_or_else(|| ApiErr::new_unknown("Unknown Sticker", 10060))
}

fn name(raw: &str) -> ApiResult<String> {
    let name = raw.trim().to_owned();
    if !(2..=30).contains(&name.chars().count()) {
        return Err(ApiErr::invalid("name", "Must be between 2 and 30 in length."));
    }
    Ok(name)
}

fn description(raw: &str) -> ApiResult<Option<String>> {
    let text = raw.trim();
    if text.chars().count() > 100 {
        return Err(ApiErr::invalid("description", "Must be 100 or fewer in length."));
    }
    Ok((!text.is_empty()).then(|| text.to_owned()))
}

fn tags(raw: &str) -> ApiResult<String> {
    let tags = raw.trim().to_owned();
    if !(2..=200).contains(&tags.chars().count()) {
        return Err(ApiErr::invalid("tags", "Must be between 2 and 200 in length."));
    }
    Ok(tags)
}

async fn list(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Vec<Sticker>>> {
    let id = guild_id(&id)?;
    guild_access(&state, user_id, id).await?;
    Ok(Json(stickers::of_guild(&state, id).await?))
}

async fn get_one(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path((id, sid)): Path<(String, String)>) -> ApiResult<Json<Sticker>> {
    let id = guild_id(&id)?;
    guild_access(&state, user_id, id).await?;
    let found = stickers::find(&state, id, sticker_id(&sid)?).await?;
    found.map(|(sticker, _)| Json(sticker)).ok_or_else(|| ApiErr::new_unknown("Unknown Sticker", 10060))
}

async fn create(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<CreateStickerRequest>,
) -> ApiResult<Json<Sticker>> {
    let id = guild_id(&id)?;
    let access = guild_access(&state, user_id, id).await?;
    access.require(MANAGE_GUILD_EXPRESSIONS)?;
    let name = name(&body.name)?;
    let description = match body.description.as_deref() {
        Some(text) => description(text)?,
        None => None,
    };
    let tags = tags(&body.tags)?;
    let (count,): (i64,) = sqlx::query_as("SELECT count(*) FROM stickers WHERE guild_id = $1").bind(id).fetch_one(&state.db).await?;
    if count as usize >= state.config.max_stickers_per_guild {
        return Err(ApiErr::conflict(30039, "Maximum number of stickers reached"));
    }

    let attachment = body.attachment_id.db();
    let upload: Option<(String, String, Option<String>, i64)> = sqlx::query_as(
        "SELECT filename, key, content_type, size FROM attachments \
         WHERE id = $1 AND uploader_id = $2 AND key IS NOT NULL AND message_id IS NULL AND claimed_at IS NULL",
    )
    .bind(attachment)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;
    let Some((filename, key, _, size)) = upload else { return Err(ApiErr::invalid("attachment_id", "Unknown attachment.")) };
    if size > MAX_STICKER_BYTES {
        return Err(ApiErr::invalid("attachment_id", "A sticker can be at most 512 KiB."));
    }
    let bytes = state.storage.read(attachment).await.map_err(|_| ApiErr::invalid("attachment_id", "Unknown attachment."))?;
    let sniffed = media::sniff_image(&bytes);
    let format = sniffed
        .and_then(|image| stickers::detect_format(image.content_type, &bytes))
        .ok_or_else(|| ApiErr::invalid("attachment_id", "A sticker must be a PNG, APNG, GIF or WebP image."))?;
    if let Some(image) = sniffed
        && (image.width == 0 || image.height == 0 || image.width > MAX_STICKER_DIMENSION || image.height > MAX_STICKER_DIMENSION)
    {
        return Err(ApiErr::invalid("attachment_id", "A sticker can be at most 512x512 pixels."));
    }

    let sticker_id = state.ids.next();
    let path = media::asset_path(attachment, &key, &filename);
    let mut tx = state.db.begin().await?;
    let claimed = sqlx::query("UPDATE attachments SET claimed_at = now(), sticker_asset = TRUE WHERE id = $1 AND claimed_at IS NULL AND message_id IS NULL")
        .bind(attachment)
        .execute(&mut *tx)
        .await?;
    if claimed.rows_affected() != 1 {
        return Err(ApiErr::invalid("attachment_id", "Unknown attachment."));
    }
    sqlx::query(
        "INSERT INTO stickers (id, guild_id, name, description, tags, format, attachment_id, asset_path, creator_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(sticker_id)
    .bind(id)
    .bind(&name)
    .bind(&description)
    .bind(&tags)
    .bind(format.as_u8() as i16)
    .bind(attachment)
    .bind(&path)
    .bind(user_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    stickers::broadcast(&state, id).await?;
    let (sticker, _) = stickers::find(&state, id, sticker_id).await?.ok_or_else(ApiErr::internal)?;
    Ok(Json(sticker))
}

async fn edit(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path((id, sid)): Path<(String, String)>,
    ApiJson(body): ApiJson<EditStickerRequest>,
) -> ApiResult<Json<Sticker>> {
    let id = guild_id(&id)?;
    let sid = sticker_id(&sid)?;
    let access = guild_access(&state, user_id, id).await?;
    let (current, _) = stickers::find(&state, id, sid).await?.ok_or_else(|| ApiErr::new_unknown("Unknown Sticker", 10060))?;
    access.require(MANAGE_GUILD_EXPRESSIONS)?;
    let name = match body.name.as_deref() {
        Some(raw) => name(raw)?,
        None => current.name,
    };
    let description = match body.description {
        Some(Some(raw)) => description(&raw)?,
        Some(None) => None,
        None => current.description,
    };
    let tags = match body.tags.as_deref() {
        Some(raw) => tags(raw)?,
        None => current.tags,
    };
    sqlx::query("UPDATE stickers SET name = $3, description = $4, tags = $5 WHERE id = $1 AND guild_id = $2")
        .bind(sid)
        .bind(id)
        .bind(&name)
        .bind(&description)
        .bind(&tags)
        .execute(&state.db)
        .await?;
    stickers::broadcast(&state, id).await?;
    stickers::find(&state, id, sid).await?.map(|(sticker, _)| Json(sticker)).ok_or_else(|| ApiErr::new_unknown("Unknown Sticker", 10060))
}

async fn remove(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path((id, sid)): Path<(String, String)>) -> ApiResult<StatusCode> {
    let id = guild_id(&id)?;
    let sid = sticker_id(&sid)?;
    let access = guild_access(&state, user_id, id).await?;
    let _ = stickers::find(&state, id, sid).await?.ok_or_else(|| ApiErr::new_unknown("Unknown Sticker", 10060))?;
    access.require(MANAGE_GUILD_EXPRESSIONS)?;
    sqlx::query("DELETE FROM stickers WHERE id = $1 AND guild_id = $2").bind(sid).bind(id).execute(&state.db).await?;
    stickers::sweep_assets(&state).await;
    stickers::broadcast(&state, id).await?;
    Ok(StatusCode::NO_CONTENT)
}
