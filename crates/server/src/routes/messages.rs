use std::collections::HashSet;

use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post, put};
use serde::Deserialize;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use vokko_protocol::api::permissions::{ATTACH_FILES, MANAGE_MESSAGES, MENTION_EVERYONE, READ_MESSAGE_HISTORY, SEND_MESSAGES, SEND_POLLS};
use vokko_protocol::api::{
    AckBulkRequest, AllowedMentions, AuditEntryInfo, AuditLogEvent, CreateMessageRequest, EditMessageRequest, Embed, GatewayEvent, Message, MessageAck,
    MessageDelete, MessageReferenceType, MessageType, PendingAttachmentMeta, PinnedMessage, PinnedMessagesPage, SUPPRESS_EMBEDS, Snowflake, TypingStart,
    message_flags::IS_CROSSPOST,
};

use crate::access::{self, ChannelAccess, channel_access};
use crate::audit::{self, AuditReason, Entry};
use crate::auth::AuthUser;
use crate::config::MAX_ATTACHMENTS_PER_MESSAGE;
use crate::error::{ApiErr, ApiResult};
use crate::extract::{ApiJson, ApiQuery, parse_id};
use crate::forward::{self, ForwardDraft};
use crate::ids::now_ms;
use crate::media;
use crate::polls;
use crate::state::AppState;
use crate::stickers::{self, StickerRef};
use crate::store::{self, ChannelRow, MESSAGE_SELECT, MessageRow, MessageView};
use crate::threads;
use crate::unfurl;

pub const MAX_CONTENT_CHARS: usize = 2000;
const MAX_FILENAME_CHARS: usize = 255;
const MAX_DESCRIPTION_CHARS: usize = 1024;
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

pub fn validate_content(content: &str, has_attachments: bool) -> ApiResult<String> {
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
pub async fn resolve_mentions(state: &AppState, access: &ChannelAccess, parsed: ParsedMentions) -> ApiResult<Resolved> {
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

/// A pending upload attached to a new message, with the rename / alt text chosen at send time.
pub struct DraftAttachment {
    pub id: i64,
    pub filename: Option<String>,
    pub description: Option<String>,
}

impl DraftAttachment {
    pub fn plain(id: i64) -> Self {
        Self { id, filename: None, description: None }
    }

    /// Validates a `CreateMessageRequest.attachments` entry: 1-255 character filename (then cleaned like an upload name),
    /// alt text up to 1024 characters (empty = none).
    pub fn from_meta(meta: &PendingAttachmentMeta) -> ApiResult<Self> {
        let filename = match meta.filename.as_deref().map(str::trim) {
            None => None,
            Some(name) if name.is_empty() || name.chars().count() > MAX_FILENAME_CHARS => {
                return Err(ApiErr::invalid("attachments", "Filename must be 1 to 255 characters."));
            }
            Some(name) => Some(media::sanitize_filename(name)),
        };
        let description = match meta.description.as_deref() {
            Some(text) if text.chars().count() > MAX_DESCRIPTION_CHARS => {
                return Err(ApiErr::invalid("attachments", "Description must be 1024 or fewer in length."));
            }
            Some(text) if !text.trim().is_empty() => Some(text.trim().to_owned()),
            _ => None,
        };
        Ok(Self { id: meta.id.db(), filename, description })
    }
}

pub struct Draft {
    pub content: String,
    pub kind: MessageType,
    pub reference: Option<i64>,
    pub attachments: Vec<DraftAttachment>,
    pub nonce: Option<String>,
    pub mentions: Resolved,
    /// Whether the replied-to author counts as mentioned (`allowed_mentions.replied_user`, default true).
    pub ping_replied: bool,
    pub stickers: Vec<StickerRef>,
    pub forward: Option<ForwardDraft>,
}

/// Applies `allowed_mentions` to what the content parsed to. Omitted = everything pings.
pub fn apply_allowed(resolved: Resolved, allowed: Option<&AllowedMentions>) -> Resolved {
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

/// What the thread and announcement features add to a message beyond a `Draft`; the default changes nothing.
#[derive(Default)]
pub struct Extras {
    /// Use this id instead of a fresh one (a forum post's first message has the id of its thread).
    pub id: Option<i64>,
    /// `message_flags` bits stored with the message.
    pub flags: i32,
    /// Where `Draft::reference` lives when it is not in the message's own channel.
    pub reference_channel: Option<i64>,
    pub reference_guild: Option<i64>,
    /// Unarchive the (archived) thread in the same transaction as the insert, then announce THREAD_UPDATE.
    pub reopen_thread: bool,
    /// Embeds to store as they are (a published copy keeps its source's); no unfurl runs for these.
    pub embeds: Option<String>,
    /// Webhook / interaction messages: the identity and metadata stored with the message (see `apps`).
    pub identity: Option<crate::apps::MessageIdentity>,
    /// Makes the message a poll (stored in the same transaction).
    pub poll: Option<polls::PollDraft>,
    /// Stored as the message's `tts` flag; callers decide it from `SEND_TTS_MESSAGES`.
    pub tts: bool,
}

/// Stores a message, updates read states / unread counters, reopens closed DMs and fans MESSAGE_CREATE out.
pub async fn insert_message(state: &AppState, channel: &ChannelRow, author_id: i64, draft: Draft) -> ApiResult<MessageView> {
    insert_message_with(state, channel, author_id, draft, Extras::default()).await
}

pub async fn insert_message_with(state: &AppState, channel: &ChannelRow, author_id: i64, draft: Draft, extras: Extras) -> ApiResult<MessageView> {
    // Files copied for a forward belong to the message only once it is committed: an error before that deletes them, an error
    // after it (DM reopen, loading the view) must not, or the saved forward would point at deleted files.
    let copies = draft.forward.as_ref().map(ForwardDraft::copy_ids).unwrap_or_default();
    let mut committed = false;
    let result = insert_message_stored(state, channel, author_id, draft, extras, &mut committed).await;
    if result.is_err() && !committed {
        media::remove_files(state, &copies).await;
    }
    result
}

async fn insert_message_stored(
    state: &AppState,
    channel: &ChannelRow,
    author_id: i64,
    draft: Draft,
    extras: Extras,
    committed: &mut bool,
) -> ApiResult<MessageView> {
    let message_id = extras.id.unwrap_or_else(|| state.ids.next());
    let crosspost = extras.flags & IS_CROSSPOST as i32 != 0;
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
    let snapshot_json = match &draft.forward {
        Some(forward) => Some(serde_json::to_string(&forward.snapshot).map_err(|_| ApiErr::internal())?),
        None => None,
    };
    sqlx::query(
        "INSERT INTO messages (id, channel_id, author_id, content, kind, reference_message_id, mention_everyone, flags, reference_channel_id, reference_guild_id, embeds, \
         forward_channel_id, forward_message_id, forward_guild_id, snapshot, webhook_id, application_id, webhook_name, webhook_avatar, interaction_metadata, tts) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, '[]')::jsonb, $12, $13, $14, $15::jsonb, $16, $17, $18, $19, $20::jsonb, $21)",
    )
    .bind(message_id)
    .bind(channel.id)
    .bind(author_id)
    .bind(&draft.content)
    .bind(draft.kind.as_u8() as i16)
    .bind(draft.reference)
    .bind(draft.mentions.everyone)
    .bind(extras.flags)
    .bind(extras.reference_channel)
    .bind(extras.reference_guild)
    .bind(&extras.embeds)
    .bind(draft.forward.as_ref().map(|forward| forward.source_channel))
    .bind(draft.forward.as_ref().map(|forward| forward.source_message))
    .bind(draft.forward.as_ref().and_then(|forward| forward.source_guild))
    .bind(snapshot_json)
    .bind(extras.identity.as_ref().and_then(|identity| identity.webhook_id))
    .bind(extras.identity.as_ref().and_then(|identity| identity.application_id))
    .bind(extras.identity.as_ref().and_then(|identity| identity.name.clone()))
    .bind(extras.identity.as_ref().and_then(|identity| identity.avatar.clone()))
    .bind(extras.identity.as_ref().and_then(|identity| identity.interaction_metadata.clone()))
    .bind(extras.tts)
    .execute(&mut *tx)
    .await?;
    if let Some(poll) = &extras.poll {
        polls::insert(&mut tx, message_id, poll).await?;
    }
    if let Some(forward) = &draft.forward {
        for copy in &forward.copies {
            sqlx::query(
                "INSERT INTO attachments (id, channel_id, uploader_id, message_id, filename, content_type, size, width, height, key, snapshot, description) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE, $11)",
            )
            .bind(copy.id)
            .bind(channel.id)
            .bind(author_id)
            .bind(message_id)
            .bind(&copy.filename)
            .bind(&copy.content_type)
            .bind(copy.size as i64)
            .bind(copy.width.map(|value| value as i32))
            .bind(copy.height.map(|value| value as i32))
            .bind(&copy.key)
            .bind(&copy.description)
            .execute(&mut *tx)
            .await?;
        }
    }
    let snapshot_stickers = draft.forward.iter().flat_map(|forward| forward.stickers.iter()).map(|sticker| (sticker, true));
    for (position, (sticker, snapshot)) in draft.stickers.iter().map(|sticker| (sticker, false)).chain(snapshot_stickers).enumerate() {
        sqlx::query(
            "INSERT INTO message_stickers (message_id, position, sticker_id, name, format, attachment_id, asset_path, snapshot) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        )
        .bind(message_id)
        .bind(position as i16)
        .bind(sticker.sticker_id)
        .bind(&sticker.name)
        .bind(sticker.format.as_u8() as i16)
        .bind(sticker.attachment_id)
        .bind(&sticker.asset_path)
        .bind(snapshot)
        .execute(&mut *tx)
        .await?;
    }
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
        let ids: Vec<i64> = draft.attachments.iter().map(|attachment| attachment.id).collect();
        let filenames: Vec<Option<String>> = draft.attachments.iter().map(|attachment| attachment.filename.clone()).collect();
        let descriptions: Vec<Option<String>> = draft.attachments.iter().map(|attachment| attachment.description.clone()).collect();
        let claimed = sqlx::query(
            "UPDATE attachments a SET message_id = $1, filename = COALESCE(m.filename, a.filename), description = m.description              FROM UNNEST($2::bigint[], $3::text[], $4::text[]) AS m(id, filename, description)              WHERE a.id = m.id AND a.channel_id = $5 AND a.uploader_id = $6 AND a.message_id IS NULL AND a.claimed_at IS NULL",
        )
        .bind(message_id)
        .bind(&ids)
        .bind(&filenames)
        .bind(&descriptions)
        .bind(channel.id)
        .bind(author_id)
        .execute(&mut *tx)
        .await?;
        if claimed.rows_affected() != draft.attachments.len() as u64 {
            return Err(ApiErr::invalid("attachment_ids", "Unknown or already used attachment."));
        }
    }
    // Every message restarts a thread's inactivity clock. This statement takes the row lock first, so the sweep can no longer archive the
    // thread behind our back and the reopen below sees its final state.
    sqlx::query("UPDATE channels SET last_message_id = $2, last_activity_at = now() WHERE id = $1").bind(channel.id).bind(message_id).execute(&mut *tx).await?;
    let reopened_thread = extras.reopen_thread
        && sqlx::query("UPDATE channels SET archived = FALSE, archive_timestamp = now() WHERE id = $1 AND archived")
            .bind(channel.id)
            .execute(&mut *tx)
            .await?
            .rows_affected()
            > 0;
    if !crosspost {
        sqlx::query(
            "INSERT INTO read_states (user_id, channel_id, last_message_id, mention_count) VALUES ($1, $2, $3, 0) \
             ON CONFLICT (user_id, channel_id) DO UPDATE SET last_message_id = EXCLUDED.last_message_id, mention_count = 0",
        )
        .bind(author_id)
        .bind(channel.id)
        .bind(message_id)
        .execute(&mut *tx)
        .await?;
    }
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
    *committed = true;

    if reopened_thread && let Some(row) = store::channel_row(state, channel.id).await? {
        threads::dispatch(state, &row, "THREAD_UPDATE", false).await?;
    }
    for (user,) in reopened {
        if let Some(dm) = store::channel(state, channel.id, Some(user)).await? {
            state.hub.send(&[user], &GatewayEvent::ChannelCreate(dm));
        }
    }
    let mut view = store::message_view(state, message_id, None).await?.ok_or_else(ApiErr::internal)?;
    view.message.nonce = draft.nonce;
    state.hub.send_with(&viewers, "MESSAGE_CREATE", |user| serde_json::to_value(view.for_viewer(user)).unwrap_or_default());
    if matches!(draft.kind, MessageType::Default | MessageType::Reply | MessageType::ChatInputCommand | MessageType::ContextMenuCommand)
        && extras.embeds.is_none()
    {
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
    let mut messages: Vec<Message> = views.into_iter().map(|view| view.message).collect();
    // The caller's own ephemeral interaction responses that fall inside this page.
    let page =
        crate::apps::PageBounds { before: query.before.map(Snowflake::db), after: query.after.map(Snowflake::db), around: query.around.map(Snowflake::db) };
    crate::apps::merge_ephemerals(&state, id, user_id, page, limit, &mut messages).await?;
    Ok(Json(messages))
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
    threads::check_send(&access)?;
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
    // `attachments` (rename / alt text per id) wins over the plain `attachment_ids` list.
    let (attachments, attachments_field): (Vec<DraftAttachment>, &str) = match &body.attachments {
        Some(list) => (list.iter().map(DraftAttachment::from_meta).collect::<ApiResult<_>>()?, "attachments"),
        None => (body.attachment_ids.unwrap_or_default().into_iter().map(|id| DraftAttachment::plain(id.db())).collect(), "attachment_ids"),
    };
    if !attachments.is_empty() {
        access.require(ATTACH_FILES)?;
        if attachments.len() > MAX_ATTACHMENTS_PER_MESSAGE {
            return Err(ApiErr::invalid(attachments_field, "A message can have at most 10 attachments."));
        }
    }
    let sticker_ids = body.sticker_ids.unwrap_or_default();
    let forwarding = body.message_reference.as_ref().is_some_and(|reference| reference.kind == Some(MessageReferenceType::Forward));
    if forwarding && (!body.content.as_deref().unwrap_or("").trim().is_empty() || !attachments.is_empty() || !sticker_ids.is_empty()) {
        return Err(ApiErr::invalid("message_reference", "A forward cannot carry content, attachments or stickers."));
    }
    let poll = match &body.poll {
        Some(request) => {
            if !access.is_dm() {
                access.require(SEND_POLLS)?;
            }
            if !attachments.is_empty() {
                return Err(ApiErr::invalid("attachments", "A poll message cannot have attachments."));
            }
            if forwarding || !sticker_ids.is_empty() {
                return Err(ApiErr::invalid("poll", "A poll message cannot carry stickers or be a forward."));
            }
            Some(polls::validate(request)?)
        }
        None => None,
    };
    let content = validate_content(body.content.as_deref().unwrap_or(""), !attachments.is_empty() || !sticker_ids.is_empty() || forwarding || poll.is_some())?;
    crate::safety::check_send(&state, &access, user_id, &content).await?;
    let stickers = stickers::resolve_for_message(&state, user_id, &access.channel, access.permissions, &sticker_ids).await?;
    let mut forward_source: Option<(i64, i64)> = None;
    let reference = match body.message_reference {
        Some(reference) if forwarding => {
            let source = reference.channel_id.ok_or_else(|| ApiErr::invalid("message_reference", "A forward needs channel_id."))?;
            forward_source = Some((source.db(), reference.message_id.db()));
            None
        }
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
    let mentions = if forwarding { Resolved { users: Vec::new(), roles: Vec::new(), everyone: false } } else { mentions };
    // Last step before the insert: it copies files, and nothing after it may fail without cleaning them up.
    let forward = match forward_source {
        Some((source_channel, source_message)) => {
            Some(forward::prepare(&state, user_id, source_channel, source_message, &access.channel, access.permissions).await?)
        }
        None => None,
    };
    let draft = Draft { content, kind, reference, attachments, nonce: body.nonce, mentions, ping_replied, stickers, forward };
    // Everything is validated: a message into a thread reopens it if it is archived (the UPDATE's `AND archived` guards it, and
    // deciding inside the transaction closes the race with the auto-archive sweep) together with the insert.
    // Without SEND_TTS_MESSAGES the flag is dropped and the message is sent as usual (Discord does the same).
    let tts = body.tts.unwrap_or(false) && access.permissions & vokko_protocol::api::permissions::SEND_TTS_MESSAGES != 0;
    let extras = Extras { reopen_thread: access.channel.is_thread(), poll, tts, ..Extras::default() };
    let view = insert_message_with(&state, &access.channel, user_id, draft, extras).await?;
    if access.channel.is_thread() {
        // Talking in a thread joins it.
        threads::add_member(&state, &access.channel, user_id).await?;
    }
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
    access.require_unarchived()?;
    let row = message_in_channel(&state, id, mid).await?;
    if row.author_id != user_id {
        return Err(ApiErr::not_author());
    }
    if !matches!(MessageType::from_u8(row.kind as u8), Some(MessageType::Default | MessageType::Reply)) {
        return Err(ApiErr::invalid("message_id", "Cannot edit a system message."));
    }
    if row.flags & IS_CROSSPOST as i32 != 0 {
        return Err(ApiErr::invalid("message_id", "Cannot edit a published copy."));
    }
    let (is_poll,): (bool,) = sqlx::query_as("SELECT EXISTS (SELECT 1 FROM polls WHERE message_id = $1)").bind(mid).fetch_one(&state.db).await?;
    if is_poll {
        return Err(polls::cannot_edit());
    }
    if row.forward_message_id.is_some() {
        return Err(ApiErr::invalid("message_id", "Cannot edit a forwarded message."));
    }
    let existing: Vec<(i64,)> =
        sqlx::query_as("SELECT id FROM attachments WHERE message_id = $1 AND NOT snapshot ORDER BY id").bind(mid).fetch_all(&state.db).await?;
    let existing: Vec<i64> = existing.into_iter().map(|(id,)| id).collect();
    // `attachments` is the keep-list: omitted = unchanged, ids that are not on the message are ignored, the rest are removed.
    let removed: Vec<i64> = match &body.attachments {
        Some(keep) => existing.iter().copied().filter(|id| !keep.iter().any(|entry| entry.id.db() == *id)).collect(),
        None => Vec::new(),
    };
    let remaining = existing.len() - removed.len();
    let content = match body.content.as_deref() {
        Some(text) => validate_content(text, true)?,
        None => row.content.clone(),
    };
    if content.is_empty() && remaining == 0 {
        return Err(ApiErr::empty_message());
    }
    let content_changed = content != row.content;
    if content_changed {
        crate::safety::check_automod(&state, &access, user_id, &content).await?;
    }
    // `flags` only carries SUPPRESS_EMBEDS; omitting it keeps the current state.
    let suppress_bit = SUPPRESS_EMBEDS as i32;
    let old_flags = row.flags;
    let new_flags = match body.flags {
        Some(flags) => (old_flags & !suppress_bit) | (flags as i32 & suppress_bit),
        None => old_flags,
    };
    if content_changed || new_flags != old_flags || !removed.is_empty() {
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
            .bind(if content_changed || !removed.is_empty() { Some(OffsetDateTime::now_utc()) } else { row.edited_at })
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
        if !removed.is_empty() {
            sqlx::query("DELETE FROM attachments WHERE id = ANY($1) AND message_id = $2").bind(&removed).bind(mid).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        media::remove_files(&state, &removed).await;
        broadcast_update(&state, &access.channel, mid).await?;
        if !suppressed {
            unfurl::spawn(&state, access.channel.clone(), mid, content, kept);
        }
    }
    store::message_view(&state, mid, Some(user_id)).await?.map(|view| Json(view.message)).ok_or_else(ApiErr::unknown_message)
}

async fn delete_message(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path((id, mid)): Path<(String, String)>,
    AuditReason(reason): AuditReason,
) -> ApiResult<StatusCode> {
    let id = channel_id(&id)?;
    let mid = message_id(&mid)?;
    let access = channel_access(&state, user_id, id).await?;
    // Dismissing an ephemeral message (only its recipient can see it, so only they can).
    if crate::apps::dismiss_ephemeral(&state, id, mid, user_id).await? {
        return Ok(StatusCode::NO_CONTENT);
    }
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
    // Discord logs deletions of someone else's message only.
    if let Some(guild_id) = access.channel.guild_id
        && row.author_id != user_id
    {
        let options = AuditEntryInfo { channel_id: Some(Snowflake::from(id)), count: Some("1".to_owned()), ..Default::default() };
        audit::record(&state, Entry::new(guild_id, user_id, AuditLogEvent::MessageDelete, row.author_id).reason(reason).options(options)).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Audit entry for a pin or unpin in a guild channel.
async fn audit_pin(state: &AppState, access: &ChannelAccess, user_id: i64, row: &MessageRow, action: AuditLogEvent, reason: Option<String>) -> ApiResult<()> {
    let Some(guild_id) = access.channel.guild_id else { return Ok(()) };
    let options = AuditEntryInfo { channel_id: Some(Snowflake::from(access.channel.id)), message_id: Some(Snowflake::from(row.id)), ..Default::default() };
    audit::record(state, Entry::new(guild_id, user_id, action, row.author_id).reason(reason).options(options)).await?;
    Ok(())
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

async fn pin_message(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path((id, mid)): Path<(String, String)>,
    AuditReason(reason): AuditReason,
) -> ApiResult<StatusCode> {
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
        stickers: Vec::new(),
        forward: None,
    };
    insert_message(&state, &access.channel, user_id, notice).await?;
    audit_pin(&state, &access, user_id, &row, AuditLogEvent::MessagePin, reason).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn unpin_message(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path((id, mid)): Path<(String, String)>,
    AuditReason(reason): AuditReason,
) -> ApiResult<StatusCode> {
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
        audit_pin(&state, &access, user_id, &row, AuditLogEvent::MessageUnpin, reason).await?;
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
    if body.read_states.len() > 100 {
        return Err(ApiErr::invalid("read_states", "At most 100 read states per request."));
    }
    let entries: Vec<(i64, i64)> = body.read_states.iter().map(|entry| (entry.channel_id.db(), entry.message_id.db())).collect();
    if entries.is_empty() {
        return Ok(StatusCode::NO_CONTENT);
    }
    let channel_ids: Vec<i64> = entries.iter().map(|(channel, _)| *channel).collect();
    let visible = access::viewable_channels(&state, user_id, &channel_ids).await?;
    let (channels, messages): (Vec<i64>, Vec<i64>) = entries.iter().copied().filter(|(channel, _)| visible.contains(channel)).unzip();
    if channels.is_empty() {
        return Ok(StatusCode::NO_CONTENT);
    }
    // One statement: keep entries whose message exists in that channel (several entries for a channel collapse to
    // the newest), move the read state forward and reset the mention counter only when caught up.
    let acked: Vec<(i64, i64)> = sqlx::query_as(
        "WITH wanted AS ( \
             SELECT t.channel_id, MAX(t.message_id) AS message_id \
             FROM UNNEST($2::bigint[], $3::bigint[]) AS t(channel_id, message_id) \
             JOIN messages m ON m.id = t.message_id AND m.channel_id = t.channel_id \
             GROUP BY t.channel_id \
         ) \
         INSERT INTO read_states (user_id, channel_id, last_message_id, mention_count) \
         SELECT $1, w.channel_id, w.message_id, 0 FROM wanted w \
         ON CONFLICT (user_id, channel_id) DO UPDATE SET \
             last_message_id = GREATEST(read_states.last_message_id, EXCLUDED.last_message_id), \
             mention_count = CASE WHEN EXCLUDED.last_message_id >= COALESCE((SELECT c.last_message_id FROM channels c WHERE c.id = read_states.channel_id), 0) \
                 THEN 0 ELSE read_states.mention_count END \
         RETURNING channel_id, last_message_id",
    )
    .bind(user_id)
    .bind(&channels)
    .bind(&messages)
    .fetch_all(&state.db)
    .await?;
    for (id, last) in acked {
        let event = GatewayEvent::MessageAck(MessageAck { channel_id: Snowflake::from(id), message_id: Snowflake::from(last) });
        state.hub.send(&[user_id], &event);
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
