//! Row types and loaders that turn database rows into wire types.
use std::collections::HashMap;

use sqlx::FromRow;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use vokko_protocol::api::{
    Attachment, Channel, ChannelType, Guild, GuildMember, Message, MessageMember, MessageReference, MessageType, Reaction, ReactionEmoji, Role, Snowflake, User,
};

use crate::error::ApiResult;
use crate::state::AppState;

pub fn iso(time: OffsetDateTime) -> String {
    time.format(&Rfc3339).unwrap_or_default()
}

fn flake(id: i64) -> Snowflake {
    Snowflake::from(id)
}

// ---- users ----

#[derive(FromRow)]
pub struct UserRow {
    pub id: i64,
    pub username: String,
    pub global_name: Option<String>,
    pub avatar_path: Option<String>,
    pub banner_color: Option<String>,
    pub bio: Option<String>,
    pub bot: bool,
}

pub const USER_COLS: &str = "id, username, global_name, avatar_path, banner_color, bio, bot";

impl UserRow {
    pub fn into_api(self, state: &AppState) -> User {
        User {
            id: flake(self.id),
            username: self.username,
            global_name: self.global_name,
            avatar: self.avatar_path.map(|path| state.asset_url(&path)),
            banner_color: self.banner_color,
            bio: self.bio,
            bot: self.bot,
        }
    }
}

pub async fn user(state: &AppState, id: i64) -> ApiResult<Option<User>> {
    let row: Option<UserRow> = sqlx::query_as(&format!("SELECT {USER_COLS} FROM users WHERE id = $1")).bind(id).fetch_optional(&state.db).await?;
    Ok(row.map(|row| row.into_api(state)))
}

pub async fn users(state: &AppState, ids: &[i64]) -> ApiResult<HashMap<i64, User>> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<UserRow> = sqlx::query_as(&format!("SELECT {USER_COLS} FROM users WHERE id = ANY($1)")).bind(ids).fetch_all(&state.db).await?;
    Ok(rows.into_iter().map(|row| (row.id, row.into_api(state))).collect())
}

// ---- guilds ----

#[derive(FromRow)]
struct RoleRow {
    id: i64,
    guild_id: i64,
    name: String,
    color: i32,
    hoist: bool,
    position: i32,
    permissions: i64,
    mentionable: bool,
}

#[derive(FromRow)]
pub struct GuildRow {
    pub id: i64,
    pub name: String,
    pub icon_path: Option<String>,
    pub owner_id: i64,
    pub system_channel_id: Option<i64>,
}

pub const GUILD_COLS: &str = "id, name, icon_path, owner_id, system_channel_id";

pub async fn guilds_from_rows(state: &AppState, rows: Vec<GuildRow>) -> ApiResult<Vec<Guild>> {
    let ids: Vec<i64> = rows.iter().map(|row| row.id).collect();
    let roles: Vec<RoleRow> =
        sqlx::query_as("SELECT id, guild_id, name, color, hoist, position, permissions, mentionable FROM roles WHERE guild_id = ANY($1) ORDER BY position, id")
            .bind(&ids)
            .fetch_all(&state.db)
            .await?;
    let mut by_guild: HashMap<i64, Vec<Role>> = HashMap::new();
    for role in roles {
        by_guild.entry(role.guild_id).or_default().push(Role {
            id: flake(role.id),
            name: role.name,
            color: role.color.max(0) as u32,
            hoist: role.hoist,
            position: role.position,
            permissions: (role.permissions as u64).to_string(),
            mentionable: role.mentionable,
        });
    }
    Ok(rows
        .into_iter()
        .map(|row| Guild {
            id: flake(row.id),
            name: row.name,
            icon: row.icon_path.map(|path| state.asset_url(&path)),
            owner_id: flake(row.owner_id),
            roles: by_guild.remove(&row.id).unwrap_or_default(),
            system_channel_id: row.system_channel_id.map(flake),
        })
        .collect())
}

pub async fn guild(state: &AppState, id: i64) -> ApiResult<Option<Guild>> {
    let row: Option<GuildRow> = sqlx::query_as(&format!("SELECT {GUILD_COLS} FROM guilds WHERE id = $1")).bind(id).fetch_optional(&state.db).await?;
    match row {
        Some(row) => Ok(guilds_from_rows(state, vec![row]).await?.pop()),
        None => Ok(None),
    }
}

pub async fn guilds_of_user(state: &AppState, user_id: i64) -> ApiResult<Vec<Guild>> {
    let rows: Vec<GuildRow> = sqlx::query_as(
        "SELECT g.id, g.name, g.icon_path, g.owner_id, g.system_channel_id FROM guilds g JOIN guild_members m ON m.guild_id = g.id WHERE m.user_id = $1 ORDER BY m.joined_at, g.id",
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;
    guilds_from_rows(state, rows).await
}

#[derive(FromRow)]
struct MemberRow {
    #[sqlx(flatten)]
    user: UserRow,
    nick: Option<String>,
    joined_at: OffsetDateTime,
}

pub async fn members(state: &AppState, guild_id: i64, limit: i64, after: Option<i64>) -> ApiResult<Vec<GuildMember>> {
    let rows: Vec<MemberRow> = sqlx::query_as(
        "SELECT u.id, u.username, u.global_name, u.avatar_path, u.banner_color, u.bio, u.bot, m.nick, m.joined_at \
         FROM guild_members m JOIN users u ON u.id = m.user_id WHERE m.guild_id = $1 AND u.id > $2 ORDER BY u.id LIMIT $3",
    )
    .bind(guild_id)
    .bind(after.unwrap_or(0))
    .bind(limit)
    .fetch_all(&state.db)
    .await?;
    let ids: Vec<i64> = rows.iter().map(|row| row.user.id).collect();
    let roles = member_roles(state, guild_id, &ids).await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let id = row.user.id;
            GuildMember { user: row.user.into_api(state), nick: row.nick, roles: roles.get(&id).cloned().unwrap_or_default(), joined_at: iso(row.joined_at) }
        })
        .collect())
}

pub async fn member(state: &AppState, guild_id: i64, user_id: i64) -> ApiResult<Option<GuildMember>> {
    let rows: Vec<MemberRow> = sqlx::query_as(
        "SELECT u.id, u.username, u.global_name, u.avatar_path, u.banner_color, u.bio, u.bot, m.nick, m.joined_at \
         FROM guild_members m JOIN users u ON u.id = m.user_id WHERE m.guild_id = $1 AND u.id = $2",
    )
    .bind(guild_id)
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;
    let roles = member_roles(state, guild_id, &[user_id]).await?;
    Ok(rows.into_iter().next().map(|row| {
        let id = row.user.id;
        GuildMember { user: row.user.into_api(state), nick: row.nick, roles: roles.get(&id).cloned().unwrap_or_default(), joined_at: iso(row.joined_at) }
    }))
}

pub async fn member_roles(state: &AppState, guild_id: i64, user_ids: &[i64]) -> ApiResult<HashMap<i64, Vec<Snowflake>>> {
    let rows: Vec<(i64, i64)> = sqlx::query_as("SELECT user_id, role_id FROM member_roles WHERE guild_id = $1 AND user_id = ANY($2) ORDER BY role_id")
        .bind(guild_id)
        .bind(user_ids)
        .fetch_all(&state.db)
        .await?;
    let mut map: HashMap<i64, Vec<Snowflake>> = HashMap::new();
    for (user_id, role_id) in rows {
        map.entry(user_id).or_default().push(flake(role_id));
    }
    Ok(map)
}

pub async fn member_count(state: &AppState, guild_id: i64) -> ApiResult<u32> {
    let (count,): (i64,) = sqlx::query_as("SELECT count(*) FROM guild_members WHERE guild_id = $1").bind(guild_id).fetch_one(&state.db).await?;
    Ok(count.max(0) as u32)
}

// ---- channels ----

#[derive(FromRow, Clone, Debug)]
pub struct ChannelRow {
    pub id: i64,
    pub kind: i16,
    pub guild_id: Option<i64>,
    pub name: Option<String>,
    pub topic: Option<String>,
    pub position: i32,
    pub parent_id: Option<i64>,
    pub owner_id: Option<i64>,
    pub icon_path: Option<String>,
    pub last_message_id: Option<i64>,
}

pub const CHANNEL_COLS: &str = "id, kind, guild_id, name, topic, position, parent_id, owner_id, icon_path, last_message_id";

impl ChannelRow {
    pub fn channel_type(&self) -> ChannelType {
        ChannelType::from_u8(self.kind as u8).unwrap_or(ChannelType::GuildText)
    }

    pub fn is_dm(&self) -> bool {
        matches!(self.channel_type(), ChannelType::Dm | ChannelType::GroupDm)
    }
}

pub async fn channel_row(state: &AppState, id: i64) -> ApiResult<Option<ChannelRow>> {
    Ok(sqlx::query_as(&format!("SELECT {CHANNEL_COLS} FROM channels WHERE id = $1")).bind(id).fetch_optional(&state.db).await?)
}

/// `viewer` is excluded from DM recipient lists.
pub async fn channels_to_api(state: &AppState, rows: Vec<ChannelRow>, viewer: Option<i64>) -> ApiResult<Vec<Channel>> {
    let dm_ids: Vec<i64> = rows.iter().filter(|row| row.is_dm()).map(|row| row.id).collect();
    let mut recipients: HashMap<i64, Vec<User>> = HashMap::new();
    if !dm_ids.is_empty() {
        let found: Vec<(i64, i64)> =
            sqlx::query_as("SELECT channel_id, user_id FROM channel_recipients WHERE channel_id = ANY($1) AND user_id <> $2 ORDER BY user_id")
                .bind(&dm_ids)
                .bind(viewer.unwrap_or(0))
                .fetch_all(&state.db)
                .await?;
        let user_ids: Vec<i64> = found.iter().map(|(_, user_id)| *user_id).collect();
        let lookup = users(state, &user_ids).await?;
        for (channel_id, user_id) in found {
            if let Some(user) = lookup.get(&user_id) {
                recipients.entry(channel_id).or_default().push(user.clone());
            }
        }
    }
    Ok(rows
        .into_iter()
        .map(|row| {
            let kind = row.channel_type();
            let is_dm = row.is_dm();
            Channel {
                id: flake(row.id),
                kind,
                guild_id: row.guild_id.map(flake),
                name: row.name,
                topic: row.topic,
                position: row.position,
                parent_id: row.parent_id.map(flake),
                recipients: is_dm.then(|| recipients.remove(&row.id).unwrap_or_default()),
                last_message_id: row.last_message_id.map(flake),
                owner_id: (kind == ChannelType::GroupDm).then_some(row.owner_id.map(flake)),
                icon: (kind == ChannelType::GroupDm).then(|| row.icon_path.map(|path| state.asset_url(&path))),
            }
        })
        .collect())
}

pub async fn channel(state: &AppState, id: i64, viewer: Option<i64>) -> ApiResult<Option<Channel>> {
    match channel_row(state, id).await? {
        Some(row) => Ok(channels_to_api(state, vec![row], viewer).await?.pop()),
        None => Ok(None),
    }
}

// ---- messages ----

#[derive(FromRow, Clone)]
pub struct MessageRow {
    pub id: i64,
    pub channel_id: i64,
    pub guild_id: Option<i64>,
    pub author_id: i64,
    pub content: String,
    pub kind: i16,
    pub pinned: bool,
    pub reference_message_id: Option<i64>,
    pub mention_everyone: bool,
    pub created_at: OffsetDateTime,
    pub edited_at: Option<OffsetDateTime>,
    /// JSON array of `Embed`.
    pub embeds: String,
    pub flags: i32,
}

pub const MESSAGE_SELECT: &str = "SELECT m.id, m.channel_id, c.guild_id, m.author_id, m.content, m.kind, m.pinned, m.reference_message_id, m.mention_everyone, \
     m.created_at, m.edited_at, m.embeds::text AS embeds, m.flags FROM messages m JOIN channels c ON c.id = m.channel_id";

#[derive(FromRow)]
struct AttachmentRow {
    id: i64,
    message_id: i64,
    filename: String,
    content_type: Option<String>,
    size: i64,
    width: Option<i32>,
    height: Option<i32>,
}

pub fn attachment_api(
    state: &AppState,
    id: i64,
    filename: String,
    content_type: Option<String>,
    size: i64,
    width: Option<i32>,
    height: Option<i32>,
) -> Attachment {
    Attachment {
        id: flake(id),
        url: state.asset_url(&format!("{id}/{filename}")),
        filename,
        content_type,
        size: size.max(0) as u64,
        width: width.map(|value| value.max(0) as u32),
        height: height.map(|value| value.max(0) as u32),
    }
}

/// A message plus who reacted with what, so `Reaction.me` can be filled in per viewer (REST and gateway fan-out).
pub struct MessageView {
    pub message: Message,
    reaction_users: Vec<Vec<i64>>,
}

impl MessageView {
    pub fn for_viewer(&self, viewer: i64) -> Message {
        let mut message = self.message.clone();
        for (reaction, users) in message.reactions.iter_mut().zip(&self.reaction_users) {
            reaction.me = users.contains(&viewer);
        }
        message
    }
}

fn kind_of(value: i16) -> MessageType {
    MessageType::from_u8(value as u8).unwrap_or(MessageType::Default)
}

/// Loads author, mentions, attachments, reactions and member info; no reply targets.
async fn load_flat(state: &AppState, rows: &[MessageRow], viewer: Option<i64>) -> ApiResult<Vec<MessageView>> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<i64> = rows.iter().map(|row| row.id).collect();

    let mention_rows: Vec<(i64, i64)> =
        sqlx::query_as("SELECT message_id, user_id FROM message_mentions WHERE message_id = ANY($1) ORDER BY user_id").bind(&ids).fetch_all(&state.db).await?;
    let attachment_rows: Vec<AttachmentRow> =
        sqlx::query_as("SELECT id, message_id, filename, content_type, size, width, height FROM attachments WHERE message_id = ANY($1) ORDER BY id")
            .bind(&ids)
            .fetch_all(&state.db)
            .await?;
    let reaction_rows: Vec<(i64, String, i64, i64)> =
        sqlx::query_as("SELECT message_id, emoji_name, emoji_id, user_id FROM reactions WHERE message_id = ANY($1) ORDER BY created_at, user_id")
            .bind(&ids)
            .fetch_all(&state.db)
            .await?;

    let mut user_ids: Vec<i64> = rows.iter().map(|row| row.author_id).chain(mention_rows.iter().map(|(_, user_id)| *user_id)).collect();
    user_ids.sort_unstable();
    user_ids.dedup();
    let lookup = users(state, &user_ids).await?;

    let mut mentions: HashMap<i64, Vec<User>> = HashMap::new();
    for (message_id, user_id) in mention_rows {
        if let Some(user) = lookup.get(&user_id) {
            mentions.entry(message_id).or_default().push(user.clone());
        }
    }
    let mut attachments: HashMap<i64, Vec<Attachment>> = HashMap::new();
    for row in attachment_rows {
        attachments.entry(row.message_id).or_default().push(attachment_api(state, row.id, row.filename, row.content_type, row.size, row.width, row.height));
    }
    // message → ordered (emoji, users)
    let mut reactions: HashMap<i64, Vec<(ReactionEmoji, Vec<i64>)>> = HashMap::new();
    for (message_id, name, emoji_id, user_id) in reaction_rows {
        let emoji = ReactionEmoji { id: (emoji_id != 0).then(|| flake(emoji_id)), name };
        let list = reactions.entry(message_id).or_default();
        match list.iter_mut().find(|(existing, _)| *existing == emoji) {
            Some((_, users)) => users.push(user_id),
            None => list.push((emoji, vec![user_id])),
        }
    }

    // member info (nick + roles) for guild messages
    let mut member_info: HashMap<(i64, i64), MessageMember> = HashMap::new();
    let mut guild_ids: Vec<i64> = rows.iter().filter_map(|row| row.guild_id).collect();
    guild_ids.sort_unstable();
    guild_ids.dedup();
    for guild_id in guild_ids {
        let authors: Vec<i64> = rows.iter().filter(|row| row.guild_id == Some(guild_id)).map(|row| row.author_id).collect();
        let nicks: Vec<(i64, Option<String>)> = sqlx::query_as("SELECT user_id, nick FROM guild_members WHERE guild_id = $1 AND user_id = ANY($2)")
            .bind(guild_id)
            .bind(&authors)
            .fetch_all(&state.db)
            .await?;
        let roles = member_roles(state, guild_id, &authors).await?;
        for (user_id, nick) in nicks {
            member_info.insert((guild_id, user_id), MessageMember { nick, roles: roles.get(&user_id).cloned().unwrap_or_default() });
        }
    }

    let mut views = Vec::with_capacity(rows.len());
    for row in rows {
        let Some(author) = lookup.get(&row.author_id).cloned() else { continue };
        let raw = reactions.remove(&row.id).unwrap_or_default();
        let reaction_users: Vec<Vec<i64>> = raw.iter().map(|(_, users)| users.clone()).collect();
        let reactions_api: Vec<Reaction> = raw
            .into_iter()
            .map(|(emoji, users)| Reaction { emoji, count: users.len() as u32, me: viewer.is_some_and(|viewer| users.contains(&viewer)) })
            .collect();
        let message = Message {
            id: flake(row.id),
            channel_id: flake(row.channel_id),
            guild_id: row.guild_id.map(flake),
            author,
            member: row.guild_id.and_then(|guild_id| member_info.get(&(guild_id, row.author_id)).cloned()),
            content: row.content.clone(),
            timestamp: iso(row.created_at),
            edited_timestamp: row.edited_at.map(iso),
            kind: kind_of(row.kind),
            mentions: mentions.remove(&row.id).unwrap_or_default(),
            mention_everyone: row.mention_everyone,
            attachments: attachments.remove(&row.id).unwrap_or_default(),
            embeds: serde_json::from_str(&row.embeds).unwrap_or_default(),
            reactions: reactions_api,
            pinned: row.pinned,
            message_reference: row.reference_message_id.map(|message_id| MessageReference {
                message_id: flake(message_id),
                channel_id: flake(row.channel_id),
                guild_id: row.guild_id.map(flake),
            }),
            referenced_message: None,
            nonce: None,
        };
        views.push(MessageView { message, reaction_users });
    }
    Ok(views)
}

/// Full messages including one level of `referenced_message` (its own reactions are always empty).
pub async fn load_messages(state: &AppState, rows: Vec<MessageRow>, viewer: Option<i64>) -> ApiResult<Vec<MessageView>> {
    let mut views = load_flat(state, &rows, viewer).await?;
    let mut reference_ids: Vec<i64> = rows.iter().filter_map(|row| row.reference_message_id).collect();
    reference_ids.sort_unstable();
    reference_ids.dedup();
    if reference_ids.is_empty() {
        return Ok(views);
    }
    let referenced_rows: Vec<MessageRow> = sqlx::query_as(&format!("{MESSAGE_SELECT} WHERE m.id = ANY($1)")).bind(&reference_ids).fetch_all(&state.db).await?;
    let mut referenced: HashMap<i64, Message> = HashMap::new();
    for view in load_flat(state, &referenced_rows, None).await? {
        let mut message = view.message;
        message.reactions.clear();
        referenced.insert(message.id.db(), message);
    }
    for view in &mut views {
        if let Some(reference) = &view.message.message_reference {
            view.message.referenced_message = referenced.get(&reference.message_id.db()).cloned().map(Box::new);
        }
    }
    Ok(views)
}

pub async fn message_view(state: &AppState, id: i64, viewer: Option<i64>) -> ApiResult<Option<MessageView>> {
    let row: Option<MessageRow> = sqlx::query_as(&format!("{MESSAGE_SELECT} WHERE m.id = $1")).bind(id).fetch_optional(&state.db).await?;
    match row {
        Some(row) => Ok(load_messages(state, vec![row], viewer).await?.pop()),
        None => Ok(None),
    }
}
