//! Bookmarks (saved messages) and reminders.
use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, put};
use serde::Deserialize;
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};
use vokko_protocol::api::permissions::READ_MESSAGE_HISTORY;
use vokko_protocol::api::{Bookmark, BookmarkRemove, BookmarksPage, CreateReminderRequest, GatewayEvent, IdOnly, Reminder, Snowflake};

use crate::access::channel_access;
use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::extract::{ApiJson, ApiQuery, parse_id};
use crate::reminders::{self, REMINDER_COLS, ReminderRow};
use crate::state::AppState;
use crate::store;

const MAX_BOOKMARKS: i64 = 250;
const MAX_PENDING_REMINDERS: i64 = 50;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/users/@me/bookmarks", get(list_bookmarks))
        .route("/channels/{id}/messages/{mid}/bookmark", put(add_bookmark).delete(remove_bookmark))
        .route("/users/@me/reminders", get(list_reminders).post(create_reminder))
        .route("/users/@me/reminders/{id}", delete(delete_reminder))
}

#[derive(Deserialize)]
struct BookmarkQuery {
    limit: Option<i64>,
    before: Option<String>,
    /// With `before`: the message id of the last item, so bookmarks saved in the same instant are neither repeated nor skipped.
    before_id: Option<Snowflake>,
}

async fn list_bookmarks(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    ApiQuery(query): ApiQuery<BookmarkQuery>,
) -> ApiResult<Json<BookmarksPage>> {
    let limit = query.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(ApiErr::invalid("limit", "Must be between 1 and 100."));
    }
    let before = match query.before.as_deref() {
        Some(raw) => Some(OffsetDateTime::parse(raw, &Rfc3339).map_err(|_| ApiErr::invalid("before", "Must be an ISO 8601 timestamp."))?),
        None => None,
    };
    // Unreadable bookmarks are skipped before the limit applies: keep paging the stored rows until the page is full.
    let mut items: Vec<Bookmark> = Vec::new();
    let mut cursor: Option<(OffsetDateTime, i64)> = before.map(|saved| (saved, query.before_id.map_or(i64::MIN, Snowflake::db)));
    let mut has_more = false;
    loop {
        let needed = limit - items.len() as i64;
        let mut rows: Vec<(i64, OffsetDateTime)> = sqlx::query_as(
            "SELECT message_id, created_at FROM bookmarks WHERE user_id = $1 AND ($2::timestamptz IS NULL OR (created_at, message_id) < ($2, $3)) \
             ORDER BY created_at DESC, message_id DESC LIMIT $4",
        )
        .bind(user_id)
        .bind(cursor.map(|(saved, _)| saved))
        .bind(cursor.map_or(0, |(_, id)| id))
        .bind(needed + 1)
        .fetch_all(&state.db)
        .await?;
        let more_rows = rows.len() as i64 > needed;
        rows.truncate(needed as usize);
        let Some(&(last_id, last_saved)) = rows.last() else { break };
        let ids: Vec<i64> = rows.iter().map(|(id, _)| *id).collect();
        let mut messages = reminders::readable_messages(&state, user_id, &ids).await?;
        items.extend(rows.into_iter().filter_map(|(id, saved_at)| messages.remove(&id).map(|message| Bookmark { message, saved_at: store::iso(saved_at) })));
        cursor = Some((last_saved, last_id));
        if items.len() as i64 >= limit {
            has_more = more_rows;
            break;
        }
        if !more_rows {
            break;
        }
    }
    Ok(Json(BookmarksPage { items, has_more }))
}

/// Channel access with READ_MESSAGE_HISTORY and a message that exists in it; everything else is the same unknown-message answer.
async fn readable_message(state: &AppState, user_id: i64, channel: &str, message: &str) -> ApiResult<(i64, i64)> {
    let channel = parse_id(channel).ok_or_else(ApiErr::unknown_channel)?;
    let message = parse_id(message).ok_or_else(ApiErr::unknown_message)?;
    let access = channel_access(state, user_id, channel).await?;
    if access.permissions & READ_MESSAGE_HISTORY == 0 {
        return Err(ApiErr::missing_permissions());
    }
    let exists: Option<(i64,)> =
        sqlx::query_as("SELECT id FROM messages WHERE id = $1 AND channel_id = $2").bind(message).bind(channel).fetch_optional(&state.db).await?;
    exists.ok_or_else(ApiErr::unknown_message)?;
    Ok((channel, message))
}

async fn add_bookmark(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path((channel, message)): Path<(String, String)>) -> ApiResult<StatusCode> {
    let (channel, message) = readable_message(&state, user_id, &channel, &message).await?;
    let existing: Option<(i64,)> =
        sqlx::query_as("SELECT message_id FROM bookmarks WHERE user_id = $1 AND message_id = $2").bind(user_id).bind(message).fetch_optional(&state.db).await?;
    if existing.is_some() {
        return Ok(StatusCode::NO_CONTENT);
    }
    let (count,): (i64,) = sqlx::query_as("SELECT count(*) FROM bookmarks WHERE user_id = $1").bind(user_id).fetch_one(&state.db).await?;
    if count >= MAX_BOOKMARKS {
        return Err(ApiErr::conflict(30090, "Maximum number of bookmarks reached (250)"));
    }
    // A concurrent PUT of the same bookmark makes ON CONFLICT DO NOTHING return no row: the bookmark exists, nothing more to do.
    let saved: Option<(OffsetDateTime,)> =
        sqlx::query_as("INSERT INTO bookmarks (user_id, message_id, channel_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING created_at")
            .bind(user_id)
            .bind(message)
            .bind(channel)
            .fetch_optional(&state.db)
            .await?;
    let Some((saved_at,)) = saved else { return Ok(StatusCode::NO_CONTENT) };
    if let Some(message) = store::message_view(&state, message, Some(user_id)).await? {
        state.hub.send(&[user_id], &GatewayEvent::BookmarkAdd(Box::new(Bookmark { message: message.message, saved_at: store::iso(saved_at) })));
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn remove_bookmark(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path((_channel, message)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let message = parse_id(&message).ok_or_else(ApiErr::unknown_message)?;
    let removed: Option<(i64,)> = sqlx::query_as("DELETE FROM bookmarks WHERE user_id = $1 AND message_id = $2 RETURNING channel_id")
        .bind(user_id)
        .bind(message)
        .fetch_optional(&state.db)
        .await?;
    if let Some((channel,)) = removed {
        state
            .hub
            .send(&[user_id], &GatewayEvent::BookmarkRemove(BookmarkRemove { channel_id: Snowflake::from(channel), message_id: Snowflake::from(message) }));
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn list_reminders(State(state): State<AppState>, AuthUser(user_id): AuthUser) -> ApiResult<Json<Vec<Reminder>>> {
    let rows: Vec<ReminderRow> = sqlx::query_as(&format!("SELECT {REMINDER_COLS} FROM reminders r WHERE r.user_id = $1 ORDER BY r.remind_at, r.id"))
        .bind(user_id)
        .fetch_all(&state.db)
        .await?;
    Ok(Json(reminders::hydrate(&state, user_id, rows).await?))
}

async fn create_reminder(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    ApiJson(body): ApiJson<CreateReminderRequest>,
) -> ApiResult<Json<Reminder>> {
    let remind_at = OffsetDateTime::parse(&body.remind_at, &Rfc3339).map_err(|_| ApiErr::invalid("remind_at", "Must be an ISO 8601 timestamp."))?;
    let now = OffsetDateTime::now_utc();
    if remind_at <= now || remind_at > now + Duration::days(365) {
        return Err(ApiErr::invalid("remind_at", "Must be in the future and at most one year ahead."));
    }
    let (channel, message) = readable_message(&state, user_id, &body.channel_id.to_string(), &body.message_id.to_string()).await?;
    let (pending,): (i64,) = sqlx::query_as("SELECT count(*) FROM reminders WHERE user_id = $1 AND delivered_at IS NULL AND message_id <> $2")
        .bind(user_id)
        .bind(message)
        .fetch_one(&state.db)
        .await?;
    if pending >= MAX_PENDING_REMINDERS {
        return Err(ApiErr::conflict(30091, "Maximum number of pending reminders reached (50)"));
    }
    let row: ReminderRow = sqlx::query_as(&format!(
        "WITH upserted AS ( \
             INSERT INTO reminders (id, user_id, message_id, channel_id, remind_at) VALUES ($1, $2, $3, $4, $5) \
             ON CONFLICT (user_id, message_id) DO UPDATE SET remind_at = EXCLUDED.remind_at, delivered_at = NULL, created_at = now() \
             RETURNING * \
         ) SELECT {REMINDER_COLS} FROM upserted r"
    ))
    .bind(state.ids.next())
    .bind(user_id)
    .bind(message)
    .bind(channel)
    .bind(remind_at)
    .fetch_one(&state.db)
    .await?;
    let reminder = reminders::hydrate(&state, user_id, vec![row]).await?.pop().ok_or_else(ApiErr::internal)?;
    state.hub.send(&[user_id], &GatewayEvent::ReminderCreate(Box::new(reminder.clone())));
    Ok(Json(reminder))
}

async fn delete_reminder(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<StatusCode> {
    let Some(id) = parse_id(&id) else { return Ok(StatusCode::NO_CONTENT) };
    let removed = sqlx::query("DELETE FROM reminders WHERE id = $1 AND user_id = $2").bind(id).bind(user_id).execute(&state.db).await?;
    if removed.rows_affected() > 0 {
        state.hub.send(&[user_id], &GatewayEvent::ReminderDelete(IdOnly { id: Snowflake::from(id) }));
    }
    Ok(StatusCode::NO_CONTENT)
}
