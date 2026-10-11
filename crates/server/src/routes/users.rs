use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::routing::get;
use sqlx::{PgConnection, Postgres, QueryBuilder};
use vokko_protocol::api::{GatewayEvent, MutualGuild, Snowflake, UpdateUserRequest, User, UserProfile};

use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::events;
use crate::extract::{ApiJson, ApiQuery, parse_id};
use crate::routes::auth::clean_text;
use crate::state::AppState;
use crate::store;

pub fn routes() -> Router<AppState> {
    Router::new().route("/users/@me", get(me).patch(update_me)).route("/users/{id}", get(get_user)).route("/users/{id}/profile", get(get_profile))
}

const MIB: i64 = 1024 * 1024;
pub const MAX_PRONOUNS_CHARS: usize = 40;
pub const MAX_BIO_CHARS: usize = 190;
/// Longest id of an asset from the client's open decoration / effect / badge / theme sets.
const MAX_ASSET_ID_CHARS: usize = 64;
const MAX_RGB: u32 = 0xff_ffff;

async fn me(State(state): State<AppState>, AuthUser(user_id): AuthUser) -> ApiResult<Json<User>> {
    store::user(&state, user_id).await?.map(Json).ok_or_else(ApiErr::unauthorized)
}

fn valid_color(value: &str) -> bool {
    value.len() == 7 && value.starts_with('#') && value[1..].chars().all(|c| c.is_ascii_hexdigit())
}

/// An id into the client's open asset sets: 1-64 characters of `a-z 0-9 _ -`; empty clears.
pub fn asset_id(value: Option<String>, field: &str) -> ApiResult<Option<String>> {
    let Some(value) = value.map(|text| text.trim().to_owned()).filter(|text| !text.is_empty()) else { return Ok(None) };
    if value.chars().count() > MAX_ASSET_ID_CHARS || !value.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-') {
        return Err(ApiErr::invalid(field, "Must be 1-64 characters: lowercase letters, numbers, '_' and '-'."));
    }
    Ok(Some(value))
}

/// An RGB int (0..=0xFFFFFF) as the INTEGER column value.
pub fn rgb(value: u32, field: &str) -> ApiResult<i32> {
    if value > MAX_RGB {
        return Err(ApiErr::invalid(field, "Must be an RGB colour between 0 and 16777215."));
    }
    Ok(value as i32)
}

/// A `[primary, accent]` profile theme as its two column values.
pub fn theme_pair(colors: [u32; 2], field: &str) -> ApiResult<(i32, i32)> {
    Ok((rgb(colors[0], field)?, rgb(colors[1], field)?))
}

/// Sends the user's current state to everyone who shares a guild, DM or friendship with them (and themselves).
pub async fn publish_user(state: &AppState, user_id: i64) -> ApiResult<User> {
    let user = store::user(state, user_id).await?.ok_or_else(ApiErr::unauthorized)?;
    let audience = events::user_audience(state, user_id).await?;
    state.hub.send(&audience, &GatewayEvent::UserUpdate(user.clone()));
    Ok(user)
}

async fn update_me(State(state): State<AppState>, AuthUser(user_id): AuthUser, ApiJson(body): ApiJson<UpdateUserRequest>) -> ApiResult<Json<User>> {
    // Validate every key first so a rejected request changes nothing. Outer `None` = key absent, inner `None` = clear.
    let global_name = body.global_name.map(|value| clean_text(value, 32, "global_name")).transpose()?;
    let bio = body.bio.map(|value| clean_text(value, MAX_BIO_CHARS, "bio")).transpose()?;
    let banner_color = match body.banner_color {
        None => None,
        Some(None) => Some(None),
        Some(Some(color)) => {
            let color = color.trim().to_lowercase();
            if color.is_empty() {
                Some(None)
            } else if valid_color(&color) {
                Some(Some(color))
            } else {
                return Err(ApiErr::invalid("banner_color", "Must be a #rrggbb colour."));
            }
        }
    };
    let pronouns = body.pronouns.map(|value| clean_text(value, MAX_PRONOUNS_CHARS, "pronouns")).transpose()?;
    let theme = match body.theme_colors {
        None => None,
        Some(None) => Some(None),
        Some(Some(colors)) => Some(Some(theme_pair(colors, "theme_colors")?)),
    };
    let decoration = body.avatar_decoration.map(|value| asset_id(value, "avatar_decoration")).transpose()?;
    let effect = body.profile_effect.map(|value| asset_id(value, "profile_effect")).transpose()?;
    let avatar = match body.avatar_attachment_id {
        None => None,
        Some(None) => Some(None),
        Some(Some(id)) => Some(Some(owned_image_path(&state, id.db(), user_id, ImageKind::Avatar, "avatar_attachment_id").await?)),
    };
    let banner = match body.banner_attachment_id {
        None => None,
        Some(None) => Some(None),
        Some(Some(id)) => Some(Some(owned_image_path(&state, id.db(), user_id, ImageKind::Banner, "banner_attachment_id").await?)),
    };
    let primary_guild = match body.primary_guild_id {
        None => None,
        Some(None) => Some(None),
        Some(Some(guild)) => {
            let usable: Option<(i64,)> =
                sqlx::query_as("SELECT g.id FROM guilds g JOIN guild_members m ON m.guild_id = g.id AND m.user_id = $2 WHERE g.id = $1 AND g.tag IS NOT NULL")
                    .bind(guild.db())
                    .bind(user_id)
                    .fetch_optional(&state.db)
                    .await?;
            if usable.is_none() {
                return Err(ApiErr::invalid("primary_guild_id", "Must be a server you are in that has a tag."));
            }
            Some(Some(guild.db()))
        }
    };

    let mut update = QueryBuilder::<Postgres>::new("UPDATE users SET ");
    let mut sets = update.separated(", ");
    if let Some(value) = global_name {
        sets.push("global_name = ").push_bind_unseparated(value);
    }
    if let Some(value) = bio {
        sets.push("bio = ").push_bind_unseparated(value);
    }
    if let Some(value) = banner_color {
        sets.push("banner_color = ").push_bind_unseparated(value);
    }
    if let Some(value) = avatar {
        sets.push("avatar_path = ").push_bind_unseparated(value);
    }
    if let Some(value) = banner {
        sets.push("banner_path = ").push_bind_unseparated(value);
    }
    if let Some(value) = pronouns {
        sets.push("pronouns = ").push_bind_unseparated(value);
    }
    if let Some(value) = theme {
        sets.push("theme_primary = ").push_bind_unseparated(value.map(|(primary, _)| primary));
        sets.push("theme_accent = ").push_bind_unseparated(value.map(|(_, accent)| accent));
    }
    if let Some(value) = decoration {
        sets.push("avatar_decoration = ").push_bind_unseparated(value);
    }
    if let Some(value) = effect {
        sets.push("profile_effect = ").push_bind_unseparated(value);
    }
    if let Some(value) = primary_guild {
        sets.push("primary_guild_id = ").push_bind_unseparated(value);
    }
    // An empty request is a no-op that still returns the user.
    if update.sql().len() > "UPDATE users SET ".len() {
        update.push(" WHERE id = ").push_bind(user_id);
        update.build().execute(&state.db).await?;
    }
    Ok(Json(publish_user(&state, user_id).await?))
}

/// Which limits an uploaded profile image has.
#[derive(Clone, Copy)]
pub enum ImageKind {
    /// Avatars and server icons.
    Avatar,
    Banner,
}

impl ImageKind {
    /// (largest file, largest animated GIF) in bytes. Nothing is re-encoded, so the animated cap stands in for the stored size.
    fn limits(self) -> (i64, i64) {
        match self {
            Self::Avatar => (8 * MIB, 2 * MIB),
            Self::Banner => (10 * MIB, 4 * MIB),
        }
    }
}

/// Asset path (`<id>/<key>/<filename>`) of a PNG/JPEG/GIF/WebP attachment uploaded by `user_id` that is within the size limits of `kind`,
/// used for avatars, banners and guild icons. Marks the row `claimed_at` so the pending-upload cleanup never deletes it while it is in use.
pub async fn owned_image_path(state: &AppState, attachment_id: i64, user_id: i64, kind: ImageKind, field: &str) -> ApiResult<String> {
    let mut conn = state.db.acquire().await?;
    image_path_on(&mut conn, attachment_id, user_id, kind, field, false).await
}

/// `owned_image_path` on the caller's connection (a transaction, so a failed write leaves nothing claimed). `cover` claims the upload
/// for a scheduled event: that needs it unclaimed, and from then on avatars and icons refuse it. Anything else refuses event covers.
pub async fn image_path_on(conn: &mut PgConnection, attachment_id: i64, user_id: i64, kind: ImageKind, field: &str, cover: bool) -> ApiResult<String> {
    let row: Option<(String, String, Option<String>, i64)> = sqlx::query_as(
        "SELECT filename, key, content_type, size FROM attachments WHERE id = $1 AND uploader_id = $2 AND key IS NOT NULL AND message_id IS NULL \
         AND ($3 OR NOT event_cover) AND NOT EXISTS (SELECT 1 FROM emojis e WHERE e.attachment_id = attachments.id)",
    )
    .bind(attachment_id)
    .bind(user_id)
    .bind(cover)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((filename, key, content_type, size)) = row else { return Err(ApiErr::invalid(field, "Unknown attachment.")) };
    let content_type = content_type.unwrap_or_default();
    if !matches!(content_type.as_str(), "image/png" | "image/jpeg" | "image/gif" | "image/webp") {
        return Err(ApiErr::invalid(field, "Must be a PNG, JPEG, GIF or WebP image."));
    }
    let (max, max_animated) = kind.limits();
    if size > max || (content_type == "image/gif" && size > max_animated) {
        let limit = if content_type == "image/gif" { max_animated } else { max };
        return Err(ApiErr::invalid(field, &format!("The image is too large ({} MiB at most).", limit / MIB)));
    }
    // Claiming is one statement, so two requests racing for the same upload cannot both win.
    let claimed = sqlx::query(
        "UPDATE attachments SET claimed_at = COALESCE(claimed_at, now()), event_cover = $3 WHERE id = $1 AND uploader_id = $2 AND key IS NOT NULL \
         AND message_id IS NULL AND CASE WHEN $3 THEN claimed_at IS NULL ELSE NOT event_cover END \
         AND NOT EXISTS (SELECT 1 FROM emojis e WHERE e.attachment_id = attachments.id)",
    )
    .bind(attachment_id)
    .bind(user_id)
    .bind(cover)
    .execute(&mut *conn)
    .await?;
    if claimed.rows_affected() == 0 {
        return Err(if cover { ApiErr::invalid(field, "This upload is already in use.") } else { ApiErr::invalid(field, "Unknown attachment.") });
    }
    Ok(crate::media::asset_path(attachment_id, &key, &filename))
}

async fn get_user(State(state): State<AppState>, AuthUser(_): AuthUser, Path(id): Path<String>) -> ApiResult<Json<User>> {
    let id = parse_id(&id).ok_or_else(ApiErr::unknown_user)?;
    store::user(&state, id).await?.map(Json).ok_or_else(ApiErr::unknown_user)
}

#[derive(serde::Deserialize)]
struct ProfileQuery {
    guild_id: Option<Snowflake>,
}

/// `GET /users/{id}/profile`: the user plus what the caller shares with them.
async fn get_profile(
    State(state): State<AppState>,
    AuthUser(viewer): AuthUser,
    Path(id): Path<String>,
    ApiQuery(query): ApiQuery<ProfileQuery>,
) -> ApiResult<Json<UserProfile>> {
    let id = parse_id(&id).ok_or_else(ApiErr::unknown_user)?;
    let user = store::user(&state, id).await?.ok_or_else(ApiErr::unknown_user)?;
    let guilds: Vec<(i64, Option<String>)> = sqlx::query_as(
        "SELECT a.guild_id, b.nick FROM guild_members a JOIN guild_members b ON b.guild_id = a.guild_id AND b.user_id = $2 \
         WHERE a.user_id = $1 ORDER BY a.guild_id",
    )
    .bind(viewer)
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    let (friends,): (i64,) = sqlx::query_as(
        "SELECT count(*) FROM relationships a JOIN relationships b ON b.other_id = a.other_id AND b.user_id = $2 AND b.kind = 1 \
         WHERE a.user_id = $1 AND a.kind = 1 AND a.other_id NOT IN ($1, $2)",
    )
    .bind(viewer)
    .bind(id)
    .fetch_one(&state.db)
    .await?;
    // Only for guilds the caller is in themselves.
    let guild_member = match query.guild_id.map(Snowflake::db) {
        Some(guild_id) if guilds.iter().any(|(shared, _)| *shared == guild_id) => store::member(&state, guild_id, id).await?,
        _ => None,
    };
    Ok(Json(UserProfile {
        user,
        mutual_guilds: guilds.into_iter().map(|(guild_id, nick)| MutualGuild { id: Snowflake::from(guild_id), nick }).collect(),
        mutual_friends_count: friends.max(0) as u32,
        guild_member,
    }))
}
