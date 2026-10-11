//! Wire types of the Vokko server API (`docs/api.md`). They serialize exactly like `apps/desktop/src/api/types.ts`:
//! snowflakes are strings, enums are numbers, timestamps are ISO 8601 strings, `T | null` fields emit `null`.
use serde::de::{self, Deserializer};
use serde::ser::Serializer;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 64-bit id serialized as a decimal string.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Snowflake(pub u64);

impl Snowflake {
    /// Database representation (ids stay below 2^63).
    pub fn db(self) -> i64 {
        self.0 as i64
    }
}

impl From<i64> for Snowflake {
    fn from(value: i64) -> Self {
        Self(value as u64)
    }
}

impl std::fmt::Display for Snowflake {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

impl std::str::FromStr for Snowflake {
    type Err = std::num::ParseIntError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        s.parse::<u64>().map(Self)
    }
}

impl Serialize for Snowflake {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for Snowflake {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Text(String),
            Number(u64),
        }
        match Raw::deserialize(deserializer)? {
            Raw::Text(text) => text.parse::<u64>().map(Self).map_err(|_| de::Error::custom("invalid snowflake")),
            Raw::Number(number) => Ok(Self(number)),
        }
    }
}

/// Distinguishes an absent field (`None`) from an explicit `null` (`Some(None)`).
fn double_option<'de, T: Deserialize<'de>, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(deserializer).map(Some)
}

macro_rules! numeric_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident = $value:expr),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum $name {
            $($variant = $value),+
        }

        impl $name {
            pub fn from_u8(value: u8) -> Option<Self> {
                match value {
                    $($value => Some(Self::$variant),)+
                    _ => None,
                }
            }

            pub fn as_u8(self) -> u8 {
                self as u8
            }
        }

        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_u8(self.as_u8())
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let value = u8::deserialize(deserializer)?;
                Self::from_u8(value).ok_or_else(|| de::Error::custom(concat!("unknown ", stringify!($name), " value")))
            }
        }
    };
}

numeric_enum!(ChannelType {
    GuildText = 0,
    Dm = 1,
    GuildVoice = 2,
    GroupDm = 3,
    GuildCategory = 4,
    GuildAnnouncement = 5,
    AnnouncementThread = 10,
    PublicThread = 11,
    PrivateThread = 12,
    GuildStage = 13,
    GuildForum = 15,
});
numeric_enum!(MessageType {
    Default = 0,
    RecipientAdd = 1,
    RecipientRemove = 2,
    ChannelNameChange = 4,
    ChannelPinnedMessage = 6,
    UserJoin = 7,
    ThreadCreated = 18,
    Reply = 19,
    ThreadStarterMessage = 21,
});

impl ChannelType {
    pub fn is_thread(self) -> bool {
        matches!(self, Self::AnnouncementThread | Self::PublicThread | Self::PrivateThread)
    }
}

/// Auto-archive durations a thread accepts, in minutes of inactivity.
pub const THREAD_AUTO_ARCHIVE_DURATIONS: [u32; 4] = [60, 1440, 4320, 10080];
pub const DEFAULT_AUTO_ARCHIVE_DURATION: u32 = 1440;

/// `Channel::flags` bits.
pub mod channel_flags {
    /// Forum post pinned to the top of the post list.
    pub const PINNED: u32 = 1 << 1;
    /// Forum channel: every post needs at least one tag.
    pub const REQUIRE_TAG: u32 = 1 << 4;
}

/// `Message::flags` bits.
pub mod message_flags {
    pub const CROSSPOSTED: u32 = 1 << 0;
    pub const IS_CROSSPOST: u32 = 1 << 1;
    pub const SUPPRESS_EMBEDS: u32 = 1 << 2;
}
numeric_enum!(
    /// `MessageReference.type`: 0 = reply / default, 1 = forward (`message_snapshots` carries the copy).
    MessageReferenceType { Default = 0, Forward = 1 }
);
numeric_enum!(
    /// `Sticker.format_type`. Discord's LOTTIE (3) is not supported; WebP (5) is Vokko's addition.
    StickerFormat { Png = 1, Apng = 2, Gif = 4, Webp = 5 }
);
numeric_enum!(OverwriteType { Role = 0, Member = 1 });
numeric_enum!(RelationshipType { Friend = 1, Blocked = 2, IncomingRequest = 3, OutgoingRequest = 4 });
numeric_enum!(GatewayOp {
    Dispatch = 0,
    Heartbeat = 1,
    Identify = 2,
    PresenceUpdate = 3,
    VoiceStateUpdate = 4,
    Resume = 6,
    Reconnect = 7,
    InvalidSession = 9,
    Hello = 10,
    HeartbeatAck = 11,
});

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PresenceStatus {
    Online,
    Idle,
    Dnd,
    /// A chosen status: shown as `Offline` to everyone but the user's own sessions.
    Invisible,
    Offline,
}

impl PresenceStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Online => "online",
            Self::Idle => "idle",
            Self::Dnd => "dnd",
            Self::Invisible => "invisible",
            Self::Offline => "offline",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "online" => Some(Self::Online),
            "idle" => Some(Self::Idle),
            "dnd" => Some(Self::Dnd),
            "invisible" => Some(Self::Invisible),
            "offline" => Some(Self::Offline),
            _ => None,
        }
    }
}

/// Permission bit values (Discord's): 53 permissions on bits 0..46 and 48..53, bit 47 is unassigned.
pub mod permissions {
    pub const CREATE_INSTANT_INVITE: u64 = 1 << 0;
    pub const KICK_MEMBERS: u64 = 1 << 1;
    pub const BAN_MEMBERS: u64 = 1 << 2;
    pub const ADMINISTRATOR: u64 = 1 << 3;
    pub const MANAGE_CHANNELS: u64 = 1 << 4;
    pub const MANAGE_GUILD: u64 = 1 << 5;
    pub const ADD_REACTIONS: u64 = 1 << 6;
    pub const VIEW_AUDIT_LOG: u64 = 1 << 7;
    pub const PRIORITY_SPEAKER: u64 = 1 << 8;
    pub const STREAM: u64 = 1 << 9;
    pub const VIEW_CHANNEL: u64 = 1 << 10;
    pub const SEND_MESSAGES: u64 = 1 << 11;
    pub const SEND_TTS_MESSAGES: u64 = 1 << 12;
    pub const MANAGE_MESSAGES: u64 = 1 << 13;
    pub const EMBED_LINKS: u64 = 1 << 14;
    pub const ATTACH_FILES: u64 = 1 << 15;
    pub const READ_MESSAGE_HISTORY: u64 = 1 << 16;
    pub const MENTION_EVERYONE: u64 = 1 << 17;
    pub const USE_EXTERNAL_EMOJIS: u64 = 1 << 18;
    pub const VIEW_GUILD_ANALYTICS: u64 = 1 << 19;
    pub const CONNECT: u64 = 1 << 20;
    pub const SPEAK: u64 = 1 << 21;
    pub const MUTE_MEMBERS: u64 = 1 << 22;
    pub const DEAFEN_MEMBERS: u64 = 1 << 23;
    pub const MOVE_MEMBERS: u64 = 1 << 24;
    pub const USE_VAD: u64 = 1 << 25;
    pub const CHANGE_NICKNAME: u64 = 1 << 26;
    pub const MANAGE_NICKNAMES: u64 = 1 << 27;
    pub const MANAGE_ROLES: u64 = 1 << 28;
    pub const MANAGE_WEBHOOKS: u64 = 1 << 29;
    pub const MANAGE_GUILD_EXPRESSIONS: u64 = 1 << 30;
    pub const USE_APPLICATION_COMMANDS: u64 = 1 << 31;
    pub const REQUEST_TO_SPEAK: u64 = 1 << 32;
    pub const MANAGE_EVENTS: u64 = 1 << 33;
    pub const MANAGE_THREADS: u64 = 1 << 34;
    pub const CREATE_PUBLIC_THREADS: u64 = 1 << 35;
    pub const CREATE_PRIVATE_THREADS: u64 = 1 << 36;
    pub const USE_EXTERNAL_STICKERS: u64 = 1 << 37;
    pub const SEND_MESSAGES_IN_THREADS: u64 = 1 << 38;
    pub const USE_EMBEDDED_ACTIVITIES: u64 = 1 << 39;
    pub const MODERATE_MEMBERS: u64 = 1 << 40;
    pub const VIEW_CREATOR_MONETIZATION_ANALYTICS: u64 = 1 << 41;
    pub const USE_SOUNDBOARD: u64 = 1 << 42;
    pub const CREATE_GUILD_EXPRESSIONS: u64 = 1 << 43;
    pub const CREATE_EVENTS: u64 = 1 << 44;
    pub const USE_EXTERNAL_SOUNDS: u64 = 1 << 45;
    pub const SEND_VOICE_MESSAGES: u64 = 1 << 46;
    pub const SET_VOICE_CHANNEL_STATUS: u64 = 1 << 48;
    pub const SEND_POLLS: u64 = 1 << 49;
    pub const USE_EXTERNAL_APPS: u64 = 1 << 50;
    pub const PIN_MESSAGES: u64 = 1 << 51;
    pub const BYPASS_SLOWMODE: u64 = 1 << 52;
    pub const MANAGE_OFFICIAL_MESSAGES: u64 = 1 << 53;

    /// Every defined permission bit (what the owner and administrators resolve to).
    pub const ALL: u64 = (1 << 54) - 1 - (1 << 47);
    /// Every permission name with its bit, in bit order.
    pub const NAMED: [(&str, u64); 53] = [
        ("CREATE_INSTANT_INVITE", CREATE_INSTANT_INVITE),
        ("KICK_MEMBERS", KICK_MEMBERS),
        ("BAN_MEMBERS", BAN_MEMBERS),
        ("ADMINISTRATOR", ADMINISTRATOR),
        ("MANAGE_CHANNELS", MANAGE_CHANNELS),
        ("MANAGE_GUILD", MANAGE_GUILD),
        ("ADD_REACTIONS", ADD_REACTIONS),
        ("VIEW_AUDIT_LOG", VIEW_AUDIT_LOG),
        ("PRIORITY_SPEAKER", PRIORITY_SPEAKER),
        ("STREAM", STREAM),
        ("VIEW_CHANNEL", VIEW_CHANNEL),
        ("SEND_MESSAGES", SEND_MESSAGES),
        ("SEND_TTS_MESSAGES", SEND_TTS_MESSAGES),
        ("MANAGE_MESSAGES", MANAGE_MESSAGES),
        ("EMBED_LINKS", EMBED_LINKS),
        ("ATTACH_FILES", ATTACH_FILES),
        ("READ_MESSAGE_HISTORY", READ_MESSAGE_HISTORY),
        ("MENTION_EVERYONE", MENTION_EVERYONE),
        ("USE_EXTERNAL_EMOJIS", USE_EXTERNAL_EMOJIS),
        ("VIEW_GUILD_ANALYTICS", VIEW_GUILD_ANALYTICS),
        ("CONNECT", CONNECT),
        ("SPEAK", SPEAK),
        ("MUTE_MEMBERS", MUTE_MEMBERS),
        ("DEAFEN_MEMBERS", DEAFEN_MEMBERS),
        ("MOVE_MEMBERS", MOVE_MEMBERS),
        ("USE_VAD", USE_VAD),
        ("CHANGE_NICKNAME", CHANGE_NICKNAME),
        ("MANAGE_NICKNAMES", MANAGE_NICKNAMES),
        ("MANAGE_ROLES", MANAGE_ROLES),
        ("MANAGE_WEBHOOKS", MANAGE_WEBHOOKS),
        ("MANAGE_GUILD_EXPRESSIONS", MANAGE_GUILD_EXPRESSIONS),
        ("USE_APPLICATION_COMMANDS", USE_APPLICATION_COMMANDS),
        ("REQUEST_TO_SPEAK", REQUEST_TO_SPEAK),
        ("MANAGE_EVENTS", MANAGE_EVENTS),
        ("MANAGE_THREADS", MANAGE_THREADS),
        ("CREATE_PUBLIC_THREADS", CREATE_PUBLIC_THREADS),
        ("CREATE_PRIVATE_THREADS", CREATE_PRIVATE_THREADS),
        ("USE_EXTERNAL_STICKERS", USE_EXTERNAL_STICKERS),
        ("SEND_MESSAGES_IN_THREADS", SEND_MESSAGES_IN_THREADS),
        ("USE_EMBEDDED_ACTIVITIES", USE_EMBEDDED_ACTIVITIES),
        ("MODERATE_MEMBERS", MODERATE_MEMBERS),
        ("VIEW_CREATOR_MONETIZATION_ANALYTICS", VIEW_CREATOR_MONETIZATION_ANALYTICS),
        ("USE_SOUNDBOARD", USE_SOUNDBOARD),
        ("CREATE_GUILD_EXPRESSIONS", CREATE_GUILD_EXPRESSIONS),
        ("CREATE_EVENTS", CREATE_EVENTS),
        ("USE_EXTERNAL_SOUNDS", USE_EXTERNAL_SOUNDS),
        ("SEND_VOICE_MESSAGES", SEND_VOICE_MESSAGES),
        ("SET_VOICE_CHANNEL_STATUS", SET_VOICE_CHANNEL_STATUS),
        ("SEND_POLLS", SEND_POLLS),
        ("USE_EXTERNAL_APPS", USE_EXTERNAL_APPS),
        ("PIN_MESSAGES", PIN_MESSAGES),
        ("BYPASS_SLOWMODE", BYPASS_SLOWMODE),
        ("MANAGE_OFFICIAL_MESSAGES", MANAGE_OFFICIAL_MESSAGES),
    ];
    /// What the @everyone role of a new guild grants: the 26-bit default set of the Discord client.
    pub const DEFAULT_EVERYONE: u64 = CREATE_INSTANT_INVITE
        | CHANGE_NICKNAME
        | VIEW_CHANNEL
        | SEND_MESSAGES
        | EMBED_LINKS
        | ATTACH_FILES
        | READ_MESSAGE_HISTORY
        | MENTION_EVERYONE
        | USE_EXTERNAL_EMOJIS
        | USE_EXTERNAL_STICKERS
        | ADD_REACTIONS
        | CREATE_PUBLIC_THREADS
        | CREATE_PRIVATE_THREADS
        | SEND_MESSAGES_IN_THREADS
        | SEND_POLLS
        | CONNECT
        | SPEAK
        | USE_VAD
        | STREAM
        | USE_EMBEDDED_ACTIVITIES
        | USE_SOUNDBOARD
        | REQUEST_TO_SPEAK
        | USE_APPLICATION_COMMANDS
        | CREATE_GUILD_EXPRESSIONS
        | CREATE_EVENTS
        | USE_EXTERNAL_APPS;
    /// A timed-out member keeps only these.
    pub const TIMEOUT_ALLOWED: u64 = VIEW_CHANNEL | READ_MESSAGE_HISTORY;
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct User {
    pub id: Snowflake,
    pub username: String,
    pub global_name: Option<String>,
    pub avatar: Option<String>,
    pub banner_color: Option<String>,
    pub bio: Option<String>,
    pub bot: bool,
    // Profile perks (free for everyone). Always sent, `null` when not set, so a merge on the client clears them.
    /// Banner image URL (static or animated).
    #[serde(default)]
    pub banner: Option<String>,
    /// Up to 40 characters.
    #[serde(default)]
    pub pronouns: Option<String>,
    /// Profile theme primary and accent colour (RGB ints).
    #[serde(default)]
    pub theme_colors: Option<[u32; 2]>,
    /// Id of an asset in the client's open decoration set.
    #[serde(default)]
    pub avatar_decoration: Option<String>,
    #[serde(default)]
    pub profile_effect: Option<String>,
    /// Server tag shown next to the name.
    #[serde(default)]
    pub primary_guild: Option<UserPrimaryGuild>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct UserPrimaryGuild {
    pub guild_id: Snowflake,
    /// 1-4 characters.
    pub tag: String,
    pub badge: String,
    pub color_primary: u32,
    pub color_secondary: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Presence {
    pub user_id: Snowflake,
    pub status: PresenceStatus,
    pub custom_status: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Channel {
    pub id: Snowflake,
    #[serde(rename = "type")]
    pub kind: ChannelType,
    pub guild_id: Option<Snowflake>,
    pub name: Option<String>,
    pub topic: Option<String>,
    pub position: i32,
    pub parent_id: Option<Snowflake>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recipients: Option<Vec<User>>,
    pub last_message_id: Option<Snowflake>,
    /// Group DM only: absent for other channels, `null` allowed.
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub owner_id: Option<Option<Snowflake>>,
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub icon: Option<Option<String>>,
    /// Guild channels only (always present there, `[]` when there are none); absent on DMs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_overwrites: Option<Vec<PermissionOverwrite>>,
    /// Guild voice only: Opus bitrate in bps (8000..=guild max, default 64000); absent on other channels.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bitrate: Option<u32>,
    /// Guild voice only: 0 = unlimited, max 99.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_limit: Option<u32>,
    /// Guild voice only: the shared channel status (max 500 chars), `null` when none.
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub status: Option<Option<String>>,
    /// Threads only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_metadata: Option<ThreadMetadata>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_count: Option<u32>,
    /// Threads: the receiving user's membership, when they joined.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member: Option<ThreadMember>,
    /// Forum posts only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_tags: Option<Vec<Snowflake>>,
    /// THREAD_CREATE and start-thread responses only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub newly_created: Option<bool>,
    /// `channel_flags` bits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flags: Option<u32>,
    /// Forum channels only (always present there).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available_tags: Option<Vec<ForumTag>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_reaction_emoji: Option<DefaultReaction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_sort_order: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_forum_layout: Option<u32>,
    /// Text, announcement and forum channels.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_auto_archive_duration: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ThreadMetadata {
    pub archived: bool,
    pub auto_archive_duration: u32,
    pub archive_timestamp: String,
    pub locked: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invitable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create_timestamp: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ThreadMember {
    /// Thread id.
    pub id: Snowflake,
    pub user_id: Snowflake,
    pub join_timestamp: String,
    pub flags: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ForumTag {
    pub id: Snowflake,
    pub name: String,
    pub moderated: bool,
    pub emoji_id: Option<Snowflake>,
    pub emoji_name: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DefaultReaction {
    pub emoji_id: Option<Snowflake>,
    pub emoji_name: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PermissionOverwrite {
    /// Role id or user id.
    pub id: Snowflake,
    #[serde(rename = "type")]
    pub kind: OverwriteType,
    /// Permission bitfield as a decimal string.
    pub allow: String,
    pub deny: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Role {
    pub id: Snowflake,
    pub name: String,
    pub color: u32,
    pub hoist: bool,
    pub position: i32,
    pub permissions: String,
    pub mentionable: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Guild {
    pub id: Snowflake,
    pub name: String,
    pub icon: Option<String>,
    pub owner_id: Snowflake,
    pub roles: Vec<Role>,
    pub system_channel_id: Option<Snowflake>,
    /// Server tag members can adopt (MANAGE_GUILD edits it); always sent, `null` when none.
    #[serde(default)]
    pub tag: Option<GuildTag>,
    #[serde(default)]
    pub theme: Option<GuildTheme>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GuildTag {
    /// 1-4 characters.
    pub tag: String,
    pub badge: String,
    pub color_primary: u32,
    pub color_secondary: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GuildTheme {
    /// Preset id in the client's asset set, `null` for a custom theme.
    pub preset: Option<String>,
    pub primary: u32,
    pub accent: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GuildMember {
    pub user: User,
    pub nick: Option<String>,
    pub roles: Vec<Snowflake>,
    pub joined_at: String,
    /// End of a communication timeout; always sent, `null` when the member is not timed out.
    #[serde(default)]
    pub communication_disabled_until: Option<String>,
    // Per-server profile: overrides the user's inside this guild, `null` = use the user's.
    #[serde(default)]
    pub avatar: Option<String>,
    #[serde(default)]
    pub banner: Option<String>,
    #[serde(default)]
    pub bio: Option<String>,
    #[serde(default)]
    pub pronouns: Option<String>,
    #[serde(default)]
    pub theme_colors: Option<[u32; 2]>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Attachment {
    pub id: Snowflake,
    pub filename: String,
    pub content_type: Option<String>,
    pub size: u64,
    pub url: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// Alt text, up to 1024 characters. A filename starting with `SPOILER_` marks a spoiler.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EmbedType {
    Rich,
    Link,
    Image,
    Video,
    Article,
    Gifv,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EmbedMedia {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EmbedFooter {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EmbedProvider {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EmbedAuthor {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EmbedField {
    pub name: String,
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inline: Option<bool>,
}

/// Link unfurl generated by the server; absent members are omitted, never `null`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Embed {
    #[serde(rename = "type")]
    pub kind: EmbedType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub footer: Option<EmbedFooter>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<EmbedMedia>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<EmbedMedia>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video: Option<EmbedMedia>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<EmbedProvider>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<EmbedAuthor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fields: Option<Vec<EmbedField>>,
}

/// `EditMessageRequest.flags` bit that hides a message's link embeds.
pub const SUPPRESS_EMBEDS: u32 = 1 << 2;

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ReactionEmoji {
    pub id: Option<Snowflake>,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Reaction {
    pub emoji: ReactionEmoji,
    pub count: u32,
    pub me: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MessageReference {
    /// Absent = 0 (reply); 1 = forward, where `channel_id`/`guild_id` point at the source message.
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<MessageReferenceType>,
    pub message_id: Snowflake,
    pub channel_id: Snowflake,
    pub guild_id: Option<Snowflake>,
}

/// A guild sticker (`GET /guilds/{id}/stickers`, `GUILD_CREATE.stickers`). Always Discord type 2 (GUILD), so no `type` field.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Sticker {
    pub id: Snowflake,
    pub guild_id: Snowflake,
    pub name: String,
    pub description: Option<String>,
    /// Comma separated search words, 2-200 chars.
    pub tags: String,
    pub format_type: StickerFormat,
    /// Absolute asset URL of the image.
    pub url: String,
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<User>,
}

/// The part of a sticker a message carries (`Message.sticker_items`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StickerItem {
    pub id: Snowflake,
    pub name: String,
    pub format_type: StickerFormat,
    pub url: String,
}

/// The copy of a forwarded message (`Message.message_snapshots[].message`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MessageSnapshotContent {
    #[serde(rename = "type")]
    pub kind: MessageType,
    pub content: String,
    pub timestamp: String,
    pub edited_timestamp: Option<String>,
    pub mentions: Vec<User>,
    pub attachments: Vec<Attachment>,
    pub embeds: Vec<Embed>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sticker_items: Vec<StickerItem>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MessageSnapshot {
    pub message: MessageSnapshotContent,
}

/// `Pick<GuildMember, "nick" | "roles">`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MessageMember {
    pub nick: Option<String>,
    pub roles: Vec<Snowflake>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub id: Snowflake,
    pub channel_id: Snowflake,
    pub guild_id: Option<Snowflake>,
    pub author: User,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member: Option<MessageMember>,
    pub content: String,
    pub timestamp: String,
    pub edited_timestamp: Option<String>,
    #[serde(rename = "type")]
    pub kind: MessageType,
    pub mentions: Vec<User>,
    pub mention_everyone: bool,
    pub attachments: Vec<Attachment>,
    #[serde(default)]
    pub embeds: Vec<Embed>,
    pub reactions: Vec<Reaction>,
    pub pinned: bool,
    pub message_reference: Option<MessageReference>,
    pub referenced_message: Option<Box<Message>>,
    pub nonce: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sticker_items: Vec<StickerItem>,
    /// Exactly one entry on a forward (`message_reference.type` 1), absent otherwise.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub message_snapshots: Vec<MessageSnapshot>,
    /// `message_flags` bits; absent = 0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flags: Option<u32>,
    /// Present when a thread was started from this message (the thread id equals the message id).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread: Option<Box<Channel>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ReadState {
    pub channel_id: Snowflake,
    pub last_message_id: Option<Snowflake>,
    pub mention_count: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Relationship {
    pub id: Snowflake,
    #[serde(rename = "type")]
    pub kind: RelationshipType,
    pub user: User,
}

/// Default bitrate of a new voice channel (Discord's default).
pub const VOICE_BITRATE_DEFAULT: u32 = 64_000;
pub const VOICE_BITRATE_MIN: u32 = 8_000;
/// Default instance ceiling (and per-guild maximum); `VOKKO_VOICE_BITRATE_MAX` may raise it up to `VOICE_BITRATE_CEILING_MAX`.
pub const VOICE_BITRATE_GUILD_MAX: u32 = 128_000;
pub const VOICE_BITRATE_CEILING_MAX: u32 = 384_000;
pub const VOICE_USER_LIMIT_MAX: u32 = 99;

/// Who is in which voice channel. `channel_id: null` = left voice.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct VoiceState {
    /// `null` for DM / group DM calls.
    pub guild_id: Option<Snowflake>,
    pub channel_id: Option<Snowflake>,
    pub user_id: Snowflake,
    /// Guild only, on VOICE_STATE_UPDATE (READY / GUILD_CREATE already carry the members).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member: Option<GuildMember>,
    /// Voice session (not the gateway session id); changes on every new binding, e.g. a join from another device.
    pub session_id: String,
    /// Server deafened / muted.
    pub deaf: bool,
    pub mute: bool,
    pub self_deaf: bool,
    pub self_mute: bool,
    /// Camera / screen share published (truth from LiveKit).
    pub self_video: bool,
    pub self_stream: bool,
    /// No SPEAK in this channel (or stage audience).
    pub suppress: bool,
    pub request_to_speak_timestamp: Option<String>,
    pub connected_at: String,
}

/// Instance-wide media settings, in READY so clients can hide what the instance does not offer.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InstanceMediaConfig {
    pub voice_enabled: bool,
    /// bps; default 128000, configurable up to 384000.
    pub voice_bitrate_ceiling: u32,
    pub screenshare_qualities: Vec<String>,
    pub video_enabled: bool,
}

/// Op 4, client → server. `channel_id: null` leaves voice.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct VoiceStateUpdateCommand {
    #[serde(default)]
    pub guild_id: Option<Snowflake>,
    pub channel_id: Option<Snowflake>,
    #[serde(default)]
    pub self_mute: bool,
    #[serde(default)]
    pub self_deaf: bool,
    /// Hint only; the truth comes from LiveKit.
    #[serde(default)]
    pub self_video: bool,
}

/// VOICE_SERVER_UPDATE: sent only to the gateway session that asked to join.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct VoiceServerUpdate {
    pub guild_id: Option<Snowflake>,
    pub channel_id: Snowflake,
    /// LiveKit signal URL (wss://...).
    pub endpoint: String,
    /// LiveKit access token (JWT).
    pub token: String,
    /// The voice session this token belongs to (matches `VoiceState.session_id`).
    pub session_id: String,
}

/// Max length of a voice channel status.
pub const VOICE_STATUS_MAX_CHARS: usize = 500;

/// `PUT /channels/{id}/voice-status`; `null` or an empty string clears it.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct VoiceStatusRequest {
    #[serde(default)]
    pub status: Option<String>,
}

/// VOICE_CHANNEL_STATUS_UPDATE, to everyone who can see the channel.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct VoiceChannelStatusUpdate {
    pub id: Snowflake,
    pub guild_id: Snowflake,
    pub status: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VoiceConnectFailure {
    MissingPermissions,
    ChannelFull,
    VideoFull,
    Blocked,
    TimedOut,
    MediaUnavailable,
}

/// VOICE_CONNECT_FAILED (Vokko-only): op 4 was refused; sent only to the requesting session.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct VoiceConnectFailed {
    pub guild_id: Option<Snowflake>,
    pub channel_id: Snowflake,
    pub reason: VoiceConnectFailure,
}

// ---- REST payloads ----

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AuthRequest {
    pub login: String,
    pub password: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RegisterRequest {
    pub email: String,
    pub username: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub global_name: Option<String>,
    pub password: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AuthResponse {
    pub token: String,
    pub user: User,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct MessageReferenceRequest {
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<MessageReferenceType>,
    pub message_id: Snowflake,
    /// Required for a forward (the source channel); ignored for replies, which always stay in the channel.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<Snowflake>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct CreateMessageRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nonce: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_reference: Option<MessageReferenceRequest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment_ids: Option<Vec<Snowflake>>,
    /// The same ids with an optional rename and alt text each; wins over `attachment_ids` when both are sent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<PendingAttachmentMeta>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_mentions: Option<AllowedMentions>,
    /// Up to 3 guild stickers; content may then be empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sticker_ids: Option<Vec<Snowflake>>,
}

/// One pending upload referenced by `CreateMessageRequest.attachments`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PendingAttachmentMeta {
    pub id: Snowflake,
    /// Rename before sending (1-255 characters); the prefix `SPOILER_` marks a spoiler.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    /// Alt text, up to 1024 characters; empty clears.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Which mentions of a new message actually ping. Omitted entirely = everything is parsed and the replied-to author is pinged.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct AllowedMentions {
    /// Subset of `users`, `roles`, `everyone`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parse: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub users: Option<Vec<Snowflake>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub roles: Option<Vec<Snowflake>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replied_user: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PinnedMessage {
    pub message: Message,
    pub pinned_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PinnedMessagesPage {
    pub items: Vec<PinnedMessage>,
    pub has_more: bool,
}

/// `GET /guilds/{id}/messages/search` and `GET /channels/{id}/messages/search`: each hit is a one-element array.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MessageSearchResponse {
    pub total_results: u64,
    pub messages: Vec<Vec<Message>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RateLimitError {
    pub message: String,
    /// Seconds (float); also sent as the `Retry-After` header.
    pub retry_after: f64,
    pub global: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AckBulkRequest {
    pub read_states: Vec<MessageAck>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EditMessageRequest {
    /// Omitted = unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flags: Option<u32>,
    /// The attachments to keep: omitted = unchanged, the others are removed (and their files deleted). Cannot add.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<IdOnly>>,
}

/// `PATCH /users/@me`. Only the keys that are present change; `null` clears (an empty string clears the text fields too).
#[derive(Clone, Debug, Default, Deserialize)]
pub struct UpdateUserRequest {
    #[serde(default, deserialize_with = "double_option")]
    pub global_name: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub bio: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub banner_color: Option<Option<String>>,
    /// PNG/JPEG/WebP/GIF (animated allowed), at most 8 MiB.
    #[serde(default, deserialize_with = "double_option")]
    pub avatar_attachment_id: Option<Option<Snowflake>>,
    /// At most 10 MiB.
    #[serde(default, deserialize_with = "double_option")]
    pub banner_attachment_id: Option<Option<Snowflake>>,
    #[serde(default, deserialize_with = "double_option")]
    pub pronouns: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub theme_colors: Option<Option<[u32; 2]>>,
    #[serde(default, deserialize_with = "double_option")]
    pub avatar_decoration: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub profile_effect: Option<Option<String>>,
    /// Adopt that guild's tag (must be a member of a guild that has one); `null` clears.
    #[serde(default, deserialize_with = "double_option")]
    pub primary_guild_id: Option<Option<Snowflake>>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct CreateDmRequest {
    #[serde(default)]
    pub recipient_id: Option<Snowflake>,
    #[serde(default)]
    pub recipient_ids: Option<Vec<Snowflake>>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct CreateRelationshipRequest {
    pub username: String,
}

/// Optional body of `PUT /users/@me/relationships/{id}`: 1 = friend (default), 2 = block.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PutRelationshipRequest {
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<u8>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MutualGuild {
    pub id: Snowflake,
    pub nick: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct UserProfile {
    pub user: User,
    pub mutual_guilds: Vec<MutualGuild>,
    pub mutual_friends_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guild_member: Option<GuildMember>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct CreateGuildRequest {
    pub name: String,
    #[serde(default)]
    pub icon_attachment_id: Option<Snowflake>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct UpdateGuildRequest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub icon_attachment_id: Option<Snowflake>,
    #[serde(default)]
    pub system_channel_id: Option<Snowflake>,
    /// `null` removes the server tag.
    #[serde(default, deserialize_with = "double_option")]
    pub tag: Option<Option<GuildTag>>,
    #[serde(default, deserialize_with = "double_option")]
    pub theme: Option<Option<GuildTheme>>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct CreateChannelRequest {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: ChannelType,
    #[serde(default)]
    pub parent_id: Option<Snowflake>,
    #[serde(default)]
    pub topic: Option<String>,
    /// Initial overwrites (a private channel is an @everyone deny of VIEW_CHANNEL); when absent a channel inside a category
    /// copies the category's overwrites.
    #[serde(default)]
    pub permission_overwrites: Option<Vec<PermissionOverwrite>>,
    /// Voice channels only.
    #[serde(default)]
    pub bitrate: Option<u32>,
    #[serde(default)]
    pub user_limit: Option<u32>,
    #[serde(default)]
    pub available_tags: Option<Vec<ForumTagRequest>>,
    #[serde(default)]
    pub default_reaction_emoji: Option<DefaultReaction>,
    #[serde(default)]
    pub default_sort_order: Option<u32>,
    #[serde(default)]
    pub default_forum_layout: Option<u32>,
    #[serde(default)]
    pub default_auto_archive_duration: Option<u32>,
    #[serde(default)]
    pub flags: Option<u32>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct ForumTagRequest {
    /// An existing tag to keep or rename; absent = a new tag.
    #[serde(default)]
    pub id: Option<Snowflake>,
    pub name: String,
    #[serde(default)]
    pub moderated: Option<bool>,
    #[serde(default)]
    pub emoji_id: Option<Snowflake>,
    #[serde(default)]
    pub emoji_name: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct UpdateChannelRequest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub topic: Option<String>,
    #[serde(default)]
    pub position: Option<i32>,
    /// `Some(None)` is not expressible with plain `Option`; send `"0"` to move a channel out of its category.
    #[serde(default)]
    pub parent_id: Option<Snowflake>,
    /// With `parent_id`: `true` replaces the channel's overwrites with the new parent's, `false`/absent keeps them.
    #[serde(default)]
    pub lock_permissions: Option<bool>,
    /// Voice channels only (MANAGE_CHANNELS); above the guild maximum → 400 50035.
    #[serde(default)]
    pub bitrate: Option<u32>,
    #[serde(default)]
    pub user_limit: Option<u32>,
    // ---- threads ----
    #[serde(default)]
    pub archived: Option<bool>,
    #[serde(default)]
    pub locked: Option<bool>,
    #[serde(default)]
    pub auto_archive_duration: Option<u32>,
    #[serde(default)]
    pub invitable: Option<bool>,
    #[serde(default)]
    pub applied_tags: Option<Vec<Snowflake>>,
    #[serde(default)]
    pub flags: Option<u32>,
    // ---- forum channels ----
    /// Full replacement list; ids not listed are deleted.
    #[serde(default)]
    pub available_tags: Option<Vec<ForumTagRequest>>,
    /// `Some(None)` (explicit `null`) clears the default reaction.
    #[serde(default, deserialize_with = "double_option")]
    pub default_reaction_emoji: Option<Option<DefaultReaction>>,
    #[serde(default)]
    pub default_sort_order: Option<u32>,
    #[serde(default)]
    pub default_forum_layout: Option<u32>,
    #[serde(default)]
    pub default_auto_archive_duration: Option<u32>,
}

// ---- Threads, forums, announcements ----

#[derive(Clone, Debug, Default, Deserialize)]
pub struct StartThreadFromMessageRequest {
    pub name: String,
    #[serde(default)]
    pub auto_archive_duration: Option<u32>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct StartThreadRequest {
    pub name: String,
    #[serde(default)]
    pub auto_archive_duration: Option<u32>,
    /// Public (default), private or announcement thread.
    #[serde(default, rename = "type")]
    pub kind: Option<ChannelType>,
    #[serde(default)]
    pub invitable: Option<bool>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct StartForumPostRequest {
    pub name: String,
    #[serde(default)]
    pub auto_archive_duration: Option<u32>,
    #[serde(default)]
    pub applied_tags: Option<Vec<Snowflake>>,
    /// The first message; its id becomes the thread id.
    pub message: CreateMessageRequest,
}

/// Response of `POST /channels/{forum}/threads`: the thread plus its first message.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ForumPost {
    #[serde(flatten)]
    pub channel: Channel,
    pub message: Message,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ThreadListResponse {
    pub threads: Vec<Channel>,
    /// The caller's memberships among `threads`.
    pub members: Vec<ThreadMember>,
    /// Archived lists only; always `false` for active lists.
    pub has_more: bool,
}

/// Query of `GET /channels/{id}/threads/search` (array filters use repeated keys, so the server parses the raw query).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ThreadSearchQuery {
    pub name: Option<String>,
    pub tag: Vec<Snowflake>,
    /// `match_all` when true, `match_some` (default) otherwise.
    pub match_all: bool,
    pub archived: Option<bool>,
    /// `creation_time` when true, `last_message_time` otherwise; `None` = the forum's default_sort_order.
    pub sort_by_creation: Option<bool>,
    pub ascending: bool,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ThreadSearchResponse {
    pub threads: Vec<Channel>,
    pub members: Vec<ThreadMember>,
    /// Starter message of each thread, same order (a deleted starter is left out).
    pub first_messages: Vec<Message>,
    pub has_more: bool,
    pub total_results: u32,
}

#[derive(Clone, Debug, Deserialize)]
pub struct FollowChannelRequest {
    pub webhook_channel_id: Snowflake,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FollowedChannel {
    pub channel_id: Snowflake,
    pub webhook_id: Snowflake,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ChannelFollower {
    pub id: Snowflake,
    pub channel_id: Snowflake,
    pub guild_id: Snowflake,
    pub source_channel_id: Snowflake,
    pub source_channel_name: String,
    pub source_guild_id: Snowflake,
    pub source_guild_name: String,
}

// ---- Moderation ----

#[derive(Clone, Debug, Default, Deserialize)]
pub struct BanRequest {
    /// 0..=604800: also deletes the user's messages of that many seconds back in the guild.
    #[serde(default)]
    pub delete_message_seconds: Option<u32>,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Ban {
    pub user: User,
    pub reason: Option<String>,
}

/// Only the keys that are present change; `nick` and `communication_disabled_until` accept `null` to clear.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct EditMemberRequest {
    #[serde(default, deserialize_with = "double_option")]
    pub nick: Option<Option<String>>,
    /// Full replacement list, without @everyone.
    #[serde(default)]
    pub roles: Option<Vec<Snowflake>>,
    #[serde(default, deserialize_with = "double_option")]
    pub communication_disabled_until: Option<Option<String>>,
}

/// `PATCH /guilds/{id}/members/@me`
#[derive(Clone, Debug, Default, Deserialize)]
pub struct EditOwnMemberRequest {
    #[serde(default, deserialize_with = "double_option")]
    pub nick: Option<Option<String>>,
    /// Per-server profile; each is `null` to fall back to the user's own.
    #[serde(default, deserialize_with = "double_option")]
    pub avatar_attachment_id: Option<Option<Snowflake>>,
    #[serde(default, deserialize_with = "double_option")]
    pub banner_attachment_id: Option<Option<Snowflake>>,
    #[serde(default, deserialize_with = "double_option")]
    pub bio: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub pronouns: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub theme_colors: Option<Option<[u32; 2]>>,
}

/// Create and update of a role; every key is optional.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct RoleRequest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub color: Option<u32>,
    #[serde(default)]
    pub hoist: Option<bool>,
    /// Bitfield as a decimal string.
    #[serde(default)]
    pub permissions: Option<String>,
    #[serde(default)]
    pub mentionable: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RolePositionUpdate {
    pub id: Snowflake,
    pub position: i32,
}

/// Body of `PUT /channels/{id}/permissions/{oid}`.
#[derive(Clone, Debug, Deserialize)]
pub struct OverwriteRequest {
    #[serde(rename = "type")]
    pub kind: OverwriteType,
    pub allow: String,
    pub deny: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct CreateInviteRequest {
    #[serde(default)]
    pub max_age: Option<u32>,
    #[serde(default)]
    pub max_uses: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Invite {
    pub code: String,
    pub guild: InviteGuild,
    pub channel: InviteChannel,
    pub expires_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InviteGuild {
    pub id: Snowflake,
    pub name: String,
    pub icon: Option<String>,
    pub member_count: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InviteChannel {
    pub id: Snowflake,
    pub name: Option<String>,
}

// ---- Stickers, GIFs, bookmarks, reminders ----

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CreateStickerRequest {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub tags: String,
    /// Pending upload from `POST /channels/{id}/attachments` (PNG, APNG, GIF or WebP, at most 512 KiB and 512x512).
    pub attachment_id: Snowflake,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct EditStickerRequest {
    pub name: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub description: Option<Option<String>>,
    pub tags: Option<String>,
}

/// Which provider answers `/gifs/*`; `none` = picker shows favourites only.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GifProvider {
    Klipy,
    Giphy,
    Tenor,
    None,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Gif {
    /// `<provider>:<provider id>`.
    pub id: String,
    pub title: String,
    /// Direct media URL (GIF or WebP). Sending a GIF = a message whose content is this URL.
    pub url: String,
    /// Small still or low-res image for the picker grid.
    pub preview_url: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GifPage {
    pub provider: GifProvider,
    pub results: Vec<Gif>,
    /// Opaque cursor for the next page (`pos` query), `null` at the end.
    pub next: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GifCategory {
    pub name: String,
    pub image: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GifCategories {
    pub provider: GifProvider,
    pub categories: Vec<GifCategory>,
}

/// A saved message, as the owner sees it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Bookmark {
    pub message: Message,
    pub saved_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BookmarksPage {
    pub items: Vec<Bookmark>,
    pub has_more: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CreateReminderRequest {
    pub channel_id: Snowflake,
    pub message_id: Snowflake,
    /// ISO 8601; must be in the future and at most one year ahead.
    pub remind_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Reminder {
    pub id: Snowflake,
    pub channel_id: Snowflake,
    pub message_id: Snowflake,
    pub guild_id: Option<Snowflake>,
    pub remind_at: String,
    pub created_at: String,
    /// Set once the due notice was sent (REMINDER_DUE); the reminder stays listed until dismissed.
    pub delivered_at: Option<String>,
    /// `null` when the owner can no longer read the message.
    pub message: Option<Message>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GuildStickersUpdate {
    pub guild_id: Snowflake,
    pub stickers: Vec<Sticker>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BookmarkRemove {
    pub channel_id: Snowflake,
    pub message_id: Snowflake,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ApiError {
    pub code: u32,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub errors: Option<Value>,
}

// ---- Gateway ----

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GatewayPayload<T = Value> {
    pub op: GatewayOp,
    pub d: T,
    pub s: Option<u64>,
    pub t: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Hello {
    pub heartbeat_interval: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Identify {
    pub token: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Resume {
    pub token: String,
    pub session_id: String,
    pub seq: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PresenceUpdateRequest {
    pub status: PresenceStatus,
    #[serde(default)]
    pub custom_status: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GuildWithState {
    #[serde(flatten)]
    pub guild: Guild,
    pub channels: Vec<Channel>,
    pub members: Vec<GuildMember>,
    pub member_count: u32,
    pub stickers: Vec<Sticker>,
    /// Active threads the user can see (they are not part of `channels`); omitted when there are none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub threads: Vec<Channel>,
    /// Only on GUILD_CREATE: the presences of the guild's members that are not offline (READY has its own list).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presences: Option<Vec<Presence>>,
    /// Who is in the guild's voice channels the receiver can see.
    #[serde(default)]
    pub voice_states: Vec<VoiceState>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ReadyEvent {
    pub v: u8,
    pub user: User,
    pub session_id: String,
    pub guilds: Vec<GuildWithState>,
    pub private_channels: Vec<Channel>,
    pub presences: Vec<Presence>,
    pub read_states: Vec<ReadState>,
    pub relationships: Vec<Relationship>,
    pub media: InstanceMediaConfig,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MessageDelete {
    pub id: Snowflake,
    pub channel_id: Snowflake,
    pub guild_id: Option<Snowflake>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MessageReaction {
    pub user_id: Snowflake,
    pub channel_id: Snowflake,
    pub message_id: Snowflake,
    pub emoji: ReactionEmoji,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TypingStart {
    pub channel_id: Snowflake,
    pub user_id: Snowflake,
    pub timestamp: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GuildMemberAdd {
    #[serde(flatten)]
    pub member: GuildMember,
    pub guild_id: Snowflake,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GuildMemberRemove {
    pub guild_id: Snowflake,
    pub user: User,
}

/// GUILD_ROLE_CREATE and GUILD_ROLE_UPDATE.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GuildRoleEvent {
    pub guild_id: Snowflake,
    pub role: Role,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GuildRoleDelete {
    pub guild_id: Snowflake,
    pub role_id: Snowflake,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MessageAck {
    pub channel_id: Snowflake,
    pub message_id: Snowflake,
}

/// THREAD_DELETE.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ThreadDelete {
    pub id: Snowflake,
    pub guild_id: Snowflake,
    pub parent_id: Snowflake,
    #[serde(rename = "type")]
    pub kind: ChannelType,
}

/// THREAD_MEMBER_UPDATE.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ThreadMemberUpdate {
    #[serde(flatten)]
    pub member: ThreadMember,
    pub guild_id: Snowflake,
}

/// THREAD_MEMBERS_UPDATE.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ThreadMembersUpdate {
    pub id: Snowflake,
    pub guild_id: Snowflake,
    pub member_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added_members: Option<Vec<ThreadMember>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removed_member_ids: Option<Vec<Snowflake>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct IdOnly {
    pub id: Snowflake,
}

/// Every dispatch event (`t` → `d`).
#[derive(Clone, Debug, PartialEq)]
pub enum GatewayEvent {
    Ready(Box<ReadyEvent>),
    Resumed,
    MessageCreate(Box<Message>),
    MessageUpdate(Box<Message>),
    MessageDelete(MessageDelete),
    MessageReactionAdd(MessageReaction),
    MessageReactionRemove(MessageReaction),
    TypingStart(TypingStart),
    ChannelCreate(Channel),
    ChannelUpdate(Channel),
    ChannelDelete(Channel),
    GuildCreate(Box<GuildWithState>),
    GuildUpdate(Guild),
    GuildDelete(IdOnly),
    GuildMemberAdd(GuildMemberAdd),
    GuildMemberRemove(GuildMemberRemove),
    /// Same payload as GUILD_MEMBER_ADD.
    GuildMemberUpdate(GuildMemberAdd),
    GuildRoleCreate(GuildRoleEvent),
    GuildRoleUpdate(GuildRoleEvent),
    GuildRoleDelete(GuildRoleDelete),
    /// Same payload as GUILD_MEMBER_REMOVE.
    GuildBanAdd(GuildMemberRemove),
    GuildBanRemove(GuildMemberRemove),
    PresenceUpdate(Presence),
    UserUpdate(User),
    MessageAck(MessageAck),
    RelationshipAdd(Relationship),
    RelationshipRemove(IdOnly),
    GuildStickersUpdate(GuildStickersUpdate),
    BookmarkAdd(Box<Bookmark>),
    BookmarkRemove(BookmarkRemove),
    ReminderCreate(Box<Reminder>),
    ReminderDue(Box<Reminder>),
    ReminderDelete(IdOnly),
    VoiceStateUpdate(Box<VoiceState>),
    VoiceServerUpdate(VoiceServerUpdate),
    VoiceConnectFailed(VoiceConnectFailed),
    VoiceChannelStatusUpdate(VoiceChannelStatusUpdate),
    ThreadCreate(Channel),
    ThreadUpdate(Channel),
    ThreadDelete(ThreadDelete),
    ThreadMemberUpdate(ThreadMemberUpdate),
    ThreadMembersUpdate(ThreadMembersUpdate),
}

impl GatewayEvent {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Ready(_) => "READY",
            Self::Resumed => "RESUMED",
            Self::MessageCreate(_) => "MESSAGE_CREATE",
            Self::MessageUpdate(_) => "MESSAGE_UPDATE",
            Self::MessageDelete(_) => "MESSAGE_DELETE",
            Self::MessageReactionAdd(_) => "MESSAGE_REACTION_ADD",
            Self::MessageReactionRemove(_) => "MESSAGE_REACTION_REMOVE",
            Self::TypingStart(_) => "TYPING_START",
            Self::ChannelCreate(_) => "CHANNEL_CREATE",
            Self::ChannelUpdate(_) => "CHANNEL_UPDATE",
            Self::ChannelDelete(_) => "CHANNEL_DELETE",
            Self::GuildCreate(_) => "GUILD_CREATE",
            Self::GuildUpdate(_) => "GUILD_UPDATE",
            Self::GuildDelete(_) => "GUILD_DELETE",
            Self::GuildMemberAdd(_) => "GUILD_MEMBER_ADD",
            Self::GuildMemberRemove(_) => "GUILD_MEMBER_REMOVE",
            Self::GuildMemberUpdate(_) => "GUILD_MEMBER_UPDATE",
            Self::GuildRoleCreate(_) => "GUILD_ROLE_CREATE",
            Self::GuildRoleUpdate(_) => "GUILD_ROLE_UPDATE",
            Self::GuildRoleDelete(_) => "GUILD_ROLE_DELETE",
            Self::GuildBanAdd(_) => "GUILD_BAN_ADD",
            Self::GuildBanRemove(_) => "GUILD_BAN_REMOVE",
            Self::PresenceUpdate(_) => "PRESENCE_UPDATE",
            Self::UserUpdate(_) => "USER_UPDATE",
            Self::MessageAck(_) => "MESSAGE_ACK",
            Self::RelationshipAdd(_) => "RELATIONSHIP_ADD",
            Self::RelationshipRemove(_) => "RELATIONSHIP_REMOVE",
            Self::GuildStickersUpdate(_) => "GUILD_STICKERS_UPDATE",
            Self::BookmarkAdd(_) => "BOOKMARK_ADD",
            Self::BookmarkRemove(_) => "BOOKMARK_REMOVE",
            Self::ReminderCreate(_) => "REMINDER_CREATE",
            Self::ReminderDue(_) => "REMINDER_DUE",
            Self::ReminderDelete(_) => "REMINDER_DELETE",
            Self::VoiceStateUpdate(_) => "VOICE_STATE_UPDATE",
            Self::VoiceServerUpdate(_) => "VOICE_SERVER_UPDATE",
            Self::VoiceConnectFailed(_) => "VOICE_CONNECT_FAILED",
            Self::VoiceChannelStatusUpdate(_) => "VOICE_CHANNEL_STATUS_UPDATE",
            Self::ThreadCreate(_) => "THREAD_CREATE",
            Self::ThreadUpdate(_) => "THREAD_UPDATE",
            Self::ThreadDelete(_) => "THREAD_DELETE",
            Self::ThreadMemberUpdate(_) => "THREAD_MEMBER_UPDATE",
            Self::ThreadMembersUpdate(_) => "THREAD_MEMBERS_UPDATE",
        }
    }

    /// The `d` value of the dispatch.
    pub fn data(&self) -> Value {
        let result = match self {
            Self::Ready(value) => serde_json::to_value(value),
            Self::Resumed => Ok(Value::Object(Default::default())),
            Self::MessageCreate(value) | Self::MessageUpdate(value) => serde_json::to_value(value),
            Self::MessageDelete(value) => serde_json::to_value(value),
            Self::MessageReactionAdd(value) | Self::MessageReactionRemove(value) => serde_json::to_value(value),
            Self::TypingStart(value) => serde_json::to_value(value),
            Self::ChannelCreate(value) | Self::ChannelUpdate(value) | Self::ChannelDelete(value) => serde_json::to_value(value),
            Self::GuildCreate(value) => serde_json::to_value(value),
            Self::GuildUpdate(value) => serde_json::to_value(value),
            Self::GuildDelete(value) | Self::RelationshipRemove(value) => serde_json::to_value(value),
            Self::GuildMemberAdd(value) => serde_json::to_value(value),
            Self::GuildMemberRemove(value) | Self::GuildBanAdd(value) | Self::GuildBanRemove(value) => serde_json::to_value(value),
            Self::GuildMemberUpdate(value) => serde_json::to_value(value),
            Self::GuildRoleCreate(value) | Self::GuildRoleUpdate(value) => serde_json::to_value(value),
            Self::GuildRoleDelete(value) => serde_json::to_value(value),
            Self::PresenceUpdate(value) => serde_json::to_value(value),
            Self::UserUpdate(value) => serde_json::to_value(value),
            Self::MessageAck(value) => serde_json::to_value(value),
            Self::RelationshipAdd(value) => serde_json::to_value(value),
            Self::GuildStickersUpdate(value) => serde_json::to_value(value),
            Self::BookmarkAdd(value) => serde_json::to_value(value),
            Self::BookmarkRemove(value) => serde_json::to_value(value),
            Self::ReminderCreate(value) | Self::ReminderDue(value) => serde_json::to_value(value),
            Self::ReminderDelete(value) => serde_json::to_value(value),
            Self::VoiceStateUpdate(value) => serde_json::to_value(value),
            Self::VoiceServerUpdate(value) => serde_json::to_value(value),
            Self::VoiceConnectFailed(value) => serde_json::to_value(value),
            Self::VoiceChannelStatusUpdate(value) => serde_json::to_value(value),
            Self::ThreadCreate(value) | Self::ThreadUpdate(value) => serde_json::to_value(value),
            Self::ThreadDelete(value) => serde_json::to_value(value),
            Self::ThreadMemberUpdate(value) => serde_json::to_value(value),
            Self::ThreadMembersUpdate(value) => serde_json::to_value(value),
        };
        result.unwrap_or(Value::Null)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Parse a hand-written fixture (taken from types.ts), re-serialize and compare as JSON values so null/missing differences show.
    fn round_trip<T: Serialize + for<'de> Deserialize<'de>>(fixture: Value) {
        let parsed: T = serde_json::from_value(fixture.clone()).expect("fixture parses");
        assert_eq!(serde_json::to_value(&parsed).expect("serializes"), fixture);
    }

    fn user() -> Value {
        json!({"id": "100", "username": "sam", "global_name": null, "avatar": null, "banner_color": "#5865f2", "bio": null, "bot": false, "banner": null, "pronouns": null, "theme_colors": null, "avatar_decoration": null, "profile_effect": null, "primary_guild": null})
    }

    #[test]
    fn snowflake_is_a_string() {
        assert_eq!(serde_json::to_string(&Snowflake(1_234_567_890_123_456_789)).expect("ser"), "\"1234567890123456789\"");
        assert!(serde_json::from_str::<Snowflake>("\"abc\"").is_err());
    }

    #[test]
    fn user_and_presence() {
        round_trip::<User>(user());
        round_trip::<Presence>(json!({"user_id": "100", "status": "dnd", "custom_status": null}));
    }

    #[test]
    fn channel_keeps_optional_fields_optional() {
        round_trip::<Channel>(json!({
            "id": "200", "type": 0, "guild_id": "300", "name": "general", "topic": null, "position": 0, "parent_id": "201", "last_message_id": null
        }));
        round_trip::<Channel>(json!({
            "id": "202", "type": 3, "guild_id": null, "name": null, "topic": null, "position": 0, "parent_id": null,
            "recipients": [user()], "last_message_id": "5", "owner_id": "100", "icon": null
        }));
    }

    #[test]
    fn guild_role_and_member() {
        let role = json!({"id": "300", "name": "@everyone", "color": 0, "hoist": false, "position": 0, "permissions": "1071698660929", "mentionable": false});
        round_trip::<Role>(role.clone());
        round_trip::<Guild>(
            json!({"id": "300", "name": "Sam's server", "icon": null, "owner_id": "100", "roles": [role], "system_channel_id": "200", "tag": null, "theme": null}),
        );
        round_trip::<Guild>(json!({
            "id": "300", "name": "g", "icon": null, "owner_id": "100", "roles": [], "system_channel_id": null,
            "tag": {"tag": "VKO", "badge": "bolt", "color_primary": 5793266, "color_secondary": 3878800}, "theme": {"preset": null, "primary": 1, "accent": 2}
        }));
        round_trip::<GuildMember>(
            json!({"user": user(), "nick": null, "roles": ["301"], "joined_at": "2026-10-11T10:00:00.000Z", "communication_disabled_until": null, "avatar": null, "banner": null, "bio": null, "pronouns": null, "theme_colors": null}),
        );
    }

    #[test]
    fn profile_perks_shapes() {
        let mut perks = user();
        perks["banner"] = json!("http://x/banner.gif");
        perks["pronouns"] = json!("they/them");
        perks["theme_colors"] = json!([1, 2]);
        perks["avatar_decoration"] = json!("sparkle");
        perks["profile_effect"] = json!("snow");
        perks["primary_guild"] = json!({"guild_id": "300", "tag": "VKO", "badge": "bolt", "color_primary": 1, "color_secondary": 2});
        round_trip::<User>(perks);
        let edit: UpdateUserRequest = serde_json::from_value(json!({"pronouns": null, "theme_colors": [5, 6], "banner_attachment_id": "7"})).expect("edit");
        assert_eq!(edit.pronouns, Some(None));
        assert_eq!(edit.theme_colors, Some(Some([5, 6])));
        assert_eq!(edit.banner_attachment_id, Some(Some(Snowflake(7))));
        assert!(edit.bio.is_none() && edit.primary_guild_id.is_none());
        assert!(serde_json::from_value::<UpdateUserRequest>(json!({"theme_colors": [1, 2, 3]})).is_err());
        let own: EditOwnMemberRequest = serde_json::from_value(json!({"bio": null, "avatar_attachment_id": null})).expect("own");
        assert_eq!((own.bio, own.avatar_attachment_id), (Some(None), Some(None)));
        let guild: UpdateGuildRequest = serde_json::from_value(json!({"tag": null})).expect("guild");
        assert_eq!(guild.tag, Some(None));
        assert!(guild.theme.is_none());
    }

    #[test]
    fn message_with_reply_attachment_and_reaction() {
        let attachment = json!({"id": "9", "filename": "a.png", "content_type": "image/png", "size": 12, "url": "http://x/a.png", "width": 4, "height": 3});
        let reaction = json!({"emoji": {"id": null, "name": "👍"}, "count": 2, "me": true});
        let embed = json!({
            "type": "article", "title": "T", "description": "D", "url": "https://example.com/a", "color": 5793266,
            "image": {"url": "https://example.com/i.png", "width": 640, "height": 360}, "thumbnail": {"url": "https://example.com/t.png"},
            "provider": {"name": "Example", "url": "https://example.com"}
        });
        round_trip::<Embed>(embed.clone());
        round_trip::<Embed>(json!({
            "type": "rich", "timestamp": "2026-10-11T10:00:00.000Z", "footer": {"text": "f"}, "author": {"name": "a", "url": "https://x.io"},
            "fields": [{"name": "n", "value": "v", "inline": true}], "video": {"url": "https://x.io/v.mp4"}
        }));
        round_trip::<Embed>(json!({"type": "link"}));
        let inner = json!({
            "id": "11", "channel_id": "200", "guild_id": null, "author": user(), "content": "hi", "timestamp": "2026-10-11T10:00:00.000Z",
            "edited_timestamp": null, "type": 0, "mentions": [], "mention_everyone": false, "attachments": [], "embeds": [], "reactions": [], "pinned": false,
            "message_reference": null, "referenced_message": null, "nonce": null
        });
        round_trip::<Message>(inner.clone());
        round_trip::<Message>(json!({
            "id": "12", "channel_id": "200", "guild_id": "300", "author": user(), "member": {"nick": "R", "roles": []}, "content": "re",
            "timestamp": "2026-10-11T10:01:00.000Z", "edited_timestamp": "2026-10-11T10:02:00.000Z", "type": 19, "mentions": [user()],
            "mention_everyone": true, "attachments": [attachment], "embeds": [embed], "reactions": [reaction], "pinned": true,
            "message_reference": {"message_id": "11", "channel_id": "200", "guild_id": "300"}, "referenced_message": inner, "nonce": "n1"
        }));
    }

    #[test]
    fn permission_table_is_complete() {
        use super::permissions::*;
        let mut seen = 0_u64;
        for (name, bit) in NAMED {
            assert_eq!(bit.count_ones(), 1, "{name} is a single bit");
            assert_eq!(seen & bit, 0, "{name} is unique");
            seen |= bit;
        }
        assert_eq!(NAMED.len(), 53);
        assert_eq!(seen, ALL);
        assert_eq!(ALL & (1 << 47), 0, "bit 47 is unassigned");
        assert_eq!(NAMED.last().map(|(_, bit)| bit.trailing_zeros()), Some(53));
        assert_eq!(DEFAULT_EVERYONE.count_ones(), 26);
        assert_eq!(DEFAULT_EVERYONE & !ALL, 0);
        assert_eq!(DEFAULT_EVERYONE & ADMINISTRATOR, 0);
        assert_ne!(DEFAULT_EVERYONE & VIEW_CHANNEL, 0);
    }

    #[test]
    fn requests_and_errors() {
        round_trip::<AuthRequest>(json!({"login": "sam", "password": "pw"}));
        round_trip::<RegisterRequest>(json!({"email": "r@x.io", "username": "sam", "password": "pw"}));
        round_trip::<AuthResponse>(json!({"token": "t", "user": user()}));
        round_trip::<CreateMessageRequest>(json!({"content": "x", "nonce": "1", "message_reference": {"message_id": "5"}, "attachment_ids": ["6"]}));
        round_trip::<EditMessageRequest>(json!({"content": "x"}));
        round_trip::<EditMessageRequest>(json!({"content": "x", "flags": SUPPRESS_EMBEDS}));
        round_trip::<EditMessageRequest>(json!({"attachments": [{"id": "6"}]}));
        round_trip::<CreateMessageRequest>(json!({"attachments": [{"id": "6", "filename": "SPOILER_a.png", "description": "a cat"}, {"id": "7"}]}));
        round_trip::<Attachment>(
            json!({"id": "6", "filename": "a.png", "content_type": "image/png", "size": 3, "url": "http://x/a", "width": 1, "height": 2, "description": "a cat"}),
        );
        round_trip::<PutRelationshipRequest>(json!({}));
        round_trip::<PutRelationshipRequest>(json!({"type": 2}));
        round_trip::<UserProfile>(json!({"user": user(), "mutual_guilds": [{"id": "300", "nick": null}], "mutual_friends_count": 2}));
        round_trip::<UserProfile>(json!({
            "user": user(), "mutual_guilds": [], "mutual_friends_count": 0,
            "guild_member": {"user": user(), "nick": "R", "roles": [], "joined_at": "2026-10-11T10:00:00.000Z", "communication_disabled_until": null, "avatar": null, "banner": null, "bio": null, "pronouns": null, "theme_colors": null}
        }));
        round_trip::<CreateMessageRequest>(json!({"content": "x", "allowed_mentions": {"parse": ["users"], "users": ["5"], "replied_user": false}}));
        round_trip::<AckBulkRequest>(json!({"read_states": [{"channel_id": "1", "message_id": "2"}]}));
        round_trip::<RateLimitError>(json!({"message": "You are being rate limited.", "retry_after": 1.5, "global": false}));
        round_trip::<PinnedMessagesPage>(json!({"items": [], "has_more": false}));
        round_trip::<MessageSearchResponse>(json!({"total_results": 0, "messages": []}));
        round_trip::<ApiError>(json!({"code": 50035, "message": "Invalid Form Body", "errors": {"content": ["too long"]}}));
        round_trip::<ApiError>(json!({"code": 0, "message": "401: Unauthorized"}));
    }

    #[test]
    fn stickers_forwards_gifs_bookmarks_reminders() {
        let sticker = json!({
            "id": "70", "guild_id": "300", "name": "wave", "description": null, "tags": "hi,wave", "format_type": 5,
            "url": "http://x/a.webp", "available": true
        });
        round_trip::<Sticker>(sticker.clone());
        round_trip::<Sticker>(json!({
            "id": "70", "guild_id": "300", "name": "wave", "description": "d", "tags": "hi", "format_type": 2, "url": "http://x/a.png",
            "available": true, "user": user()
        }));
        let item = json!({"id": "70", "name": "wave", "format_type": 1, "url": "http://x/a.png"});
        round_trip::<StickerItem>(item.clone());
        let snapshot = json!({"message": {
            "type": 0, "content": "hi", "timestamp": "2026-10-11T10:00:00.000Z", "edited_timestamp": null, "mentions": [],
            "attachments": [], "embeds": [], "sticker_items": [item]
        }});
        round_trip::<MessageSnapshot>(snapshot.clone());
        round_trip::<Message>(json!({
            "id": "13", "channel_id": "201", "guild_id": null, "author": user(), "content": "", "timestamp": "2026-10-11T10:03:00.000Z",
            "edited_timestamp": null, "type": 0, "mentions": [], "mention_everyone": false, "attachments": [], "embeds": [], "reactions": [],
            "pinned": false, "message_reference": {"type": 1, "message_id": "11", "channel_id": "200", "guild_id": "300"},
            "referenced_message": null, "nonce": null, "message_snapshots": [snapshot], "sticker_items": [item]
        }));
        round_trip::<CreateMessageRequest>(json!({"sticker_ids": ["70"]}));
        round_trip::<CreateMessageRequest>(json!({"message_reference": {"type": 1, "message_id": "11", "channel_id": "200"}}));
        round_trip::<CreateStickerRequest>(json!({"name": "wave", "tags": "hi", "attachment_id": "9"}));
        let gif = json!({"id": "giphy:abc", "title": "t", "url": "http://x/a.gif", "preview_url": "http://x/p.gif", "width": 200, "height": 100});
        round_trip::<GifPage>(json!({"provider": "giphy", "results": [gif], "next": "25"}));
        round_trip::<GifPage>(json!({"provider": "none", "results": [], "next": null}));
        round_trip::<GifCategories>(json!({"provider": "tenor", "categories": [{"name": "happy", "image": "http://x/c.gif"}]}));
        round_trip::<CreateReminderRequest>(json!({"channel_id": "200", "message_id": "11", "remind_at": "2026-10-11T11:00:00.000Z"}));
        round_trip::<Reminder>(json!({
            "id": "80", "channel_id": "200", "message_id": "11", "guild_id": null, "remind_at": "2026-10-11T11:00:00.000Z",
            "created_at": "2026-10-11T10:00:00.000Z", "delivered_at": null, "message": null
        }));
        round_trip::<BookmarksPage>(json!({"items": [], "has_more": false}));
    }

    #[test]
    fn gateway_payloads() {
        round_trip::<GatewayPayload>(json!({"op": 10, "d": {"heartbeat_interval": 41250}, "s": null, "t": null}));
        round_trip::<GatewayPayload>(json!({"op": 0, "d": {"id": "1"}, "s": 3, "t": "GUILD_DELETE"}));
        round_trip::<ReadState>(json!({"channel_id": "1", "last_message_id": null, "mention_count": 0}));
        round_trip::<Relationship>(json!({"id": "100", "type": 3, "user": user()}));
    }

    #[test]
    fn ready_and_flattened_guild_events() {
        let guild = json!({"id": "300", "name": "g", "icon": null, "owner_id": "100", "roles": [], "system_channel_id": null, "tag": null, "theme": null});
        let with_state = {
            let mut value = guild.clone();
            value["channels"] = json!([]);
            value["members"] = json!([{"user": user(), "nick": null, "roles": [], "joined_at": "2026-10-11T10:00:00.000Z", "communication_disabled_until": null, "avatar": null, "banner": null, "bio": null, "pronouns": null, "theme_colors": null}]);
            value["member_count"] = json!(1);
            value["stickers"] = json!([]);
            value["voice_states"] = json!([]);
            value
        };
        round_trip::<GuildWithState>(with_state.clone());
        round_trip::<ReadyEvent>(json!({
            "v": 1, "user": user(), "session_id": "abc", "guilds": [with_state], "private_channels": [], "presences": [], "read_states": [], "relationships": [],
            "media": {"voice_enabled": true, "voice_bitrate_ceiling": 128000, "screenshare_qualities": ["720p30", "1080p60"], "video_enabled": false}
        }));
        round_trip::<GuildMemberAdd>(
            json!({"user": user(), "nick": null, "roles": [], "joined_at": "2026-10-11T10:00:00.000Z", "communication_disabled_until": "2026-10-12T10:00:00.000Z", "avatar": null, "banner": null, "bio": null, "pronouns": null, "theme_colors": null, "guild_id": "300"}),
        );
        round_trip::<MessageDelete>(json!({"id": "1", "channel_id": "2", "guild_id": null}));
        round_trip::<MessageReaction>(json!({"user_id": "1", "channel_id": "2", "message_id": "3", "emoji": {"id": null, "name": "🎉"}}));
        round_trip::<TypingStart>(json!({"channel_id": "2", "user_id": "1", "timestamp": 1_760_000_000}));
        round_trip::<MessageAck>(json!({"channel_id": "2", "message_id": "3"}));
    }

    #[test]
    fn moderation_shapes_match_types_ts() {
        let overwrite = json!({"id": "301", "type": 0, "allow": "0", "deny": "1024"});
        round_trip::<PermissionOverwrite>(overwrite.clone());
        round_trip::<PermissionOverwrite>(json!({"id": "100", "type": 1, "allow": "2048", "deny": "0"}));
        round_trip::<Channel>(json!({
            "id": "200", "type": 0, "guild_id": "300", "name": "mods", "topic": null, "position": 1, "parent_id": null, "last_message_id": null,
            "permission_overwrites": [overwrite]
        }));
        round_trip::<Ban>(json!({"user": user(), "reason": null}));
        let edit: EditMemberRequest = serde_json::from_value(json!({"nick": null, "communication_disabled_until": "2026-10-12T10:00:00.000Z"})).expect("edit");
        assert_eq!(edit.nick, Some(None));
        assert_eq!(edit.communication_disabled_until, Some(Some("2026-10-12T10:00:00.000Z".to_owned())));
        assert!(edit.roles.is_none());
        let untouched: EditMemberRequest = serde_json::from_value(json!({})).expect("empty edit");
        assert!(untouched.nick.is_none() && untouched.communication_disabled_until.is_none());
        let ban: BanRequest = serde_json::from_value(json!({"delete_message_seconds": 60, "reason": "spam"})).expect("ban");
        assert_eq!((ban.delete_message_seconds, ban.reason.as_deref()), (Some(60), Some("spam")));
        let role: RoleRequest = serde_json::from_value(json!({"name": "mod", "color": 255, "permissions": "8192"})).expect("role");
        assert_eq!((role.name.as_deref(), role.color, role.permissions.as_deref(), role.hoist), (Some("mod"), Some(255), Some("8192"), None));
        round_trip::<RolePositionUpdate>(json!({"id": "301", "position": 2}));
        let request: OverwriteRequest = serde_json::from_value(json!({"type": 1, "allow": "1", "deny": "2"})).expect("overwrite");
        assert_eq!(request.kind, OverwriteType::Member);
        assert!(serde_json::from_value::<OverwriteRequest>(json!({"type": 2, "allow": "0", "deny": "0"})).is_err());
        let own: EditOwnMemberRequest = serde_json::from_value(json!({"nick": "R"})).expect("own nick");
        assert_eq!(own.nick, Some(Some("R".to_owned())));
    }

    #[test]
    fn moderation_events_and_invisible_presence() {
        let role = Role { id: Snowflake(301), name: "mod".to_owned(), color: 0, hoist: false, position: 1, permissions: "8192".to_owned(), mentionable: false };
        let created = GatewayEvent::GuildRoleCreate(GuildRoleEvent { guild_id: Snowflake(300), role: role.clone() });
        assert_eq!(created.name(), "GUILD_ROLE_CREATE");
        assert_eq!(created.data()["role"]["name"], "mod");
        assert_eq!(GatewayEvent::GuildRoleUpdate(GuildRoleEvent { guild_id: Snowflake(300), role }).name(), "GUILD_ROLE_UPDATE");
        let deleted = GatewayEvent::GuildRoleDelete(GuildRoleDelete { guild_id: Snowflake(300), role_id: Snowflake(301) });
        assert_eq!((deleted.name(), deleted.data()), ("GUILD_ROLE_DELETE", json!({"guild_id": "300", "role_id": "301"})));
        let removed = GuildMemberRemove { guild_id: Snowflake(300), user: serde_json::from_value(user()).expect("user") };
        assert_eq!(GatewayEvent::GuildBanAdd(removed.clone()).name(), "GUILD_BAN_ADD");
        assert_eq!(GatewayEvent::GuildBanRemove(removed).data()["user"]["username"], "sam");
        round_trip::<Presence>(json!({"user_id": "100", "status": "invisible", "custom_status": "brb"}));
        assert_eq!(PresenceStatus::parse("invisible"), Some(PresenceStatus::Invisible));
    }

    #[test]
    fn thread_and_forum_shapes_match_types_ts() {
        let tag = json!({"id": "900", "name": "bug", "moderated": false, "emoji_id": null, "emoji_name": "🐛"});
        round_trip::<ForumTag>(tag.clone());
        round_trip::<Channel>(json!({
            "id": "210", "type": 15, "guild_id": "300", "name": "help", "topic": null, "position": 2, "parent_id": null, "last_message_id": null,
            "permission_overwrites": [], "available_tags": [tag], "default_reaction_emoji": {"emoji_id": null, "emoji_name": "👍"},
            "default_sort_order": 1, "default_forum_layout": 2, "default_auto_archive_duration": 4320, "flags": 16
        }));
        let thread = json!({
            "id": "11", "type": 11, "guild_id": "300", "name": "a thread", "topic": null, "position": 0, "parent_id": "200", "last_message_id": "12",
            "owner_id": "100", "permission_overwrites": [], "message_count": 3, "member_count": 2, "newly_created": true, "applied_tags": ["900"],
            "member": {"id": "11", "user_id": "100", "join_timestamp": "2026-10-11T10:00:00.000Z", "flags": 0},
            "thread_metadata": {"archived": false, "auto_archive_duration": 1440, "archive_timestamp": "2026-10-11T10:00:00.000Z", "locked": false, "invitable": true, "create_timestamp": "2026-10-11T10:00:00.000Z"}
        });
        round_trip::<Channel>(thread.clone());
        round_trip::<ThreadListResponse>(json!({"threads": [thread.clone()], "members": [], "has_more": false}));
        let message = json!({
            "id": "11", "channel_id": "200", "guild_id": "300", "author": user(), "content": "start", "timestamp": "2026-10-11T10:00:00.000Z",
            "edited_timestamp": null, "type": 0, "mentions": [], "mention_everyone": false, "attachments": [], "embeds": [], "reactions": [], "pinned": false,
            "message_reference": null, "referenced_message": null, "nonce": null, "flags": 1, "thread": thread.clone()
        });
        round_trip::<Message>(message.clone());
        round_trip::<ThreadSearchResponse>(
            json!({"threads": [thread.clone()], "members": [], "first_messages": [message], "has_more": false, "total_results": 1}),
        );
        assert_eq!(MessageType::from_u8(18), Some(MessageType::ThreadCreated));
        assert_eq!(MessageType::from_u8(21), Some(MessageType::ThreadStarterMessage));
        assert!(ChannelType::PrivateThread.is_thread() && !ChannelType::GuildForum.is_thread());
        round_trip::<ChannelFollower>(json!({
            "id": "5", "channel_id": "200", "guild_id": "300", "source_channel_id": "400", "source_channel_name": "news", "source_guild_id": "500", "source_guild_name": "Other"
        }));
        round_trip::<FollowedChannel>(json!({"channel_id": "400", "webhook_id": "5"}));
        let clear: UpdateChannelRequest =
            serde_json::from_value(json!({"default_reaction_emoji": null, "archived": true, "auto_archive_duration": 60})).expect("edit");
        assert_eq!(clear.default_reaction_emoji, Some(None));
        assert_eq!((clear.archived, clear.auto_archive_duration), (Some(true), Some(60)));
        assert!(serde_json::from_value::<UpdateChannelRequest>(json!({})).expect("empty").default_reaction_emoji.is_none());
        let post: StartForumPostRequest = serde_json::from_value(json!({"name": "q", "applied_tags": ["900"], "message": {"content": "hi"}})).expect("post");
        assert_eq!((post.name.as_str(), post.message.content.as_deref()), ("q", Some("hi")));
        let start: StartThreadRequest = serde_json::from_value(json!({"name": "t", "type": 12, "invitable": false})).expect("start");
        assert_eq!(start.kind, Some(ChannelType::PrivateThread));
    }

    #[test]
    fn thread_events_match_the_contract() {
        let member = ThreadMember { id: Snowflake(11), user_id: Snowflake(100), join_timestamp: "2026-10-11T10:00:00.000Z".to_owned(), flags: 0 };
        let deleted = GatewayEvent::ThreadDelete(ThreadDelete {
            id: Snowflake(11),
            guild_id: Snowflake(300),
            parent_id: Snowflake(200),
            kind: ChannelType::PublicThread,
        });
        assert_eq!((deleted.name(), deleted.data()), ("THREAD_DELETE", json!({"id": "11", "guild_id": "300", "parent_id": "200", "type": 11})));
        let update = GatewayEvent::ThreadMemberUpdate(ThreadMemberUpdate { member: member.clone(), guild_id: Snowflake(300) });
        assert_eq!(update.name(), "THREAD_MEMBER_UPDATE");
        assert_eq!(update.data(), json!({"id": "11", "user_id": "100", "join_timestamp": "2026-10-11T10:00:00.000Z", "flags": 0, "guild_id": "300"}));
        let members = GatewayEvent::ThreadMembersUpdate(ThreadMembersUpdate {
            id: Snowflake(11),
            guild_id: Snowflake(300),
            member_count: 2,
            added_members: Some(vec![member]),
            removed_member_ids: None,
        });
        assert_eq!(members.name(), "THREAD_MEMBERS_UPDATE");
        assert!(members.data().get("removed_member_ids").is_none());
        assert_eq!(
            GatewayEvent::ThreadCreate(
                serde_json::from_value(json!({
                    "id": "11", "type": 11, "guild_id": "300", "name": "t", "topic": null, "position": 0, "parent_id": "200", "last_message_id": null
                }))
                .expect("channel")
            )
            .name(),
            "THREAD_CREATE"
        );
    }

    #[test]
    fn event_names_match_the_contract() {
        let event = GatewayEvent::MessageAck(MessageAck { channel_id: Snowflake(2), message_id: Snowflake(3) });
        assert_eq!(event.name(), "MESSAGE_ACK");
        assert_eq!(event.data(), json!({"channel_id": "2", "message_id": "3"}));
    }

    #[test]
    fn voice_shapes_match_types_ts() {
        let state = json!({
            "guild_id": "300", "channel_id": "201", "user_id": "100", "session_id": "abc", "deaf": false, "mute": false, "self_deaf": false,
            "self_mute": true, "self_video": false, "self_stream": false, "suppress": false, "request_to_speak_timestamp": null,
            "connected_at": "2026-10-11T10:00:00.000Z"
        });
        round_trip::<VoiceState>(state.clone());
        let mut left = state.clone();
        left["channel_id"] = Value::Null;
        round_trip::<VoiceState>(left);
        round_trip::<Channel>(json!({
            "id": "201", "type": 2, "guild_id": "300", "name": "General", "topic": null, "position": 0, "parent_id": null, "last_message_id": null,
            "permission_overwrites": [], "bitrate": 64000, "user_limit": 0, "status": null
        }));
        let command: VoiceStateUpdateCommand = serde_json::from_value(json!({"guild_id": "300", "channel_id": null})).expect("op 4");
        assert_eq!((command.channel_id, command.self_mute, command.self_deaf), (None, false, false));
        round_trip::<VoiceStateUpdateCommand>(json!({"guild_id": null, "channel_id": "201", "self_mute": true, "self_deaf": false, "self_video": false}));
        let server = GatewayEvent::VoiceServerUpdate(VoiceServerUpdate {
            guild_id: Some(Snowflake(300)),
            channel_id: Snowflake(201),
            endpoint: "wss://lk.example.org".to_owned(),
            token: "t".to_owned(),
            session_id: "abc".to_owned(),
        });
        assert_eq!(
            (server.name(), server.data()),
            ("VOICE_SERVER_UPDATE", json!({"guild_id": "300", "channel_id": "201", "endpoint": "wss://lk.example.org", "token": "t", "session_id": "abc"}))
        );
        let status = GatewayEvent::VoiceChannelStatusUpdate(VoiceChannelStatusUpdate { id: Snowflake(201), guild_id: Snowflake(300), status: None });
        assert_eq!((status.name(), status.data()), ("VOICE_CHANNEL_STATUS_UPDATE", json!({"id": "201", "guild_id": "300", "status": null})));
        let failed =
            GatewayEvent::VoiceConnectFailed(VoiceConnectFailed { guild_id: None, channel_id: Snowflake(5), reason: VoiceConnectFailure::ChannelFull });
        assert_eq!((failed.name(), failed.data()), ("VOICE_CONNECT_FAILED", json!({"guild_id": null, "channel_id": "5", "reason": "channel_full"})));
        let parsed: VoiceState = serde_json::from_value(state).expect("state");
        assert_eq!(GatewayEvent::VoiceStateUpdate(Box::new(parsed)).name(), "VOICE_STATE_UPDATE");
        assert_eq!(serde_json::to_value(GatewayOp::VoiceStateUpdate).expect("op"), json!(4));
    }

    #[test]
    fn permission_bits_match_discord() {
        assert_eq!(permissions::VIEW_CHANNEL, 1024);
        assert_eq!(permissions::SEND_MESSAGES, 2048);
        assert_eq!(permissions::MANAGE_MESSAGES, 8192);
        assert_eq!(permissions::ADMINISTRATOR, 8);
        assert_eq!(permissions::DEFAULT_EVERYONE & (1 | 64 | 1024 | 2048 | 32768 | 65536 | 131072), 1 | 64 | 1024 | 2048 | 32768 | 65536 | 131072);
    }
}
