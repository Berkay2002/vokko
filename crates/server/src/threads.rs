//! Threads: access resolution, membership, wire decoration and the auto-archive sweep. The routes live in `routes/threads.rs`,
//! `routes/forums.rs` and `routes/follows.rs`. A thread is a channel (kind 10, 11, 12) whose parent is a text, announcement or forum channel.
use std::collections::{HashMap, HashSet};
use std::time::Duration;

use sqlx::FromRow;
use time::OffsetDateTime;
use vokko_protocol::api::permissions::{MANAGE_THREADS, SEND_MESSAGES, SEND_MESSAGES_IN_THREADS};
use vokko_protocol::api::{
    Channel, ChannelType, DEFAULT_AUTO_ARCHIVE_DURATION, DefaultReaction, ForumTag, GatewayEvent, Snowflake, THREAD_AUTO_ARCHIVE_DURATIONS, ThreadDelete,
    ThreadMember, ThreadMemberUpdate, ThreadMembersUpdate, ThreadMetadata,
};

use crate::access::{self, ChannelAccess};
use crate::error::{ApiErr, ApiResult};
use crate::state::AppState;
use crate::store::{self, CHANNEL_COLS, ChannelRow, MessageRow, iso};

/// How often the auto-archive sweep runs.
const SWEEP_INTERVAL: Duration = Duration::from_secs(60);

pub fn is_thread_kind(kind: i16) -> bool {
    matches!(kind, 10..=12)
}

fn flake(id: i64) -> Snowflake {
    Snowflake::from(id)
}

/// Thread names are 1-100 characters; unlike text channel names they keep their case and spaces.
pub fn thread_name(raw: &str) -> ApiResult<String> {
    let name = raw.trim().to_owned();
    if !(1..=100).contains(&name.chars().count()) {
        return Err(ApiErr::invalid("name", "Must be between 1 and 100 in length."));
    }
    Ok(name)
}

pub fn validate_auto_archive(minutes: u32) -> ApiResult<i32> {
    if THREAD_AUTO_ARCHIVE_DURATIONS.contains(&minutes) {
        Ok(minutes as i32)
    } else {
        Err(ApiErr::invalid("auto_archive_duration", "Must be one of 60, 1440, 4320 or 10080."))
    }
}

/// The parent's default (or one day) unless the request names a duration.
pub fn auto_archive_for(parent: &ChannelRow, requested: Option<u32>) -> ApiResult<i32> {
    match requested {
        Some(minutes) => validate_auto_archive(minutes),
        None => Ok(parent.default_auto_archive_duration.unwrap_or(DEFAULT_AUTO_ARCHIVE_DURATION as i32)),
    }
}

// ---- membership rows ----

#[derive(FromRow)]
struct MemberRow {
    thread_id: i64,
    user_id: i64,
    joined_at: OffsetDateTime,
    flags: i32,
}

impl MemberRow {
    fn into_api(self) -> ThreadMember {
        ThreadMember { id: flake(self.thread_id), user_id: flake(self.user_id), join_timestamp: iso(self.joined_at), flags: self.flags.max(0) as u32 }
    }
}

pub async fn is_member(state: &AppState, thread_id: i64, user_id: i64) -> ApiResult<bool> {
    let found: Option<(i64,)> = sqlx::query_as("SELECT user_id FROM thread_members WHERE thread_id = $1 AND user_id = $2")
        .bind(thread_id)
        .bind(user_id)
        .fetch_optional(&state.db)
        .await?;
    Ok(found.is_some())
}

pub async fn member(state: &AppState, thread_id: i64, user_id: i64) -> ApiResult<Option<ThreadMember>> {
    let row: Option<MemberRow> = sqlx::query_as("SELECT thread_id, user_id, joined_at, flags FROM thread_members WHERE thread_id = $1 AND user_id = $2")
        .bind(thread_id)
        .bind(user_id)
        .fetch_optional(&state.db)
        .await?;
    Ok(row.map(MemberRow::into_api))
}

pub async fn members_of(state: &AppState, thread_id: i64) -> ApiResult<Vec<ThreadMember>> {
    let rows: Vec<MemberRow> =
        sqlx::query_as("SELECT thread_id, user_id, joined_at, flags FROM thread_members WHERE thread_id = $1 ORDER BY joined_at, user_id")
            .bind(thread_id)
            .fetch_all(&state.db)
            .await?;
    Ok(rows.into_iter().map(MemberRow::into_api).collect())
}

/// The user's memberships among `thread_ids`, by thread id.
pub async fn memberships(state: &AppState, user_id: i64, thread_ids: &[i64]) -> ApiResult<HashMap<i64, ThreadMember>> {
    if thread_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<MemberRow> = sqlx::query_as("SELECT thread_id, user_id, joined_at, flags FROM thread_members WHERE user_id = $1 AND thread_id = ANY($2)")
        .bind(user_id)
        .bind(thread_ids)
        .fetch_all(&state.db)
        .await?;
    Ok(rows.into_iter().map(|row| (row.thread_id, row.into_api())).collect())
}

pub async fn member_count(state: &AppState, thread_id: i64) -> ApiResult<u32> {
    let (count,): (i64,) = sqlx::query_as("SELECT count(*) FROM thread_members WHERE thread_id = $1").bind(thread_id).fetch_one(&state.db).await?;
    Ok(count.max(0) as u32)
}

// ---- access ----

/// Permissions in a thread are the parent's with SEND_MESSAGES replaced by SEND_MESSAGES_IN_THREADS; a private thread is only
/// visible to its members and holders of MANAGE_THREADS (403 50001 otherwise).
pub async fn thread_access(state: &AppState, user_id: i64, thread: ChannelRow) -> ApiResult<ChannelAccess> {
    let parent_id = thread.parent_id.ok_or_else(ApiErr::unknown_channel)?;
    let parent_row = store::channel_row(state, parent_id).await?.ok_or_else(ApiErr::unknown_channel)?;
    let parent = access::guild_channel_access(state, user_id, parent_row).await?;
    if thread.channel_type() == ChannelType::PrivateThread && parent.permissions & MANAGE_THREADS == 0 && !is_member(state, thread.id, user_id).await? {
        return Err(ApiErr::missing_access());
    }
    let mut permissions = parent.permissions;
    if permissions & SEND_MESSAGES_IN_THREADS != 0 {
        permissions |= SEND_MESSAGES;
    } else {
        permissions &= !SEND_MESSAGES;
    }
    Ok(ChannelAccess { channel: thread, permissions, parent: Some(parent.channel) })
}

/// Who sees a thread: everyone who sees the parent, or for private threads its members and MANAGE_THREADS holders.
pub async fn thread_viewers(state: &AppState, thread: &ChannelRow) -> ApiResult<Vec<i64>> {
    let Some(parent_id) = thread.parent_id else { return Ok(Vec::new()) };
    let Some(parent) = store::channel_row(state, parent_id).await? else { return Ok(Vec::new()) };
    let viewers = access::viewer_permissions(state, &parent).await?;
    if thread.channel_type() != ChannelType::PrivateThread {
        return Ok(viewers.into_iter().map(|(user_id, _)| user_id).collect());
    }
    let members: Vec<(i64,)> = sqlx::query_as("SELECT user_id FROM thread_members WHERE thread_id = $1").bind(thread.id).fetch_all(&state.db).await?;
    let members: HashSet<i64> = members.into_iter().map(|(id,)| id).collect();
    Ok(viewers
        .into_iter()
        .filter(|(user_id, permissions)| permissions & MANAGE_THREADS != 0 || members.contains(user_id))
        .map(|(user_id, _)| user_id)
        .collect())
}

/// Checks before a message goes into `access.channel` and the side effects it needs: forums only take posts, locked threads only
/// accept MANAGE_THREADS. A message into an archived thread reopens it, but only once the message is valid (`Extras::reopen`).
pub fn check_send(access: &ChannelAccess) -> ApiResult<()> {
    let channel = &access.channel;
    if channel.channel_type() == ChannelType::GuildForum {
        return Err(ApiErr::wrong_channel_type());
    }
    if !channel.is_thread() {
        return Ok(());
    }
    if channel.locked && access.permissions & MANAGE_THREADS == 0 {
        return Err(ApiErr::thread_locked());
    }
    Ok(())
}

// ---- wire decoration ----

/// Data `channels_to_api` needs for thread and forum rows, loaded in a constant number of queries.
#[derive(Default)]
pub struct Extras {
    message_counts: HashMap<i64, u32>,
    member_counts: HashMap<i64, u32>,
    members: HashMap<i64, ThreadMember>,
    forum_parents: HashSet<i64>,
    tags: HashMap<i64, Vec<ForumTag>>,
}

pub async fn load_extras(state: &AppState, rows: &[ChannelRow], viewer: Option<i64>) -> ApiResult<Extras> {
    let mut extras = Extras::default();
    let thread_ids: Vec<i64> = rows.iter().filter(|row| row.is_thread()).map(|row| row.id).collect();
    let forum_ids: Vec<i64> = rows.iter().filter(|row| row.channel_type() == ChannelType::GuildForum).map(|row| row.id).collect();
    if !thread_ids.is_empty() {
        let counts: Vec<(i64, i64)> =
            sqlx::query_as("SELECT channel_id, count(*) FROM messages WHERE channel_id = ANY($1) AND kind IN (0, 19) AND id <> channel_id GROUP BY channel_id")
                .bind(&thread_ids)
                .fetch_all(&state.db)
                .await?;
        extras.message_counts = counts.into_iter().map(|(id, count)| (id, count.max(0) as u32)).collect();
        let counts: Vec<(i64, i64)> = sqlx::query_as("SELECT thread_id, count(*) FROM thread_members WHERE thread_id = ANY($1) GROUP BY thread_id")
            .bind(&thread_ids)
            .fetch_all(&state.db)
            .await?;
        extras.member_counts = counts.into_iter().map(|(id, count)| (id, count.max(0) as u32)).collect();
        if let Some(viewer) = viewer {
            extras.members = memberships(state, viewer, &thread_ids).await?;
        }
        let parents: Vec<i64> = rows.iter().filter(|row| row.is_thread()).filter_map(|row| row.parent_id).collect();
        let forums: Vec<(i64,)> = sqlx::query_as("SELECT id FROM channels WHERE id = ANY($1) AND kind = 15").bind(&parents).fetch_all(&state.db).await?;
        extras.forum_parents = forums.into_iter().map(|(id,)| id).collect();
    }
    if !forum_ids.is_empty() {
        extras.tags = tags_of(state, &forum_ids).await?;
    }
    Ok(extras)
}

/// The tags of the given forum channels in their display order.
pub async fn tags_of(state: &AppState, forum_ids: &[i64]) -> ApiResult<HashMap<i64, Vec<ForumTag>>> {
    type TagRow = (i64, i64, String, bool, Option<i64>, Option<String>);
    let rows: Vec<TagRow> = sqlx::query_as(
        "SELECT channel_id, id, name, moderated, emoji_id, emoji_name FROM forum_tags WHERE channel_id = ANY($1) ORDER BY channel_id, position, id",
    )
    .bind(forum_ids)
    .fetch_all(&state.db)
    .await?;
    let mut map: HashMap<i64, Vec<ForumTag>> = HashMap::new();
    for (channel_id, id, name, moderated, emoji_id, emoji_name) in rows {
        map.entry(channel_id).or_default().push(ForumTag { id: flake(id), name, moderated, emoji_id: emoji_id.map(flake), emoji_name });
    }
    Ok(map)
}

/// The thread / forum fields of a channel, computed before `channels_to_api` moves the row apart.
#[derive(Default)]
pub struct Decoration {
    owner_id: Option<Option<Snowflake>>,
    thread_metadata: Option<ThreadMetadata>,
    member_count: Option<u32>,
    message_count: Option<u32>,
    member: Option<ThreadMember>,
    applied_tags: Option<Vec<Snowflake>>,
    flags: Option<u32>,
    available_tags: Option<Vec<ForumTag>>,
    default_reaction_emoji: Option<DefaultReaction>,
    default_sort_order: Option<u32>,
    default_forum_layout: Option<u32>,
    default_auto_archive_duration: Option<u32>,
}

impl Decoration {
    pub fn apply(self, channel: &mut Channel) {
        if self.owner_id.is_some() {
            channel.owner_id = self.owner_id;
        }
        channel.thread_metadata = self.thread_metadata;
        channel.member_count = self.member_count;
        channel.message_count = self.message_count;
        channel.member = self.member;
        channel.applied_tags = self.applied_tags;
        channel.flags = self.flags;
        channel.available_tags = self.available_tags;
        channel.default_reaction_emoji = self.default_reaction_emoji;
        channel.default_sort_order = self.default_sort_order;
        channel.default_forum_layout = self.default_forum_layout;
        channel.default_auto_archive_duration = self.default_auto_archive_duration;
    }
}

pub fn decoration(row: &ChannelRow, extras: &mut Extras) -> Decoration {
    let mut decoration = Decoration::default();
    let kind = row.channel_type();
    if kind.is_thread() {
        let in_forum = row.parent_id.is_some_and(|parent| extras.forum_parents.contains(&parent));
        decoration.owner_id = Some(row.owner_id.map(flake));
        decoration.thread_metadata = Some(ThreadMetadata {
            archived: row.archived,
            auto_archive_duration: row.auto_archive_duration.unwrap_or(DEFAULT_AUTO_ARCHIVE_DURATION as i32).max(0) as u32,
            archive_timestamp: iso(row.archive_timestamp.unwrap_or(row.created_at)),
            locked: row.locked,
            invitable: (kind == ChannelType::PrivateThread).then_some(row.invitable),
            create_timestamp: Some(iso(row.created_at)),
        });
        decoration.message_count = Some(extras.message_counts.get(&row.id).copied().unwrap_or(0));
        decoration.member_count = Some(extras.member_counts.get(&row.id).copied().unwrap_or(0));
        decoration.member = extras.members.remove(&row.id);
        if in_forum {
            decoration.applied_tags = Some(row.applied_tags.iter().copied().map(flake).collect());
            decoration.flags = Some(row.flags.max(0) as u32);
        }
    } else if kind == ChannelType::GuildForum {
        decoration.available_tags = Some(extras.tags.remove(&row.id).unwrap_or_default());
        decoration.flags = Some(row.flags.max(0) as u32);
        decoration.default_reaction_emoji = (row.default_reaction_emoji_name.is_some() || row.default_reaction_emoji_id.is_some())
            .then(|| DefaultReaction { emoji_id: row.default_reaction_emoji_id.map(flake), emoji_name: row.default_reaction_emoji_name.clone() });
        decoration.default_sort_order = Some(row.default_sort_order.max(0) as u32);
        decoration.default_forum_layout = Some(row.default_forum_layout.max(0) as u32);
    }
    if matches!(kind, ChannelType::GuildText | ChannelType::GuildAnnouncement | ChannelType::GuildForum) {
        decoration.default_auto_archive_duration = Some(row.default_auto_archive_duration.unwrap_or(DEFAULT_AUTO_ARCHIVE_DURATION as i32).max(0) as u32);
    }
    decoration
}

/// The threads started from the given messages (thread id == message id, parent == the message's channel), by message id.
pub async fn started_threads(state: &AppState, rows: &[MessageRow], viewer: Option<i64>) -> ApiResult<HashMap<i64, Channel>> {
    let ids: Vec<i64> = rows.iter().map(|row| row.id).collect();
    let found: Vec<ChannelRow> =
        sqlx::query_as(&format!("SELECT {CHANNEL_COLS} FROM channels WHERE id = ANY($1) AND kind IN (10, 11)")).bind(&ids).fetch_all(&state.db).await?;
    if found.is_empty() {
        return Ok(HashMap::new());
    }
    let channel_of: HashMap<i64, i64> = rows.iter().map(|row| (row.id, row.channel_id)).collect();
    let started: Vec<ChannelRow> =
        found.into_iter().filter(|thread| thread.parent_id.is_some() && thread.parent_id == channel_of.get(&thread.id).copied()).collect();
    Ok(store::channels_to_api(state, started, viewer).await?.into_iter().map(|channel| (channel.id.db(), channel)).collect())
}

// ---- events ----

/// THREAD_CREATE / THREAD_UPDATE to everyone who sees the thread, with `member` filled for those who joined.
pub async fn dispatch(state: &AppState, row: &ChannelRow, event: &str, newly_created: bool) -> ApiResult<()> {
    let viewers = access::channel_viewers(state, row).await?;
    send_channel(state, row, &viewers, event, newly_created).await
}

async fn send_channel(state: &AppState, row: &ChannelRow, viewers: &[i64], event: &str, newly_created: bool) -> ApiResult<()> {
    let Some(mut channel) = store::channels_to_api(state, vec![row.clone()], None).await?.pop() else { return Ok(()) };
    channel.newly_created = newly_created.then_some(true);
    let members: HashMap<i64, ThreadMember> = members_of(state, row.id).await?.into_iter().map(|member| (member.user_id.db(), member)).collect();
    state.hub.send_with(viewers, event, |user| {
        let mut channel = channel.clone();
        channel.member = members.get(&user).cloned();
        serde_json::to_value(channel).unwrap_or_default()
    });
    Ok(())
}

fn delete_event(row: &ChannelRow) -> GatewayEvent {
    GatewayEvent::ThreadDelete(ThreadDelete {
        id: flake(row.id),
        guild_id: row.guild_id.map(flake).unwrap_or(Snowflake(0)),
        parent_id: row.parent_id.map(flake).unwrap_or(Snowflake(0)),
        kind: row.channel_type(),
    })
}

/// Adds `user_id` to a thread; false when they already were a member. The viewers get THREAD_MEMBERS_UPDATE, the user
/// THREAD_MEMBER_UPDATE (and THREAD_CREATE first when a private thread was invisible to them until now).
pub async fn add_member(state: &AppState, thread: &ChannelRow, user_id: i64) -> ApiResult<bool> {
    let private = thread.channel_type() == ChannelType::PrivateThread;
    let before = if private { access::channel_viewers(state, thread).await? } else { Vec::new() };
    let inserted = sqlx::query("INSERT INTO thread_members (thread_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING")
        .bind(thread.id)
        .bind(user_id)
        .execute(&state.db)
        .await?;
    if inserted.rows_affected() == 0 {
        return Ok(false);
    }
    let Some(member) = member(state, thread.id, user_id).await? else { return Ok(true) };
    let guild_id = thread.guild_id.map(flake).unwrap_or(Snowflake(0));
    if private && !before.contains(&user_id) {
        send_channel(state, thread, &[user_id], "THREAD_CREATE", false).await?;
    }
    state.hub.send(&[user_id], &GatewayEvent::ThreadMemberUpdate(ThreadMemberUpdate { member: member.clone(), guild_id }));
    let viewers = access::channel_viewers(state, thread).await?;
    let update = ThreadMembersUpdate {
        id: flake(thread.id),
        guild_id,
        member_count: member_count(state, thread.id).await?,
        added_members: Some(vec![member]),
        removed_member_ids: None,
    };
    state.hub.send(&viewers, &GatewayEvent::ThreadMembersUpdate(update));
    Ok(true)
}

/// Removes `user_id` from a thread; false when they were not a member. A user who loses sight of a private thread gets THREAD_DELETE.
pub async fn remove_member(state: &AppState, thread: &ChannelRow, user_id: i64) -> ApiResult<bool> {
    let before = access::channel_viewers(state, thread).await?;
    let removed = sqlx::query("DELETE FROM thread_members WHERE thread_id = $1 AND user_id = $2").bind(thread.id).bind(user_id).execute(&state.db).await?;
    if removed.rows_affected() == 0 {
        return Ok(false);
    }
    let guild_id = thread.guild_id.map(flake).unwrap_or(Snowflake(0));
    let update = ThreadMembersUpdate {
        id: flake(thread.id),
        guild_id,
        member_count: member_count(state, thread.id).await?,
        added_members: None,
        removed_member_ids: Some(vec![flake(user_id)]),
    };
    state.hub.send(&before, &GatewayEvent::ThreadMembersUpdate(update));
    if thread.channel_type() == ChannelType::PrivateThread {
        let after = access::channel_viewers(state, thread).await?;
        let lost: Vec<i64> = before.into_iter().filter(|user| !after.contains(user)).collect();
        state.hub.send(&lost, &delete_event(thread));
    }
    Ok(true)
}

// ---- lists ----

/// Unarchived threads of the guild that `user_id` can see: the parent is visible, and private ones need membership or MANAGE_THREADS.
pub async fn active_threads(state: &AppState, user_id: i64, guild_id: i64) -> ApiResult<Vec<ChannelRow>> {
    let parents: HashMap<i64, u64> =
        access::guild_channels_with_permissions(state, user_id, guild_id).await?.into_iter().map(|(row, permissions)| (row.id, permissions)).collect();
    let rows: Vec<ChannelRow> =
        sqlx::query_as(&format!("SELECT {CHANNEL_COLS} FROM channels WHERE guild_id = $1 AND kind IN (10, 11, 12) AND NOT archived ORDER BY id DESC"))
            .bind(guild_id)
            .fetch_all(&state.db)
            .await?;
    let ids: Vec<i64> = rows.iter().map(|row| row.id).collect();
    let joined = memberships(state, user_id, &ids).await?;
    Ok(rows
        .into_iter()
        .filter(|row| {
            let permissions = row.parent_id.and_then(|parent| parents.get(&parent)).copied().unwrap_or(0);
            permissions & vokko_protocol::api::permissions::VIEW_CHANNEL != 0
                && (row.channel_type() != ChannelType::PrivateThread || permissions & MANAGE_THREADS != 0 || joined.contains_key(&row.id))
        })
        .collect())
}

/// Threads as a list response: the wire channels plus the caller's memberships among them.
pub async fn thread_list(state: &AppState, user_id: i64, rows: Vec<ChannelRow>, has_more: bool) -> ApiResult<vokko_protocol::api::ThreadListResponse> {
    let ids: Vec<i64> = rows.iter().map(|row| row.id).collect();
    let mut joined = memberships(state, user_id, &ids).await?;
    let members = ids.iter().filter_map(|id| joined.remove(id)).collect();
    let threads = store::channels_to_api(state, rows, Some(user_id)).await?;
    Ok(vokko_protocol::api::ThreadListResponse { threads, members, has_more })
}

// ---- deletion ----

/// Deletes threads (messages, members and read states cascade), announcing THREAD_DELETE to their viewers. With `refresh_starters`
/// the parent's starter messages are re-sent without their `thread`; a parent that is being deleted skips that.
pub async fn delete_threads(state: &AppState, rows: Vec<ChannelRow>, refresh_starters: bool) -> ApiResult<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let mut audiences = Vec::with_capacity(rows.len());
    for row in &rows {
        audiences.push(access::channel_viewers(state, row).await?);
    }
    let ids: Vec<i64> = rows.iter().map(|row| row.id).collect();
    let attachments: Vec<(i64,)> = sqlx::query_as("DELETE FROM attachments WHERE channel_id = ANY($1) RETURNING id").bind(&ids).fetch_all(&state.db).await?;
    sqlx::query("DELETE FROM channels WHERE id = ANY($1)").bind(&ids).execute(&state.db).await?;
    crate::media::remove_files(state, &attachments.into_iter().map(|(id,)| id).collect::<Vec<_>>()).await;
    for (row, viewers) in rows.iter().zip(&audiences) {
        state.hub.send(viewers, &delete_event(row));
    }
    if refresh_starters {
        for row in &rows {
            let Some(parent_id) = row.parent_id else { continue };
            let starter: Option<(i64,)> =
                sqlx::query_as("SELECT id FROM messages WHERE id = $1 AND channel_id = $2").bind(row.id).bind(parent_id).fetch_optional(&state.db).await?;
            if starter.is_some()
                && let Some(parent) = store::channel_row(state, parent_id).await?
            {
                crate::routes::messages::broadcast_update(state, &parent, row.id).await?;
            }
        }
    }
    Ok(())
}

/// Deletes every thread of a channel that is going away.
pub async fn delete_children(state: &AppState, parent_id: i64) -> ApiResult<()> {
    let rows: Vec<ChannelRow> = sqlx::query_as(&format!("SELECT {CHANNEL_COLS} FROM channels WHERE parent_id = $1 AND kind IN (10, 11, 12) ORDER BY id"))
        .bind(parent_id)
        .fetch_all(&state.db)
        .await?;
    delete_threads(state, rows, false).await
}

// ---- auto-archive ----

/// Archives open threads that had no activity for their `auto_archive_duration`; THREAD_UPDATE for each. Returns how many.
pub async fn sweep_archived(state: &AppState) -> ApiResult<usize> {
    let archived: Vec<(i64,)> = sqlx::query_as(
        "UPDATE channels SET archived = TRUE, archive_timestamp = now() \
         WHERE kind IN (10, 11, 12) AND NOT archived \
           AND COALESCE(last_activity_at, created_at) + COALESCE(auto_archive_duration, 1440) * interval '1 minute' < now() \
         RETURNING id",
    )
    .fetch_all(&state.db)
    .await?;
    for (id,) in &archived {
        if let Some(row) = store::channel_row(state, *id).await? {
            dispatch(state, &row, "THREAD_UPDATE", false).await?;
        }
    }
    Ok(archived.len())
}

/// Runs `sweep_archived` every minute; the task ends with the runtime.
pub fn spawn_sweeper(state: AppState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(SWEEP_INTERVAL);
        loop {
            interval.tick().await;
            match sweep_archived(&state).await {
                Ok(0) => {}
                Ok(count) => tracing::info!("archived {count} inactive threads"),
                Err(error) => tracing::warn!("thread sweep failed: {error:?}"),
            }
        }
    });
}
