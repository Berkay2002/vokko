//! Row types and loaders that turn database rows into wire types.
use std::collections::HashMap;

use sqlx::FromRow;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use vokko_protocol::api::{
    Attachment, Channel, ChannelType, ExplicitContentFilter, Guild, GuildMember, GuildTag, GuildTheme, Message, MessageCall, MessageMember,
    MessageReference, MessageReferenceType, MessageSnapshot, MessageType, OverwriteType, PermissionOverwrite, Reaction, ReactionEmoji, Role, Snowflake,
    StickerFormat, StickerItem, User, UserPrimaryGuild, VerificationLevel,
};

use crate::error::ApiResult;
use crate::state::AppState;
use crate::threads;

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
    pub banner_path: Option<String>,
    pub pronouns: Option<String>,
    pub theme_primary: Option<i32>,
    pub theme_accent: Option<i32>,
    pub avatar_decoration: Option<String>,
    pub profile_effect: Option<String>,
    /// The adopted server tag, present only while the user still belongs to a guild that has one.
    pub tag_guild_id: Option<i64>,
    pub tag_text: Option<String>,
    pub tag_badge: Option<String>,
    pub tag_color_primary: Option<i32>,
    pub tag_color_secondary: Option<i32>,
}

/// Columns of [`UserRow`]; select them `FROM {USER_FROM}` (aliases `u` and `pg`).
pub const USER_COLS: &str = "u.id, u.username, u.global_name, u.avatar_path, u.banner_color, u.bio, u.bot, u.banner_path, u.pronouns, u.theme_primary, \
     u.theme_accent, u.avatar_decoration, u.profile_effect, pg.id AS tag_guild_id, pg.tag AS tag_text, pg.tag_badge, pg.tag_color_primary, \
     pg.tag_color_secondary";

/// `users u` joined to the guild whose tag the user adopted, while they still belong to it and it still has a tag.
pub const USER_FROM: &str = "users u LEFT JOIN guilds pg ON pg.id = u.primary_guild_id AND pg.tag IS NOT NULL \
     AND EXISTS (SELECT 1 FROM guild_members pm WHERE pm.guild_id = pg.id AND pm.user_id = u.id)";

fn theme_colors(primary: Option<i32>, accent: Option<i32>) -> Option<[u32; 2]> {
    Some([primary?.max(0) as u32, accent?.max(0) as u32])
}

impl UserRow {
    pub fn into_api(self, state: &AppState) -> User {
        let primary_guild = match (self.tag_guild_id, self.tag_text, self.tag_badge, self.tag_color_primary, self.tag_color_secondary) {
            (Some(guild_id), Some(tag), Some(badge), Some(color_primary), Some(color_secondary)) => Some(UserPrimaryGuild {
                guild_id: flake(guild_id),
                tag,
                badge,
                color_primary: color_primary.max(0) as u32,
                color_secondary: color_secondary.max(0) as u32,
            }),
            _ => None,
        };
        User {
            id: flake(self.id),
            username: self.username,
            global_name: self.global_name,
            avatar: self.avatar_path.map(|path| state.asset_url(&path)),
            banner_color: self.banner_color,
            bio: self.bio,
            bot: self.bot,
            banner: self.banner_path.map(|path| state.asset_url(&path)),
            pronouns: self.pronouns,
            theme_colors: theme_colors(self.theme_primary, self.theme_accent),
            avatar_decoration: self.avatar_decoration,
            profile_effect: self.profile_effect,
            primary_guild,
        }
    }
}

pub async fn user(state: &AppState, id: i64) -> ApiResult<Option<User>> {
    let row: Option<UserRow> = sqlx::query_as(&format!("SELECT {USER_COLS} FROM {USER_FROM} WHERE u.id = $1")).bind(id).fetch_optional(&state.db).await?;
    Ok(row.map(|row| row.into_api(state)))
}

pub async fn users(state: &AppState, ids: &[i64]) -> ApiResult<HashMap<i64, User>> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<UserRow> = sqlx::query_as(&format!("SELECT {USER_COLS} FROM {USER_FROM} WHERE u.id = ANY($1)")).bind(ids).fetch_all(&state.db).await?;
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
    unicode_emoji: Option<String>,
}

#[derive(FromRow)]
pub struct GuildRow {
    pub id: i64,
    pub name: String,
    pub icon_path: Option<String>,
    pub owner_id: i64,
    pub system_channel_id: Option<i64>,
    pub tag: Option<String>,
    pub tag_badge: Option<String>,
    pub tag_color_primary: Option<i32>,
    pub tag_color_secondary: Option<i32>,
    pub theme_preset: Option<String>,
    pub theme_primary: Option<i32>,
    pub theme_accent: Option<i32>,
    pub verification_level: i16,
    pub explicit_content_filter: i16,
}

pub const GUILD_COLS: &str = "id, name, icon_path, owner_id, system_channel_id, tag, tag_badge, tag_color_primary, tag_color_secondary, theme_preset, \
     theme_primary, theme_accent, verification_level, explicit_content_filter";

pub async fn guilds_from_rows(state: &AppState, rows: Vec<GuildRow>) -> ApiResult<Vec<Guild>> {
    let ids: Vec<i64> = rows.iter().map(|row| row.id).collect();
    let roles: Vec<RoleRow> = sqlx::query_as(
        "SELECT id, guild_id, name, color, hoist, position, permissions, mentionable, unicode_emoji FROM roles WHERE guild_id = ANY($1) ORDER BY position, id",
    )
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
            unicode_emoji: role.unicode_emoji,
        });
    }
    Ok(rows
        .into_iter()
        .map(|row| {
            let tag = match (row.tag, row.tag_badge, row.tag_color_primary, row.tag_color_secondary) {
                (Some(tag), Some(badge), Some(primary), Some(secondary)) => {
                    Some(GuildTag { tag, badge, color_primary: primary.max(0) as u32, color_secondary: secondary.max(0) as u32 })
                }
                _ => None,
            };
            let theme = match (row.theme_primary, row.theme_accent) {
                (Some(primary), Some(accent)) => Some(GuildTheme { preset: row.theme_preset, primary: primary.max(0) as u32, accent: accent.max(0) as u32 }),
                _ => None,
            };
            Guild {
                id: flake(row.id),
                name: row.name,
                icon: row.icon_path.map(|path| state.asset_url(&path)),
                owner_id: flake(row.owner_id),
                roles: by_guild.remove(&row.id).unwrap_or_default(),
                system_channel_id: row.system_channel_id.map(flake),
                tag,
                theme,
                verification_level: VerificationLevel::from_u8(row.verification_level as u8).unwrap_or_default(),
                explicit_content_filter: ExplicitContentFilter::from_u8(row.explicit_content_filter as u8).unwrap_or_default(),
            }
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
        "SELECT g.id, g.name, g.icon_path, g.owner_id, g.system_channel_id, g.tag, g.tag_badge, g.tag_color_primary, g.tag_color_secondary, g.theme_preset, \
         g.theme_primary, g.theme_accent, g.verification_level, g.explicit_content_filter FROM guilds g JOIN guild_members m ON m.guild_id = g.id WHERE m.user_id = $1 ORDER BY m.joined_at, g.id",
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
    timeout_until: Option<OffsetDateTime>,
    member_avatar_path: Option<String>,
    member_banner_path: Option<String>,
    member_bio: Option<String>,
    member_pronouns: Option<String>,
    member_theme_primary: Option<i32>,
    member_theme_accent: Option<i32>,
    member_mute: bool,
    member_deaf: bool,
    flags: i32,
}

/// Member columns after [`USER_COLS`] (alias `m` = `guild_members`).
const MEMBER_COLS: &str = "m.nick, m.joined_at, m.timeout_until, m.avatar_path AS member_avatar_path, m.banner_path AS member_banner_path, \
     m.bio AS member_bio, m.pronouns AS member_pronouns, m.theme_primary AS member_theme_primary, m.theme_accent AS member_theme_accent, m.flags, \
     m.mute AS member_mute, m.deaf AS member_deaf";

impl MemberRow {
    fn into_api(self, state: &AppState, roles: Vec<Snowflake>) -> GuildMember {
        // an expired timeout reads as none
        let timeout = self.timeout_until.filter(|until| *until > OffsetDateTime::now_utc());
        GuildMember {
            user: self.user.into_api(state),
            nick: self.nick,
            roles,
            joined_at: iso(self.joined_at),
            communication_disabled_until: timeout.map(iso),
            avatar: self.member_avatar_path.map(|path| state.asset_url(&path)),
            banner: self.member_banner_path.map(|path| state.asset_url(&path)),
            bio: self.member_bio,
            pronouns: self.member_pronouns,
            theme_colors: theme_colors(self.member_theme_primary, self.member_theme_accent),
            mute: self.member_mute,
            deaf: self.member_deaf,
            flags: self.flags.max(0) as u32,
        }
    }
}

pub async fn members(state: &AppState, guild_id: i64, limit: i64, after: Option<i64>) -> ApiResult<Vec<GuildMember>> {
    let rows: Vec<MemberRow> = sqlx::query_as(&format!(
        "SELECT {USER_COLS}, {MEMBER_COLS} FROM guild_members m JOIN {USER_FROM} ON u.id = m.user_id WHERE m.guild_id = $1 AND u.id > $2 ORDER BY u.id LIMIT $3"
    ))
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
            let member_roles = roles.get(&row.user.id).cloned().unwrap_or_default();
            row.into_api(state, member_roles)
        })
        .collect())
}

pub async fn member(state: &AppState, guild_id: i64, user_id: i64) -> ApiResult<Option<GuildMember>> {
    let rows: Vec<MemberRow> = sqlx::query_as(&format!(
        "SELECT {USER_COLS}, {MEMBER_COLS} FROM guild_members m JOIN {USER_FROM} ON u.id = m.user_id WHERE m.guild_id = $1 AND u.id = $2"
    ))
    .bind(guild_id)
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;
    let roles = member_roles(state, guild_id, &[user_id]).await?;
    Ok(rows.into_iter().next().map(|row| {
        let member_roles = roles.get(&row.user.id).cloned().unwrap_or_default();
        row.into_api(state, member_roles)
    }))
}

/// Several members of a guild in two queries, keyed by user id.
pub async fn members_by_ids(state: &AppState, guild_id: i64, user_ids: &[i64]) -> ApiResult<HashMap<i64, GuildMember>> {
    let rows: Vec<MemberRow> = sqlx::query_as(&format!(
        "SELECT {USER_COLS}, {MEMBER_COLS} FROM guild_members m JOIN {USER_FROM} ON u.id = m.user_id WHERE m.guild_id = $1 AND u.id = ANY($2)"
    ))
    .bind(guild_id)
    .bind(user_ids)
    .fetch_all(&state.db)
    .await?;
    let roles = member_roles(state, guild_id, user_ids).await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let id = row.user.id;
            (id, row.into_api(state, roles.get(&id).cloned().unwrap_or_default()))
        })
        .collect())
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
    pub bitrate: Option<i32>,
    pub user_limit: Option<i32>,
    pub voice_status: Option<String>,
    pub archived: bool,
    pub locked: bool,
    pub invitable: bool,
    pub auto_archive_duration: Option<i32>,
    pub default_auto_archive_duration: Option<i32>,
    pub archive_timestamp: Option<OffsetDateTime>,
    pub last_activity_at: Option<OffsetDateTime>,
    pub flags: i32,
    pub applied_tags: Vec<i64>,
    pub default_reaction_emoji_id: Option<i64>,
    pub default_reaction_emoji_name: Option<String>,
    pub default_sort_order: i32,
    pub default_forum_layout: i32,
    pub created_at: OffsetDateTime,
}

pub const CHANNEL_COLS: &str = "id, kind, guild_id, name, topic, position, parent_id, owner_id, icon_path, last_message_id, archived, locked, invitable, \
     auto_archive_duration, default_auto_archive_duration, archive_timestamp, last_activity_at, flags, applied_tags, default_reaction_emoji_id, \
     default_reaction_emoji_name, default_sort_order, default_forum_layout, created_at, bitrate, user_limit, voice_status";

impl ChannelRow {
    pub fn channel_type(&self) -> ChannelType {
        ChannelType::from_u8(self.kind as u8).unwrap_or(ChannelType::GuildText)
    }

    pub fn is_dm(&self) -> bool {
        matches!(self.channel_type(), ChannelType::Dm | ChannelType::GroupDm)
    }

    pub fn is_thread(&self) -> bool {
        self.channel_type().is_thread()
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
    let guild_channel_ids: Vec<i64> = rows.iter().filter(|row| !row.is_dm()).map(|row| row.id).collect();
    let mut overwrites = overwrites_of(state, &guild_channel_ids).await?;
    let mut extras = threads::load_extras(state, &rows, viewer).await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let kind = row.channel_type();
            let is_dm = row.is_dm();
            let voice_settings = (kind == ChannelType::GuildVoice).then(|| crate::voice::channel_settings(row.bitrate, row.user_limit));
            let decoration = threads::decoration(&row, &mut extras);
            let mut channel = Channel {
                permission_overwrites: (!is_dm).then(|| overwrites.remove(&row.id).unwrap_or_default()),
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
                bitrate: voice_settings.map(|(bitrate, _)| bitrate),
                user_limit: voice_settings.map(|(_, limit)| limit),
                status: (kind == ChannelType::GuildVoice).then(|| row.voice_status.clone()),
                thread_metadata: None,
                member_count: None,
                message_count: None,
                member: None,
                applied_tags: None,
                newly_created: None,
                flags: None,
                available_tags: None,
                default_reaction_emoji: None,
                default_sort_order: None,
                default_forum_layout: None,
                default_auto_archive_duration: None,
            };
            decoration.apply(&mut channel);
            channel
        })
        .collect())
}

/// The overwrites of the given channels as wire values, roles before members, each by id.
pub async fn overwrites_of(state: &AppState, channel_ids: &[i64]) -> ApiResult<HashMap<i64, Vec<PermissionOverwrite>>> {
    let mut map: HashMap<i64, Vec<PermissionOverwrite>> = HashMap::new();
    if channel_ids.is_empty() {
        return Ok(map);
    }
    let rows: Vec<(i64, i64, i16, i64, i64)> = sqlx::query_as(
        "SELECT channel_id, target_id, target_type, allow, deny FROM permission_overwrites WHERE channel_id = ANY($1) ORDER BY channel_id, target_type, target_id",
    )
    .bind(channel_ids)
    .fetch_all(&state.db)
    .await?;
    for (channel_id, target_id, target_type, allow, deny) in rows {
        let kind = OverwriteType::from_u8(target_type as u8).unwrap_or(OverwriteType::Role);
        map.entry(channel_id).or_default().push(PermissionOverwrite { id: flake(target_id), kind, allow: allow.to_string(), deny: deny.to_string() });
    }
    Ok(map)
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
    /// Set when the reference points into another channel (thread starters, thread announcements, published copies).
    pub reference_channel_id: Option<i64>,
    pub reference_guild_id: Option<i64>,
    pub forward_channel_id: Option<i64>,
    pub forward_message_id: Option<i64>,
    pub forward_guild_id: Option<i64>,
    /// JSON `MessageSnapshot` of a forward.
    pub snapshot: Option<String>,
    /// Webhook and interaction messages (see `apps`): the identity shown instead of the author's profile.
    pub webhook_id: Option<i64>,
    pub application_id: Option<i64>,
    pub webhook_name: Option<String>,
    pub webhook_avatar: Option<String>,
    /// JSON `MessageInteractionMetadata`.
    pub interaction_metadata: Option<String>,
}

pub const MESSAGE_SELECT: &str = "SELECT m.id, m.channel_id, c.guild_id, m.author_id, m.content, m.kind, m.pinned, m.reference_message_id, m.mention_everyone, \
     m.created_at, m.edited_at, m.embeds::text AS embeds, m.flags, m.reference_channel_id, m.reference_guild_id, m.forward_channel_id, m.forward_message_id, \
     m.forward_guild_id, m.snapshot::text AS snapshot, m.webhook_id, m.application_id, m.webhook_name, m.webhook_avatar, \
     m.interaction_metadata::text AS interaction_metadata FROM messages m JOIN channels c ON c.id = m.channel_id";

#[derive(FromRow)]
struct AttachmentRow {
    id: i64,
    message_id: i64,
    key: Option<String>,
    filename: String,
    content_type: Option<String>,
    size: i64,
    width: Option<i32>,
    height: Option<i32>,
    description: Option<String>,
}

#[allow(clippy::too_many_arguments)]
pub fn attachment_api(
    state: &AppState,
    id: i64,
    key: &str,
    filename: String,
    content_type: Option<String>,
    size: i64,
    width: Option<i32>,
    height: Option<i32>,
) -> Attachment {
    Attachment {
        id: flake(id),
        url: state.asset_url(&crate::media::asset_path(id, key, &filename)),
        filename,
        content_type,
        size: size.max(0) as u64,
        width: width.map(|value| value.max(0) as u32),
        height: height.map(|value| value.max(0) as u32),
        description: None,
    }
}

/// A message plus who reacted with what, so `Reaction.me` can be filled in per viewer (REST and gateway fan-out).
pub struct MessageView {
    pub message: Message,
    reaction_users: Vec<Vec<i64>>,
    poll: Option<crate::polls::LoadedPoll>,
}

impl MessageView {
    pub fn for_viewer(&self, viewer: i64) -> Message {
        let mut message = self.message.clone();
        for (reaction, users) in message.reactions.iter_mut().zip(&self.reaction_users) {
            reaction.me = users.contains(&viewer);
        }
        if let Some(poll) = &self.poll {
            message.poll = Some(Box::new(poll.for_viewer(Some(viewer))));
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
    let attachment_rows: Vec<AttachmentRow> = sqlx::query_as(
        "SELECT id, message_id, key, filename, content_type, size, width, height, description FROM attachments WHERE message_id = ANY($1) AND NOT snapshot ORDER BY id",
    )
    .bind(&ids)
    .fetch_all(&state.db)
    .await?;
    let sticker_rows: Vec<(i64, i64, String, i16, String)> = sqlx::query_as(
        "SELECT message_id, sticker_id, name, format, asset_path FROM message_stickers WHERE message_id = ANY($1) AND NOT snapshot ORDER BY message_id, position",
    )
    .bind(&ids)
    .fetch_all(&state.db)
    .await?;
    let reaction_rows: Vec<(i64, String, i64, i64, Option<bool>)> = sqlx::query_as(
        "SELECT r.message_id, r.emoji_name, r.emoji_id, r.user_id, e.animated FROM reactions r LEFT JOIN emojis e ON r.emoji_id <> 0 AND e.id = r.emoji_id
         WHERE r.message_id = ANY($1) ORDER BY r.created_at, r.user_id",
    )
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
        // rows from before keys existed cannot be served, so they are not listed
        let Some(key) = row.key else { continue };
        let mut attachment = attachment_api(state, row.id, &key, row.filename, row.content_type, row.size, row.width, row.height);
        attachment.description = row.description;
        attachments.entry(row.message_id).or_default().push(attachment);
    }
    let mut stickers: HashMap<i64, Vec<StickerItem>> = HashMap::new();
    for (message_id, sticker_id, name, format, path) in sticker_rows {
        stickers.entry(message_id).or_default().push(StickerItem {
            id: flake(sticker_id),
            name,
            format_type: StickerFormat::from_u8(format as u8).unwrap_or(StickerFormat::Png),
            url: state.asset_url(&path),
        });
    }
    // message → ordered (emoji, users)
    let mut reactions: HashMap<i64, Vec<(ReactionEmoji, Vec<i64>)>> = HashMap::new();
    for (message_id, name, emoji_id, user_id, animated) in reaction_rows {
        let emoji = ReactionEmoji { id: (emoji_id != 0).then(|| flake(emoji_id)), name, animated };
        let list = reactions.entry(message_id).or_default();
        // A custom emoji is one reaction whatever name it was stored with.
        match list.iter_mut().find(|(existing, _)| if emoji.id.is_some() { existing.id == emoji.id } else { *existing == emoji }) {
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

    let mut started_threads = threads::started_threads(state, rows, viewer).await?;
    let mut calls = call_records(state, rows).await?;
    let mut polls = crate::polls::load(state, &ids).await?;

    let mut views = Vec::with_capacity(rows.len());
    for row in rows {
        let Some(mut author) = lookup.get(&row.author_id).cloned() else { continue };
        if let Some(name) = &row.webhook_name {
            // A webhook message shows the name and avatar it was sent with.
            author.username = name.clone();
            author.global_name = None;
            author.avatar = row.webhook_avatar.clone();
        }
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
            member: row.guild_id.filter(|_| row.webhook_name.is_none()).and_then(|guild_id| member_info.get(&(guild_id, row.author_id)).cloned()),
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
            message_reference: match (row.forward_message_id, row.forward_channel_id) {
                (Some(message_id), Some(channel_id)) => Some(MessageReference {
                    kind: Some(MessageReferenceType::Forward),
                    message_id: flake(message_id),
                    channel_id: flake(channel_id),
                    guild_id: row.forward_guild_id.map(flake),
                }),
                _ => row.reference_message_id.map(|message_id| MessageReference {
                    kind: None,
                    message_id: flake(message_id),
                    channel_id: flake(row.reference_channel_id.unwrap_or(row.channel_id)),
                    guild_id: if row.reference_channel_id.is_some() { row.reference_guild_id } else { row.guild_id }.map(flake),
                }),
            },
            referenced_message: None,
            nonce: None,
            sticker_items: stickers.remove(&row.id).unwrap_or_default(),
            message_snapshots: row.snapshot.as_deref().and_then(|raw| serde_json::from_str::<MessageSnapshot>(raw).ok()).into_iter().collect(),
            flags: (row.flags != 0).then_some(row.flags as u32),
            thread: started_threads.remove(&row.id).map(Box::new),
            webhook_id: row.webhook_id.map(flake),
            application_id: row.application_id.map(flake),
            interaction_metadata: row.interaction_metadata.as_deref().and_then(|raw| serde_json::from_str(raw).ok()).map(Box::new),
            call: (row.kind == MessageType::Call.as_u8() as i16).then(|| {
                // No row yet: the MESSAGE_CREATE of a call that just started (only its author is in it).
                calls.remove(&row.id).unwrap_or_else(|| MessageCall { participants: vec![flake(row.author_id)], ended_timestamp: None })
            }),
            poll: None,
        };
        let poll = polls.remove(&row.id);
        let mut message = message;
        message.poll = poll.as_ref().map(|poll| Box::new(poll.for_viewer(viewer)));
        views.push(MessageView { message, reaction_users, poll });
    }
    Ok(views)
}

/// `Message::call` of the type 3 messages among `rows`.
async fn call_records(state: &AppState, rows: &[MessageRow]) -> ApiResult<HashMap<i64, MessageCall>> {
    let ids: Vec<i64> = rows.iter().filter(|row| row.kind == MessageType::Call.as_u8() as i16).map(|row| row.id).collect();
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let records: Vec<(i64, Vec<i64>, Option<OffsetDateTime>)> =
        sqlx::query_as("SELECT message_id, participants, ended_at FROM message_calls WHERE message_id = ANY($1)").bind(&ids).fetch_all(&state.db).await?;
    Ok(records
        .into_iter()
        .map(|(id, participants, ended)| (id, MessageCall { participants: participants.into_iter().map(flake).collect(), ended_timestamp: ended.map(iso) }))
        .collect())
}

/// Full messages including one level of `referenced_message` (its own reactions are always empty).
pub async fn load_messages(state: &AppState, rows: Vec<MessageRow>, viewer: Option<i64>) -> ApiResult<Vec<MessageView>> {
    let mut views = load_flat(state, &rows, viewer).await?;
    // Only same-channel references (and a thread's starter, whose parent the viewer can read) are expanded: following a reference
    // into another channel would hand out messages and attachments the viewer may not see (published copies point at their source).
    let expands = |row: &MessageRow| row.reference_channel_id.is_none() || row.kind == MessageType::ThreadStarterMessage.as_u8() as i16;
    let mut reference_ids: Vec<i64> = rows.iter().filter(|row| expands(row)).filter_map(|row| row.reference_message_id).collect();
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
        let same_channel = view.message.message_reference.as_ref().is_some_and(|reference| reference.channel_id == view.message.channel_id);
        // A forward never shows its source as a reply target, even when the source is in the same channel.
        if let Some(reference) = view.message.message_reference.as_ref().filter(|reference| {
            reference.kind != Some(MessageReferenceType::Forward) && (same_channel || view.message.kind == MessageType::ThreadStarterMessage)
        }) {
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
