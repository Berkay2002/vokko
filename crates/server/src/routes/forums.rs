//! Forum channels: tags and defaults, post creation (`POST /channels/{forum}/threads`) and the thread search behind the post list.
use std::collections::HashMap;

use axum::Json;
use axum::Router;
use axum::extract::{Path, RawQuery, State};
use axum::routing::get;
use vokko_protocol::api::permissions::{ATTACH_FILES, MANAGE_THREADS, READ_MESSAGE_HISTORY, SEND_MESSAGES};
use vokko_protocol::api::{
    ChannelType, CreateChannelRequest, DefaultReaction, ForumPost, ForumTagRequest, MessageType, Snowflake, StartForumPostRequest, ThreadSearchQuery,
    ThreadSearchResponse, UpdateChannelRequest, channel_flags,
};

use crate::access::ChannelAccess;
use crate::auth::AuthUser;
use crate::config::MAX_ATTACHMENTS_PER_MESSAGE;
use crate::error::{ApiErr, ApiResult};
use crate::extract::parse_id;
use crate::routes::messages::{Draft, DraftAttachment, Extras, apply_allowed, insert_message_with, parse_mentions, resolve_mentions, validate_content};
use crate::routes::search::percent_decode;
use crate::routes::threads::{created_response, insert_thread};
use crate::state::AppState;
use crate::store::{self, CHANNEL_COLS, ChannelRow, MESSAGE_SELECT, MessageRow};
use crate::threads;

const MAX_TAGS: usize = 20;
const MAX_APPLIED_TAGS: usize = 5;
const MAX_SEARCH_OFFSET: u32 = 10_000;

pub fn routes() -> Router<AppState> {
    Router::new().route("/channels/{id}/threads/search", get(search_threads))
}

// ---- tags and defaults of a parent channel ----

struct TagWrite {
    id: Option<i64>,
    name: String,
    moderated: bool,
    emoji_id: Option<i64>,
    emoji_name: Option<String>,
}

fn validate_tags(tags: &[ForumTagRequest]) -> ApiResult<Vec<TagWrite>> {
    if tags.len() > MAX_TAGS {
        return Err(ApiErr::invalid("available_tags", "A forum has at most 20 tags."));
    }
    tags.iter()
        .map(|tag| {
            let name = tag.name.trim().to_owned();
            if !(1..=20).contains(&name.chars().count()) {
                return Err(ApiErr::invalid("available_tags", "Tag names must be between 1 and 20 in length."));
            }
            let emoji_name = tag.emoji_name.as_ref().map(|name| name.trim().to_owned()).filter(|name| !name.is_empty());
            if emoji_name.as_ref().is_some_and(|name| name.chars().count() > 64) {
                return Err(ApiErr::invalid("available_tags", "Tag emoji names are at most 64 long."));
            }
            Ok(TagWrite {
                id: tag.id.map(Snowflake::db),
                name,
                moderated: tag.moderated.unwrap_or(false),
                emoji_id: tag.emoji_id.map(Snowflake::db),
                emoji_name,
            })
        })
        .collect()
}

/// The forum / thread-parent fields of a create or edit request, validated and ready to write.
#[derive(Default)]
pub struct ParentFields {
    tags: Option<Vec<TagWrite>>,
    reaction: Option<Option<DefaultReaction>>,
    sort_order: Option<i32>,
    layout: Option<i32>,
    auto_archive: Option<i32>,
    require_tag: Option<bool>,
}

struct RawFields<'a> {
    tags: Option<&'a Vec<ForumTagRequest>>,
    reaction: Option<Option<&'a DefaultReaction>>,
    sort_order: Option<u32>,
    layout: Option<u32>,
    auto_archive: Option<u32>,
    flags: Option<u32>,
}

fn parent_fields(kind: ChannelType, raw: RawFields<'_>) -> ApiResult<ParentFields> {
    let mut fields = ParentFields::default();
    if matches!(kind, ChannelType::GuildText | ChannelType::GuildAnnouncement | ChannelType::GuildForum) {
        fields.auto_archive = raw.auto_archive.map(threads::validate_auto_archive).transpose()?;
    }
    if kind == ChannelType::GuildForum {
        fields.tags = raw.tags.map(|tags| validate_tags(tags)).transpose()?;
        fields.reaction = raw.reaction.map(|reaction| reaction.cloned());
        if let Some(sort) = raw.sort_order {
            if sort > 1 {
                return Err(ApiErr::invalid("default_sort_order", "Must be 0 (latest activity) or 1 (creation date)."));
            }
            fields.sort_order = Some(sort as i32);
        }
        if let Some(layout) = raw.layout {
            if !(1..=2).contains(&layout) {
                return Err(ApiErr::invalid("default_forum_layout", "Must be 1 (list) or 2 (gallery)."));
            }
            fields.layout = Some(layout as i32);
        }
        fields.require_tag = raw.flags.map(|flags| flags & channel_flags::REQUIRE_TAG != 0);
    }
    Ok(fields)
}

impl ParentFields {
    pub fn from_create(body: &CreateChannelRequest) -> ApiResult<Self> {
        parent_fields(
            body.kind,
            RawFields {
                tags: body.available_tags.as_ref(),
                reaction: body.default_reaction_emoji.as_ref().map(Some),
                sort_order: body.default_sort_order,
                layout: body.default_forum_layout,
                auto_archive: body.default_auto_archive_duration,
                flags: body.flags,
            },
        )
    }

    pub fn from_update(kind: ChannelType, body: &UpdateChannelRequest) -> ApiResult<Self> {
        parent_fields(
            kind,
            RawFields {
                tags: body.available_tags.as_ref(),
                reaction: body.default_reaction_emoji.as_ref().map(Option::as_ref),
                sort_order: body.default_sort_order,
                layout: body.default_forum_layout,
                auto_archive: body.default_auto_archive_duration,
                flags: body.flags,
            },
        )
    }

    /// Writes the fields; returns the posts that lost a removed tag (the caller sends THREAD_UPDATE after the commit).
    pub async fn apply(&self, state: &AppState, tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, channel_id: i64) -> ApiResult<Vec<i64>> {
        if let Some(minutes) = self.auto_archive {
            sqlx::query("UPDATE channels SET default_auto_archive_duration = $2 WHERE id = $1").bind(channel_id).bind(minutes).execute(&mut **tx).await?;
        }
        if let Some(sort) = self.sort_order {
            sqlx::query("UPDATE channels SET default_sort_order = $2 WHERE id = $1").bind(channel_id).bind(sort).execute(&mut **tx).await?;
        }
        if let Some(layout) = self.layout {
            sqlx::query("UPDATE channels SET default_forum_layout = $2 WHERE id = $1").bind(channel_id).bind(layout).execute(&mut **tx).await?;
        }
        if let Some(require) = self.require_tag {
            let bit = channel_flags::REQUIRE_TAG as i32;
            sqlx::query("UPDATE channels SET flags = CASE WHEN $2 THEN flags | $3 ELSE flags & ~$3 END WHERE id = $1")
                .bind(channel_id)
                .bind(require)
                .bind(bit)
                .execute(&mut **tx)
                .await?;
        }
        if let Some(reaction) = &self.reaction {
            sqlx::query("UPDATE channels SET default_reaction_emoji_id = $2, default_reaction_emoji_name = $3 WHERE id = $1")
                .bind(channel_id)
                .bind(reaction.as_ref().and_then(|reaction| reaction.emoji_id).map(Snowflake::db))
                .bind(reaction.as_ref().and_then(|reaction| reaction.emoji_name.clone()))
                .execute(&mut **tx)
                .await?;
        }
        match &self.tags {
            Some(tags) => self.replace_tags(state, tx, channel_id, tags).await,
            None => Ok(Vec::new()),
        }
    }

    async fn replace_tags(&self, state: &AppState, tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, channel_id: i64, tags: &[TagWrite]) -> ApiResult<Vec<i64>> {
        let existing: Vec<(i64,)> = sqlx::query_as("SELECT id FROM forum_tags WHERE channel_id = $1").bind(channel_id).fetch_all(&mut **tx).await?;
        let existing: Vec<i64> = existing.into_iter().map(|(id,)| id).collect();
        let mut kept = Vec::new();
        for tag in tags {
            if let Some(id) = tag.id {
                if !existing.contains(&id) || kept.contains(&id) {
                    return Err(ApiErr::invalid("available_tags", "Unknown or repeated tag id."));
                }
                kept.push(id);
            }
        }
        let removed: Vec<i64> = existing.into_iter().filter(|id| !kept.contains(id)).collect();
        sqlx::query("DELETE FROM forum_tags WHERE channel_id = $1 AND id = ANY($2)").bind(channel_id).bind(&removed).execute(&mut **tx).await?;
        for (position, tag) in tags.iter().enumerate() {
            match tag.id {
                Some(id) => {
                    sqlx::query("UPDATE forum_tags SET name = $2, moderated = $3, emoji_id = $4, emoji_name = $5, position = $6 WHERE id = $1")
                        .bind(id)
                        .bind(&tag.name)
                        .bind(tag.moderated)
                        .bind(tag.emoji_id)
                        .bind(&tag.emoji_name)
                        .bind(position as i32)
                        .execute(&mut **tx)
                        .await?;
                }
                None => {
                    sqlx::query("INSERT INTO forum_tags (id, channel_id, name, moderated, emoji_id, emoji_name, position) VALUES ($1, $2, $3, $4, $5, $6, $7)")
                        .bind(state.ids.next())
                        .bind(channel_id)
                        .bind(&tag.name)
                        .bind(tag.moderated)
                        .bind(tag.emoji_id)
                        .bind(&tag.emoji_name)
                        .bind(position as i32)
                        .execute(&mut **tx)
                        .await?;
                }
            }
        }
        if removed.is_empty() {
            return Ok(Vec::new());
        }
        let posts: Vec<(i64,)> = sqlx::query_as(
            "UPDATE channels SET applied_tags = ARRAY(SELECT t FROM unnest(applied_tags) AS t WHERE t <> ALL($2)) \
             WHERE parent_id = $1 AND kind IN (10, 11, 12) AND applied_tags && $2 RETURNING id",
        )
        .bind(channel_id)
        .bind(&removed)
        .fetch_all(&mut **tx)
        .await?;
        Ok(posts.into_iter().map(|(id,)| id).collect())
    }
}

/// THREAD_UPDATE for posts whose tags changed under them.
pub async fn announce_changed_posts(state: &AppState, posts: &[i64]) -> ApiResult<()> {
    for id in posts {
        if let Some(row) = store::channel_row(state, *id).await? {
            threads::dispatch(state, &row, "THREAD_UPDATE", false).await?;
        }
    }
    Ok(())
}

/// Checks the tags a post wants: at most 5, all of this forum, moderated ones only added or removed with MANAGE_THREADS, and at least
/// one when the forum requires a tag (220003). `previous` are the tags the post has now (empty for a new post).
pub async fn validate_applied_tags(state: &AppState, forum: &ChannelRow, tags: &[Snowflake], manage: bool, previous: &[i64]) -> ApiResult<Vec<i64>> {
    let mut wanted: Vec<i64> = Vec::new();
    for tag in tags {
        if !wanted.contains(&tag.db()) {
            wanted.push(tag.db());
        }
    }
    if wanted.len() > MAX_APPLIED_TAGS {
        return Err(ApiErr::invalid("applied_tags", "A post has at most 5 tags."));
    }
    if wanted.is_empty() && forum.flags & channel_flags::REQUIRE_TAG as i32 != 0 {
        return Err(ApiErr::tag_required());
    }
    let mut lookup = wanted.clone();
    lookup.extend(previous.iter().copied());
    let known: Vec<(i64, bool)> =
        sqlx::query_as("SELECT id, moderated FROM forum_tags WHERE channel_id = $1 AND id = ANY($2)").bind(forum.id).bind(&lookup).fetch_all(&state.db).await?;
    if wanted.iter().any(|tag| !known.iter().any(|(id, _)| id == tag)) {
        return Err(ApiErr::invalid("applied_tags", "Unknown tag."));
    }
    if !manage {
        let changed_moderated = known.iter().any(|(id, moderated)| *moderated && wanted.contains(id) != previous.contains(id));
        if changed_moderated {
            return Err(ApiErr::missing_permissions());
        }
    }
    Ok(wanted)
}

// ---- posts ----

/// `POST /channels/{forum}/threads`: a post is a public thread whose id is the id of its first message.
pub async fn create_post(state: &AppState, user_id: i64, access: &ChannelAccess, request: StartForumPostRequest) -> ApiResult<Json<ForumPost>> {
    let forum = &access.channel;
    access.require(SEND_MESSAGES)?;
    let name = threads::thread_name(&request.name)?;
    let duration = threads::auto_archive_for(forum, request.auto_archive_duration)?;
    let manage = access.permissions & MANAGE_THREADS != 0;
    let tags = validate_applied_tags(state, forum, request.applied_tags.as_deref().unwrap_or(&[]), manage, &[]).await?;

    let first = request.message;
    let drafts: Vec<DraftAttachment> = match &first.attachments {
        Some(list) => list.iter().map(DraftAttachment::from_meta).collect::<ApiResult<_>>()?,
        None => first.attachment_ids.clone().unwrap_or_default().into_iter().map(|id| DraftAttachment::plain(id.db())).collect(),
    };
    let attachments: Vec<i64> = drafts.iter().map(|draft| draft.id).collect();
    if !attachments.is_empty() {
        access.require(ATTACH_FILES)?;
        if attachments.len() > MAX_ATTACHMENTS_PER_MESSAGE {
            return Err(ApiErr::invalid("attachment_ids", "A message can have at most 10 attachments."));
        }
        // Uploaded to the forum before the post existed; checked here so the post is not created for nothing.
        let (usable,): (i64,) =
            sqlx::query_as("SELECT count(*) FROM attachments WHERE id = ANY($1) AND channel_id = $2 AND uploader_id = $3 AND message_id IS NULL")
                .bind(&attachments)
                .bind(forum.id)
                .bind(user_id)
                .fetch_one(&state.db)
                .await?;
        if usable != attachments.len() as i64 {
            return Err(ApiErr::invalid("attachment_ids", "Unknown or already used attachment."));
        }
    }
    let content = validate_content(first.content.as_deref().unwrap_or(""), !attachments.is_empty())?;
    crate::safety::check_send(state, access, user_id, &content).await?;
    let mentions = apply_allowed(resolve_mentions(state, access, parse_mentions(&content)).await?, first.allowed_mentions.as_ref());

    let id = state.ids.next();
    insert_thread(state, id, ChannelType::PublicThread, forum, user_id, &name, duration, true, &tags).await?;
    if !attachments.is_empty() {
        // locked first in one statement by ascending id, like every multi-upload lock, rather than in the UPDATE's own scan order
        let mut tx = state.db.begin().await?;
        crate::media::lock_uploads(&mut tx, &attachments).await?;
        sqlx::query("UPDATE attachments SET channel_id = $2 WHERE id = ANY($1)").bind(&attachments).bind(id).execute(&mut *tx).await?;
        tx.commit().await?;
    }
    let row = store::channel_row(state, id).await?.ok_or_else(ApiErr::internal)?;
    threads::dispatch(state, &row, "THREAD_CREATE", true).await?;
    let draft = Draft {
        content,
        kind: MessageType::Default,
        reference: None,
        attachments: drafts,
        nonce: first.nonce,
        mentions,
        ping_replied: false,
        stickers: Vec::new(),
        forward: None,
    };
    let view = match insert_message_with(state, &row, user_id, draft, Extras { id: Some(id), ..Extras::default() }).await {
        Ok(view) => view,
        Err(error) => {
            // The post is the message: without it there is no post.
            threads::delete_threads(state, vec![row], false).await?;
            return Err(error);
        }
    };
    let channel = created_response(state, id, user_id).await?;
    Ok(Json(ForumPost { channel, message: view.for_viewer(user_id) }))
}

// ---- search ----

fn parse_search(raw: Option<&str>) -> ApiResult<ThreadSearchQuery> {
    let mut query = ThreadSearchQuery::default();
    let bad = |field: &str| ApiErr::invalid(field, "Invalid value.");
    for pair in raw.unwrap_or("").split('&').filter(|pair| !pair.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let (key, value) = (percent_decode(key), percent_decode(value));
        match key.as_str() {
            "name" if !value.trim().is_empty() => query.name = Some(value.trim().to_owned()),
            "tag" => {
                query.tag.push(Snowflake::from(value.parse::<u64>().ok().filter(|id| *id > 0 && *id <= i64::MAX as u64).ok_or_else(|| bad("tag"))? as i64))
            }
            "tag_setting" => {
                query.match_all = match value.as_str() {
                    "match_all" => true,
                    "match_some" => false,
                    _ => return Err(bad("tag_setting")),
                }
            }
            "archived" => query.archived = Some(value.parse::<bool>().map_err(|_| bad("archived"))?),
            "sort_by" => {
                query.sort_by_creation = Some(match value.as_str() {
                    "creation_time" => true,
                    "last_message_time" => false,
                    _ => return Err(bad("sort_by")),
                })
            }
            "sort_order" => {
                query.ascending = match value.as_str() {
                    "asc" => true,
                    "desc" => false,
                    _ => return Err(bad("sort_order")),
                }
            }
            "limit" => query.limit = Some(value.parse::<u32>().ok().filter(|limit| (1..=25).contains(limit)).ok_or_else(|| bad("limit"))?),
            "offset" => query.offset = Some(value.parse::<u32>().ok().filter(|offset| *offset <= MAX_SEARCH_OFFSET).ok_or_else(|| bad("offset"))?),
            _ => {}
        }
    }
    Ok(query)
}

/// Escapes `\`, `%` and `_` so the name filter is a plain substring match.
fn like_pattern(name: &str) -> String {
    let escaped = name.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    format!("%{escaped}%")
}

const SEARCH_FILTER: &str = "FROM channels c WHERE c.parent_id = $1 AND c.kind IN (10, 11, 12) \
     AND ($2::text IS NULL OR c.name ILIKE $2) \
     AND ($3::bigint[] IS NULL OR CASE WHEN $4 THEN c.applied_tags @> $3 ELSE c.applied_tags && $3 END) \
     AND ($5::bool IS NULL OR c.archived = $5) \
     AND (c.kind <> 12 OR $6 OR c.id IN (SELECT thread_id FROM thread_members WHERE user_id = $7))";

async fn search_threads(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
) -> ApiResult<Json<ThreadSearchResponse>> {
    let query = parse_search(raw.as_deref())?;
    let parent_id = parse_id(&id).ok_or_else(ApiErr::unknown_channel)?;
    let access = crate::access::channel_access(&state, user_id, parent_id).await?;
    let parent = &access.channel;
    if !matches!(parent.channel_type(), ChannelType::GuildText | ChannelType::GuildAnnouncement | ChannelType::GuildForum) {
        return Err(ApiErr::wrong_channel_type());
    }
    let empty = ThreadSearchResponse { threads: Vec::new(), members: Vec::new(), first_messages: Vec::new(), has_more: false, total_results: 0 };
    if access.permissions & READ_MESSAGE_HISTORY == 0 {
        return Ok(Json(empty));
    }
    let by_creation = query.sort_by_creation.unwrap_or(parent.default_sort_order == 1);
    let direction = if query.ascending { "ASC" } else { "DESC" };
    let key = if by_creation { "c.id" } else { "COALESCE(c.last_message_id, c.id)" };
    let (limit, offset) = (query.limit.unwrap_or(25) as i64, query.offset.unwrap_or(0) as i64);
    let name = query.name.as_deref().map(like_pattern);
    let tags: Option<Vec<i64>> = (!query.tag.is_empty()).then(|| query.tag.iter().map(|tag| tag.db()).collect());
    let manage = access.permissions & MANAGE_THREADS != 0;

    let cols = CHANNEL_COLS.split(", ").map(|column| format!("c.{column}")).collect::<Vec<_>>().join(", ");
    let rows: Vec<ChannelRow> =
        sqlx::query_as(&format!("SELECT {cols} {SEARCH_FILTER} ORDER BY (c.flags & 2) DESC, {key} {direction}, c.id {direction} LIMIT $8 OFFSET $9"))
            .bind(parent_id)
            .bind(&name)
            .bind(&tags)
            .bind(query.match_all)
            .bind(query.archived)
            .bind(manage)
            .bind(user_id)
            .bind(limit)
            .bind(offset)
            .fetch_all(&state.db)
            .await?;
    let (total,): (i64,) = sqlx::query_as(&format!("SELECT count(*) {SEARCH_FILTER}"))
        .bind(parent_id)
        .bind(&name)
        .bind(&tags)
        .bind(query.match_all)
        .bind(query.archived)
        .bind(manage)
        .bind(user_id)
        .fetch_one(&state.db)
        .await?;

    let ids: Vec<i64> = rows.iter().map(|row| row.id).collect();
    let starters: Vec<(i64,)> = sqlx::query_as(
        "SELECT DISTINCT ON (channel_id) id FROM messages WHERE channel_id = ANY($1) AND (id = channel_id OR kind = 21) ORDER BY channel_id, id",
    )
    .bind(&ids)
    .fetch_all(&state.db)
    .await?;
    let starter_ids: Vec<i64> = starters.into_iter().map(|(id,)| id).collect();
    let message_rows: Vec<MessageRow> = sqlx::query_as(&format!("{MESSAGE_SELECT} WHERE m.id = ANY($1)")).bind(&starter_ids).fetch_all(&state.db).await?;
    let mut by_thread: HashMap<i64, vokko_protocol::api::Message> =
        store::load_messages(&state, message_rows, Some(user_id)).await?.into_iter().map(|view| (view.message.channel_id.db(), view.message)).collect();
    let first_messages = ids.iter().filter_map(|id| by_thread.remove(id)).collect();

    let mut joined = threads::memberships(&state, user_id, &ids).await?;
    let members = ids.iter().filter_map(|id| joined.remove(id)).collect();
    let threads = store::channels_to_api(&state, rows, Some(user_id)).await?;
    Ok(Json(ThreadSearchResponse { has_more: offset + (threads.len() as i64) < total, total_results: total.max(0) as u32, threads, members, first_messages }))
}
