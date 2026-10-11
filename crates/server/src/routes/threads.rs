//! Thread routes: starting threads, members, active / archived lists and thread edits (see docs/api.md, "Threads, forums and announcements").
use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use serde::Deserialize;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use vokko_protocol::api::permissions::{CREATE_PRIVATE_THREADS, CREATE_PUBLIC_THREADS, MANAGE_THREADS, READ_MESSAGE_HISTORY, SEND_MESSAGES_IN_THREADS};
use vokko_protocol::api::{
    Channel, ChannelType, MessageType, StartThreadFromMessageRequest, StartThreadRequest, ThreadListResponse, ThreadMember, UpdateChannelRequest, channel_flags,
};

use crate::access::{self, ChannelAccess, channel_access};
use crate::auth::AuthUser;
use crate::error::{ApiErr, ApiResult};
use crate::extract::{ApiJson, ApiQuery, parse_id};
use crate::routes::forums;
use crate::routes::messages::{Draft, Extras, Resolved, broadcast_update, insert_message_with};
use crate::state::AppState;
use crate::store::{self, CHANNEL_COLS, ChannelRow};
use crate::threads;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/channels/{id}/messages/{mid}/threads", post(start_from_message))
        .route("/channels/{id}/threads", post(start_thread))
        .route("/channels/{id}/thread-members", get(list_members))
        .route("/channels/{id}/thread-members/{uid}", get(get_member).put(add_member).delete(remove_member))
        .route("/guilds/{id}/threads/active", get(active_threads))
        .route("/channels/{id}/threads/archived/public", get(archived_public))
        .route("/channels/{id}/threads/archived/private", get(archived_private))
        .route("/channels/{id}/users/@me/threads/archived/private", get(archived_private_joined))
}

fn channel_id(raw: &str) -> ApiResult<i64> {
    parse_id(raw).ok_or_else(ApiErr::unknown_channel)
}

fn no_mentions() -> Resolved {
    Resolved { users: Vec::new(), roles: Vec::new(), everyone: false }
}

fn system_draft(kind: MessageType, content: String, reference: i64) -> Draft {
    Draft {
        content,
        kind,
        reference: Some(reference),
        attachments: Vec::new(),
        nonce: None,
        mentions: no_mentions(),
        ping_replied: false,
        stickers: Vec::new(),
        forward: None,
    }
}

/// Inserts the thread row and its creator as the first member in one transaction.
#[allow(clippy::too_many_arguments)]
pub async fn insert_thread(
    state: &AppState,
    id: i64,
    kind: ChannelType,
    parent: &ChannelRow,
    owner_id: i64,
    name: &str,
    auto_archive_duration: i32,
    invitable: bool,
    applied_tags: &[i64],
) -> ApiResult<bool> {
    let mut tx = state.db.begin().await?;
    let inserted = sqlx::query(
        "INSERT INTO channels (id, kind, guild_id, name, position, parent_id, owner_id, auto_archive_duration, invitable, applied_tags, archive_timestamp, last_activity_at) \
         VALUES ($1, $2, $3, $4, 0, $5, $6, $7, $8, $9, now(), now()) ON CONFLICT (id) DO NOTHING",
    )
    .bind(id)
    .bind(kind.as_u8() as i16)
    .bind(parent.guild_id)
    .bind(name)
    .bind(parent.id)
    .bind(owner_id)
    .bind(auto_archive_duration)
    .bind(invitable)
    .bind(applied_tags)
    .execute(&mut *tx)
    .await?;
    if inserted.rows_affected() == 0 {
        return Ok(false);
    }
    sqlx::query("INSERT INTO thread_members (thread_id, user_id) VALUES ($1, $2)").bind(id).bind(owner_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(true)
}

/// The thread as the creator sees it, flagged `newly_created`.
pub async fn created_response(state: &AppState, id: i64, viewer: i64) -> ApiResult<Channel> {
    let mut channel = store::channel(state, id, Some(viewer)).await?.ok_or_else(ApiErr::internal)?;
    channel.newly_created = Some(true);
    Ok(channel)
}

async fn start_from_message(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path((id, mid)): Path<(String, String)>,
    ApiJson(body): ApiJson<StartThreadFromMessageRequest>,
) -> ApiResult<Json<Channel>> {
    let id = channel_id(&id)?;
    let mid = parse_id(&mid).ok_or_else(ApiErr::unknown_message)?;
    let access = channel_access(&state, user_id, id).await?;
    let parent = &access.channel;
    if !matches!(parent.channel_type(), ChannelType::GuildText | ChannelType::GuildAnnouncement) {
        return Err(ApiErr::wrong_channel_type());
    }
    access.require(CREATE_PUBLIC_THREADS)?;
    // The type 21 starter shows the original message, so the creator must be able to read the channel's history.
    access.require(READ_MESSAGE_HISTORY)?;
    let name = threads::thread_name(&body.name)?;
    let duration = threads::auto_archive_for(parent, body.auto_archive_duration)?;
    let message: Option<(i64, i16)> =
        sqlx::query_as("SELECT author_id, kind FROM messages WHERE id = $1 AND channel_id = $2").bind(mid).bind(id).fetch_optional(&state.db).await?;
    let Some((author_id, message_kind)) = message else { return Err(ApiErr::unknown_message()) };
    if !matches!(MessageType::from_u8(message_kind as u8), Some(MessageType::Default | MessageType::Reply)) {
        return Err(ApiErr::invalid("message_id", "Cannot start a thread from a system message."));
    }
    let kind = if parent.channel_type() == ChannelType::GuildAnnouncement { ChannelType::AnnouncementThread } else { ChannelType::PublicThread };
    if !insert_thread(&state, mid, kind, parent, user_id, &name, duration, true, &[]).await? {
        return Err(ApiErr::thread_exists());
    }
    let row = store::channel_row(&state, mid).await?.ok_or_else(ApiErr::internal)?;
    threads::dispatch(&state, &row, "THREAD_CREATE", true).await?;
    // The thread starts with a type 21 message that points back at the original.
    let extras = Extras { reference_channel: Some(parent.id), reference_guild: parent.guild_id, ..Extras::default() };
    insert_message_with(&state, &row, author_id, system_draft(MessageType::ThreadStarterMessage, String::new(), mid), extras).await?;
    broadcast_update(&state, parent, mid).await?;
    Ok(Json(created_response(&state, mid, user_id).await?))
}

async fn start_thread(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<serde_json::Value>,
) -> ApiResult<axum::response::Response> {
    use axum::response::IntoResponse;
    let id = channel_id(&id)?;
    let access = channel_access(&state, user_id, id).await?;
    let parent = &access.channel;
    let invalid_body = |error: serde_json::Error| ApiErr::invalid("body", &error.to_string());
    match parent.channel_type() {
        ChannelType::GuildForum => {
            let request = serde_json::from_value(body).map_err(invalid_body)?;
            Ok(forums::create_post(&state, user_id, &access, request).await?.into_response())
        }
        ChannelType::GuildText | ChannelType::GuildAnnouncement => {
            let request: StartThreadRequest = serde_json::from_value(body).map_err(invalid_body)?;
            Ok(start_free_thread(&state, user_id, &access, request).await?.into_response())
        }
        _ => Err(ApiErr::wrong_channel_type()),
    }
}

/// A thread that is not attached to a message: public (announced in the parent by a type 18 message) or private.
async fn start_free_thread(state: &AppState, user_id: i64, access: &ChannelAccess, body: StartThreadRequest) -> ApiResult<Json<Channel>> {
    let parent = &access.channel;
    let announcement = parent.channel_type() == ChannelType::GuildAnnouncement;
    let kind = match body.kind {
        None | Some(ChannelType::PublicThread) => {
            if announcement {
                ChannelType::AnnouncementThread
            } else {
                ChannelType::PublicThread
            }
        }
        Some(ChannelType::AnnouncementThread) if announcement => ChannelType::AnnouncementThread,
        Some(ChannelType::PrivateThread) if !announcement => ChannelType::PrivateThread,
        Some(_) => return Err(ApiErr::invalid("type", "Unsupported thread type for this channel.")),
    };
    access.require(if kind == ChannelType::PrivateThread { CREATE_PRIVATE_THREADS } else { CREATE_PUBLIC_THREADS })?;
    let name = threads::thread_name(&body.name)?;
    let duration = threads::auto_archive_for(parent, body.auto_archive_duration)?;
    let id = state.ids.next();
    insert_thread(state, id, kind, parent, user_id, &name, duration, body.invitable.unwrap_or(true), &[]).await?;
    let row = store::channel_row(state, id).await?.ok_or_else(ApiErr::internal)?;
    threads::dispatch(state, &row, "THREAD_CREATE", true).await?;
    if kind != ChannelType::PrivateThread {
        // Public threads are announced in the parent; the reference points at the thread itself.
        let extras = Extras { reference_channel: Some(id), reference_guild: parent.guild_id, ..Extras::default() };
        insert_message_with(state, parent, user_id, system_draft(MessageType::ThreadCreated, name, id), extras).await?;
    }
    Ok(Json(created_response(state, id, user_id).await?))
}

/// The thread behind `id`, and what the caller may do in it.
async fn thread_of(state: &AppState, user_id: i64, id: &str) -> ApiResult<ChannelAccess> {
    let access = channel_access(state, user_id, channel_id(id)?).await?;
    if !access.channel.is_thread() {
        return Err(ApiErr::wrong_channel_type());
    }
    Ok(access)
}

fn target_user(raw: &str, user_id: i64) -> ApiResult<i64> {
    if raw == "@me" { Ok(user_id) } else { parse_id(raw).ok_or_else(ApiErr::unknown_user) }
}

async fn list_members(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Vec<ThreadMember>>> {
    let access = thread_of(&state, user_id, &id).await?;
    Ok(Json(threads::members_of(&state, access.channel.id).await?))
}

async fn get_member(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path((id, uid)): Path<(String, String)>) -> ApiResult<Json<ThreadMember>> {
    let access = thread_of(&state, user_id, &id).await?;
    let target = target_user(&uid, user_id)?;
    threads::member(&state, access.channel.id, target).await?.map(Json).ok_or_else(ApiErr::unknown_thread_member)
}

async fn add_member(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path((id, uid)): Path<(String, String)>) -> ApiResult<StatusCode> {
    let access = thread_of(&state, user_id, &id).await?;
    let thread = &access.channel;
    let target = target_user(&uid, user_id)?;
    if target == user_id {
        if !threads::is_member(&state, thread.id, user_id).await? {
            access.require_unarchived()?;
            threads::add_member(&state, thread, user_id).await?;
        }
        return Ok(StatusCode::NO_CONTENT);
    }
    access.require(SEND_MESSAGES_IN_THREADS)?;
    let invited_by_member = thread.channel_type() == ChannelType::PrivateThread && thread.invitable && threads::is_member(&state, thread.id, user_id).await?;
    if thread.owner_id != Some(user_id) && access.permissions & MANAGE_THREADS == 0 && !invited_by_member {
        return Err(ApiErr::missing_permissions());
    }
    access.require_unarchived()?;
    let parent = access.parent.clone().ok_or_else(ApiErr::internal)?;
    match access::guild_channel_access(&state, target, parent).await {
        Ok(_) => {}
        Err(error) if error.status == StatusCode::FORBIDDEN => return Err(ApiErr::invalid("user_id", "That user cannot see this channel.")),
        Err(error) => return Err(error),
    }
    threads::add_member(&state, thread, target).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn remove_member(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path((id, uid)): Path<(String, String)>) -> ApiResult<StatusCode> {
    let access = thread_of(&state, user_id, &id).await?;
    let thread = &access.channel;
    let target = target_user(&uid, user_id)?;
    if target != user_id && thread.owner_id != Some(user_id) && access.permissions & MANAGE_THREADS == 0 {
        return Err(ApiErr::missing_permissions());
    }
    threads::remove_member(&state, thread, target).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn active_threads(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<Json<ThreadListResponse>> {
    let guild_id = parse_id(&id).ok_or_else(ApiErr::unknown_guild)?;
    let rows = threads::active_threads(&state, user_id, guild_id).await?;
    Ok(Json(threads::thread_list(&state, user_id, rows, false).await?))
}

#[derive(Deserialize)]
struct ArchivedQuery {
    before: Option<String>,
    limit: Option<i64>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Archived {
    Public,
    Private,
    Joined,
}

async fn archived_list(state: &AppState, user_id: i64, id: &str, query: ArchivedQuery, which: Archived) -> ApiResult<Json<ThreadListResponse>> {
    let access = channel_access(state, user_id, channel_id(id)?).await?;
    if !matches!(access.channel.channel_type(), ChannelType::GuildText | ChannelType::GuildAnnouncement | ChannelType::GuildForum) {
        return Err(ApiErr::wrong_channel_type());
    }
    access.require(READ_MESSAGE_HISTORY)?;
    if which == Archived::Private {
        access.require(MANAGE_THREADS)?;
    }
    let limit = query.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(ApiErr::invalid("limit", "Must be between 1 and 100."));
    }
    let before = match query.before.as_deref() {
        Some(raw) => Some(OffsetDateTime::parse(raw, &Rfc3339).map_err(|_| ApiErr::invalid("before", "Must be an ISO 8601 timestamp."))?),
        None => None,
    };
    let kinds: Vec<i16> = if which == Archived::Public { vec![10, 11] } else { vec![12] };
    let mut rows: Vec<ChannelRow> = sqlx::query_as(&format!(
        "SELECT {CHANNEL_COLS} FROM channels WHERE parent_id = $1 AND kind = ANY($2) AND archived AND ($3::timestamptz IS NULL OR archive_timestamp < $3) \
         AND ($4 = FALSE OR id IN (SELECT thread_id FROM thread_members WHERE user_id = $5)) ORDER BY archive_timestamp DESC, id DESC LIMIT $6"
    ))
    .bind(access.channel.id)
    .bind(&kinds)
    .bind(before)
    .bind(which == Archived::Joined)
    .bind(user_id)
    .bind(limit + 1)
    .fetch_all(&state.db)
    .await?;
    let has_more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    Ok(Json(threads::thread_list(state, user_id, rows, has_more).await?))
}

async fn archived_public(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    ApiQuery(query): ApiQuery<ArchivedQuery>,
) -> ApiResult<Json<ThreadListResponse>> {
    archived_list(&state, user_id, &id, query, Archived::Public).await
}

async fn archived_private(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    ApiQuery(query): ApiQuery<ArchivedQuery>,
) -> ApiResult<Json<ThreadListResponse>> {
    archived_list(&state, user_id, &id, query, Archived::Private).await
}

async fn archived_private_joined(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    ApiQuery(query): ApiQuery<ArchivedQuery>,
) -> ApiResult<Json<ThreadListResponse>> {
    archived_list(&state, user_id, &id, query, Archived::Joined).await
}

/// `PATCH /channels/{thread}`: the owner or MANAGE_THREADS edit name, archive state, auto-archive duration, invitable and tags;
/// `locked` and `flags` need MANAGE_THREADS. A locked thread only accepts MANAGE_THREADS.
pub async fn edit_thread(state: &AppState, user_id: i64, access: ChannelAccess, body: UpdateChannelRequest) -> ApiResult<Json<Channel>> {
    let thread = &access.channel;
    let manage = access.permissions & MANAGE_THREADS != 0;
    if thread.locked && !manage {
        return Err(ApiErr::thread_locked());
    }
    if !manage && thread.owner_id != Some(user_id) {
        return Err(ApiErr::missing_permissions());
    }
    if (body.locked.is_some() || body.flags.is_some()) && !manage {
        return Err(ApiErr::missing_permissions());
    }
    // An archived thread can only be unarchived (or, by a moderator, edited).
    if thread.archived && !manage && body.archived != Some(false) {
        return Err(ApiErr::thread_archived());
    }
    let name = match &body.name {
        Some(name) => Some(threads::thread_name(name)?),
        None => None,
    };
    let duration = match body.auto_archive_duration {
        Some(minutes) => Some(threads::validate_auto_archive(minutes)?),
        None => None,
    };
    let parent = access.parent.clone().ok_or_else(ApiErr::internal)?;
    let in_forum = parent.channel_type() == ChannelType::GuildForum;
    let tags = match &body.applied_tags {
        Some(tags) if in_forum => Some(forums::validate_applied_tags(state, &parent, tags, manage, &thread.applied_tags).await?),
        Some(_) => return Err(ApiErr::wrong_channel_type()),
        None => None,
    };
    let flags = match body.flags {
        Some(_) if !in_forum => return Err(ApiErr::wrong_channel_type()),
        Some(flags) => Some((thread.flags & !(channel_flags::PINNED as i32)) | (flags & channel_flags::PINNED) as i32),
        None => None,
    };
    let mut tx = state.db.begin().await?;
    if let Some(name) = &name {
        sqlx::query("UPDATE channels SET name = $2 WHERE id = $1").bind(thread.id).bind(name).execute(&mut *tx).await?;
    }
    if let Some(duration) = duration {
        sqlx::query("UPDATE channels SET auto_archive_duration = $2 WHERE id = $1").bind(thread.id).bind(duration).execute(&mut *tx).await?;
    }
    if let Some(invitable) = body.invitable {
        sqlx::query("UPDATE channels SET invitable = $2 WHERE id = $1").bind(thread.id).bind(invitable).execute(&mut *tx).await?;
    }
    if let Some(locked) = body.locked {
        sqlx::query("UPDATE channels SET locked = $2 WHERE id = $1").bind(thread.id).bind(locked).execute(&mut *tx).await?;
    }
    if let Some(tags) = &tags {
        sqlx::query("UPDATE channels SET applied_tags = $2 WHERE id = $1").bind(thread.id).bind(tags).execute(&mut *tx).await?;
    }
    if let Some(flags) = flags {
        sqlx::query("UPDATE channels SET flags = $2 WHERE id = $1").bind(thread.id).bind(flags).execute(&mut *tx).await?;
    }
    match body.archived {
        // Unarchiving restarts the inactivity clock.
        Some(false) if thread.archived => {
            sqlx::query("UPDATE channels SET archived = FALSE, archive_timestamp = now(), last_activity_at = now() WHERE id = $1")
                .bind(thread.id)
                .execute(&mut *tx)
                .await?;
        }
        Some(true) if !thread.archived => {
            sqlx::query("UPDATE channels SET archived = TRUE, archive_timestamp = now() WHERE id = $1").bind(thread.id).execute(&mut *tx).await?;
        }
        _ => {}
    }
    tx.commit().await?;
    let row = store::channel_row(state, thread.id).await?.ok_or_else(ApiErr::unknown_channel)?;
    threads::dispatch(state, &row, "THREAD_UPDATE", false).await?;
    store::channel(state, thread.id, Some(user_id)).await?.map(Json).ok_or_else(ApiErr::unknown_channel)
}

/// `DELETE /channels/{thread}`: MANAGE_THREADS or the owner.
pub async fn delete_thread(state: &AppState, user_id: i64, access: ChannelAccess) -> ApiResult<Json<Channel>> {
    let thread = &access.channel;
    if thread.owner_id != Some(user_id) && access.permissions & MANAGE_THREADS == 0 {
        return Err(ApiErr::missing_permissions());
    }
    let channel = store::channel(state, thread.id, Some(user_id)).await?.ok_or_else(ApiErr::unknown_channel)?;
    threads::delete_threads(state, vec![thread.clone()], true).await?;
    Ok(Json(channel))
}
