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

numeric_enum!(ChannelType { GuildText = 0, Dm = 1, GuildVoice = 2, GroupDm = 3, GuildCategory = 4 });
numeric_enum!(MessageType { Default = 0, RecipientAdd = 1, RecipientRemove = 2, ChannelNameChange = 4, ChannelPinnedMessage = 6, UserJoin = 7, Reply = 19 });
numeric_enum!(RelationshipType { Friend = 1, Blocked = 2, IncomingRequest = 3, OutgoingRequest = 4 });
numeric_enum!(GatewayOp {
    Dispatch = 0,
    Heartbeat = 1,
    Identify = 2,
    PresenceUpdate = 3,
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
    Offline,
}

impl PresenceStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Online => "online",
            Self::Idle => "idle",
            Self::Dnd => "dnd",
            Self::Offline => "offline",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "online" => Some(Self::Online),
            "idle" => Some(Self::Idle),
            "dnd" => Some(Self::Dnd),
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
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GuildMember {
    pub user: User,
    pub nick: Option<String>,
    pub roles: Vec<Snowflake>,
    pub joined_at: String,
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
    pub message_id: Snowflake,
    pub channel_id: Snowflake,
    pub guild_id: Option<Snowflake>,
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
    pub message_id: Snowflake,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_mentions: Option<AllowedMentions>,
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
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flags: Option<u32>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct UpdateUserRequest {
    #[serde(default)]
    pub global_name: Option<String>,
    #[serde(default)]
    pub bio: Option<String>,
    #[serde(default)]
    pub banner_color: Option<String>,
    #[serde(default)]
    pub avatar_attachment_id: Option<Snowflake>,
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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MessageAck {
    pub channel_id: Snowflake,
    pub message_id: Snowflake,
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
    PresenceUpdate(Presence),
    UserUpdate(User),
    MessageAck(MessageAck),
    RelationshipAdd(Relationship),
    RelationshipRemove(IdOnly),
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
            Self::PresenceUpdate(_) => "PRESENCE_UPDATE",
            Self::UserUpdate(_) => "USER_UPDATE",
            Self::MessageAck(_) => "MESSAGE_ACK",
            Self::RelationshipAdd(_) => "RELATIONSHIP_ADD",
            Self::RelationshipRemove(_) => "RELATIONSHIP_REMOVE",
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
            Self::GuildMemberRemove(value) => serde_json::to_value(value),
            Self::PresenceUpdate(value) => serde_json::to_value(value),
            Self::UserUpdate(value) => serde_json::to_value(value),
            Self::MessageAck(value) => serde_json::to_value(value),
            Self::RelationshipAdd(value) => serde_json::to_value(value),
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
        json!({"id": "100", "username": "sam", "global_name": null, "avatar": null, "banner_color": "#5865f2", "bio": null, "bot": false})
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
        round_trip::<Guild>(json!({"id": "300", "name": "Sam's server", "icon": null, "owner_id": "100", "roles": [role], "system_channel_id": "200"}));
        round_trip::<GuildMember>(json!({"user": user(), "nick": null, "roles": ["301"], "joined_at": "2026-10-11T10:00:00.000Z"}));
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
        round_trip::<PutRelationshipRequest>(json!({}));
        round_trip::<PutRelationshipRequest>(json!({"type": 2}));
        round_trip::<UserProfile>(json!({"user": user(), "mutual_guilds": [{"id": "300", "nick": null}], "mutual_friends_count": 2}));
        round_trip::<UserProfile>(json!({
            "user": user(), "mutual_guilds": [], "mutual_friends_count": 0,
            "guild_member": {"user": user(), "nick": "R", "roles": [], "joined_at": "2026-10-11T10:00:00.000Z"}
        }));
        round_trip::<CreateMessageRequest>(json!({"content": "x", "allowed_mentions": {"parse": ["users"], "users": ["5"], "replied_user": false}}));
        round_trip::<AckBulkRequest>(json!({"read_states": [{"channel_id": "1", "message_id": "2"}]}));
        round_trip::<RateLimitError>(json!({"message": "You are being rate limited.", "retry_after": 1.5, "global": false}));
        round_trip::<PinnedMessagesPage>(json!({"items": [], "has_more": false}));
        round_trip::<ApiError>(json!({"code": 50035, "message": "Invalid Form Body", "errors": {"content": ["too long"]}}));
        round_trip::<ApiError>(json!({"code": 0, "message": "401: Unauthorized"}));
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
        let guild = json!({"id": "300", "name": "g", "icon": null, "owner_id": "100", "roles": [], "system_channel_id": null});
        let with_state = {
            let mut value = guild.clone();
            value["channels"] = json!([]);
            value["members"] = json!([{"user": user(), "nick": null, "roles": [], "joined_at": "2026-10-11T10:00:00.000Z"}]);
            value["member_count"] = json!(1);
            value
        };
        round_trip::<GuildWithState>(with_state.clone());
        round_trip::<ReadyEvent>(json!({
            "v": 1, "user": user(), "session_id": "abc", "guilds": [with_state], "private_channels": [], "presences": [], "read_states": [], "relationships": []
        }));
        round_trip::<GuildMemberAdd>(json!({"user": user(), "nick": null, "roles": [], "joined_at": "2026-10-11T10:00:00.000Z", "guild_id": "300"}));
        round_trip::<MessageDelete>(json!({"id": "1", "channel_id": "2", "guild_id": null}));
        round_trip::<MessageReaction>(json!({"user_id": "1", "channel_id": "2", "message_id": "3", "emoji": {"id": null, "name": "🎉"}}));
        round_trip::<TypingStart>(json!({"channel_id": "2", "user_id": "1", "timestamp": 1_760_000_000}));
        round_trip::<MessageAck>(json!({"channel_id": "2", "message_id": "3"}));
    }

    #[test]
    fn event_names_match_the_contract() {
        let event = GatewayEvent::MessageAck(MessageAck { channel_id: Snowflake(2), message_id: Snowflake(3) });
        assert_eq!(event.name(), "MESSAGE_ACK");
        assert_eq!(event.data(), json!({"channel_id": "2", "message_id": "3"}));
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
