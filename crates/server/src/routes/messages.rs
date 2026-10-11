use std::collections::HashSet;

use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post, put};
use serde::Deserialize;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use vokko_protocol::api::permissions::{ATTACH_FILES, MANAGE_MESSAGES, MENTION_EVERYONE, READ_MESSAGE_HISTORY, SEND_MESSAGES};
use vokko_protocol::api::{
    AckBulkRequest, AllowedMentions, CreateMessageRequest, EditMessageRequest, Embed, GatewayEvent, Message, MessageAck, MessageDelete, MessageType,
    PinnedMessage, PinnedMessagesPage, SUPPRESS_EMBEDS, Snowflake, TypingStart,
};

use crate::access::{self, ChannelAccess, channel_access};
use crate::auth::AuthUser;
use crate::config::MAX_ATTACHMENTS_PER_MESSAGE;
use crate::error::{ApiErr, ApiResult};
use crate::extract::{ApiJson, ApiQuery, parse_id};
use crate::ids::now_ms;
use crate::media;
use crate::state::AppState;
use crate::store::{self, ChannelRow, MESSAGE_SELECT, MessageRow, MessageView};
use crate::unfurl;

pub const MAX_CONTENT_CHARS: usize = 2000;
const MAX_PINS: i64 = 250;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/channels/{id}/messages", get(list_messages).post(create_message))
        .route("/channels/{id}/messages/{mid}", axum::routing::patch(edit_message).delete(delete_message))
        .route("/channels/{id}/messages/{mid}/ack", post(ack_message))
        .route("/channels/{id}/messages/pins", get(list_pins))
        .route("/channels/{id}/messages/pins/{mid}", put(pin_message).delete(unpin_message))
        .route("/read-states/ack-bulk", post(ack_bulk))
        .route("/channels/{id}/typing", post(typing))
}

fn channel_id(raw: &str) -> ApiResult<i64> {
    parse_id(raw).ok_or_else(ApiErr::unknown_channel)
}

fn message_id(raw: &str) -> ApiResult<i64> {
    parse_id(raw).ok_or_else(ApiErr::unknown_message)
}

/// `<@id>` / `<@!id>` user mentions, `<@&id>` role mentions and `@everyone` / `@here`.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ParsedMentions {
    pub users: Vec<i64>,
    pub roles: Vec<i64>,
    pub everyone: bool,
}

pub fn parse_mentions(content: &str) -> ParsedMentions {
    let mut parsed = ParsedMentions { everyone: content.contains("@everyone") || content.contains("@here"), ..ParsedMentions::default() };
    let mut rest = content;
    while let Some(start) = rest.find("<@") {
        rest = &rest[start + 2..];
        let (is_role, digits_start) = match rest.as_bytes().first() {
            Some(b'&') => (true, 1),
            Some(b'!') => (false, 1),
            _ => (false, 0),
        };
        let tail = &rest[digits_start..];
        let digits: String = tail.chars().take_while(char::is_ascii_digit).collect();
        if digits.is_empty() || !tail[digits.len()..].starts_with('>') {
            continue;
        }
        let Ok(id) = digits.parse::<u64>() else { continue };
        if id == 0 || id > i64::MAX as u64 {
            continue;
        }
        let list = if is_role { &mut parsed.roles } else { &mut parsed.users };
        if !list.contains(&(id as i64)) {
            list.push(id as i64);
        }
    }
    parsed
}

fn validate_content(content: &str, has_attachments: bool) -> ApiResult<String> {
    let content = content.trim().to_owned();
    if content.chars().count() > MAX_CONTENT_CHARS {
        return Err(ApiErr::invalid("content", "Must be 2000 or fewer in length."));
    }
    if content.is_empty() && !has_attachments {
        return Err(ApiErr::invalid("content", "Cannot send an empty message."));
    }
    Ok(content)
}

pub struct Resolved {
    pub users: Vec<i64>,
    pub roles: Vec<i64>,
    pub everyone: bool,
}

/// Drops mentions of people/roles that do not exist in the channel's scope, and `@everyone` without permission.
async fn resolve_mentions(state: &AppState, access: &ChannelAccess, parsed: ParsedMentions) -> ApiResult<Resolved> {
    let everyone = parsed.everyone && access.permissions & MENTION_EVERYONE != 0;
    let channel = &access.channel;
    let users: Vec<i64> = if parsed.users.is_empty() {
        Vec::new()
    } else if channel.is_dm() {
        let rows: Vec<(i64,)> = sqlx::query_as("SELECT user_id FROM channel_recipients WHERE channel_id = $1 AND user_id = ANY($2)")
            .bind(channel.id)
            .bind(&parsed.users)
            .fetch_all(&state.db)
            .await?;
        rows.into_iter().map(|(id,)| id).collect()
    } else {
        let rows: Vec<(i64,)> = sqlx::query_as("SELECT user_id FROM guild_members WHERE guild_id = $1 AND user_id = ANY($2)")
            .bind(channel.guild_id)
            .bind(&parsed.users)
            .fetch_all(&state.db)
            .await?;
        rows.into_iter().map(|(id,)| id).collect()
    };
    let roles: Vec<i64> = match (channel.guild_id, parsed.roles.is_empty()) {
        (Some(guild_id), false) => {
            let rows: Vec<(i64,)> = sqlx::query_as("SELECT id FROM roles WHERE guild_id = $1 AND id = ANY($2) AND id <> $1 AND (mentionable OR $3)")
                .bind(guild_id)
                .bind(&parsed.roles)
                .bind(access.permissions & MENTION_EVERYONE != 0)
                .fetch_all(&state.db)
                .await?;
            rows.into_iter().map(|(id,)| id).collect()
        }
        _ => Vec::new(),
    };
    Ok(Resolved { users, roles, everyone })
}

pub struct Draft {
    pub content: String,
    pub kind: MessageType,
    pub reference: Option<i64>,
    pub attachments: Vec<i64>,
    pub nonce: Option<String>,
    pub mentions: Resolved,
    /// Whether the replied-to author counts as mentioned (`allowed_mentions.replied_user`, default true).
    pub ping_replied: bool,
}

/// Applies `allowed_mentions` to what the content parsed to. Omitted = everything pings.
fn apply_allowed(resolved: Resolved, allowed: Option<&AllowedMentions>) -> Resolved {
    let Some(allowed) = allowed else { return resolved };
    let parse = |kind: &str| match &allowed.parse {
        Some(list) => list.iter().any(|entry| entry == kind),
        // `{}` and `{replied_user}` keep the defaults; explicit user/role lists narrow their kind.
        None => match kind {
            "users" => allowed.users.is_none(),
            "roles" => allowed.roles.is_none(),
            _ => true,
        },
    };
    let listed = |list: &Option<Vec<Snowflake>>| -> Vec<i64> { list.iter().flatten().map(|id| id.db()).collect() };
    let (allowed_users, allowed_roles) = (listed(&allowed.users), listed(&allowed.roles));
    Resolved {
        users: resolved.users.into_iter().filter(|id| parse("users") || allowed_users.contains(id)).collect(),
        roles: resolved.roles.into_iter().filter(|id| parse("roles") || allowed_roles.contains(id)).collect(),
        everyone: resolved.everyone && parse("everyone"),
    }
}

/// Stores a message, updates read states / unread counters, reopens closed DMs and fans MESSAGE_CREATE out.
pub async fn insert_message(state: &AppState, channel: &ChannelRow, author_id: i64, draft: Draft) -> ApiResult<MessageView> {
    let message_id = state.ids.next();
    let viewers = access::channel_viewers(state, channel).await?;

    // Reply targets count as mentions of their author.
    let mut mentioned: Vec<i64> = draft.mentions.users.clone();
    if let Some(reference) = draft.reference {
        let author: Option<(i64,)> = sqlx::query_as("SELECT author_id FROM messages WHERE id = $1").bind(reference).fetch_optional(&state.db).await?;
        if let Some((replied,)) = author
            && draft.ping_replied
            && replied != author_id
            && !mentioned.contains(&replied)
            && viewers.contains(&replied)
        {
            mentioned.push(replied);
        }
    }
    // Everyone whose unread-mention counter goes up.
    let mut notify: HashSet<i64> = mentioned.iter().copied().collect();
    if !draft.mentions.roles.is_empty()
        && let Some(guild_id) = channel.guild_id
    {
        let rows: Vec<(i64,)> = sqlx::query_as("SELECT DISTINCT user_id FROM member_roles WHERE guild_id = $1 AND role_id = ANY($2)")
            .bind(guild_id)
            .bind(&draft.mentions.roles)
            .fetch_all(&state.db)
            .await?;
        notify.extend(rows.into_iter().map(|(id,)| id));
    }
    if draft.mentions.everyone || (channel.is_dm() && draft.kind != MessageType::ChannelPinnedMessage) {
        notify.extend(viewers.iter().copied());
    }
    notify.remove(&author_id);
    if draft.kind != MessageType::Default && draft.kind != MessageType::Reply {
        notify.clear();
    }
    notify.retain(|user| viewers.contains(user));

    let mut tx = state.db.begin().await?;
    sqlx::query("INSERT INTO messages (id, channel_id, author_id, content, kind, reference_message_id, mention_everyone) VALUES ($1, $2, $3, $4, $5, $6, $7)")
        .bind(message_id)
        .bind(channel.id)
        .bind(author_id)
        .bind(&draft.content)
        .bind(draft.kind.as_u8() as i16)
        .bind(draft.reference)
        .bind(draft.mentions.everyone)
        .execute(&mut *tx)
        .await?;
    for user in &mentioned {
        sqlx::query("INSERT INTO message_mentions (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING")
            .bind(message_id)
            .bind(user)
            .execute(&mut *tx)
            .await?;
    }
    for role in &draft.mentions.roles {
        sqlx::query("INSERT INTO message_role_mentions (message_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING")
            .bind(message_id)
            .bind(role)
            .execute(&mut *tx)
            .await?;
    }
    if !draft.attachments.is_empty() {
        let claimed = sqlx::query("UPDATE attachments SET message_id = $1 WHERE id = ANY($2) AND channel_id = $3 AND uploader_id = $4 AND message_id IS NULL")
            .bind(message_id)
            .bind(&draft.attachments)
            .bind(channel.id)
            .bind(author_id)
            .execute(&mut *tx)
            .await?;
        if claimed.rows_affected() != draft.attachments.len() as u64 {
            return Err(ApiErr::invalid("attachment_ids", "Unknown or already used attachment."));
        }
    }
    sqlx::query("UPDATE channels SET last_message_id = $2 WHERE id = $1").bind(channel.id).bind(message_id).execute(&mut *tx).await?;
    sqlx::query(
        "INSERT INTO read_states (user_id, channel_id, last_message_id, mention_count) VALUES ($1, $2, $3, 0) \
         ON CONFLICT (user_id, channel_id) DO UPDATE SET last_message_id = EXCLUDED.last_message_id, mention_count = 0",
    )
    .bind(author_id)
    .bind(channel.id)
    .bind(message_id)
    .execute(&mut *tx)
    .await?;
    for user in &notify {
        sqlx::query(
            "INSERT INTO read_states (user_id, channel_id, mention_count) VALUES ($1, $2, 1) \
             ON CONFLICT (user_id, channel_id) DO UPDATE SET mention_count = read_states.mention_count + 1",
        )
        .bind(user)
        .bind(channel.id)
        .execute(&mut *tx)
        .await?;
    }
    let reopened: Vec<(i64,)> = if channel.is_dm() {
        sqlx::query_as("UPDATE channel_recipients SET closed = FALSE WHERE channel_id = $1 AND closed RETURNING user_id")
            .bind(channel.id)
            .fetch_all(&mut *tx)
            .await?
    } else {
        Vec::new()
    };
    tx.commit().await?;

    for (user,) in reopened {
        if let Some(dm) = store::channel(state, channel.id, Some(user)).await? {
            state.hub.send(&[user], &GatewayEvent::ChannelCreate(dm));
        }
    }
    let mut view = store::message_view(state, message_id, None).await?.ok_or_else(ApiErr::internal)?;
    view.message.nonce = draft.nonce;
    state.hub.send_with(&viewers, "MESSAGE_CREATE", |user| serde_json::to_value(view.for_viewer(user)).unwrap_or_default());
    if matches!(draft.kind, MessageType::Default | MessageType::Reply) {
        unfurl::spawn(state, channel.clone(), message_id, draft.content, Vec::new());
    }
    Ok(view)
}

#[derive(Deserialize)]
struct ListQuery {
    before: Option<Snowflake>,
    after: Option<Snowflake>,
    around: Option<Snowflake>,
    limit: Option<i64>,
}

async fn list_messages(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    ApiQuery(query): ApiQuery<ListQuery>,
) -> ApiResult<Json<Vec<Message>>> {
    let id = channel_id(&id)?;
    let access = channel_access(&state, user_id, id).await?;
    if access.permissions & READ_MESSAGE_HISTORY == 0 {
        return Ok(Json(Vec::new()));
    }
    let limit = query.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(ApiErr::invalid("limit", "Must be between 1 and 100."));
    }
    let select = |filter: &str, order: &str| format!("{MESSAGE_SELECT} WHERE m.channel_id = $1 {filter} ORDER BY m.id {order} LIMIT $3");
    let mut rows: Vec<MessageRow> = if let Some(around) = query.around {
        let older: Vec<MessageRow> = sqlx::query_as(&select("AND m.id < $2", "DESC")).bind(id).bind(around.db()).bind(limit / 2).fetch_all(&state.db).await?;
        let newer: Vec<MessageRow> =
            sqlx::query_as(&select("AND m.id >= $2", "ASC")).bind(id).bind(around.db()).bind(limit - limit / 2).fetch_all(&state.db).await?;
        let mut all = older;
        all.extend(newer);
        all
    } else if let Some(after) = query.after {
        // Take the oldest page after the cursor, then present it newest first like every other listing.
        sqlx::query_as(&select("AND m.id > $2", "ASC")).bind(id).bind(after.db()).bind(limit).fetch_all(&state.db).await?
    } else {
        sqlx::query_as(&select("AND m.id < $2", "DESC"))
            .bind(id)
            .bind(query.before.map(Snowflake::db).unwrap_or(i64::MAX))
            .bind(limit)
            .fetch_all(&state.db)
            .await?
    };
    rows.sort_by_key(|row| std::cmp::Reverse(row.id));
    let views = store::load_messages(&state, rows, Some(user_id)).await?;
    Ok(Json(views.into_iter().map(|view| view.message).collect()))
}

async fn create_message(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<CreateMessageRequest>,
) -> ApiResult<Json<Message>> {
    let id = channel_id(&id)?;
    let access = channel_access(&state, user_id, id).await?;
    if access.channel.channel_type() == vokko_protocol::api::ChannelType::GuildCategory {
        return Err(ApiErr::invalid("channel_id", "Cannot send messages in a category."));
    }
    access.require(SEND_MESSAGES)?;
    if access.channel.channel_type() == vokko_protocol::api::ChannelType::Dm {
        // A block in either direction closes the 1:1 DM for new messages.
        let (blocked,): (bool,) = sqlx::query_as(
            "SELECT EXISTS (SELECT 1 FROM channel_recipients r JOIN relationships rel ON rel.kind = 2 \
             AND ((rel.user_id = $2 AND rel.other_id = r.user_id) OR (rel.other_id = $2 AND rel.user_id = r.user_id)) \
             WHERE r.channel_id = $1 AND r.user_id <> $2)",
        )
        .bind(id)
        .bind(user_id)
        .fetch_one(&state.db)
        .await?;
        if blocked {
            return Err(ApiErr::cannot_message_user());
        }
    }
    let attachments: Vec<i64> = body.attachment_ids.unwrap_or_default().into_iter().map(Snowflake::db).collect();
    if !attachments.is_empty() {
        access.require(ATTACH_FILES)?;
        if attachments.len() > MAX_ATTACHMENTS_PER_MESSAGE {
            return Err(ApiErr::invalid("attachment_ids", "A message can have at most 10 attachments."));
        }
    }
    let content = validate_content(body.content.as_deref().unwrap_or(""), !attachments.is_empty())?;
    let reference = match body.message_reference {
        Some(reference) => {
            let exists: Option<(i64,)> = sqlx::query_as("SELECT id FROM messages WHERE id = $1 AND channel_id = $2")
                .bind(reference.message_id.db())
                .bind(id)
                .fetch_optional(&state.db)
                .await?;
            if exists.is_none() {
                return Err(ApiErr::invalid("message_reference", "Unknown message."));
            }
            Some(reference.message_id.db())
        }
        None => None,
    };
    let mentions = apply_allowed(resolve_mentions(&state, &access, parse_mentions(&content)).await?, body.allowed_mentions.as_ref());
    let ping_replied = body.allowed_mentions.as_ref().and_then(|allowed| allowed.replied_user).unwrap_or(true);
    let kind = if reference.is_some() { MessageType::Reply } else { MessageType::Default };
    let draft = Draft { content, kind, reference, attachments, nonce: body.nonce, mentions, ping_replied };
    let view = insert_message(&state, &access.channel, user_id, draft).await?;
    Ok(Json(view.for_viewer(user_id)))
}

async fn message_in_channel(state: &AppState, channel: i64, message: i64) -> ApiResult<MessageRow> {
    let row: Option<MessageRow> =
        sqlx::query_as(&format!("{MESSAGE_SELECT} WHERE m.id = $1 AND m.channel_id = $2")).bind(message).bind(channel).fetch_optional(&state.db).await?;
    row.ok_or_else(ApiErr::unknown_message)
}

/// MESSAGE_UPDATE to everyone who can see the channel, with `Reaction.me` per receiver.
pub async fn broadcast_update(state: &AppState, channel: &ChannelRow, message: i64) -> ApiResult<Option<MessageView>> {
    let Some(view) = store::message_view(state, message, None).await? else { return Ok(None) };
    let viewers = access::channel_viewers(state, channel).await?;
    state.hub.send_with(&viewers, "MESSAGE_UPDATE", |user| serde_json::to_value(view.for_viewer(user)).unwrap_or_default());
    Ok(Some(view))
}

async fn edit_message(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path((id, mid)): Path<(String, String)>,
    ApiJson(body): ApiJson<EditMessageRequest>,
) -> ApiResult<Json<Message>> {
    let id = channel_id(&id)?;
    let mid = message_id(&mid)?;
    let access = channel_access(&state, user_id, id).await?;
    let row = message_in_channel(&state, id, mid).await?;
    if row.author_id != user_id {
        return Err(ApiErr::not_author());
    }
    if !matches!(MessageType::from_u8(row.kind as u8), Some(MessageType::Default | MessageType::Reply)) {
        return Err(ApiErr::invalid("message_id", "Cannot edit a system message."));
    }
    let (attachment_count,): (i64,) = sqlx::query_as("SELECT count(*) FROM attachments WHERE message_id = $1").bind(mid).fetch_one(&state.db).await?;
    let content = validate_content(&body.content, attachment_count > 0)?;
    let content_changed = content != row.content;
    // `flags` only carries SUPPRESS_EMBEDS; omitting it keeps the current state.
    let suppress_bit = SUPPRESS_EMBEDS as i32;
    let old_flags = row.flags;
    let new_flags = match body.flags {
        Some(flags) => (old_flags & !suppress_bit) | (flags as i32 & suppress_bit),
        None => old_flags,
    };
    if content_changed || new_flags != old_flags {
        let suppressed = new_flags & suppress_bit != 0;
        let current: Vec<Embed> = serde_json::from_str(&row.embeds).unwrap_or_default();
        let urls: Vec<String> = unfurl::extract_urls(&content).iter().map(ToString::to_string).collect();
        // Embeds whose URL is gone from the content disappear at once; new URLs are unfurled in the background.
        let kept: Vec<Embed> =
            if suppressed { Vec::new() } else { current.into_iter().filter(|embed| embed.url.as_ref().is_some_and(|url| urls.contains(url))).collect() };
        let mentions = if content_changed { Some(resolve_mentions(&state, &access, parse_mentions(&content)).await?) } else { None };
        let mut tx = state.db.begin().await?;
        sqlx::query("UPDATE messages SET content = $2, edited_at = $3, mention_everyone = $4, flags = $5, embeds = $6::jsonb WHERE id = $1")
            .bind(mid)
            .bind(&content)
            .bind(if content_changed { Some(OffsetDateTime::now_utc()) } else { row.edited_at })
            .bind(mentions.as_ref().map_or(row.mention_everyone, |mentions| mentions.everyone))
            .bind(new_flags)
            .bind(serde_json::to_string(&kept).map_err(|_| ApiErr::internal())?)
            .execute(&mut *tx)
            .await?;
        if let Some(mentions) = &mentions {
            sqlx::query("DELETE FROM message_mentions WHERE message_id = $1").bind(mid).execute(&mut *tx).await?;
            sqlx::query("DELETE FROM message_role_mentions WHERE message_id = $1").bind(mid).execute(&mut *tx).await?;
            for user in &mentions.users {
                sqlx::query("INSERT INTO message_mentions (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING")
                    .bind(mid)
                    .bind(user)
                    .execute(&mut *tx)
                    .await?;
            }
            for role in &mentions.roles {
                sqlx::query("INSERT INTO message_role_mentions (message_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING")
                    .bind(mid)
                    .bind(role)
                    .execute(&mut *tx)
                    .await?;
            }
        }
        tx.commit().await?;
        broadcast_update(&state, &access.channel, mid).await?;
        if !suppressed {
            unfurl::spawn(&state, access.channel.clone(), mid, content, kept);
        }
    }
    store::message_view(&state, mid, Some(user_id)).await?.map(|view| Json(view.message)).ok_or_else(ApiErr::unknown_message)
}

async fn delete_message(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path((id, mid)): Path<(String, String)>) -> ApiResult<StatusCode> {
    let id = channel_id(&id)?;
    let mid = message_id(&mid)?;
    let access = channel_access(&state, user_id, id).await?;
    let row = message_in_channel(&state, id, mid).await?;
    if row.author_id != user_id && (access.is_dm() || access.permissions & MANAGE_MESSAGES == 0) {
        return Err(ApiErr::missing_permissions());
    }
    let viewers = access::channel_viewers(&state, &access.channel).await?;
    let files: Vec<(i64,)> = sqlx::query_as("DELETE FROM attachments WHERE message_id = $1 RETURNING id").bind(mid).fetch_all(&state.db).await?;
    sqlx::query("DELETE FROM messages WHERE id = $1").bind(mid).execute(&state.db).await?;
    sqlx::query("UPDATE channels SET last_message_id = (SELECT max(id) FROM messages WHERE channel_id = $1) WHERE id = $1 AND last_message_id = $2")
        .bind(id)
        .bind(mid)
        .execute(&state.db)
        .await?;
    media::remove_files(&state, &files.into_iter().map(|(id,)| id).collect::<Vec<_>>()).await;
    let event = GatewayEvent::MessageDelete(MessageDelete {
        id: Snowflake::from(mid),
        channel_id: Snowflake::from(id),
        guild_id: access.channel.guild_id.map(Snowflake::from),
    });
    state.hub.send(&viewers, &event);
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct PinsQuery {
    limit: Option<i64>,
    before: Option<String>,
}

/// Newest pin first; `before` is the `pinned_at` of the last item of the previous page.
async fn list_pins(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    ApiQuery(query): ApiQuery<PinsQuery>,
) -> ApiResult<Json<PinnedMessagesPage>> {
    let id = channel_id(&id)?;
    channel_access(&state, user_id, id).await?.require(READ_MESSAGE_HISTORY)?;
    let limit = query.limit.unwrap_or(50);
    if !(1..=50).contains(&limit) {
        return Err(ApiErr::invalid("limit", "Must be between 1 and 50."));
    }
    let before = match query.before.as_deref() {
        Some(raw) => Some(OffsetDateTime::parse(raw, &Rfc3339).map_err(|_| ApiErr::invalid("before", "Must be an ISO 8601 timestamp."))?),
        None => None,
    };
    let mut pins: Vec<(i64, OffsetDateTime)> = sqlx::query_as(
        "SELECT id, pinned_at FROM messages WHERE channel_id = $1 AND pinned AND pinned_at IS NOT NULL AND ($2::timestamptz IS NULL OR pinned_at < $2) \
         ORDER BY pinned_at DESC, id DESC LIMIT $3",
    )
    .bind(id)
    .bind(before)
    .bind(limit + 1)
    .fetch_all(&state.db)
    .await?;
    let has_more = pins.len() as i64 > limit;
    pins.truncate(limit as usize);
    let ids: Vec<i64> = pins.iter().map(|(message, _)| *message).collect();
    let rows: Vec<MessageRow> = sqlx::query_as(&format!("{MESSAGE_SELECT} WHERE m.id = ANY($1)")).bind(&ids).fetch_all(&state.db).await?;
    let mut messages: std::collections::HashMap<i64, Message> =
        store::load_messages(&state, rows, Some(user_id)).await?.into_iter().map(|view| (view.message.id.db(), view.message)).collect();
    let items = pins
        .into_iter()
        .filter_map(|(message, pinned_at)| messages.remove(&message).map(|message| PinnedMessage { message, pinned_at: store::iso(pinned_at) }))
        .collect();
    Ok(Json(PinnedMessagesPage { items, has_more }))
}

fn can_pin(access: &ChannelAccess) -> bool {
    access.is_dm() || access.permissions & MANAGE_MESSAGES != 0
}

async fn pin_message(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path((id, mid)): Path<(String, String)>) -> ApiResult<StatusCode> {
    let id = channel_id(&id)?;
    let mid = message_id(&mid)?;
    let access = channel_access(&state, user_id, id).await?;
    if !can_pin(&access) {
        return Err(ApiErr::missing_permissions());
    }
    let row = message_in_channel(&state, id, mid).await?;
    if row.pinned {
        return Ok(StatusCode::NO_CONTENT);
    }
    let (pins,): (i64,) = sqlx::query_as("SELECT count(*) FROM messages WHERE channel_id = $1 AND pinned").bind(id).fetch_one(&state.db).await?;
    if pins >= MAX_PINS {
        return Err(ApiErr::conflict(30003, "Maximum number of pins reached for the channel (250)"));
    }
    sqlx::query("UPDATE messages SET pinned = TRUE, pinned_at = now() WHERE id = $1").bind(mid).execute(&state.db).await?;
    broadcast_update(&state, &access.channel, mid).await?;
    let notice = Draft {
        content: String::new(),
        kind: MessageType::ChannelPinnedMessage,
        reference: Some(mid),
        attachments: Vec::new(),
        nonce: None,
        mentions: Resolved { users: Vec::new(), roles: Vec::new(), everyone: false },
        ping_replied: false,
    };
    insert_message(&state, &access.channel, user_id, notice).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn unpin_message(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path((id, mid)): Path<(String, String)>) -> ApiResult<StatusCode> {
    let id = channel_id(&id)?;
    let mid = message_id(&mid)?;
    let access = channel_access(&state, user_id, id).await?;
    if !can_pin(&access) {
        return Err(ApiErr::missing_permissions());
    }
    let row = message_in_channel(&state, id, mid).await?;
    if row.pinned {
        sqlx::query("UPDATE messages SET pinned = FALSE, pinned_at = NULL WHERE id = $1").bind(mid).execute(&state.db).await?;
        broadcast_update(&state, &access.channel, mid).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn typing(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path(id): Path<String>) -> ApiResult<StatusCode> {
    let id = channel_id(&id)?;
    let access = channel_access(&state, user_id, id).await?;
    access.require(SEND_MESSAGES)?;
    let viewers: Vec<i64> = access::channel_viewers(&state, &access.channel).await?.into_iter().filter(|viewer| *viewer != user_id).collect();
    let event = GatewayEvent::TypingStart(TypingStart { channel_id: Snowflake::from(id), user_id: Snowflake::from(user_id), timestamp: now_ms() / 1000 });
    state.hub.send(&viewers, &event);
    Ok(StatusCode::NO_CONTENT)
}

/// Moves a read state forward and tells the user's other sessions.
async fn ack(state: &AppState, user_id: i64, id: i64, mid: i64) -> ApiResult<()> {
    // The mention counter only resets when the user has caught up with the newest message.
    sqlx::query(
        "INSERT INTO read_states (user_id, channel_id, last_message_id, mention_count) VALUES ($1, $2, $3, 0) \
         ON CONFLICT (user_id, channel_id) DO UPDATE SET \
           last_message_id = GREATEST(read_states.last_message_id, EXCLUDED.last_message_id), \
           mention_count = CASE WHEN $3 >= COALESCE((SELECT last_message_id FROM channels WHERE id = $2), 0) THEN 0 ELSE read_states.mention_count END",
    )
    .bind(user_id)
    .bind(id)
    .bind(mid)
    .execute(&state.db)
    .await?;
    let event = GatewayEvent::MessageAck(MessageAck { channel_id: Snowflake::from(id), message_id: Snowflake::from(mid) });
    state.hub.send(&[user_id], &event);
    Ok(())
}

async fn ack_message(State(state): State<AppState>, AuthUser(user_id): AuthUser, Path((id, mid)): Path<(String, String)>) -> ApiResult<StatusCode> {
    let id = channel_id(&id)?;
    let mid = message_id(&mid)?;
    channel_access(&state, user_id, id).await?;
    message_in_channel(&state, id, mid).await?;
    ack(&state, user_id, id, mid).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// "Mark server as read": entries the caller cannot see, or whose message is gone, are skipped.
async fn ack_bulk(State(state): State<AppState>, AuthUser(user_id): AuthUser, ApiJson(body): ApiJson<AckBulkRequest>) -> ApiResult<StatusCode> {
    if body.read_states.len() > 200 {
        return Err(ApiErr::invalid("read_states", "At most 200 read states per request."));
    }
    for entry in body.read_states {
        let (id, mid) = (entry.channel_id.db(), entry.message_id.db());
        if channel_access(&state, user_id, id).await.is_ok() && message_in_channel(&state, id, mid).await.is_ok() {
            ack(&state, user_id, id, mid).await?;
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_user_role_and_everyone_mentions() {
        let parsed = parse_mentions("hi <@123> and <@!456>, <@&789> @everyone <@123> <@abc> <@12");
        assert_eq!(parsed.users, vec![123, 456]);
        assert_eq!(parsed.roles, vec![789]);
        assert!(parsed.everyone);
    }

    #[test]
    fn plain_text_has_no_mentions() {
        assert_eq!(parse_mentions("email me at a@b.c <@> <@&>"), ParsedMentions::default());
    }
}
