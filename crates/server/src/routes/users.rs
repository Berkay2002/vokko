use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::routing::{get, post};
use sqlx::{PgConnection, Postgres, QueryBuilder};
use vokko_protocol::api::permissions::ATTACH_FILES;
use vokko_protocol::api::{
    Attachment, AvatarGifRequest, DisplayNameStyles, GatewayEvent, MutualGuild, ProfileWidgetsInput, RecentAvatar, Snowflake, UpdateUserRequest, User,
    UserProfile,
};

use crate::access::channel_access;

use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::events;
use crate::extract::{ApiJson, ApiQuery, parse_id};
use crate::routes::auth::clean_text;
use crate::state::AppState;
use crate::store::{self, StoredFavorite, StoredGame, StoredWidgets};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/users/@me", get(me).patch(update_me))
        .route("/users/@me/avatars", get(recent_avatars))
        .route("/users/@me/avatars/gif", post(import_avatar_gif))
        .route("/users/{id}", get(get_user))
        .route("/users/{id}/profile", get(get_profile))
        .route("/users/{id}/relationships", get(mutual_friends))
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

/// A display name style as its (font, effect, colours) column values: asset ids for font and effect, one or two RGB colours.
pub fn name_style(style: DisplayNameStyles, field: &str) -> ApiResult<(String, String, Vec<i32>)> {
    let font = asset_id(Some(style.font_id), field)?.ok_or_else(|| ApiErr::invalid(field, "A font is required."))?;
    let effect = asset_id(Some(style.effect_id), field)?.ok_or_else(|| ApiErr::invalid(field, "An effect is required."))?;
    if !(1..=2).contains(&style.colors.len()) {
        return Err(ApiErr::invalid(field, "Must have one or two colours."));
    }
    let colors = style.colors.into_iter().map(|color| rgb(color, field)).collect::<ApiResult<Vec<i32>>>()?;
    Ok((font, effect, colors))
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
    let nameplate = body.nameplate.map(|value| asset_id(value, "nameplate")).transpose()?;
    let name_style = match body.display_name_styles {
        None => None,
        Some(None) => Some(None),
        Some(Some(style)) => Some(Some(name_style(style, "display_name_styles")?)),
    };
    let widgets = match body.widgets {
        None => None,
        Some(None) => Some(None),
        Some(Some(input)) => Some(clean_widgets(input)?),
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

    // Images (avatar, banner, widgets) are claimed in the same transaction as the write that shows them, and the widget images the new
    // value no longer shows are released only once the row is updated, so a claim is never visible without its path.
    // Outer `None` = unchanged, inner `None` = cleared.
    // Only the uploads this request can claim or release are locked, all in one statement by ascending id and before the users row
    // (the order account delete takes them), so this never deadlocks with message sends, guild edits or an account delete, and a
    // request that touches no image locks no upload at all. Releasing needs the widget images the profile shows now: they are read
    // first without a lock, and if a concurrent edit changed them before the users row was ours, the request starts over locking all of
    // the user's unsent uploads (a superset of anything it can claim or release, still one ordered statement).
    let mut wanted: Vec<i64> = [body.avatar_attachment_id, body.banner_attachment_id].into_iter().flatten().flatten().map(|id| id.db()).collect();
    if let Some(Some(board)) = &widgets {
        wanted.extend(board.favorite_game.iter().filter_map(|favorite| favorite.game.image));
        wanted.extend(board.games_i_like.iter().flatten().filter_map(|game| game.image));
    }
    let mut broad = false;
    let (mut tx, previous_widgets) = loop {
        let mut tx = state.db.begin().await?;
        let mut locked = wanted.clone();
        if broad {
            sqlx::query("SELECT id FROM attachments WHERE uploader_id = $1 AND message_id IS NULL ORDER BY id FOR UPDATE")
                .bind(user_id)
                .execute(&mut *tx)
                .await?;
        } else {
            if widgets.is_some() {
                locked.extend(shown_widget_images(&mut tx, user_id).await?.1);
            }
            locked.sort_unstable();
            locked.dedup();
            crate::media::lock_own_uploads(&mut tx, &locked, user_id).await?;
        }
        sqlx::query("SELECT id FROM users WHERE id = $1 FOR UPDATE").bind(user_id).execute(&mut *tx).await?;
        if widgets.is_none() {
            break (tx, None);
        }
        let (previous, shown) = shown_widget_images(&mut tx, user_id).await?;
        if broad || shown.iter().all(|id| locked.contains(id)) {
            break (tx, Some(previous));
        }
        tx.rollback().await?;
        broad = true;
    };
    let avatar = match body.avatar_attachment_id {
        None => None,
        Some(None) => Some(None),
        Some(Some(id)) => Some(Some(image_path_on(&mut tx, id.db(), user_id, ImageKind::Avatar, "avatar_attachment_id", false).await?)),
    };
    let banner = match body.banner_attachment_id {
        None => None,
        Some(None) => Some(None),
        Some(Some(id)) => Some(Some(image_path_on(&mut tx, id.db(), user_id, ImageKind::Banner, "banner_attachment_id", false).await?)),
    };
    let mut released: Vec<i64> = Vec::new();
    let widgets = match widgets {
        None => None,
        Some(board) => {
            let previous = previous_widgets.flatten();
            let stored = resolve_widgets(&mut tx, board, user_id).await?;
            let kept = stored.as_ref().map(StoredWidgets::attachment_ids).unwrap_or_default();
            released = previous
                .and_then(|text| serde_json::from_str::<StoredWidgets>(&text).ok())
                .map(|old| old.attachment_ids())
                .unwrap_or_default()
                .into_iter()
                .filter(|id| !kept.contains(id))
                .collect();
            Some(stored.map(|stored| serde_json::to_string(&stored)).transpose().map_err(|_| ApiErr::internal())?)
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
    if let Some(value) = nameplate {
        sets.push("nameplate = ").push_bind_unseparated(value);
    }
    if let Some(value) = name_style {
        let (font, effect, colors) = match value {
            Some((font, effect, colors)) => (Some(font), Some(effect), Some(colors)),
            None => (None, None, None),
        };
        sets.push("name_font = ").push_bind_unseparated(font);
        sets.push("name_effect = ").push_bind_unseparated(effect);
        sets.push("name_colors = ").push_bind_unseparated(colors);
    }
    if let Some(value) = widgets {
        sets.push("widgets = ").push_bind_unseparated(value).push_unseparated("::jsonb");
    }
    // An empty request is a no-op that still returns the user.
    if update.sql().len() > "UPDATE users SET ".len() {
        update.push(" WHERE id = ").push_bind(user_id);
        update.build().execute(&mut *tx).await?;
    }
    release_uploads(&mut tx, &released, user_id).await?;
    if let Some(Some(id)) = body.avatar_attachment_id {
        remember_avatar(&mut tx, user_id, id.db()).await?;
    }
    tx.commit().await?;
    Ok(Json(publish_user(&state, user_id).await?))
}

/// How many past avatars `GET /users/@me/avatars` lists (Discord's "Recent avatars").
const RECENT_AVATARS: i64 = 6;

/// Puts the avatar the user just set at the top of their recent avatars and drops all but the newest [`RECENT_AVATARS`]. A listed upload is
/// in use ([`crate::media::IN_USE`]), so it stays until it falls off the list.
async fn remember_avatar(conn: &mut PgConnection, user_id: i64, attachment_id: i64) -> ApiResult<()> {
    sqlx::query("INSERT INTO user_avatar_history (user_id, attachment_id) VALUES ($1, $2) ON CONFLICT (user_id, attachment_id) DO UPDATE SET used_at = now()")
        .bind(user_id)
        .bind(attachment_id)
        .execute(&mut *conn)
        .await?;
    sqlx::query(
        "DELETE FROM user_avatar_history WHERE user_id = $1 AND attachment_id NOT IN          (SELECT attachment_id FROM user_avatar_history WHERE user_id = $1 ORDER BY used_at DESC, attachment_id DESC LIMIT $2)",
    )
    .bind(user_id)
    .bind(RECENT_AVATARS)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// `GET /users/@me/avatars`: the caller's last avatars, newest first. Setting one again is `avatar_attachment_id` with its id.
async fn recent_avatars(State(state): State<AppState>, AuthUser(user_id): AuthUser) -> ApiResult<Json<Vec<RecentAvatar>>> {
    let rows: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT a.id, a.key, a.filename FROM user_avatar_history h JOIN attachments a ON a.id = h.attachment_id          WHERE h.user_id = $1 AND a.key IS NOT NULL ORDER BY h.used_at DESC, h.attachment_id DESC LIMIT $2",
    )
    .bind(user_id)
    .bind(RECENT_AVATARS)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|(id, key, filename)| RecentAvatar { id: Snowflake::from(id), url: state.asset_url(&crate::media::asset_path(id, &key, &filename)) })
            .collect(),
    ))
}

/// `POST /users/@me/avatars/gif`: the server downloads a GIF picked in the GIF picker (only from the configured provider's media hosts, at
/// most as big as an avatar) and answers with the pending upload, which `PATCH /users/@me` then claims like any uploaded avatar. The
/// client does not download it itself: the desktop app's content security policy and the providers' CORS rules would stop it.
async fn import_avatar_gif(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    ApiJson(body): ApiJson<AvatarGifRequest>,
) -> ApiResult<Json<Attachment>> {
    let channel_id = body.channel_id.db();
    channel_access(&state, user_id, channel_id).await?.require(ATTACH_FILES)?;
    let _slot = state.uploads.acquire(user_id).ok_or_else(|| ApiErr::rate_limited(1.0))?;
    let max = usize::try_from(ImageKind::Avatar.limit()).unwrap_or(usize::MAX).min(state.config.max_upload_bytes);
    let bytes = state.gifs.download(&body.url, max).await?;
    Ok(Json(super::attachments::store_fetched_image(&state, user_id, channel_id, bytes).await?))
}

/// The user's stored widgets (as text) and the ids of the uploads they show.
async fn shown_widget_images(conn: &mut PgConnection, user_id: i64) -> ApiResult<(Option<String>, Vec<i64>)> {
    let (text,): (Option<String>,) = sqlx::query_as("SELECT widgets::text FROM users WHERE id = $1").bind(user_id).fetch_one(&mut *conn).await?;
    let ids = text.as_deref().and_then(|text| serde_json::from_str::<StoredWidgets>(text).ok()).map(|old| old.attachment_ids()).unwrap_or_default();
    Ok((text, ids))
}

const MAX_WIDGET_NAME_CHARS: usize = 64;
const MAX_WIDGET_REASON_CHARS: usize = 190;
const MAX_WIDGET_TAGS: usize = 5;
const MAX_WIDGET_TAG_CHARS: usize = 20;
const MAX_LIKED_GAMES: usize = 20;

/// A widget game with its text normalised; the image is still the caller's attachment id.
struct CleanGame {
    name: String,
    image: Option<i64>,
}

struct CleanFavorite {
    game: CleanGame,
    reason: Option<String>,
    tags: Vec<String>,
}

#[derive(Default)]
struct CleanWidgets {
    favorite_game: Option<CleanFavorite>,
    games_i_like: Option<Vec<CleanGame>>,
}

fn clean_game_name(name: String, field: &str) -> ApiResult<String> {
    let name = name.trim().to_owned();
    if name.is_empty() || name.chars().count() > MAX_WIDGET_NAME_CHARS {
        return Err(ApiErr::invalid(field, &format!("Must be between 1 and {MAX_WIDGET_NAME_CHARS} characters in length.")));
    }
    Ok(name)
}

/// Checks the text and the counts of a `widgets` value, so a rejected request never reaches the uploads. `None` = no widgets.
fn clean_widgets(input: ProfileWidgetsInput) -> ApiResult<Option<CleanWidgets>> {
    if !input.unknown.is_empty() {
        return Err(ApiErr::invalid("widgets", "Only favorite_game and games_i_like are allowed."));
    }
    let mut board = CleanWidgets::default();
    if let Some(Some(game)) = input.favorite_game {
        let name = clean_game_name(game.name, "widgets.favorite_game.name")?;
        let reason = clean_text(game.reason, MAX_WIDGET_REASON_CHARS, "widgets.favorite_game.reason")?;
        let tags: Vec<String> = game.tags.unwrap_or_default().into_iter().map(|tag| tag.trim().to_owned()).collect();
        if tags.len() > MAX_WIDGET_TAGS {
            return Err(ApiErr::invalid("widgets.favorite_game.tags", &format!("Must be {MAX_WIDGET_TAGS} or fewer.")));
        }
        for (index, tag) in tags.iter().enumerate() {
            if tag.is_empty() || tag.chars().count() > MAX_WIDGET_TAG_CHARS {
                return Err(ApiErr::invalid(
                    "widgets.favorite_game.tags",
                    &format!("Each tag must be between 1 and {MAX_WIDGET_TAG_CHARS} characters in length."),
                ));
            }
            if tags[..index].iter().any(|other| other.to_lowercase() == tag.to_lowercase()) {
                return Err(ApiErr::invalid("widgets.favorite_game.tags", "Tags must be unique."));
            }
        }
        board.favorite_game = Some(CleanFavorite { game: CleanGame { name, image: game.image_attachment_id.map(Snowflake::db) }, reason, tags });
    }
    if let Some(Some(games)) = input.games_i_like {
        if games.len() > MAX_LIKED_GAMES {
            return Err(ApiErr::invalid("widgets.games_i_like", &format!("Must be {MAX_LIKED_GAMES} or fewer.")));
        }
        let mut cleaned = Vec::with_capacity(games.len());
        for (index, game) in games.into_iter().enumerate() {
            let name = clean_game_name(game.name, &format!("widgets.games_i_like.{index}.name"))?;
            cleaned.push(CleanGame { name, image: game.image_attachment_id.map(Snowflake::db) });
        }
        board.games_i_like = Some(cleaned);
    }
    Ok(if board.favorite_game.is_none() && board.games_i_like.is_none() { None } else { Some(board) })
}

/// Claims the images of a cleaned board (each must be an upload of `user_id`, which includes ones the profile already shows) and
/// returns the value to store.
async fn resolve_widgets(conn: &mut PgConnection, board: Option<CleanWidgets>, user_id: i64) -> ApiResult<Option<StoredWidgets>> {
    let Some(board) = board else { return Ok(None) };
    let mut stored = StoredWidgets::default();
    if let Some(favorite) = board.favorite_game {
        let image_path = match favorite.game.image {
            Some(id) => Some(image_path_on(conn, id, user_id, ImageKind::Avatar, "widgets.favorite_game.image_attachment_id", false).await?),
            None => None,
        };
        stored.favorite_game = Some(StoredFavorite { name: favorite.game.name, image_path, reason: favorite.reason, tags: favorite.tags });
    }
    if let Some(games) = board.games_i_like {
        let mut liked = Vec::with_capacity(games.len());
        for (index, game) in games.into_iter().enumerate() {
            let image_path = match game.image {
                Some(id) => {
                    Some(image_path_on(conn, id, user_id, ImageKind::Avatar, &format!("widgets.games_i_like.{index}.image_attachment_id"), false).await?)
                }
                None => None,
            };
            liked.push(StoredGame { name: game.name, image_path });
        }
        stored.games_i_like = Some(liked);
    }
    Ok(Some(stored))
}

/// Lets go of uploads the profile stopped showing: when nothing else (an avatar, banner, server profile, guild or group icon, or another
/// widget) uses an upload any more it is a pending upload again, and the periodic cleanup removes it. Avatars and banners keep their old
/// uploads claimed; this only covers widget images.
///
/// The rows are locked first: a request that is claiming one of them for an avatar, icon or server profile holds that lock until it
/// has written the path (claim and write share a transaction), so the `UPDATE` below, a new statement with a fresh snapshot, always
/// sees whether the upload is in use. [`crate::media::IN_USE`] is the same condition the sweeps and deletes use.
async fn release_uploads(conn: &mut PgConnection, ids: &[i64], user_id: i64) -> ApiResult<()> {
    if ids.is_empty() {
        return Ok(());
    }
    sqlx::query("SELECT id FROM attachments WHERE id = ANY($1) AND uploader_id = $2 ORDER BY id FOR UPDATE")
        .bind(ids)
        .bind(user_id)
        .execute(&mut *conn)
        .await?;
    sqlx::query(&format!(
        "UPDATE attachments a SET claimed_at = NULL WHERE a.id = ANY($1) AND a.uploader_id = $2 AND a.message_id IS NULL \
         AND NOT a.sticker_asset AND NOT a.event_cover AND NOT {}",
        crate::media::IN_USE
    ))
    .bind(ids)
    .bind(user_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Which limits an uploaded profile image has.
#[derive(Clone, Copy)]
pub enum ImageKind {
    /// Avatars and server icons.
    Avatar,
    Banner,
}

impl ImageKind {
    /// Largest file in bytes, static or animated: every Vokko user gets the top (Nitro) limit. Nothing is re-encoded.
    pub fn limit(self) -> i64 {
        match self {
            Self::Avatar | Self::Banner => 10 * MIB,
        }
    }
}

/// Asset path (`<id>/<key>/<filename>`) of a PNG/JPEG/GIF/WebP attachment uploaded by `user_id` that is within the size limits of `kind`,
/// used for avatars, banners and guild icons. Marks the row `claimed_at` so the pending-upload cleanup never deletes it while it is in use.
/// Run it in the transaction that writes the reference: a failed write leaves nothing claimed, and the row lock it takes makes an account
/// delete wait until the reference is visible. `cover` claims the upload for a scheduled event: that needs it unclaimed, and from then on
/// avatars and icons refuse it. Anything else refuses event covers.
pub async fn image_path_on(conn: &mut PgConnection, attachment_id: i64, user_id: i64, kind: ImageKind, field: &str, cover: bool) -> ApiResult<String> {
    let row: Option<(String, String, Option<String>, i64)> = sqlx::query_as(
        "SELECT filename, key, content_type, size FROM attachments WHERE id = $1 AND uploader_id = $2 AND key IS NOT NULL AND message_id IS NULL \
         AND NOT sticker_asset AND ($3 OR NOT event_cover) AND NOT EXISTS (SELECT 1 FROM emojis e WHERE e.attachment_id = attachments.id)",
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
    let limit = kind.limit();
    if size > limit {
        return Err(ApiErr::invalid(field, &format!("The image is too large ({} MiB at most).", limit / MIB)));
    }
    // Claiming is one statement, so two requests racing for the same upload cannot both win.
    let claimed = sqlx::query(
        "UPDATE attachments SET claimed_at = COALESCE(claimed_at, now()), event_cover = $3 WHERE id = $1 AND uploader_id = $2 AND key IS NOT NULL \
         AND message_id IS NULL AND NOT sticker_asset AND CASE WHEN $3 THEN claimed_at IS NULL ELSE NOT event_cover END \
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

/// The friends the caller ($1) and `id` ($2) share, by id. Empty for the caller themselves, when either has blocked the other,
/// and when they share no context: no relationship other than a block (a pending request counts, as on Discord), no guild, no
/// DM or group DM that has a message (opening a DM alone stores it closed on the other side, who never saw it). Friends that
/// the caller blocks or that block the caller are left out. Never more of `id`'s friends than the caller's own.
async fn mutual_friend_ids(state: &AppState, viewer: i64, id: i64) -> ApiResult<Vec<i64>> {
    if viewer == id {
        return Ok(Vec::new());
    }
    let rows: Vec<(i64,)> = sqlx::query_as(
        "SELECT a.other_id FROM relationships a JOIN relationships b ON b.other_id = a.other_id AND b.user_id = $2 AND b.kind = 1 \
         WHERE a.user_id = $1 AND a.kind = 1 AND a.other_id NOT IN ($1, $2) \
         AND NOT EXISTS (SELECT 1 FROM relationships x WHERE x.kind = 2 AND ((x.user_id = $1 AND x.other_id = a.other_id) OR (x.user_id = a.other_id AND x.other_id = $1))) \
         AND NOT EXISTS (SELECT 1 FROM relationships x WHERE x.kind = 2 AND ((x.user_id = $1 AND x.other_id = $2) OR (x.user_id = $2 AND x.other_id = $1))) \
         AND (EXISTS (SELECT 1 FROM relationships x WHERE x.user_id = $1 AND x.other_id = $2 AND x.kind <> 2) \
              OR EXISTS (SELECT 1 FROM guild_members g JOIN guild_members h ON h.guild_id = g.guild_id AND h.user_id = $2 WHERE g.user_id = $1) \
              OR EXISTS (SELECT 1 FROM channel_recipients c JOIN channel_recipients d ON d.channel_id = c.channel_id AND d.user_id = $2 \
                        JOIN channels ch ON ch.id = c.channel_id AND ch.last_message_id IS NOT NULL WHERE c.user_id = $1)) \
         ORDER BY a.other_id",
    )
    .bind(viewer)
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    Ok(rows.into_iter().map(|(friend,)| friend).collect())
}

/// `GET /users/{id}/relationships`: the friends the caller and the user share (Discord's mutual friends), by id.
async fn mutual_friends(State(state): State<AppState>, AuthUser(viewer): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Vec<User>>> {
    let id = parse_id(&id).ok_or_else(ApiErr::unknown_user)?;
    store::user(&state, id).await?.ok_or_else(ApiErr::unknown_user)?;
    let ids = mutual_friend_ids(&state, viewer, id).await?;
    let mut users = store::users(&state, &ids).await?;
    Ok(Json(ids.iter().filter_map(|friend| users.remove(friend)).collect()))
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
    let friends = mutual_friend_ids(&state, viewer, id).await?.len();
    // Only for guilds the caller is in themselves.
    let guild_member = match query.guild_id.map(Snowflake::db) {
        Some(guild_id) if guilds.iter().any(|(shared, _)| *shared == guild_id) => store::member(&state, guild_id, id).await?,
        _ => None,
    };
    Ok(Json(UserProfile {
        user,
        mutual_guilds: guilds.into_iter().map(|(guild_id, nick)| MutualGuild { id: Snowflake::from(guild_id), nick }).collect(),
        mutual_friends_count: u32::try_from(friends).unwrap_or(u32::MAX),
        guild_member,
    }))
}
