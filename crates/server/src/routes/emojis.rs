use axum::Json;
use axum::Router;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE, HeaderName};
use axum::http::{HeaderValue, StatusCode};
use axum::response::Response;
use axum::routing::get;
use tokio_util::io::ReaderStream;
use vokko_protocol::api::permissions::MANAGE_GUILD_EXPRESSIONS;
use vokko_protocol::api::{CreateGuildEmojiRequest, EditGuildEmojiRequest, GuildEmoji, Snowflake};

use crate::access::guild_access;
use crate::auth::AuthUser;
use crate::emojis::{self, MAX_BYTES, MAX_PER_KIND};
use crate::error::{ApiErr, ApiResult};
use crate::extract::{ApiJson, parse_id};
use crate::media;
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/guilds/{id}/emojis", get(list).post(create))
        .route("/guilds/{id}/emojis/{emoji_id}", get(get_one).patch(edit).delete(remove))
        .route("/emojis/{emoji_id}", get(image))
}

fn ids(guild: &str, emoji: Option<&str>) -> ApiResult<(i64, i64)> {
    let guild_id = parse_id(guild).ok_or_else(ApiErr::unknown_guild)?;
    let emoji_id = match emoji {
        Some(raw) => parse_id(raw).ok_or_else(ApiErr::unknown_emoji)?,
        None => 0,
    };
    Ok((guild_id, emoji_id))
}

fn check_name(name: &str) -> ApiResult<()> {
    if emojis::valid_name(name) { Ok(()) } else { Err(ApiErr::invalid("name", "Must be 2-32 characters of letters, digits and underscores.")) }
}

/// Role ids of this guild other than @everyone, deduplicated.
async fn check_roles(state: &AppState, guild_id: i64, roles: &[Snowflake]) -> ApiResult<Vec<i64>> {
    let mut ids: Vec<i64> = roles.iter().map(|role| role.db()).collect();
    ids.sort_unstable();
    ids.dedup();
    let found: Vec<(i64,)> =
        sqlx::query_as("SELECT id FROM roles WHERE guild_id = $1 AND id = ANY($2) AND id <> $1").bind(guild_id).bind(&ids).fetch_all(&state.db).await?;
    if found.len() != ids.len() {
        return Err(ApiErr::invalid("roles", "Unknown role."));
    }
    Ok(ids)
}

async fn set_roles(state: &AppState, emoji_id: i64, roles: &[i64]) -> ApiResult<()> {
    sqlx::query("DELETE FROM emoji_roles WHERE emoji_id = $1").bind(emoji_id).execute(&state.db).await?;
    sqlx::query("INSERT INTO emoji_roles (emoji_id, role_id) SELECT $1, unnest($2::BIGINT[])").bind(emoji_id).bind(roles).execute(&state.db).await?;
    Ok(())
}

async fn list(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Vec<GuildEmoji>>> {
    let (guild_id, _) = ids(&id, None)?;
    guild_access(&state, user_id, guild_id).await?;
    Ok(Json(emojis::guild_emojis(&state, guild_id, true).await?))
}

async fn get_one(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path((id, emoji)): Path<(String, String)>) -> ApiResult<Json<GuildEmoji>> {
    let (guild_id, emoji_id) = ids(&id, Some(&emoji))?;
    guild_access(&state, user_id, guild_id).await?;
    Ok(Json(emojis::guild_emoji(&state, guild_id, emoji_id).await?))
}

async fn create(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<CreateGuildEmojiRequest>,
) -> ApiResult<Json<GuildEmoji>> {
    let (guild_id, _) = ids(&id, None)?;
    guild_access(&state, user_id, guild_id).await?.require(MANAGE_GUILD_EXPRESSIONS)?;
    check_name(&body.name)?;
    let roles = check_roles(&state, guild_id, body.roles.as_deref().unwrap_or_default()).await?;

    let field = "image_attachment_id";
    let attachment_id = body.image_attachment_id.db();
    let row: Option<(Option<String>, i64)> = sqlx::query_as(
        "SELECT content_type, size FROM attachments WHERE id = $1 AND uploader_id = $2 AND key IS NOT NULL AND message_id IS NULL AND claimed_at IS NULL",
    )
    .bind(attachment_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;
    let Some((content_type, size)) = row else { return Err(ApiErr::invalid(field, "Unknown attachment.")) };
    let content_type = content_type.unwrap_or_default();
    if !matches!(content_type.as_str(), "image/png" | "image/gif" | "image/webp") {
        return Err(ApiErr::invalid(field, "Must be a PNG, GIF or WebP image."));
    }
    if size > MAX_BYTES {
        return Err(ApiErr::invalid(field, "The image is too large (256 KiB at most)."));
    }
    let bytes = tokio::fs::read(media::file_path(&state, attachment_id)).await.map_err(|_| ApiErr::invalid(field, "Unknown attachment."))?;
    let animated = emojis::is_animated(&content_type, &bytes);

    let emoji_id = state.ids.next();
    let mut tx = state.db.begin().await?;
    // Serialises concurrent uploads to one guild so the per-kind cap holds.
    sqlx::query("SELECT id FROM guilds WHERE id = $1 FOR UPDATE").bind(guild_id).execute(&mut *tx).await?;
    let (count,): (i64,) =
        sqlx::query_as("SELECT count(*) FROM emojis WHERE guild_id = $1 AND animated = $2").bind(guild_id).bind(animated).fetch_one(&mut *tx).await?;
    if count >= MAX_PER_KIND {
        return Err(ApiErr::conflict(30008, "Maximum number of emojis reached (250)"));
    }
    let claimed = sqlx::query("UPDATE attachments SET claimed_at = now() WHERE id = $1 AND uploader_id = $2 AND message_id IS NULL AND claimed_at IS NULL")
        .bind(attachment_id)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    if claimed.rows_affected() == 0 {
        return Err(ApiErr::invalid(field, "Unknown attachment."));
    }
    sqlx::query("INSERT INTO emojis (id, guild_id, name, animated, attachment_id, uploader_id) VALUES ($1, $2, $3, $4, $5, $6)")
        .bind(emoji_id)
        .bind(guild_id)
        .bind(&body.name)
        .bind(animated)
        .bind(attachment_id)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO emoji_roles (emoji_id, role_id) SELECT $1, unnest($2::BIGINT[])").bind(emoji_id).bind(&roles).execute(&mut *tx).await?;
    tx.commit().await?;
    emojis::broadcast(&state, guild_id).await?;
    Ok(Json(emojis::guild_emoji(&state, guild_id, emoji_id).await?))
}

async fn edit(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path((id, emoji)): Path<(String, String)>,
    ApiJson(body): ApiJson<EditGuildEmojiRequest>,
) -> ApiResult<Json<GuildEmoji>> {
    let (guild_id, emoji_id) = ids(&id, Some(&emoji))?;
    guild_access(&state, user_id, guild_id).await?.require(MANAGE_GUILD_EXPRESSIONS)?;
    emojis::guild_emoji(&state, guild_id, emoji_id).await?;
    if let Some(name) = &body.name {
        check_name(name)?;
    }
    let roles = match &body.roles {
        Some(roles) => Some(check_roles(&state, guild_id, roles.as_deref().unwrap_or_default()).await?),
        None => None,
    };
    if let Some(name) = &body.name {
        sqlx::query("UPDATE emojis SET name = $1 WHERE id = $2").bind(name).bind(emoji_id).execute(&state.db).await?;
    }
    if let Some(roles) = roles {
        set_roles(&state, emoji_id, &roles).await?;
    }
    emojis::broadcast(&state, guild_id).await?;
    Ok(Json(emojis::guild_emoji(&state, guild_id, emoji_id).await?))
}

async fn remove(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path((id, emoji)): Path<(String, String)>) -> ApiResult<StatusCode> {
    let (guild_id, emoji_id) = ids(&id, Some(&emoji))?;
    guild_access(&state, user_id, guild_id).await?.require(MANAGE_GUILD_EXPRESSIONS)?;
    let deleted: Option<(i64,)> = sqlx::query_as("DELETE FROM emojis WHERE id = $1 AND guild_id = $2 RETURNING attachment_id")
        .bind(emoji_id)
        .bind(guild_id)
        .fetch_optional(&state.db)
        .await?;
    let Some((attachment_id,)) = deleted else { return Err(ApiErr::unknown_emoji()) };
    sqlx::query("DELETE FROM attachments WHERE id = $1").bind(attachment_id).execute(&state.db).await?;
    media::remove_files(&state, &[attachment_id]).await;
    emojis::broadcast(&state, guild_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The emoji image by id, without auth (Discord's emoji CDN is public too): viewers outside the guild render `<:name:id>`.
async fn image(State(state): State<AppState>, Path(emoji): Path<String>) -> ApiResult<Response> {
    let emoji_id = parse_id(&emoji).ok_or_else(ApiErr::unknown_emoji)?;
    let row: Option<(i64, Option<String>)> =
        sqlx::query_as("SELECT a.id, a.content_type FROM emojis e JOIN attachments a ON a.id = e.attachment_id WHERE e.id = $1")
            .bind(emoji_id)
            .fetch_optional(&state.db)
            .await?;
    let Some((attachment_id, content_type)) = row else { return Err(ApiErr::unknown_emoji()) };
    let file = tokio::fs::File::open(media::file_path(&state, attachment_id)).await.map_err(|_| ApiErr::unknown_emoji())?;
    let length = file.metadata().await.map_err(|_| ApiErr::unknown_emoji())?.len();
    let content_type = content_type.unwrap_or_else(|| "application/octet-stream".to_owned());
    let mut response = Response::new(Body::from_stream(ReaderStream::new(file)));
    *response.status_mut() = StatusCode::OK;
    let headers = response.headers_mut();
    headers.insert(CONTENT_TYPE, HeaderValue::from_str(&content_type).map_err(|_| ApiErr::internal())?);
    headers.insert(CONTENT_LENGTH, HeaderValue::from(length));
    // The image of an id never changes (PATCH edits only name and roles); a deleted emoji 404s once the cache expires.
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("public, max-age=86400"));
    headers.insert(HeaderName::from_static("x-content-type-options"), HeaderValue::from_static("nosniff"));
    Ok(response)
}
