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
    ($(#[$meta:meta])* $name:ident { $($(#[$vmeta:meta])* $variant:ident = $value:expr),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum $name {
            $($(#[$vmeta])* $variant = $value),+
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
    Call = 3,
    ChannelNameChange = 4,
    ChannelPinnedMessage = 6,
    UserJoin = 7,
    ThreadCreated = 18,
    Reply = 19,
    ChatInputCommand = 20,
    ThreadStarterMessage = 21,
    ContextMenuCommand = 23,
    PollResult = 46,
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
    /// Interaction response visible only to the user who ran the command.
    pub const EPHEMERAL: u32 = 1 << 6;
    /// Deferred interaction response ("is thinking...") until the bot edits `@original`.
    pub const LOADING: u32 = 1 << 7;
    /// A voice message: one audio attachment and no content; sending one needs `SEND_VOICE_MESSAGES`.
    pub const IS_VOICE_MESSAGE: u32 = 1 << 13;
}
numeric_enum!(
    /// `MessageReference.type`: 0 = reply / default, 1 = forward (`message_snapshots` carries the copy).
    MessageReferenceType { Default = 0, Forward = 1 }
);
numeric_enum!(
    /// `Sticker.format_type`. Discord's LOTTIE (3) is not supported; WebP (5) is Vokko's addition.
    StickerFormat { Png = 1, Apng = 2, Gif = 4, Webp = 5 }
);
numeric_enum!(
    /// Reaction `type`: 0 = normal, 1 = burst (super reaction).
    ReactionType { Normal = 0, Burst = 1 }
);
numeric_enum!(OverwriteType { Role = 0, Member = 1 });
numeric_enum!(ScheduledEventEntityType { StageInstance = 1, Voice = 2, External = 3 });
numeric_enum!(ScheduledEventStatus { Scheduled = 1, Active = 2, Completed = 3, Canceled = 4 });
numeric_enum!(RecurrenceFrequency { Yearly = 0, Monthly = 1, Weekly = 2, Daily = 3 });
numeric_enum!(OnboardingPromptType { MultipleChoice = 0, Dropdown = 1 });
numeric_enum!(OnboardingMode { Default = 0, Advanced = 1 });
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
    /// Vokko-only (docs/design/bot-control.md): pause, seek, skip, stop and reorder Watch Together, Stremio and Spotify in a call.
    /// High on purpose, so Discord's future bits never collide.
    pub const CONTROL_MEDIA: u64 = 1 << 60;

    /// Every defined permission bit (what the owner and administrators resolve to).
    pub const ALL: u64 = ((1 << 54) - 1 - (1 << 47)) | CONTROL_MEDIA;
    /// Every permission name with its bit, in bit order.
    pub const NAMED: [(&str, u64); 54] = [
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
        ("CONTROL_MEDIA", CONTROL_MEDIA),
    ];
    /// What the @everyone role of a new guild grants: the 27-bit default set of the Discord client, plus Vokko's CONTROL_MEDIA.
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
        | USE_EXTERNAL_SOUNDS
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
        | USE_EXTERNAL_APPS
        | CONTROL_MEDIA;
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
    /// Id of a nameplate (the background of the user's row in member and DM lists) in the client's open set.
    #[serde(default)]
    pub nameplate: Option<String>,
    #[serde(default)]
    pub display_name_styles: Option<DisplayNameStyles>,
    /// Id of a profile frame (a decorative border around the whole profile card) in the client's open set.
    #[serde(default)]
    pub profile_frame: Option<String>,
    /// Profile board widgets; `null` when none are set.
    #[serde(default)]
    pub widgets: Option<ProfileWidgets>,
}

/// Display name style: a font and an effect from the client's open set, with one or two RGB colours.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DisplayNameStyles {
    pub font_id: String,
    pub effect_id: String,
    pub colors: Vec<u32>,
}

/// The profile board: at most these two widgets.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ProfileWidgets {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub favorite_game: Option<FavoriteGame>,
    /// Up to 20 entries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub games_i_like: Option<Vec<GameEntry>>,
}

/// A game on the profile board: `name` is 1-64 characters, the image one of the owner's uploads.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GameEntry {
    pub name: String,
    pub image: Option<String>,
    pub image_attachment_id: Option<Snowflake>,
}

/// A `GameEntry` with why it is the favourite (up to 190 characters) and up to 5 tags of 1-20 characters.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FavoriteGame {
    pub name: String,
    pub image: Option<String>,
    pub image_attachment_id: Option<Snowflake>,
    pub reason: Option<String>,
    pub tags: Vec<String>,
}

/// `PATCH /users/@me` `widgets`: replaces the whole value. Keys other than the two below are collected in `unknown` so the route can refuse them.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct ProfileWidgetsInput {
    #[serde(default, deserialize_with = "double_option")]
    pub favorite_game: Option<Option<FavoriteGameInput>>,
    #[serde(default, deserialize_with = "double_option")]
    pub games_i_like: Option<Option<Vec<GameEntryInput>>>,
    #[serde(flatten)]
    pub unknown: std::collections::BTreeMap<String, serde::de::IgnoredAny>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct GameEntryInput {
    pub name: String,
    /// An upload owned by the caller; echoing the id of an image already on the profile keeps it.
    #[serde(default)]
    pub image_attachment_id: Option<Snowflake>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct FavoriteGameInput {
    pub name: String,
    #[serde(default)]
    pub image_attachment_id: Option<Snowflake>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
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
    /// What the user is doing (a detected game and Spotify on the desktop app); at most one of each kind. Omitted when empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub activities: Vec<Activity>,
}

/// An activity shown next to a user's presence: type 0 "Playing" (a detected game or app) or type 2 "Listening" (Spotify only).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Activity {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamps: Option<ActivityTimestamps>,
    /// Listening only: the track title.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
    /// Listening only: the artists, joined with "; ".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    /// Playing: the app's icon as `app:<64 hex>` (the SHA-256 of the 64x64 PNG the server stores, `POST /app-icons`). Listening: the
    /// album art as `spotify:<40 hex>` (Spotify's image id).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assets: Option<ActivityAssets>,
    /// Listening only: the Spotify track id (22 letters or digits).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_id: Option<String>,
    /// Playing only: the sender marks a program it did not take from its list of games (an app the user added), so viewers say
    /// "Using X" instead of "Playing X". Absent or false is a game, which is what clients that predate the flag send.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub app: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivityTimestamps {
    /// Unix time in milliseconds when the activity began.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<i64>,
    /// Listening only: unix time in milliseconds when the track ends.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivityAssets {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub large_image: Option<String>,
}

impl Activity {
    /// "Playing".
    pub const PLAYING: u8 = 0;
    /// Prefix of a Playing activity's `assets.large_image`: `app:<64 lowercase hex>`.
    pub const APP_IMAGE_PREFIX: &'static str = "app:";
    /// "Listening to Spotify".
    pub const LISTENING: u8 = 2;
    pub const SPOTIFY: &'static str = "Spotify";
    pub const MAX_NAME_CHARS: usize = 128;
    /// Most activities a user can have at once: a game and Spotify, at most one of each kind.
    pub const MAX_PER_PRESENCE: usize = 2;

    /// Whether a client-supplied activity list is acceptable: at most two entries of different kinds; type 0 (a name of 1 to
    /// 128 characters (code points) that shows something and holds no control, zero-width or bidirectional-override
    /// characters, a start time that is not negative, optionally `assets.large_image` as `app:<64 hex>`, optionally `app: true`, none of the other
    /// Spotify-only fields) or type 2 (the name "Spotify",
    /// optional `details` and `state` under the same text rules, `assets.large_image` as `spotify:<40 hex>`, `sync_id` as 22
    /// letters or digits, `timestamps.end` not negative and not before `start`).
    pub fn list_is_valid(list: &[Activity]) -> bool {
        list.len() <= Self::MAX_PER_PRESENCE
            && list.iter().enumerate().all(|(i, activity)| list[..i].iter().all(|other| other.kind != activity.kind) && activity.is_valid())
    }

    fn is_valid(&self) -> bool {
        let start = self.timestamps.as_ref().and_then(|timestamps| timestamps.start);
        let end = self.timestamps.as_ref().and_then(|timestamps| timestamps.end);
        if !start.is_none_or(|start| start >= 0) || !Self::text_is_valid(&self.name) {
            return false;
        }
        match self.kind {
            Self::PLAYING => {
                end.is_none()
                    && self.details.is_none()
                    && self.state.is_none()
                    && self.sync_id.is_none()
                    && self
                        .assets
                        .as_ref()
                        .is_none_or(|assets| assets.large_image.as_deref().is_none_or(|image| Self::hash_id(image, Self::APP_IMAGE_PREFIX, 64)))
            }
            Self::LISTENING => {
                self.name == Self::SPOTIFY
                    && !self.app
                    && self.details.as_deref().is_none_or(Self::text_is_valid)
                    && self.state.as_deref().is_none_or(Self::text_is_valid)
                    && self.assets.as_ref().and_then(|assets| assets.large_image.as_deref()).is_none_or(|image| Self::hash_id(image, "spotify:", 40))
                    && self.sync_id.as_deref().is_none_or(|id| id.len() == 22 && id.bytes().all(|b| b.is_ascii_alphanumeric()))
                    && end.is_none_or(|end| end >= 0 && start.is_none_or(|start| end >= start))
            }
            _ => false,
        }
    }

    /// `prefix` followed by exactly `len` lowercase hex digits.
    fn hash_id(image: &str, prefix: &str, len: usize) -> bool {
        image.strip_prefix(prefix).is_some_and(|id| id.len() == len && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
    }

    /// The hash of an `app:<64 hex>` image, `None` for anything else.
    pub fn app_hash(&self) -> Option<&str> {
        let image = self.assets.as_ref()?.large_image.as_deref()?;
        if self.kind == Self::PLAYING && Self::hash_id(image, Self::APP_IMAGE_PREFIX, 64) { image.strip_prefix(Self::APP_IMAGE_PREFIX) } else { None }
    }

    fn text_is_valid(text: &str) -> bool {
        text.chars().count() <= Self::MAX_NAME_CHARS && !text.chars().any(|c| c.is_control() || is_invisible(c)) && text.chars().any(|c| !c.is_whitespace())
    }
}

/// Characters that take no space or reorder the text around them (zero-width, directional marks and overrides, soft hyphen, fillers).
fn is_invisible(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{034F}'
            | '\u{061C}'
            | '\u{115F}'
            | '\u{1160}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2069}'
            | '\u{3164}'
            | '\u{FEFF}'
            | '\u{FFA0}'
    )
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
    /// Age-restricted channel; always sent, `false` on everything but guild text, announcement, forum and voice channels.
    #[serde(default)]
    pub nsfw: bool,
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
    /// `thread_member_flags` bits.
    pub flags: u32,
    /// Always false once a timed mute has ended (computed on read).
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub mute_config: Option<MuteConfig>,
}

/// `ThreadMember::flags` bits. None of the notify bits set means the thread follows its parent channel's setting.
pub mod thread_member_flags {
    pub const HAS_INTERACTED: u32 = 1 << 0;
    pub const ALL_MESSAGES: u32 = 1 << 1;
    pub const ONLY_MENTIONS: u32 = 1 << 2;
    pub const NO_MESSAGES: u32 = 1 << 3;
    pub const NOTIFY_MASK: u32 = ALL_MESSAGES | ONLY_MENTIONS | NO_MESSAGES;
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MuteConfig {
    /// ISO 8601; `None` = until turned back on.
    pub end_time: Option<String>,
}

/// `PATCH /channels/{id}/thread-members/@me`: only sent keys change.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct UpdateThreadMemberRequest {
    #[serde(default)]
    pub flags: Option<u32>,
    #[serde(default)]
    pub muted: Option<bool>,
    /// `Some(None)` = explicit `null` (forever while muted).
    #[serde(default, deserialize_with = "double_option")]
    pub mute_config: Option<Option<MuteConfig>>,
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
    /// Role icon as a unicode emoji (free in Vokko, no boost level); always sent, `null` when none.
    #[serde(default)]
    pub unicode_emoji: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Guild {
    pub id: Snowflake,
    pub name: String,
    pub icon: Option<String>,
    /// Server banner URL; always sent, `null` when unset.
    #[serde(default)]
    pub banner: Option<String>,
    pub owner_id: Snowflake,
    pub roles: Vec<Role>,
    pub system_channel_id: Option<Snowflake>,
    /// Server tag members can adopt (MANAGE_GUILD edits it); always sent, `null` when none.
    #[serde(default)]
    pub tag: Option<GuildTag>,
    #[serde(default)]
    pub theme: Option<GuildTheme>,
    /// Safety setup (MANAGE_GUILD edits both).
    #[serde(default)]
    pub verification_level: VerificationLevel,
    #[serde(default)]
    pub explicit_content_filter: ExplicitContentFilter,
    /// Access: `AgeRestricted` puts the age gate on every channel of the server (MANAGE_GUILD edits it).
    #[serde(default)]
    pub nsfw_level: NsfwLevel,
    /// Access: the text channel shown as the server rules; always sent, `null` when unset.
    #[serde(default)]
    pub rules_channel_id: Option<Snowflake>,
    /// Access: how people get in (MANAGE_GUILD edits it).
    #[serde(default)]
    pub join_mode: JoinMode,
    /// Engagement: the notification level of members who set none for the server (MANAGE_GUILD edits it); always sent.
    #[serde(default)]
    pub default_message_notifications: DefaultMessageNotifications,
}

numeric_enum!(
    /// Discord's guild `default_message_notifications`.
    #[derive(Default)]
    DefaultMessageNotifications {
        #[default]
        AllMessages = 0,
        OnlyMentions = 1,
    }
);

numeric_enum!(
    /// `Invite`: an invite link is enough. `Apply`: nobody joins without an approved join request.
    #[derive(Default)]
    JoinMode {
        #[default]
        Invite = 0,
        Apply = 1,
    }
);

numeric_enum!(
    /// Discord's guild NSFW level. Only `Default` and `AgeRestricted` can be set (Discord's UI offers the same two).
    #[derive(Default)]
    NsfwLevel {
        #[default]
        Default = 0,
        Explicit = 1,
        Safe = 2,
        AgeRestricted = 3,
    }
);

numeric_enum!(
    /// Who may send messages in the guild's channels (members with any role bypass it, like Discord).
    #[derive(Default)]
    VerificationLevel {
        #[default]
        None = 0,
        /// Discord: verified email. Vokko has no email verification, so every account passes.
        Low = 1,
        /// Account older than 5 minutes.
        Medium = 2,
        /// Also a member of the guild for longer than 10 minutes.
        High = 3,
        /// Discord: verified phone. Vokko has none, so it behaves like `High`.
        VeryHigh = 4,
    }
);
numeric_enum!(
    /// Stored and shown; Vokko does not scan media yet.
    #[derive(Default)]
    ExplicitContentFilter {
        #[default]
        Disabled = 0,
        MembersWithoutRoles = 1,
        AllMembers = 2,
    }
);

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
    /// Server muted / deafened in voice (MUTE_MEMBERS / DEAFEN_MEMBERS); persists across leave and rejoin. Absent = false.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub mute: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub deaf: bool,
    /// `member_flags` bitfield; omitted from the JSON while 0.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub flags: u32,
}

fn is_zero(value: &u32) -> bool {
    *value == 0
}

/// `GuildMember.flags` bits (Discord's values).
pub mod member_flags {
    pub const DID_REJOIN: u32 = 1 << 0;
    pub const COMPLETED_ONBOARDING: u32 = 1 << 1;
    pub const BYPASSES_VERIFICATION: u32 = 1 << 2;
    /// Set when a member joins a guild whose onboarding is enabled.
    pub const STARTED_ONBOARDING: u32 = 1 << 3;
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
    /// Voice messages only: length of the recording in seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_secs: Option<f64>,
    /// Voice messages only: base64 of up to 256 one-byte amplitude samples (0-255), Discord's shape.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waveform: Option<String>,
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
    /// Only on a `PollResult` message; the data is in `fields` (see `poll_result_fields`).
    #[serde(rename = "poll_result")]
    PollResult,
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
    /// The signed same-origin copy of `icon_url`, set on serialization like `EmbedMedia::proxy_url`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy_icon_url: Option<String>,
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
    /// The signed same-origin copy of `icon_url`, set on serialization like `EmbedMedia::proxy_url`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy_icon_url: Option<String>,
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
    /// Custom emoji id, `null` for unicode; the reaction routes take `name:id` for custom emoji.
    pub id: Option<Snowflake>,
    pub name: String,
    /// Custom emoji only: whether it is animated; omitted for unicode emoji.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub animated: Option<bool>,
}

/// Custom emoji uploaded to a guild; messages reference it as `<:name:id>` or `<a:name:id>`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GuildEmoji {
    pub id: Snowflake,
    /// 2-32 characters of `A-Z a-z 0-9 _`.
    pub name: String,
    /// Roles allowed to use it; empty = every member.
    pub roles: Vec<Snowflake>,
    /// Uploader; only in REST responses, omitted in gateway payloads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<User>,
    pub require_colons: bool,
    pub managed: bool,
    pub animated: bool,
    pub available: bool,
    /// Absolute image URL; the same file is served by id at `GET /emojis/{id}`.
    pub url: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CreateGuildEmojiRequest {
    pub name: String,
    pub image_attachment_id: Snowflake,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub roles: Option<Vec<Snowflake>>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct EditGuildEmojiRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// `null` or `[]` = every member.
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub roles: Option<Option<Vec<Snowflake>>>,
}

/// One emoji on a message. Normal and burst (super) reactions of the same emoji share the entry; `count` is their sum.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Reaction {
    pub emoji: ReactionEmoji,
    pub count: u32,
    #[serde(default)]
    pub count_details: ReactionCountDetails,
    /// Glow colours of the burst pill (`#rrggbb`). Vokko clients compute them from the emoji, so the server always sends `[]`.
    #[serde(default)]
    pub burst_colors: Vec<String>,
    pub me: bool,
    /// The viewer added a burst reaction with this emoji.
    #[serde(default)]
    pub me_burst: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReactionCountDetails {
    pub burst: u32,
    pub normal: u32,
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
    /// Sent with the `SEND_TTS_MESSAGES` permission and meant to be read aloud; always serialized (absent = false when reading).
    #[serde(default)]
    pub tts: bool,
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
    /// Posted by a webhook or as an interaction response (then equal to `application_id`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webhook_id: Option<Snowflake>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub application_id: Option<Snowflake>,
    /// Interaction responses: who ran which command.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interaction_metadata: Option<Box<MessageInteractionMetadata>>,
    /// Type 3 (call) messages only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub call: Option<MessageCall>,
    /// Present on poll messages; `results.answer_counts[].me_voted` is per viewer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poll: Option<Box<Poll>>,
}

/// `Message::call` of a type 3 message: who joined the DM call, and when it ended (`null` while it goes on).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MessageCall {
    pub participants: Vec<Snowflake>,
    pub ended_timestamp: Option<String>,
}

// ---- polls ----

pub const POLL_MAX_ANSWERS: usize = 10;
pub const POLL_QUESTION_MAX_CHARS: usize = 300;
pub const POLL_ANSWER_MAX_CHARS: usize = 55;
/// Hours a poll may run (Discord's API range); the client offers 1, 4, 8, 24, 72, 168 and 336.
pub const POLL_MAX_DURATION_HOURS: u32 = 768;
pub const POLL_DEFAULT_DURATION_HOURS: u32 = 24;
pub const POLL_LAYOUT_DEFAULT: u8 = 1;

/// Question (text only) or answer (text plus optional emoji).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct PollMedia {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emoji: Option<ReactionEmoji>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PollAnswer {
    /// 1-based, in creation order.
    pub answer_id: u32,
    pub poll_media: PollMedia,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PollAnswerCount {
    pub id: u32,
    pub count: u32,
    pub me_voted: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PollResults {
    pub is_finalized: bool,
    /// One entry per answer, in answer order, zero counts included.
    pub answer_counts: Vec<PollAnswerCount>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Poll {
    pub question: PollMedia,
    pub answers: Vec<PollAnswer>,
    pub expiry: String,
    pub allow_multiselect: bool,
    pub layout_type: u8,
    pub results: PollResults,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct PollAnswerRequest {
    pub poll_media: PollMedia,
}

/// `CreateMessageRequest.poll`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct PollCreateRequest {
    pub question: PollMedia,
    pub answers: Vec<PollAnswerRequest>,
    /// Hours, 1-768, default 24.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_multiselect: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout_type: Option<u8>,
}

/// `GET /channels/{id}/polls/{message_id}/answers/{answer_id}`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PollAnswerVotersResponse {
    pub users: Vec<User>,
}

/// MESSAGE_POLL_VOTE_ADD / MESSAGE_POLL_VOTE_REMOVE.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PollVote {
    pub user_id: Snowflake,
    pub channel_id: Snowflake,
    pub message_id: Snowflake,
    pub guild_id: Option<Snowflake>,
    pub answer_id: u32,
}

/// `EmbedField::name`s of a `poll_result` embed (Discord's); `victor_*` only when one answer has strictly the most votes.
pub mod poll_result_fields {
    pub const QUESTION_TEXT: &str = "poll_question_text";
    pub const TOTAL_VOTES: &str = "total_votes";
    pub const VICTOR_ANSWER_ID: &str = "victor_answer_id";
    pub const VICTOR_ANSWER_TEXT: &str = "victor_answer_text";
    pub const VICTOR_ANSWER_VOTES: &str = "victor_answer_votes";
    pub const VICTOR_ANSWER_EMOJI_ID: &str = "victor_answer_emoji_id";
    pub const VICTOR_ANSWER_EMOJI_NAME: &str = "victor_answer_emoji_name";
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
    /// Guild voice and stage channels: the channel's bitrate in bps (within the server's limits), the microphone's max
    /// publish bitrate. Absent for DM calls.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bitrate: Option<u32>,
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

/// Longest a Watch Together queue gets.
pub const WATCH_TOGETHER_QUEUE_MAX: usize = 20;
/// Queue entries one person without control may have in a Watch Together queue at once (docs/design/bot-control.md §2.5).
pub const WATCH_TOGETHER_QUEUE_PER_USER: usize = 3;
/// Furthest position a Watch Together seek may name (24 hours).
pub const WATCH_TOGETHER_POSITION_MAX_MS: u64 = 24 * 60 * 60 * 1000;
/// Longest title a Watch Together session carries.
pub const WATCH_TOGETHER_TITLE_MAX_CHARS: usize = 200;

/// The YouTube video everyone in a voice channel or DM call watches together (Vokko-only, in memory per channel). While
/// `playing`, the expected position now is `position_ms + (now - updated_at_ms)`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WatchTogetherState {
    /// 11 characters of `A-Za-z0-9_-`.
    pub video_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub playing: bool,
    pub position_ms: u64,
    /// Unix milliseconds of the server when `position_ms` was true.
    pub updated_at_ms: i64,
    pub started_by: Snowflake,
    /// Video ids up next, at most `WATCH_TOGETHER_QUEUE_MAX`.
    #[serde(default)]
    pub queue: Vec<String>,
    /// Who added each `queue` entry (same length and order).
    #[serde(default)]
    pub queue_added_by: Vec<Snowflake>,
    #[serde(flatten)]
    pub control: MediaControl,
}

/// `PUT /channels/{id}/watch-together`: start a session or change its video.
#[derive(Clone, Debug, Deserialize)]
pub struct WatchTogetherStartRequest {
    pub video_id: String,
    #[serde(default)]
    pub title: Option<String>,
}

/// `PATCH /channels/{id}/watch-together`: play / pause / seek, set the title, add to or remove from the queue, or skip. With `skip`, a
/// `video_id` makes it a no-op unless that video is still the current one (every client reports "ended" at once).
#[derive(Clone, Debug, Default, Deserialize)]
pub struct WatchTogetherPatchRequest {
    #[serde(default)]
    pub playing: Option<bool>,
    #[serde(default)]
    pub position_ms: Option<u64>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub queue_add: Option<String>,
    #[serde(default)]
    pub queue_remove: Option<WatchTogetherQueueRemove>,
    #[serde(default)]
    pub skip: Option<bool>,
    #[serde(default)]
    pub video_id: Option<String>,
}

/// One queue entry to remove: a no-op unless `queue[index]` is still `video_id` (the queue moved since the client saw it).
#[derive(Clone, Debug, Deserialize)]
pub struct WatchTogetherQueueRemove {
    pub index: usize,
    pub video_id: String,
}

/// Who controls a Watch Together, Stremio or Spotify session and the skip vote on its current item (docs/design/bot-control.md
/// sections 2 and 3), flattened into each state. A controller is someone in the call who is in a DM call, holds CONTROL_MEDIA in
/// the channel, or is `host_id`. Everyone else in the call may vote to skip (`skip: true`; `skip: false` withdraws), skip the
/// item they added (`added_by`) at once, add to the end of the queue up to the per-user quota and remove their own entries.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct MediaControl {
    /// Starts as `started_by`; when the host leaves the call it moves to whoever has been in the call longest.
    pub host_id: Snowflake,
    /// Who added the current item (the `PUT` caller, or the queue entry's adder): they may skip it without a vote.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added_by: Option<Snowflake>,
    /// Votes to skip the current item, in vote order; cleared whenever the item changes.
    #[serde(default)]
    pub skip_votes: Vec<Snowflake>,
    /// Votes that skip it: half the listeners (in the call and not deafened), rounded up, at least 1.
    pub skip_needed: u32,
    /// Changes with every item change (and when a skip passes). A Stremio or Spotify `skip` may name it as `item_seq`: a vote
    /// or skip for an item that is no longer current is ignored.
    #[serde(default)]
    pub item_seq: u64,
}

/// `max(1, ceil(listeners / 2))`: 0 or 1 or 2 listeners -> 1, 3 -> 2, 4 -> 2, 5 -> 3.
pub fn skip_needed(listeners: usize) -> u32 {
    listeners.div_ceil(2).max(1) as u32
}

/// WATCH_TOGETHER_UPDATE, to everyone who can see the channel; `state: null` = no session (also on the READY / GUILD_CREATE
/// list `watch_together`, which only names channels that have one).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WatchTogetherUpdate {
    pub channel_id: Snowflake,
    pub state: Option<WatchTogetherState>,
}

/// Longest Up next queue of a Stremio session.
pub const STREMIO_QUEUE_MAX: usize = 10;
/// Queue entries one person without control may have in a Stremio queue at once.
pub const STREMIO_QUEUE_PER_USER: usize = 2;
/// Furthest position a Stremio seek may name before the duration is known (24 hours).
pub const STREMIO_POSITION_MAX_MS: u64 = 24 * 60 * 60 * 1000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StremioStatus {
    Starting,
    Playing,
    Paused,
    Buffering,
    Error,
}

/// Most audio or subtitle tracks the server keeps of one file.
pub const STREMIO_TRACKS_MAX: usize = 32;

/// An audio stream of the file. `id` is the container's stream index; the bot reported the rest. The audio language is shared:
/// everyone hears the one that is playing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StremioAudioTrack {
    pub id: u32,
    /// ISO 639 code in lower case, as the file tags it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub codec: String,
    #[serde(default)]
    pub default: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StremioSubtitleKind {
    /// Cues the bot publishes as data in the media room (topic `subs:<id>`); every viewer picks their own, locally.
    Text,
    /// A picture the bot burns into the video: shared, like the audio.
    Bitmap,
}

/// A subtitle stream inside the file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StremioSubtitleTrack {
    pub id: u32,
    pub kind: StremioSubtitleKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub codec: String,
    #[serde(default)]
    pub forced: bool,
    #[serde(default)]
    pub default: bool,
}

/// One subtitle line: shown from `start_ms` to `end_ms` of the media. Plain text, no markup.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StremioCue {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

/// An entry of `GET /channels/{id}/stremio/subtitles`: a subtitle one of the requester's addons offers for the playing title.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StremioAddonSubtitle {
    /// Opaque, bound to the user who listed it, the channel and the playing item.
    pub sid: String,
    pub addon: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StremioAddonSubtitles {
    pub subtitles: Vec<StremioAddonSubtitle>,
    /// Addons that failed or timed out.
    #[serde(default)]
    pub addon_errors: Vec<String>,
}

/// `GET /channels/{id}/stremio/subtitles/{sid}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StremioCues {
    pub cues: Vec<StremioCue>,
}

/// What is playing. No URLs except an allow-listed `poster` (https on the Stremio image hosts).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StremioItem {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poster: Option<String>,
    /// The stream's quality label, for example `[TB+] Torrentio 1080p`.
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StremioQueueItem {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poster: Option<String>,
    pub label: String,
    pub added_by: Snowflake,
}

/// The Stremio session of a voice channel or DM call (Vokko-only, in memory). While `playing`, the expected position now is
/// `position_ms + (now - updated_at_ms)`. The picture and sound come from the media LiveKit room (`bot_identity`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StremioState {
    pub item: StremioItem,
    pub status: StremioStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub playing: bool,
    pub position_ms: u64,
    /// Unix milliseconds of the server when `position_ms` was true.
    pub updated_at_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    pub started_by: Snowflake,
    /// `bot:stremio:<channel_id>`.
    pub bot_identity: String,
    /// Up next, at most `STREMIO_QUEUE_MAX`.
    #[serde(default)]
    pub queue: Vec<StremioQueueItem>,
    /// The file's audio streams, once the bot has looked at it (empty before that).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub audio_tracks: Vec<StremioAudioTrack>,
    /// The `id` of the audio stream in use.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio: Option<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub subtitle_tracks: Vec<StremioSubtitleTrack>,
    /// The `id` of the bitmap subtitle burned into the picture for everyone, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub burned_subtitle: Option<u32>,
    #[serde(flatten)]
    pub control: MediaControl,
}

/// STREMIO_UPDATE, to everyone who can see the channel (`state: null` = ended), and the entries of the `stremio` lists on READY
/// guilds, GUILD_CREATE and `Call`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StremioUpdate {
    pub channel_id: Snowflake,
    pub state: Option<StremioState>,
}

/// Largest relayed game message, serialized (`POST /channels/{id}/game/messages`).
pub const GAME_RELAY_MAX_BYTES: usize = 4096;
/// Most games in one guild's catalog.
pub const GUILD_GAMES_MAX: usize = 25;
/// Longest game name.
pub const GAME_NAME_MAX_CHARS: usize = 32;
/// Most players a game manifest may name.
pub const GAME_PLAYERS_MAX: u8 = 16;

/// How the game frame is shaped in its tile.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum GameAspect {
    #[default]
    #[serde(rename = "16:9")]
    Wide,
    #[serde(rename = "4:3")]
    Standard,
    #[serde(rename = "1:1")]
    Square,
    #[serde(rename = "fill")]
    Fill,
}

/// How a game runs: `sdk` talks to Vokko over the games SDK; `web` is a website game with its own lobby and servers (no SDK,
/// a looser frame sandbox for forms, popups and fullscreen, and a shareable room link).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GameKind {
    #[default]
    Sdk,
    Web,
}

/// A game that can run in a call (docs/design/games-host.md section 4): a built-in (`id` = `builtin:<name>`) or an entry of a
/// guild's catalog (`id` = snowflake string).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GameManifest {
    pub id: String,
    pub name: String,
    pub url: String,
    /// One emoji, or none.
    #[serde(default)]
    pub icon: Option<String>,
    pub min_players: u8,
    pub max_players: u8,
    #[serde(default)]
    pub aspect: GameAspect,
    #[serde(default)]
    pub kind: GameKind,
}

/// `POST /guilds/{id}/games`; players default to 1-16, `aspect` to 16:9, `kind` to `sdk`.
#[derive(Clone, Debug, Deserialize)]
pub struct CreateGameRequest {
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub min_players: Option<u8>,
    #[serde(default)]
    pub max_players: Option<u8>,
    #[serde(default)]
    pub aspect: Option<GameAspect>,
    #[serde(default)]
    pub kind: Option<GameKind>,
}

/// `PATCH /guilds/{id}/games/{game_id}`; `icon: null` clears the icon.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct EditGameRequest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub icon: Option<Option<String>>,
    #[serde(default)]
    pub min_players: Option<u8>,
    #[serde(default)]
    pub max_players: Option<u8>,
    #[serde(default)]
    pub aspect: Option<GameAspect>,
    #[serde(default)]
    pub kind: Option<GameKind>,
}

/// The game running in a voice channel or DM call (Vokko-only, in memory per channel).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GameSession {
    /// 16 hex characters, new for every start.
    pub session_id: String,
    pub game: GameManifest,
    pub started_by: Snowflake,
    pub started_at_ms: i64,
    /// A `web` game's shared room link (`PUT /channels/{id}/game/room`); every tile loads it. Always null for `sdk` games.
    #[serde(default)]
    pub room_url: Option<String>,
}

/// `PUT /channels/{id}/game/room`: share a room link of the running web game with the call, or clear it with null.
#[derive(Clone, Debug, Deserialize)]
pub struct GameRoomRequest {
    pub url: Option<String>,
}

/// GAME_UPDATE, to everyone who can see the channel (`state: null` = the game ended), and the entries of the `games` list on
/// READY guilds and GUILD_CREATE.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GameUpdate {
    pub channel_id: Snowflake,
    pub state: Option<GameSession>,
}

/// `PUT /channels/{id}/game`.
#[derive(Clone, Debug, Deserialize)]
pub struct GameStartRequest {
    pub game_id: String,
}

/// `GET /channels/{id}/game/players`: someone in the call and their id inside this game.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GamePlayer {
    pub user_id: Snowflake,
    /// 22 characters of base64url, stable per game and user, never the user id.
    pub app_id: String,
}

/// `POST /channels/{id}/game/messages`: relay `data` to the call, or to the one player whose app id is `to`.
#[derive(Clone, Debug, Deserialize)]
pub struct GameRelayRequest {
    pub data: Value,
    #[serde(default)]
    pub to: Option<String>,
}

/// GAME_MESSAGE: relayed game data, only to people in the call (never back to the sender).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GameMessage {
    pub channel_id: Snowflake,
    pub session_id: String,
    /// The sender's app id.
    pub from: String,
    pub data: Value,
}

/// GUILD_GAMES_UPDATE: the guild's game catalog changed; refetch `GET /guilds/{id}/games`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GuildGamesUpdate {
    pub guild_id: Snowflake,
}

/// `PUT /channels/{id}/stremio`.
#[derive(Clone, Debug, Deserialize)]
pub struct StremioStartRequest {
    pub sid: String,
    /// Where to start (0..=24 h), for resuming a saved position; the beginning when absent.
    #[serde(default)]
    pub position_ms: Option<u64>,
}

/// `PATCH /channels/{id}/stremio`.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct StremioPatchRequest {
    #[serde(default)]
    pub playing: Option<bool>,
    #[serde(default)]
    pub position_ms: Option<u64>,
    #[serde(default)]
    pub queue_add: Option<String>,
    #[serde(default)]
    pub queue_remove: Option<usize>,
    #[serde(default)]
    pub skip: Option<bool>,
    /// With `skip`: the state's `item_seq` the skip or vote is for; ignored (200, current state) when the item has changed.
    #[serde(default)]
    pub item_seq: Option<u64>,
    /// An audio track `id` from the state.
    #[serde(default)]
    pub audio: Option<u32>,
    /// A bitmap subtitle track `id` to burn in for everyone, or `null` to turn it off. Text subtitles are chosen locally by each viewer.
    #[serde(default, deserialize_with = "double_option")]
    pub burned_subtitle: Option<Option<u32>>,
}

/// `POST /channels/{id}/stremio/viewer-token`: a subscribe-only token for the media LiveKit room `stremio-<channel_id>`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StremioViewerToken {
    /// `VOKKO_MEDIA_LIVEKIT_URL`.
    pub url: String,
    pub token: String,
}

/// `GET /users/@me/stremio`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StremioAccountStatus {
    pub linked: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linked_at: Option<String>,
}

/// `POST /users/@me/stremio/link`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StremioLinkStart {
    pub code: String,
    pub link: String,
    pub expires_at: String,
}

/// `POST /users/@me/stremio/link/poll`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StremioLinkPoll {
    pub linked: bool,
}

/// `POST /users/@me/stremio/login` (the password is used once, never stored or logged).
#[derive(Clone, Deserialize)]
pub struct StremioLoginRequest {
    pub email: String,
    pub password: String,
}

impl std::fmt::Debug for StremioLoginRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StremioLoginRequest").finish_non_exhaustive()
    }
}

/// An entry of `GET /stremio/search` and `/stremio/catalog`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StremioTitle {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poster: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<String>,
}

/// An episode of a series in `StremioMeta`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StremioVideo {
    /// `tt<imdb>:<season>:<episode>`.
    pub id: String,
    pub season: u32,
    pub episode: u32,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub released: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
}

/// `GET /stremio/meta/{type}/{id}`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StremioMeta {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poster: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    #[serde(default)]
    pub videos: Vec<StremioVideo>,
}

/// An entry of `GET /stremio/streams/{type}/{video_id}`. `sid` is opaque and bound to the user who listed it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StremioStream {
    pub sid: String,
    pub addon: String,
    pub label: String,
    pub details: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution: Option<u32>,
    /// `hdr`, `dv`, `remux`, `hevc`, `10bit`.
    #[serde(default)]
    pub flags: Vec<String>,
    pub playable: bool,
    /// `torrent`, `external` or `youtube` when `playable` is false.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unsupported: Option<String>,
}

/// An entry of `GET /stremio/continue`: a title from the caller's own Stremio library that has progress.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StremioContinueItem {
    /// `tt<imdb>`.
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poster: Option<String>,
    /// Series only: the episode to continue, `tt<imdb>:<season>:<episode>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub season: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub episode: Option<u32>,
    /// 0 when the next episode is waiting (nothing of it has been watched yet).
    pub position_ms: u64,
    /// 0 when unknown.
    pub duration_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StremioStreamList {
    pub streams: Vec<StremioStream>,
    /// Names of the addons that failed or timed out.
    #[serde(default)]
    pub addon_errors: Vec<String>,
}

// ---- Spotify in calls (docs/design/spotify-bot.md) ----

/// Longest Spotify queue.
pub const SPOTIFY_QUEUE_MAX: usize = 200;
/// Queue entries one person without control may have in the Spotify queue at once; an album or playlist adds what fits.
pub const SPOTIFY_QUEUE_PER_USER: usize = 10;
/// Queue entries a SPOTIFY_UPDATE (and READY / `Call`) carries; `GET /channels/{id}/spotify` has all of them.
pub const SPOTIFY_EVENT_QUEUE_MAX: usize = 50;

/// A playable track. `art` is a 40-hex image id (`https://i.scdn.co/image/<id>`); no other URL ever appears.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SpotifyTrack {
    /// `spotify:track:<22 characters>`.
    pub uri: String,
    pub title: String,
    pub artists: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub album: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub art: Option<String>,
    pub duration_ms: u64,
    pub explicit: bool,
}

/// An album in a search result or on an artist page (`artists` is empty only if Spotify sent none).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SpotifyAlbumSummary {
    pub id: String,
    pub name: String,
    pub artists: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub art: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SpotifyArtistSummary {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub art: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SpotifyPlaylistSummary {
    pub id: String,
    pub name: String,
    pub owner_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub art: Option<String>,
}

/// `GET /spotify/search`; a list is empty when its type was not asked for.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SpotifySearchResults {
    #[serde(default)]
    pub tracks: Vec<SpotifyTrack>,
    #[serde(default)]
    pub albums: Vec<SpotifyAlbumSummary>,
    #[serde(default)]
    pub artists: Vec<SpotifyArtistSummary>,
    #[serde(default)]
    pub playlists: Vec<SpotifyPlaylistSummary>,
}

/// `GET /spotify/albums/{id}`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SpotifyAlbum {
    pub id: String,
    pub name: String,
    pub artists: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub art: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<String>,
    pub tracks: Vec<SpotifyTrack>,
}

/// `GET /spotify/playlists/{id}`: one page of 100 tracks.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SpotifyPlaylist {
    pub id: String,
    pub name: String,
    pub owner_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub art: Option<String>,
    /// Tracks in the whole playlist (the page holds fewer, and skips what cannot be played).
    pub total: u32,
    pub tracks: Vec<SpotifyTrack>,
}

/// `GET /spotify/artists/{id}`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SpotifyArtist {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub art: Option<String>,
    pub top_tracks: Vec<SpotifyTrack>,
    pub albums: Vec<SpotifyAlbumSummary>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpotifyStatus {
    /// The session was just created and the bot has not started the first track.
    Starting,
    Playing,
    /// Paused, or nothing left to play (`track` is `null`).
    Paused,
    /// A new track was sent to the bot and has not started yet.
    Loading,
    Error,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpotifyLoop {
    #[default]
    Off,
    Track,
    Queue,
}

/// A queue entry: the track's fields plus `qid` (random per entry, so a remove or move never hits another row) and who added it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SpotifyQueueEntry {
    pub qid: String,
    #[serde(flatten)]
    pub track: SpotifyTrack,
    pub added_by: Snowflake,
}

/// The Spotify session of a voice channel or DM call (Vokko-only, in memory, at most one on the whole server). While `playing`,
/// the expected position now is `position_ms + (now - updated_at_ms)`. The sound comes from the media LiveKit room (`bot_identity`).
/// Nothing about the Spotify account that plays appears here.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SpotifyState {
    pub status: SpotifyStatus,
    /// Why the session is in `error` (a fixed text, never the bot's own message).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// A passing note, for example "Skipped an unavailable track"; it goes away by itself after 5 s.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
    /// `null` when the queue ran out and nothing plays.
    pub track: Option<SpotifyTrack>,
    pub playing: bool,
    pub position_ms: u64,
    /// Unix milliseconds of the server when `position_ms` was true.
    pub updated_at_ms: i64,
    #[serde(rename = "loop")]
    pub loop_mode: SpotifyLoop,
    /// The whole queue from `GET`; at most `SPOTIFY_EVENT_QUEUE_MAX` entries in events, READY and `Call` (see `queue_len`).
    #[serde(default)]
    pub queue: Vec<SpotifyQueueEntry>,
    pub queue_len: u32,
    pub can_previous: bool,
    pub started_by: Snowflake,
    /// `bot:spotify:<channel_id>`.
    pub bot_identity: String,
    /// `added_by` is who put `track` in play; absent while nothing plays.
    #[serde(flatten)]
    pub control: MediaControl,
}

/// What `PUT` and `PATCH` answer: the state, plus `left_out` when an album or playlist did not fit in the queue.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SpotifyReply {
    #[serde(flatten)]
    pub state: SpotifyState,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub left_out: u32,
}

/// SPOTIFY_UPDATE, to everyone who can see the channel (`state: null` = ended), and the entries of the `spotify` lists on READY
/// guilds, GUILD_CREATE and `Call`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SpotifyUpdate {
    pub channel_id: Snowflake,
    pub state: Option<SpotifyState>,
}

/// `PUT /channels/{id}/spotify`.
#[derive(Clone, Debug, Deserialize)]
pub struct SpotifyStartRequest {
    pub uri: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct SpotifyQueueAdd {
    pub uri: String,
    /// Put it at the front of the queue instead of the end.
    #[serde(default)]
    pub next: bool,
}

#[derive(Clone, Debug, Deserialize)]
pub struct SpotifyQueueMove {
    pub qid: String,
    /// New index in the queue (0-based; clamped to the end).
    pub to: usize,
}

/// `PATCH /channels/{id}/spotify`: exactly one field per request.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct SpotifyPatchRequest {
    #[serde(default)]
    pub playing: Option<bool>,
    #[serde(default)]
    pub position_ms: Option<u64>,
    #[serde(default)]
    pub skip: Option<bool>,
    /// With `skip`: the state's `item_seq` the skip or vote is for; ignored (200, current state) when the item has changed.
    #[serde(default)]
    pub item_seq: Option<u64>,
    #[serde(default)]
    pub previous: Option<bool>,
    #[serde(default, rename = "loop")]
    pub loop_mode: Option<SpotifyLoop>,
    #[serde(default)]
    pub shuffle: Option<bool>,
    #[serde(default)]
    pub queue_add: Option<SpotifyQueueAdd>,
    #[serde(default)]
    pub queue_remove: Option<String>,
    #[serde(default)]
    pub queue_move: Option<SpotifyQueueMove>,
    #[serde(default)]
    pub queue_clear: Option<bool>,
}

/// `POST /channels/{id}/spotify/listener-token`: a subscribe-only token for the session's media LiveKit room.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SpotifyListenerToken {
    /// `VOKKO_MEDIA_LIVEKIT_URL`.
    pub url: String,
    pub token: String,
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

/// Most people in one DM / group DM call (Discord's group DM cap).
pub const CALL_PARTICIPANT_MAX: usize = 10;
/// Most cameras + screen shares published in one DM call.
pub const CALL_VIDEO_MAX: usize = 25;
/// How long a recipient is rung before the call shows as missed for them.
pub const CALL_RING_TIMEOUT_SECS: u64 = 180;

/// An ongoing DM / group DM call (CALL_CREATE). The `voice_states` are the people in it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Call {
    pub channel_id: Snowflake,
    /// The type 3 message that records the call.
    pub message_id: Snowflake,
    /// Preferred media region; `null` = automatic. Vokko has one media server, so this is stored and echoed only.
    pub region: Option<String>,
    /// Users being rung right now.
    pub ringing: Vec<Snowflake>,
    pub voice_states: Vec<VoiceState>,
    /// The Watch Together session of the call, if one is running.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub watch_together: Option<WatchTogetherState>,
    /// The Stremio session of the call, if one is running (at most one entry).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stremio: Vec<StremioUpdate>,
    /// The Spotify session of the call, if one is running (at most one entry).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub spotify: Vec<SpotifyUpdate>,
    /// The game running in the call, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub game: Option<GameSession>,
}

/// CALL_UPDATE: a `Call` without its voice states (those travel as VOICE_STATE_UPDATE).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CallUpdate {
    pub channel_id: Snowflake,
    pub message_id: Snowflake,
    pub region: Option<String>,
    pub ringing: Vec<Snowflake>,
}

/// CALL_DELETE: the call ended.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CallDelete {
    pub channel_id: Snowflake,
}

/// `POST /channels/{id}/call/ring` and `/call/stop-ringing`. Absent / `null` = every recipient not in the call (ring) or
/// yourself (stop-ringing).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct CallRingRequest {
    #[serde(default)]
    pub recipients: Option<Vec<Snowflake>>,
}

/// `PATCH /channels/{id}/call`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct EditCallRequest {
    #[serde(default)]
    pub region: Option<String>,
}

numeric_enum!(
    /// Discord's values; Vokko only has guild-only stages (1 = public is deprecated in Discord too).
    StagePrivacyLevel { GuildOnly = 2 }
);

/// Max length of a stage topic.
pub const STAGE_TOPIC_MAX_CHARS: usize = 120;

/// A live stage in a stage channel (type 13); at most one per channel. Ends when the last stage moderator leaves or on DELETE.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StageInstance {
    pub id: Snowflake,
    pub guild_id: Snowflake,
    pub channel_id: Snowflake,
    /// 1-120 characters.
    pub topic: String,
    pub privacy_level: StagePrivacyLevel,
}

/// `POST /stage-instances` (stage moderator in the channel).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CreateStageInstanceRequest {
    pub channel_id: Snowflake,
    pub topic: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub privacy_level: Option<StagePrivacyLevel>,
}

/// `PATCH /stage-instances/{channel_id}`; only the keys that are present change.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct EditStageInstanceRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub privacy_level: Option<StagePrivacyLevel>,
}

/// `PATCH /guilds/{id}/voice-states/@me` and `/{user_id}` (stage channels). `channel_id` must be the stage the user is in.
/// `@me`: `request_to_speak_timestamp` (ISO, or `null` to lower the hand; needs REQUEST_TO_SPEAK) and `suppress` (`true` =
/// back to the audience, `false` = become a speaker, which needs stage moderator). `{user_id}`: `suppress` only (moderator).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct EditVoiceStateRequest {
    pub channel_id: Snowflake,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suppress: Option<bool>,
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub request_to_speak_timestamp: Option<Option<String>>,
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
    /// `YYYY-MM-DD`; optional here so a missing value gets a 50035 field error instead of a body error.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date_of_birth: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub consent: Option<bool>,
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
    /// Makes this a poll message: content optional, no attachments.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poll: Option<PollCreateRequest>,
    /// Up to 3 guild stickers; content may then be empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sticker_ids: Option<Vec<Snowflake>>,
    /// Read the message aloud to the viewers of the channel. Needs `SEND_TTS_MESSAGES`; without it the message is still sent, with `tts` false.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tts: Option<bool>,
    /// `message_flags`: only `IS_VOICE_MESSAGE` is read (needs `SEND_VOICE_MESSAGES`, one attachment, no content); other bits are ignored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flags: Option<u32>,
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
    /// Required on a voice message (`IS_VOICE_MESSAGE`): 0 < seconds <= 1200. Ignored otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_secs: Option<f64>,
    /// Required on a voice message: base64 of 1-256 amplitude bytes. Ignored otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waveform: Option<String>,
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

/// `MemberSearchRequest.sort` (Discord's member-safety sort).
pub mod member_search_sort {
    pub const MEMBER_SINCE_NEWEST_FIRST: u8 = 1;
    pub const MEMBER_SINCE_OLDEST_FIRST: u8 = 2;
    pub const JOINED_VOKKO_NEWEST_FIRST: u8 = 3;
    pub const JOINED_VOKKO_OLDEST_FIRST: u8 = 4;
}

/// `SupplementalGuildMember.join_source_type` (Discord's values; Vokko records `INVITE` and leaves the rest `UNSPECIFIED`).
pub mod join_source_type {
    pub const UNSPECIFIED: u8 = 0;
    pub const BOT: u8 = 1;
    pub const INTEGRATION: u8 = 2;
    pub const DISCOVERY: u8 = 3;
    pub const HUB: u8 = 4;
    pub const INVITE: u8 = 5;
    pub const VANITY_URL: u8 = 6;
    pub const MANUAL_MEMBER_VERIFICATION: u8 = 7;
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct OrQuery<T> {
    pub or_query: Vec<T>,
}

/// `{and_query}`: every listed value must match; `{or_query}`: any of them.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct AndOrQuery<T> {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub and_query: Option<Vec<T>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub or_query: Option<Vec<T>>,
}

/// Inclusive bounds in unix milliseconds.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct TimeRange {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gte: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lte: Option<i64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RangeQuery {
    pub range: TimeRange,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct MemberSearchQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_id: Option<OrQuery<Snowflake>>,
    /// Prefix of the username, display name or nickname (case-insensitive), or an exact user id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usernames: Option<OrQuery<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role_ids: Option<AndOrQuery<Snowflake>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guild_joined_at: Option<RangeQuery>,
    /// Account creation, read from the user id (snowflake).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_created_at: Option<RangeQuery>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_invite_code: Option<OrQuery<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub join_source_type: Option<OrQuery<u8>>,
}

/// `POST /guilds/{id}/members-search`. Vokko pages with `offset` instead of Discord's `before`/`after` cursors.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct MemberSearchRequest {
    /// 1-1000, default 25.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    /// 0-100000, default 0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<u32>,
    /// `member_search_sort`, default MEMBER_SINCE_NEWEST_FIRST.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort: Option<u8>,
    #[serde(default)]
    pub and_query: MemberSearchQuery,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SupplementalGuildMember {
    pub member: GuildMember,
    /// The invite the member joined through; `null` for members from before tracking, the owner and other join paths.
    pub source_invite_code: Option<String>,
    pub join_source_type: u8,
    pub inviter_id: Option<Snowflake>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MemberSearchResponse {
    pub guild_id: Snowflake,
    pub members: Vec<SupplementalGuildMember>,
    pub page_result_count: u32,
    pub total_result_count: u32,
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
    /// PNG/JPEG/WebP/GIF (animated allowed), at most 10 MiB.
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
    #[serde(default, deserialize_with = "double_option")]
    pub nameplate: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub display_name_styles: Option<Option<DisplayNameStyles>>,
    #[serde(default, deserialize_with = "double_option")]
    pub profile_frame: Option<Option<String>>,
    /// Replaces the whole board; `null` clears, absent leaves it.
    #[serde(default, deserialize_with = "double_option")]
    pub widgets: Option<Option<ProfileWidgetsInput>>,
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
    /// An uploaded PNG/JPEG/GIF/WebP (at most 10 MiB, animated GIF 4 MiB); `null` removes the banner.
    #[serde(default, deserialize_with = "double_option")]
    pub banner_attachment_id: Option<Option<Snowflake>>,
    #[serde(default)]
    pub system_channel_id: Option<Snowflake>,
    /// `null` removes the server tag.
    #[serde(default, deserialize_with = "double_option")]
    pub tag: Option<Option<GuildTag>>,
    #[serde(default, deserialize_with = "double_option")]
    pub theme: Option<Option<GuildTheme>>,
    #[serde(default)]
    pub verification_level: Option<VerificationLevel>,
    #[serde(default)]
    pub explicit_content_filter: Option<ExplicitContentFilter>,
    /// `Default` or `AgeRestricted` (anything else is 400 50035).
    #[serde(default)]
    pub nsfw_level: Option<NsfwLevel>,
    /// A text channel of this guild; `null` clears it.
    #[serde(default, deserialize_with = "double_option")]
    pub rules_channel_id: Option<Option<Snowflake>>,
    /// `Invite` or `Apply` (anything else is 400 50035).
    #[serde(default)]
    pub join_mode: Option<JoinMode>,
    /// 0 all messages, 1 only mentions (anything else is 400 50035).
    #[serde(default)]
    pub default_message_notifications: Option<DefaultMessageNotifications>,
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
    /// Text, announcement, forum and voice channels only (MANAGE_CHANNELS).
    #[serde(default)]
    pub nsfw: Option<bool>,
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

/// One entry of `PATCH /guilds/{id}/channels` (Modify Guild Channel Positions); the body is an array of these.
#[derive(Clone, Debug, Deserialize)]
pub struct ModifyChannelPosition {
    pub id: Snowflake,
    /// Absent or `null` leaves the position unchanged.
    #[serde(default)]
    pub position: Option<i32>,
    /// Absent leaves the parent unchanged; `null` (or `"0"`) moves the channel out of its category.
    #[serde(default, deserialize_with = "double_option")]
    pub parent_id: Option<Option<Snowflake>>,
    /// With a parent: `true` replaces the channel's overwrites with the parent's.
    #[serde(default)]
    pub lock_permissions: Option<bool>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct UpdateChannelRequest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub topic: Option<String>,
    /// Guild text, announcement, forum and voice channels only; other types → 400.
    #[serde(default)]
    pub nsfw: Option<bool>,
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
    /// Server mute (MUTE_MEMBERS) / deafen (DEAFEN_MEMBERS); persisted, applied to a connected member at once.
    #[serde(default)]
    pub mute: Option<bool>,
    #[serde(default)]
    pub deaf: Option<bool>,
    /// Voice move (MOVE_MEMBERS in the current and the target channel): a voice channel of the guild, or `null` to disconnect.
    /// The member must be in voice (400 40032).
    #[serde(default, deserialize_with = "double_option")]
    pub channel_id: Option<Option<Snowflake>>,
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
    /// `null` removes the role icon.
    #[serde(default, deserialize_with = "double_option")]
    pub unicode_emoji: Option<Option<String>>,
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

// ---- Server admin: prune, audit log, AutoMod ----

/// `GET /guilds/{id}/prune?days&include_roles` (query) and `POST /guilds/{id}/prune` (body).
#[derive(Clone, Debug, Default, Deserialize)]
pub struct PruneRequest {
    /// 1..=30, default 7.
    #[serde(default)]
    pub days: Option<u32>,
    /// Members holding only these roles are pruned too (members with any other role never are).
    #[serde(default)]
    pub include_roles: Option<Vec<Snowflake>>,
    /// POST only: `false` skips counting and answers `{pruned: null}`. Default true.
    #[serde(default)]
    pub compute_prune_count: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PruneResponse {
    pub pruned: Option<u32>,
}

numeric_enum!(
    /// Discord's audit log event numbers; Vokko records the ones whose routes exist (docs/api.md).
    AuditLogEvent {
        GuildUpdate = 1,
        ChannelCreate = 10,
        ChannelUpdate = 11,
        ChannelDelete = 12,
        ChannelOverwriteCreate = 13,
        ChannelOverwriteUpdate = 14,
        ChannelOverwriteDelete = 15,
        MemberKick = 20,
        MemberPrune = 21,
        MemberBanAdd = 22,
        MemberBanRemove = 23,
        MemberUpdate = 24,
        MemberRoleUpdate = 25,
        MemberMove = 26,
        MemberDisconnect = 27,
        BotAdd = 28,
        RoleCreate = 30,
        RoleUpdate = 31,
        RoleDelete = 32,
        InviteCreate = 40,
        InviteUpdate = 41,
        InviteDelete = 42,
        WebhookCreate = 50,
        WebhookUpdate = 51,
        WebhookDelete = 52,
        EmojiCreate = 60,
        EmojiUpdate = 61,
        EmojiDelete = 62,
        MessageDelete = 72,
        MessageBulkDelete = 73,
        MessagePin = 74,
        MessageUnpin = 75,
        IntegrationCreate = 80,
        IntegrationUpdate = 81,
        IntegrationDelete = 82,
        StickerCreate = 90,
        StickerUpdate = 91,
        StickerDelete = 92,
        GuildScheduledEventCreate = 100,
        GuildScheduledEventUpdate = 101,
        GuildScheduledEventDelete = 102,
        ThreadCreate = 110,
        ThreadUpdate = 111,
        ThreadDelete = 112,
        ApplicationCommandPermissionUpdate = 121,
        AutoModerationRuleCreate = 140,
        AutoModerationRuleUpdate = 141,
        AutoModerationRuleDelete = 142,
        AutoModerationBlockMessage = 143,
        OnboardingPromptCreate = 163,
        OnboardingPromptUpdate = 164,
        OnboardingPromptDelete = 165,
        OnboardingCreate = 166,
        OnboardingUpdate = 167,
        /// Vokko-only (Discord has no report queue): a moderator closed or reopened a report (MOD-009). `target_id` is the
        /// report id, the one change is `status`.
        ReportUpdate = 250,
        /// Vokko-only: a game was added to, changed in or removed from the guild's catalog (`target_id` = the game id).
        GameAdd = 251,
        GameUpdate = 252,
        GameRemove = 253,
    }
);

/// One changed key; a missing side means the key was not set before (create) or after (delete).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AuditLogChange {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_value: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_value: Option<Value>,
}

/// Extra context per action type (Discord's "optional audit entry info"; numbers are strings like Discord's).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct AuditEntryInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<Snowflake>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<Snowflake>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delete_member_days: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub members_removed: Option<String>,
    /// Overwrite entries: the role or member id and `"0"` role / `"1"` member.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<Snowflake>,
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_moderation_rule_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_moderation_rule_trigger_type: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AuditLogEntry {
    pub id: Snowflake,
    pub guild_id: Snowflake,
    /// Who acted; `null` for system actions.
    pub user_id: Option<Snowflake>,
    /// The affected object (user, role, channel, invite code, rule...).
    pub target_id: Option<String>,
    pub action_type: AuditLogEvent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changes: Option<Vec<AuditLogChange>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<AuditEntryInfo>,
    /// From the `X-Audit-Log-Reason` header (URL-encoded, at most 512 characters).
    pub reason: Option<String>,
}

/// `GET /guilds/{id}/audit-logs`
#[derive(Clone, Debug, Default, Deserialize)]
pub struct AuditLogQuery {
    #[serde(default)]
    pub user_id: Option<Snowflake>,
    #[serde(default)]
    pub action_type: Option<u8>,
    #[serde(default)]
    pub before: Option<Snowflake>,
    #[serde(default)]
    pub after: Option<Snowflake>,
    /// 1..=100, default 50.
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AuditLog {
    /// Newest first.
    pub audit_log_entries: Vec<AuditLogEntry>,
    /// Every user referenced as actor or target.
    pub users: Vec<User>,
}

numeric_enum!(AutoModerationTriggerType { Keyword = 1 });
numeric_enum!(AutoModerationEventType { MessageSend = 1 });
numeric_enum!(AutoModerationActionType { BlockMessage = 1 });

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct AutoModerationTriggerMetadata {
    /// Up to 1000 keywords of at most 60 characters; `*` at the start or end matches a prefix / suffix / substring.
    #[serde(default)]
    pub keyword_filter: Vec<String>,
    /// Words that never trigger the rule (same syntax), up to 100.
    #[serde(default)]
    pub allow_list: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct AutoModerationActionMetadata {
    /// Shown to the blocked author (at most 150 characters).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_message: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AutoModerationAction {
    #[serde(rename = "type")]
    pub kind: AutoModerationActionType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<AutoModerationActionMetadata>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AutoModerationRule {
    pub id: Snowflake,
    pub guild_id: Snowflake,
    pub name: String,
    pub creator_id: Snowflake,
    pub event_type: AutoModerationEventType,
    pub trigger_type: AutoModerationTriggerType,
    pub trigger_metadata: AutoModerationTriggerMetadata,
    pub actions: Vec<AutoModerationAction>,
    pub enabled: bool,
    pub exempt_roles: Vec<Snowflake>,
    pub exempt_channels: Vec<Snowflake>,
}

/// POST (name, event_type, trigger_type and actions required) and PATCH (every key optional; the trigger type never changes).
#[derive(Clone, Debug, Default, Deserialize)]
pub struct AutoModerationRuleRequest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub event_type: Option<AutoModerationEventType>,
    #[serde(default)]
    pub trigger_type: Option<AutoModerationTriggerType>,
    #[serde(default)]
    pub trigger_metadata: Option<AutoModerationTriggerMetadata>,
    #[serde(default)]
    pub actions: Option<Vec<AutoModerationAction>>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub exempt_roles: Option<Vec<Snowflake>>,
    #[serde(default)]
    pub exempt_channels: Option<Vec<Snowflake>>,
}

/// Body of `POST /channels/{id}/invites`; every key is optional.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct CreateInviteRequest {
    /// Seconds until it expires, 0..=604800 (0 = never); default 86400.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_age: Option<u32>,
    /// 0..=100 (0 = no limit); default 0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_uses: Option<u32>,
    /// Members who join through it are removed when their last gateway connection closes, unless they were given a role.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temporary: Option<bool>,
    /// `false` (default) returns a live invite of the same inviter and channel with the same settings when there is one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unique: Option<bool>,
}

/// An invite with its settings and counters: the create response, the invite lists and INVITE_CREATE.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InviteMetadata {
    #[serde(flatten)]
    pub invite: Invite,
    pub uses: u32,
    pub max_uses: u32,
    pub max_age: u32,
    pub temporary: bool,
    pub created_at: String,
}

/// INVITE_DELETE.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InviteDelete {
    pub code: String,
    pub guild_id: Snowflake,
    pub channel_id: Snowflake,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MemberVerificationFieldType {
    Terms,
    TextInput,
    Paragraph,
    MultipleChoice,
}

/// A field's answer: TERMS `true`, TEXT_INPUT / PARAGRAPH a string, MULTIPLE_CHOICE the index of the choice.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MemberVerificationResponse {
    Bool(bool),
    Index(u32),
    Text(String),
}

/// One field of the member verification form (`values` are the rules or the choices).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MemberVerificationField {
    pub field_type: MemberVerificationFieldType,
    pub label: String,
    pub required: bool,
    #[serde(default)]
    pub values: Option<Vec<String>>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub placeholder: Option<String>,
    /// Only in a submitted request and in `GuildJoinRequest.form_responses`.
    #[serde(default)]
    pub response: Option<MemberVerificationResponse>,
}

/// `GET` / `PUT /guilds/{id}/member-verification`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct MemberVerificationForm {
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub form_fields: Vec<MemberVerificationField>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum JoinRequestStatus {
    Submitted,
    Approved,
    Rejected,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GuildJoinRequest {
    pub id: Snowflake,
    pub guild_id: Snowflake,
    pub user_id: Snowflake,
    pub user: User,
    pub created_at: String,
    pub application_status: JoinRequestStatus,
    pub form_responses: Vec<MemberVerificationField>,
    pub rejection_reason: Option<String>,
    pub actioned_at: Option<String>,
    pub actioned_by_user: Option<User>,
}

/// `GET /guilds/{id}/requests`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GuildJoinRequestList {
    pub guild_join_requests: Vec<GuildJoinRequest>,
    /// Requests with the asked status, regardless of paging.
    pub total: u32,
}

/// `PUT /guilds/{id}/requests/@me`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SubmitJoinRequest {
    pub invite_code: String,
    pub form_fields: Vec<MemberVerificationField>,
}

/// `PATCH /guilds/{id}/requests/{request_id}`; `action` is `APPROVED` or `REJECTED`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ActionJoinRequest {
    pub action: JoinRequestStatus,
    #[serde(default)]
    pub rejection_reason: Option<String>,
}

/// GUILD_JOIN_REQUEST_CREATE / GUILD_JOIN_REQUEST_UPDATE.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GuildJoinRequestEvent {
    pub guild_id: Snowflake,
    pub status: JoinRequestStatus,
    pub request: GuildJoinRequest,
}

/// GUILD_JOIN_REQUEST_DELETE.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GuildJoinRequestDelete {
    pub guild_id: Snowflake,
    pub id: Snowflake,
    pub user_id: Snowflake,
}

/// A server folder on the rail. `id` is chosen by the client (any snowflake-shaped string, unique among the user's folders).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GuildFolder {
    pub id: Snowflake,
    pub name: Option<String>,
    /// RGB int, `null` = the default folder colour.
    pub color: Option<u32>,
    pub guild_ids: Vec<Snowflake>,
}

/// Per-user server folders and rail order stored on the server (`GET/PATCH /users/@me/guild-layout`, READY `guild_layout`, GUILD_LAYOUT_UPDATE).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct GuildLayout {
    #[serde(default)]
    pub guild_folders: Vec<GuildFolder>,
    /// Rail order of guild ids (folder members in place, in folder order).
    #[serde(default)]
    pub guild_positions: Vec<Snowflake>,
}

/// Body of `PATCH /users/@me/guild-layout`: only sent keys change.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct UpdateGuildLayoutRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guild_folders: Option<Vec<GuildFolder>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guild_positions: Option<Vec<Snowflake>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Invite {
    pub code: String,
    pub guild: InviteGuild,
    pub channel: InviteChannel,
    pub expires_at: Option<String>,
    /// `null` when the inviter's account is gone.
    #[serde(default)]
    pub inviter: Option<User>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InviteGuild {
    pub id: Snowflake,
    pub name: String,
    pub icon: Option<String>,
    pub member_count: u32,
    /// Members online now (not offline or invisible); only on the `GET /invites/{code}` preview.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presence_count: Option<u32>,
    #[serde(default)]
    pub join_mode: JoinMode,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InviteChannel {
    pub id: Snowflake,
    pub name: Option<String>,
}

// ---- Community: scheduled events, onboarding, friend suggestions ----

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EventEntityMetadata {
    pub location: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EventRecurrenceRule {
    pub start: String,
    pub end: Option<String>,
    pub frequency: RecurrenceFrequency,
    pub interval: u32,
    /// 0 = Monday .. 6 = Sunday.
    pub by_weekday: Option<Vec<u8>>,
    pub count: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GuildScheduledEvent {
    pub id: Snowflake,
    pub guild_id: Snowflake,
    pub channel_id: Option<Snowflake>,
    pub creator_id: Option<Snowflake>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creator: Option<User>,
    pub name: String,
    pub description: Option<String>,
    pub scheduled_start_time: String,
    pub scheduled_end_time: Option<String>,
    /// Always 2 (guild only).
    pub privacy_level: u8,
    pub status: ScheduledEventStatus,
    pub entity_type: ScheduledEventEntityType,
    /// Always `null`.
    pub entity_id: Option<Snowflake>,
    pub entity_metadata: Option<EventEntityMetadata>,
    pub user_count: u32,
    /// Whether the receiver is Interested (filled per receiver, also in gateway events).
    pub user_rsvp: bool,
    pub image: Option<String>,
    pub recurrence_rule: Option<EventRecurrenceRule>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct CreateScheduledEventRequest {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub entity_type: ScheduledEventEntityType,
    #[serde(default)]
    pub channel_id: Option<Snowflake>,
    #[serde(default)]
    pub entity_metadata: Option<EventEntityMetadata>,
    pub scheduled_start_time: String,
    #[serde(default)]
    pub scheduled_end_time: Option<String>,
    #[serde(default)]
    pub privacy_level: Option<u8>,
    #[serde(default)]
    pub image_attachment_id: Option<Snowflake>,
    #[serde(default)]
    pub recurrence_rule: Option<EventRecurrenceRule>,
}

/// Every key is optional; a key sent as `null` clears the value where the type is nullable (`Some(None)`).
#[derive(Clone, Debug, Default, Deserialize)]
pub struct EditScheduledEventRequest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub description: Option<Option<String>>,
    #[serde(default)]
    pub entity_type: Option<ScheduledEventEntityType>,
    #[serde(default, deserialize_with = "double_option")]
    pub channel_id: Option<Option<Snowflake>>,
    #[serde(default, deserialize_with = "double_option")]
    pub entity_metadata: Option<Option<EventEntityMetadata>>,
    #[serde(default)]
    pub scheduled_start_time: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub scheduled_end_time: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub image_attachment_id: Option<Option<Snowflake>>,
    #[serde(default, deserialize_with = "double_option")]
    pub recurrence_rule: Option<Option<EventRecurrenceRule>>,
    #[serde(default)]
    pub status: Option<ScheduledEventStatus>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ScheduledEventUser {
    pub guild_scheduled_event_id: Snowflake,
    pub user: User,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member: Option<GuildMember>,
}

/// GUILD_SCHEDULED_EVENT_USER_ADD / _REMOVE.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ScheduledEventUserEvent {
    pub guild_scheduled_event_id: Snowflake,
    pub user_id: Snowflake,
    pub guild_id: Snowflake,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OnboardingOption {
    pub id: Snowflake,
    pub title: String,
    pub description: Option<String>,
    pub emoji: Option<ReactionEmoji>,
    pub channel_ids: Vec<Snowflake>,
    pub role_ids: Vec<Snowflake>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OnboardingPrompt {
    pub id: Snowflake,
    #[serde(rename = "type")]
    pub kind: OnboardingPromptType,
    pub title: String,
    pub options: Vec<OnboardingOption>,
    pub single_select: bool,
    pub required: bool,
    pub in_onboarding: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OnboardingRules {
    pub description: Option<String>,
    pub items: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GuildOnboarding {
    pub guild_id: Snowflake,
    pub prompts: Vec<OnboardingPrompt>,
    pub default_channel_ids: Vec<Snowflake>,
    pub enabled: bool,
    pub mode: OnboardingMode,
    pub rules: Option<OnboardingRules>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct OnboardingOptionInput {
    #[serde(default)]
    pub id: Option<Snowflake>,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub emoji: Option<ReactionEmoji>,
    #[serde(default)]
    pub channel_ids: Vec<Snowflake>,
    #[serde(default)]
    pub role_ids: Vec<Snowflake>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct OnboardingPromptInput {
    #[serde(default)]
    pub id: Option<Snowflake>,
    #[serde(rename = "type")]
    pub kind: OnboardingPromptType,
    pub title: String,
    pub options: Vec<OnboardingOptionInput>,
    #[serde(default)]
    pub single_select: Option<bool>,
    #[serde(default)]
    pub required: Option<bool>,
    #[serde(default)]
    pub in_onboarding: Option<bool>,
}

/// `PUT /guilds/{id}/onboarding`: only the sent keys change.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct EditOnboardingRequest {
    #[serde(default)]
    pub prompts: Option<Vec<OnboardingPromptInput>>,
    #[serde(default)]
    pub default_channel_ids: Option<Vec<Snowflake>>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub mode: Option<OnboardingMode>,
    #[serde(default, deserialize_with = "double_option")]
    pub rules: Option<Option<OnboardingRules>>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct OnboardingResponsesRequest {
    pub option_ids: Vec<Snowflake>,
    #[serde(default)]
    pub rules_accepted: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OnboardingResponses {
    pub option_ids: Vec<Snowflake>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OnboardingCompletion {
    pub member: GuildMember,
    pub channel_ids: Vec<Snowflake>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FriendSuggestion {
    pub user: User,
    pub mutual_guilds: Vec<MutualGuild>,
    pub mutual_friends_count: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FriendSuggestionsResponse {
    pub enabled: bool,
    pub suggestions: Vec<FriendSuggestion>,
}

/// Body and response of `GET` / `PATCH /users/@me/guilds/{id}/privacy`: whether members of that guild who are not friends may
/// DM the caller (Discord's `restricted_guilds`, inverted).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GuildPrivacySettings {
    pub direct_messages: bool,
}

/// Body and response of `PATCH /users/@me/friend-suggestion-settings`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FriendSuggestionSettings {
    pub enabled: bool,
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

// ---- Soundboard and entrance sounds ----

/// Soundboard upload limits: MP3, OGG or WAV, at most 512 KiB and 5.2 s; Vokko gives every guild the top tier.
pub const SOUNDBOARD_MAX_BYTES: u64 = 512 * 1024;
pub const SOUNDBOARD_MAX_DURATION_MS: u32 = 5_200;
pub const SOUNDBOARD_SOUNDS_PER_GUILD: usize = 48;

/// A soundboard sound: a guild's own (`guild_id` set) or one of the instance's default sounds (no `guild_id`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SoundboardSound {
    pub sound_id: Snowflake,
    /// 2-32 chars.
    pub name: String,
    /// 0..=1.
    pub volume: f64,
    /// Custom emoji id (Vokko has no custom emoji yet, so always `null` in practice).
    pub emoji_id: Option<Snowflake>,
    /// Unicode emoji shown on the tile.
    pub emoji_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guild_id: Option<Snowflake>,
    pub available: bool,
    /// Uploader (guild sounds only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<User>,
    /// Vokko addition: absolute URL of the audio file (clients treat it as opaque).
    pub url: String,
}

/// `GET /guilds/{id}/soundboard-sounds` (Discord's shape).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SoundboardSoundList {
    pub items: Vec<SoundboardSound>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CreateSoundboardSoundRequest {
    pub name: String,
    /// Pending upload from `POST /channels/{id}/attachments` (MP3, OGG or WAV, at most 512 KiB and 5.2 s).
    pub attachment_id: Snowflake,
    /// Default 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub volume: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emoji_id: Option<Snowflake>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emoji_name: Option<String>,
}

/// Only sent keys change; `null` clears the emoji.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct EditSoundboardSoundRequest {
    pub name: Option<String>,
    pub volume: Option<f64>,
    #[serde(default, deserialize_with = "double_option")]
    pub emoji_id: Option<Option<Snowflake>>,
    #[serde(default, deserialize_with = "double_option")]
    pub emoji_name: Option<Option<String>>,
}

/// `POST /channels/{id}/send-soundboard-sound`. `source_guild_id` absent: a default sound, or a sound of the channel's guild.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SendSoundboardSoundRequest {
    pub sound_id: Snowflake,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_guild_id: Option<Snowflake>,
}

/// The user's entrance sound for one scope: a guild (`guild_id`) or every guild without its own (`guild_id: null`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EntranceSound {
    pub guild_id: Option<Snowflake>,
    pub sound_id: Snowflake,
    /// Guild the sound belongs to; `null` = a default sound.
    pub source_guild_id: Option<Snowflake>,
}

/// `PUT /users/@me/entrance-sounds`: sets (or with `sound_id: null` clears) the entrance sound of one scope.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SetEntranceSoundRequest {
    #[serde(default)]
    pub guild_id: Option<Snowflake>,
    #[serde(default)]
    pub sound_id: Option<Snowflake>,
    #[serde(default)]
    pub source_guild_id: Option<Snowflake>,
}

/// `GET`/`PUT /users/@me/entrance-sounds` and ENTRANCE_SOUNDS_UPDATE.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EntranceSounds {
    pub entrance_sounds: Vec<EntranceSound>,
}

/// GUILD_SOUNDBOARD_SOUND_DELETE.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SoundboardSoundDelete {
    pub sound_id: Snowflake,
    pub guild_id: Snowflake,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EffectEmoji {
    pub id: Option<Snowflake>,
    pub name: Option<String>,
}

/// VOICE_CHANNEL_EFFECT_SEND: someone played a sound; sent only to the users connected to that voice channel.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct VoiceChannelEffectSend {
    pub channel_id: Snowflake,
    pub guild_id: Snowflake,
    pub user_id: Snowflake,
    pub sound_id: Snowflake,
    pub sound_volume: f64,
    pub emoji: Option<EffectEmoji>,
    /// Vokko addition: `null` = a default sound.
    pub source_guild_id: Option<Snowflake>,
    /// Vokko addition: the audio file, so members who are not in the source guild can play it.
    pub sound_url: String,
    /// Vokko addition: the sender's entrance sound on joining the channel.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub entrance: bool,
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

/// One of the caller's last avatars or banners (`GET /users/@me/avatars`, `/banners`): an upload they can set again with
/// `avatar_attachment_id` / `banner_attachment_id`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RecentImage {
    /// The attachment id.
    pub id: Snowflake,
    pub url: String,
}

/// `POST /users/@me/avatars/gif` and `/banners/gif`: the server downloads a picked GIF and stores it as a pending upload in `channel_id`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ImageGifRequest {
    pub channel_id: Snowflake,
    /// `Gif.url` from the GIF picker (a media URL of the configured provider).
    pub url: String,
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

/// Why a message or member is reported (the reason picker).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportReason {
    Spam,
    Harassment,
    Hate,
    Sexual,
    Violence,
    SelfHarm,
    Impersonation,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportStatus {
    Open,
    Resolved,
    Dismissed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportTargetType {
    Message,
    User,
}

/// `POST /channels/{id}/messages/{mid}/report` and `POST /guilds/{id}/members/{uid}/report`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CreateReportRequest {
    pub reason: ReportReason,
    /// Optional free text, at most 1000 characters (trimmed; blank is `null`).
    #[serde(default)]
    pub details: Option<String>,
}

/// `POST /bug-reports` ("Report a problem"): kept for the instance operator, deleted after 30 days.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CreateBugReportRequest {
    /// What went wrong, 1-2000 characters (trimmed).
    pub description: String,
    /// Client version, at most 64 characters.
    pub app_version: String,
    /// Operating system and browser, at most 256 characters.
    pub os: String,
    /// Recent client log lines (warnings, errors, voice events) with secrets scrubbed by the client; the whole body is capped at 256 KiB.
    #[serde(default)]
    pub logs: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BugReportCreated {
    pub id: Snowflake,
}

/// `PATCH /guilds/{id}/reports/{report_id}`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct UpdateReportRequest {
    pub status: ReportStatus,
}

/// A report for a guild's moderators (or, for a DM message, `guild_id: null`: kept for the instance operator).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Report {
    pub id: Snowflake,
    pub guild_id: Option<Snowflake>,
    pub target_type: ReportTargetType,
    pub reporter: User,
    /// The reported member, or the reported message's author.
    pub target_user: User,
    /// Message reports only.
    pub channel_id: Option<Snowflake>,
    pub message_id: Option<Snowflake>,
    /// The message text as it was when reported (it may since have been edited or deleted).
    pub message_content: Option<String>,
    pub reason: ReportReason,
    pub details: Option<String>,
    pub status: ReportStatus,
    pub created_at: String,
    /// Set when a moderator resolves or dismisses it (cleared when reopened).
    pub closed_by: Option<Snowflake>,
    pub closed_at: Option<String>,
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

// ---- User settings (synced preferences) and data export ----

/// `GET /users/@me/settings`, the PATCH result, the 409 body (flattened into [`UserSettingsConflict`]) and USER_SETTINGS_UPDATE.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct UserSettings {
    /// Starts at 0 (nothing saved yet) and grows by one with every accepted PATCH.
    pub version: u64,
    /// Only keys of [`user_settings::KEYS`]; a key that is absent means the client default.
    pub settings: serde_json::Map<String, Value>,
}

/// `PATCH /users/@me/settings`: `version` is the one the change is based on; each key in `settings` is set, `null` removes it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct PatchUserSettingsRequest {
    pub version: u64,
    pub settings: serde_json::Map<String, Value>,
}

/// 409 body of a PATCH based on an old version: the error plus the current blob.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct UserSettingsConflict {
    pub code: u32,
    pub message: String,
    pub version: u64,
    pub settings: serde_json::Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ExportedGuild {
    pub id: Snowflake,
    pub name: String,
    pub nick: Option<String>,
    pub joined_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ExportedChannel {
    pub id: Snowflake,
    #[serde(rename = "type")]
    pub kind: ChannelType,
    pub guild_id: Option<Snowflake>,
    pub name: Option<String>,
    /// DMs and group DMs: the other recipients.
    pub recipient_ids: Vec<Snowflake>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ExportedMessage {
    pub id: Snowflake,
    pub channel_id: Snowflake,
    pub content: String,
    pub timestamp: String,
    pub edited_timestamp: Option<String>,
    /// File names of the message's attachments.
    pub attachments: Vec<String>,
}

/// `GET /users/@me/export` ("Request my data"): the caller's own data as JSON, at most once per 24 h.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct UserDataExport {
    pub exported_at: String,
    pub user: User,
    pub settings: UserSettings,
    pub relationships: Vec<Relationship>,
    pub guilds: Vec<ExportedGuild>,
    /// Every channel the user wrote in plus their open DMs.
    pub channels: Vec<ExportedChannel>,
    /// The user's own messages, newest first, at most [`user_settings::EXPORT_MAX_MESSAGES`].
    pub messages: Vec<ExportedMessage>,
    pub messages_truncated: bool,
    /// Guilds whose members (non-friends) may not DM the user: Privacy Settings with Direct Messages off, including guilds left since.
    pub dm_restricted_guild_ids: Vec<Snowflake>,
}

/// The allow-list of synced settings. A key the server does not know is rejected, so a new synced pref needs one line here
/// (and one in `apps/desktop/src/ui/settingsSync.ts`).
pub mod user_settings {
    use serde_json::Value;

    /// Serialized size cap of the stored blob.
    pub const MAX_BYTES: usize = 64 * 1024;
    pub const EXPORT_MAX_MESSAGES: i64 = 20_000;
    /// 409 code of a PATCH whose `version` is not the current one.
    pub const VERSION_CONFLICT: u32 = 40090;
    pub const MAX_KEYBINDS: usize = 512;

    #[derive(Clone, Copy, Debug, PartialEq)]
    pub enum Kind {
        Bool,
        Enum(&'static [&'static str]),
        Int {
            min: i64,
            max: i64,
        },
        Text {
            max_chars: usize,
        },
        /// Array of distinct short strings.
        StringList {
            max_items: usize,
            max_chars: usize,
        },
        /// Array of `{action, keys, global?}` objects.
        Keybinds,
    }

    const MESSAGE_DISPLAY: &[&str] = &["cozy", "compact"];
    const DENSITY: &[&str] = &["compact", "default", "cozy"];
    const SPACING: &[&str] = &["compact", "balanced", "roomy"];
    const TIME_FORMAT: &[&str] = &["auto", "12", "24"];
    const SPOILERS: &[&str] = &["click", "always", "moderated"];
    const REACTION_NOTIFICATIONS: &[&str] = &["all", "dm", "never"];

    pub const KEYS: &[(&str, Kind)] = &[
        // Appearance
        // Theme ids grow with every client release (community and gradient themes), so the client validates them.
        ("theme", Kind::Text { max_chars: 32 }),
        ("message_display", Kind::Enum(MESSAGE_DISPLAY)),
        ("density", Kind::Enum(DENSITY)),
        ("message_spacing", Kind::Enum(SPACING)),
        ("message_group_gap", Kind::Int { min: 0, max: 24 }),
        ("show_compact_avatars", Kind::Bool),
        // Chat
        ("inline_attachment_media", Kind::Bool),
        ("inline_embed_media", Kind::Bool),
        ("show_embeds", Kind::Bool),
        ("show_reactions", Kind::Bool),
        ("convert_emoticons", Kind::Bool),
        ("emoji_autocomplete", Kind::Bool),
        ("sticker_suggestions", Kind::Bool),
        ("sticker_autocomplete", Kind::Bool),
        ("preview_markdown", Kind::Bool),
        ("spoiler_content", Kind::Enum(SPOILERS)),
        ("thread_split_view", Kind::Bool),
        // Language & time
        ("locale", Kind::Text { max_chars: 16 }),
        ("time_format", Kind::Enum(TIME_FORMAT)),
        // Notifications
        ("desktop_notifications", Kind::Bool),
        ("notification_sounds", Kind::Bool),
        ("sound_current_channel", Kind::Bool),
        ("unread_badge", Kind::Bool),
        ("taskbar_flash", Kind::Bool),
        ("friends_online_alerts", Kind::Bool),
        ("reaction_notifications", Kind::Enum(REACTION_NOTIFICATIONS)),
        ("disabled_sounds", Kind::StringList { max_items: 32, max_chars: 32 }),
        // Keybinds
        ("keybinds", Kind::Keybinds),
        // Streamer mode
        ("streamer_mode", Kind::Bool),
        ("streamer_auto_enable", Kind::Bool),
        ("streamer_hide_personal", Kind::Bool),
        ("streamer_hide_invites", Kind::Bool),
        ("streamer_disable_sounds", Kind::Bool),
        ("streamer_disable_notifications", Kind::Bool),
        ("streamer_hide_window", Kind::Bool),
        // Advanced
        ("developer_mode", Kind::Bool),
        // Data & privacy (the server enforces these three groups)
        ("dms_from_server_members", Kind::Bool),
        ("message_requests", Kind::Bool),
        ("friend_requests_everyone", Kind::Bool),
        ("friend_requests_mutual_friends", Kind::Bool),
        ("friend_requests_mutual_guilds", Kind::Bool),
    ];

    pub fn kind(key: &str) -> Option<Kind> {
        KEYS.iter().find(|(name, _)| *name == key).map(|(_, kind)| *kind)
    }

    fn short_text(value: &Value, max_chars: usize) -> bool {
        value.as_str().is_some_and(|text| !text.is_empty() && text.chars().count() <= max_chars)
    }

    /// Checks one value against its key; the error is the 50035 message for that key.
    pub fn validate(key: &str, value: &Value) -> Result<(), &'static str> {
        let Some(kind) = kind(key) else { return Err("Unknown setting.") };
        let ok = match kind {
            Kind::Bool => value.is_boolean(),
            Kind::Enum(values) => value.as_str().is_some_and(|text| values.contains(&text)),
            Kind::Int { min, max } => value.as_i64().is_some_and(|number| (min..=max).contains(&number)),
            Kind::Text { max_chars } => short_text(value, max_chars),
            Kind::StringList { max_items, max_chars } => value.as_array().is_some_and(|items| {
                let mut seen = std::collections::HashSet::new();
                items.len() <= max_items && items.iter().all(|item| short_text(item, max_chars) && seen.insert(item.as_str()))
            }),
            Kind::Keybinds => value.as_array().is_some_and(|items| {
                items.len() <= MAX_KEYBINDS
                    && items.iter().all(|item| {
                        item.as_object().is_some_and(|bind| {
                            bind.keys().all(|field| matches!(field.as_str(), "action" | "keys" | "global"))
                                && bind.get("action").is_some_and(|action| short_text(action, 64))
                                && bind.get("keys").is_some_and(|keys| short_text(keys, 64))
                                && bind.get("global").is_none_or(Value::is_boolean)
                        })
                    })
            }),
        };
        if ok { Ok(()) } else { Err("Invalid value for this setting.") }
    }

    /// Server-enforced privacy setting with its default when the key is absent.
    pub fn flag(settings: &serde_json::Map<String, Value>, key: &str, default: bool) -> bool {
        settings.get(key).and_then(Value::as_bool).unwrap_or(default)
    }
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
    /// Absent keeps the current activities, an empty list clears them.
    #[serde(default)]
    pub activities: Option<Vec<Activity>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GuildWithState {
    #[serde(flatten)]
    pub guild: Guild,
    pub channels: Vec<Channel>,
    pub members: Vec<GuildMember>,
    pub member_count: u32,
    pub stickers: Vec<Sticker>,
    /// The guild's own soundboard sounds; omitted when there are none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub soundboard_sounds: Vec<SoundboardSound>,
    /// Active threads the user can see (they are not part of `channels`); omitted when there are none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub threads: Vec<Channel>,
    /// The guild's custom emoji (without `user`); omitted when there are none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub emojis: Vec<GuildEmoji>,
    /// Only on GUILD_CREATE: the presences of the guild's members that are not offline (READY has its own list).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presences: Option<Vec<Presence>>,
    /// Who is in the guild's voice channels the receiver can see.
    #[serde(default)]
    pub voice_states: Vec<VoiceState>,
    /// Live stages in stage channels the receiver can see; omitted when there are none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stage_instances: Vec<StageInstance>,
    /// Watch Together sessions in the voice channels the receiver can see; omitted when there are none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub watch_together: Vec<WatchTogetherUpdate>,
    /// Stremio sessions in the voice channels the receiver can see; omitted when there are none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stremio: Vec<StremioUpdate>,
    /// The Spotify session in the voice channels the receiver can see (at most one on the whole server); omitted when there is none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub spotify: Vec<SpotifyUpdate>,
    /// Games running in the voice channels the receiver can see; omitted when there are none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub games: Vec<GameUpdate>,
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
    #[serde(default)]
    pub guild_layout: GuildLayout,
    pub media: InstanceMediaConfig,
    /// Latest desktop release this server knows of (`version` of the downloads' `latest.json`); absent when none is configured.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desktop_version: Option<String>,
}

/// DESKTOP_VERSION: sent to every connected session when the server sees a new desktop release (same value as READY `desktop_version`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DesktopVersion {
    pub version: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MessageDelete {
    pub id: Snowflake,
    pub channel_id: Snowflake,
    pub guild_id: Option<Snowflake>,
}

/// MESSAGE_DELETE_BULK: several messages of one channel at once (a ban with message history deletion).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MessageDeleteBulk {
    pub ids: Vec<Snowflake>,
    pub channel_id: Snowflake,
    pub guild_id: Option<Snowflake>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MessageReaction {
    pub user_id: Snowflake,
    pub channel_id: Snowflake,
    pub message_id: Snowflake,
    pub emoji: ReactionEmoji,
    /// Absent on old payloads = normal.
    #[serde(rename = "type", default = "normal_reaction")]
    pub kind: ReactionType,
    /// `type == 1`, kept for Discord parity.
    #[serde(default)]
    pub burst: bool,
    /// Author of the reacted message; MESSAGE_REACTION_ADD only (Discord's field), for "someone reacted to my message".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_author_id: Option<Snowflake>,
}

fn normal_reaction() -> ReactionType {
    ReactionType::Normal
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

/// GUILD_EMOJIS_UPDATE: the guild's full emoji list after a change.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GuildEmojisUpdate {
    pub guild_id: Snowflake,
    pub emojis: Vec<GuildEmoji>,
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

// ---- Applications, bots, slash commands, interactions, webhooks ----

numeric_enum!(ApplicationCommandType { ChatInput = 1, User = 2, Message = 3 });
numeric_enum!(ApplicationCommandOptionType { String = 3, Integer = 4, Boolean = 5, User = 6, Channel = 7, Role = 8, Number = 10 });
numeric_enum!(InteractionType { Ping = 1, ApplicationCommand = 2, ApplicationCommandAutocomplete = 4 });
numeric_enum!(InteractionCallbackType { ChannelMessageWithSource = 4, DeferredChannelMessageWithSource = 5, ApplicationCommandAutocompleteResult = 8 });
numeric_enum!(WebhookType { Incoming = 1, ChannelFollower = 2, Application = 3 });

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InstallParams {
    /// Decimal permission bitfield.
    pub permissions: String,
}

/// A bot application; the bot user's id equals the application id.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Application {
    pub id: Snowflake,
    pub name: String,
    pub description: String,
    pub icon: Option<String>,
    pub owner_id: Snowflake,
    pub bot: User,
    pub bot_public: bool,
    pub install_params: InstallParams,
}

/// `POST /applications`: the application plus its bot token (shown once).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ApplicationWithToken {
    #[serde(flatten)]
    pub application: Application,
    pub token: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CreateApplicationRequest {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct EditApplicationRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub icon_attachment_id: Option<Option<Snowflake>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot_public: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_params: Option<InstallParams>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BotTokenResponse {
    pub token: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AuthorizeGuild {
    pub id: Snowflake,
    pub name: String,
    pub icon: Option<String>,
    pub permissions: String,
}

/// `GET /oauth2/authorize`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OAuth2AuthorizeInfo {
    pub application: Application,
    pub bot: User,
    pub permissions: String,
    pub guilds: Vec<AuthorizeGuild>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OAuth2AuthorizeRequest {
    pub guild_id: Snowflake,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permissions: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OAuth2AuthorizeResponse {
    pub guild_id: Snowflake,
    pub role_id: Option<Snowflake>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ApplicationCommandOptionChoice {
    pub name: String,
    /// A string for string options, a number for integer/number options.
    pub value: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ApplicationCommandOption {
    #[serde(rename = "type")]
    pub kind: ApplicationCommandOptionType,
    pub name: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub choices: Option<Vec<ApplicationCommandOptionChoice>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub autocomplete: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_value: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_value: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_length: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_length: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_types: Option<Vec<ChannelType>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ApplicationCommand {
    pub id: Snowflake,
    #[serde(rename = "type")]
    pub kind: ApplicationCommandType,
    pub application_id: Snowflake,
    pub guild_id: Option<Snowflake>,
    pub name: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<ApplicationCommandOption>>,
    pub default_member_permissions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dm_permission: Option<bool>,
    pub version: Snowflake,
}

/// Body of POST/PUT (all of `name`) and PATCH (every field optional; `name` may then be absent) on the command routes.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ApplicationCommandRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<ApplicationCommandType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<ApplicationCommandOption>>,
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub default_member_permissions: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dm_permission: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CommandIndexApplication {
    pub id: Snowflake,
    pub name: String,
    pub icon: Option<String>,
    pub bot_id: Snowflake,
}

/// `GET /channels/{id}/application-commands`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ApplicationCommandIndex {
    pub applications: Vec<CommandIndexApplication>,
    pub application_commands: Vec<ApplicationCommand>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InteractionDataOption {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: ApplicationCommandOptionType,
    /// string, number or boolean; user/channel/role options carry the id as a string.
    pub value: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focused: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ResolvedMember {
    pub nick: Option<String>,
    pub roles: Vec<Snowflake>,
    pub joined_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ResolvedChannel {
    pub id: Snowflake,
    #[serde(rename = "type")]
    pub kind: ChannelType,
    pub name: Option<String>,
    pub parent_id: Option<Snowflake>,
}

/// Objects referenced by user/channel/role options and the target of a context-menu command, keyed by id.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct InteractionResolved {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub users: Option<std::collections::BTreeMap<Snowflake, User>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub members: Option<std::collections::BTreeMap<Snowflake, ResolvedMember>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub roles: Option<std::collections::BTreeMap<Snowflake, Role>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channels: Option<std::collections::BTreeMap<Snowflake, ResolvedChannel>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub messages: Option<std::collections::BTreeMap<Snowflake, Message>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InteractionData {
    pub id: Snowflake,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: ApplicationCommandType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guild_id: Option<Snowflake>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<InteractionDataOption>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved: Option<InteractionResolved>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<Snowflake>,
}

/// INTERACTION_CREATE, sent to the bot.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Interaction {
    pub id: Snowflake,
    pub application_id: Snowflake,
    #[serde(rename = "type")]
    pub kind: InteractionType,
    pub data: InteractionData,
    pub guild_id: Option<Snowflake>,
    pub channel_id: Snowflake,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member: Option<GuildMember>,
    pub user: User,
    pub token: String,
    pub app_permissions: String,
    pub version: u8,
}

/// `data` of `POST /interactions`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InvokeInteractionData {
    pub id: Snowflake,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: ApplicationCommandType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<InteractionDataOption>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<Snowflake>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InvokeInteractionRequest {
    #[serde(rename = "type")]
    pub kind: InteractionType,
    pub application_id: Snowflake,
    pub channel_id: Snowflake,
    pub data: InvokeInteractionData,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nonce: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InteractionCreated {
    pub id: Snowflake,
    pub nonce: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct InteractionCallbackData {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embeds: Option<Vec<Embed>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flags: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_mentions: Option<AllowedMentions>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub choices: Option<Vec<ApplicationCommandOptionChoice>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InteractionResponse {
    #[serde(rename = "type")]
    pub kind: InteractionCallbackType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<InteractionCallbackData>,
}

/// Webhook execute, interaction followups and edits of webhook/interaction messages.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct WebhookMessageRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embeds: Option<Vec<Embed>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flags: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_mentions: Option<AllowedMentions>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MessageInteractionMetadata {
    pub id: Snowflake,
    #[serde(rename = "type")]
    pub kind: InteractionType,
    pub user: User,
    pub name: String,
    pub command_type: ApplicationCommandType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_user: Option<User>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_message_id: Option<Snowflake>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Webhook {
    pub id: Snowflake,
    #[serde(rename = "type")]
    pub kind: WebhookType,
    pub guild_id: Option<Snowflake>,
    pub channel_id: Snowflake,
    pub name: String,
    pub avatar: Option<String>,
    pub application_id: Option<Snowflake>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<User>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CreateWebhookRequest {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_attachment_id: Option<Snowflake>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct EditWebhookRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub avatar_attachment_id: Option<Option<Snowflake>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<Snowflake>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct IntegrationApplication {
    pub id: Snowflake,
    pub name: String,
    pub description: String,
    pub icon: Option<String>,
    pub bot: User,
}

/// `GET /guilds/{id}/integrations`: a bot added to the guild.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GuildIntegration {
    pub id: Snowflake,
    /// Always `"bot"`.
    #[serde(rename = "type")]
    pub kind: String,
    pub name: String,
    pub enabled: bool,
    pub application: IntegrationApplication,
    pub user: Option<User>,
    pub role_id: Option<Snowflake>,
}

/// INTERACTION_FAILURE: the bot did not answer within 3 seconds.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InteractionFailure {
    pub id: Snowflake,
    pub nonce: Option<String>,
    pub channel_id: Snowflake,
    pub application_id: Snowflake,
}

/// APPLICATION_COMMAND_AUTOCOMPLETE_RESPONSE.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AutocompleteResponse {
    pub id: Snowflake,
    pub nonce: Option<String>,
    pub choices: Vec<ApplicationCommandOptionChoice>,
}

/// WEBHOOKS_UPDATE.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WebhooksUpdate {
    pub guild_id: Snowflake,
    pub channel_id: Snowflake,
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
    GuildEmojisUpdate(GuildEmojisUpdate),
    /// Same payload as GUILD_MEMBER_REMOVE.
    GuildBanAdd(GuildMemberRemove),
    GuildBanRemove(GuildMemberRemove),
    PresenceUpdate(Presence),
    UserUpdate(User),
    MessageAck(MessageAck),
    RelationshipAdd(Relationship),
    RelationshipRemove(IdOnly),
    GuildScheduledEventCreate(Box<GuildScheduledEvent>),
    GuildScheduledEventUpdate(Box<GuildScheduledEvent>),
    GuildScheduledEventDelete(Box<GuildScheduledEvent>),
    GuildScheduledEventUserAdd(ScheduledEventUserEvent),
    GuildScheduledEventUserRemove(ScheduledEventUserEvent),
    GuildStickersUpdate(GuildStickersUpdate),
    BookmarkAdd(Box<Bookmark>),
    BookmarkRemove(BookmarkRemove),
    ReminderCreate(Box<Reminder>),
    ReminderDue(Box<Reminder>),
    ReminderDelete(IdOnly),
    UserSettingsUpdate(Box<UserSettings>),
    VoiceStateUpdate(Box<VoiceState>),
    VoiceServerUpdate(VoiceServerUpdate),
    VoiceConnectFailed(VoiceConnectFailed),
    VoiceChannelStatusUpdate(VoiceChannelStatusUpdate),
    WatchTogetherUpdate(WatchTogetherUpdate),
    StremioUpdate(StremioUpdate),
    SpotifyUpdate(SpotifyUpdate),
    GameUpdate(GameUpdate),
    GameMessage(GameMessage),
    GuildGamesUpdate(GuildGamesUpdate),
    StageInstanceCreate(StageInstance),
    StageInstanceUpdate(StageInstance),
    StageInstanceDelete(StageInstance),
    ThreadCreate(Channel),
    ThreadUpdate(Channel),
    ThreadDelete(ThreadDelete),
    ThreadMemberUpdate(ThreadMemberUpdate),
    ThreadMembersUpdate(ThreadMembersUpdate),
    InteractionCreate(Box<Interaction>),
    InteractionFailure(InteractionFailure),
    AutocompleteResponse(AutocompleteResponse),
    WebhooksUpdate(WebhooksUpdate),
    CallCreate(Box<Call>),
    CallUpdate(CallUpdate),
    CallDelete(CallDelete),
    MessagePollVoteAdd(PollVote),
    MessagePollVoteRemove(PollVote),
    GuildSoundboardSoundCreate(Box<SoundboardSound>),
    GuildSoundboardSoundUpdate(Box<SoundboardSound>),
    GuildSoundboardSoundDelete(SoundboardSoundDelete),
    VoiceChannelEffectSend(VoiceChannelEffectSend),
    EntranceSoundsUpdate(EntranceSounds),
    MessageDeleteBulk(MessageDeleteBulk),
    /// Only to members with VIEW_AUDIT_LOG.
    GuildAuditLogEntryCreate(AuditLogEntry),
    /// AUTO_MODERATION_RULE_*: only to members with MANAGE_GUILD.
    AutoModerationRuleCreate(AutoModerationRule),
    AutoModerationRuleUpdate(AutoModerationRule),
    AutoModerationRuleDelete(AutoModerationRule),
    InviteCreate(Box<InviteMetadata>),
    InviteDelete(InviteDelete),
    GuildLayoutUpdate(GuildLayout),
    DesktopVersion(DesktopVersion),
    /// GUILD_JOIN_REQUEST_*: to the applicant and members with KICK_MEMBERS or MANAGE_GUILD.
    GuildJoinRequestCreate(Box<GuildJoinRequestEvent>),
    GuildJoinRequestUpdate(Box<GuildJoinRequestEvent>),
    GuildJoinRequestDelete(GuildJoinRequestDelete),
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
            Self::GuildEmojisUpdate(_) => "GUILD_EMOJIS_UPDATE",
            Self::GuildBanAdd(_) => "GUILD_BAN_ADD",
            Self::GuildBanRemove(_) => "GUILD_BAN_REMOVE",
            Self::PresenceUpdate(_) => "PRESENCE_UPDATE",
            Self::UserUpdate(_) => "USER_UPDATE",
            Self::MessageAck(_) => "MESSAGE_ACK",
            Self::RelationshipAdd(_) => "RELATIONSHIP_ADD",
            Self::RelationshipRemove(_) => "RELATIONSHIP_REMOVE",
            Self::GuildScheduledEventCreate(_) => "GUILD_SCHEDULED_EVENT_CREATE",
            Self::GuildScheduledEventUpdate(_) => "GUILD_SCHEDULED_EVENT_UPDATE",
            Self::GuildScheduledEventDelete(_) => "GUILD_SCHEDULED_EVENT_DELETE",
            Self::GuildScheduledEventUserAdd(_) => "GUILD_SCHEDULED_EVENT_USER_ADD",
            Self::GuildScheduledEventUserRemove(_) => "GUILD_SCHEDULED_EVENT_USER_REMOVE",
            Self::GuildStickersUpdate(_) => "GUILD_STICKERS_UPDATE",
            Self::BookmarkAdd(_) => "BOOKMARK_ADD",
            Self::BookmarkRemove(_) => "BOOKMARK_REMOVE",
            Self::ReminderCreate(_) => "REMINDER_CREATE",
            Self::ReminderDue(_) => "REMINDER_DUE",
            Self::ReminderDelete(_) => "REMINDER_DELETE",
            Self::UserSettingsUpdate(_) => "USER_SETTINGS_UPDATE",
            Self::VoiceStateUpdate(_) => "VOICE_STATE_UPDATE",
            Self::VoiceServerUpdate(_) => "VOICE_SERVER_UPDATE",
            Self::VoiceConnectFailed(_) => "VOICE_CONNECT_FAILED",
            Self::VoiceChannelStatusUpdate(_) => "VOICE_CHANNEL_STATUS_UPDATE",
            Self::WatchTogetherUpdate(_) => "WATCH_TOGETHER_UPDATE",
            Self::StremioUpdate(_) => "STREMIO_UPDATE",
            Self::SpotifyUpdate(_) => "SPOTIFY_UPDATE",
            Self::GameUpdate(_) => "GAME_UPDATE",
            Self::GameMessage(_) => "GAME_MESSAGE",
            Self::GuildGamesUpdate(_) => "GUILD_GAMES_UPDATE",
            Self::StageInstanceCreate(_) => "STAGE_INSTANCE_CREATE",
            Self::StageInstanceUpdate(_) => "STAGE_INSTANCE_UPDATE",
            Self::StageInstanceDelete(_) => "STAGE_INSTANCE_DELETE",
            Self::ThreadCreate(_) => "THREAD_CREATE",
            Self::ThreadUpdate(_) => "THREAD_UPDATE",
            Self::ThreadDelete(_) => "THREAD_DELETE",
            Self::ThreadMemberUpdate(_) => "THREAD_MEMBER_UPDATE",
            Self::ThreadMembersUpdate(_) => "THREAD_MEMBERS_UPDATE",
            Self::InteractionCreate(_) => "INTERACTION_CREATE",
            Self::InteractionFailure(_) => "INTERACTION_FAILURE",
            Self::AutocompleteResponse(_) => "APPLICATION_COMMAND_AUTOCOMPLETE_RESPONSE",
            Self::WebhooksUpdate(_) => "WEBHOOKS_UPDATE",
            Self::CallCreate(_) => "CALL_CREATE",
            Self::CallUpdate(_) => "CALL_UPDATE",
            Self::CallDelete(_) => "CALL_DELETE",
            Self::MessagePollVoteAdd(_) => "MESSAGE_POLL_VOTE_ADD",
            Self::MessagePollVoteRemove(_) => "MESSAGE_POLL_VOTE_REMOVE",
            Self::GuildSoundboardSoundCreate(_) => "GUILD_SOUNDBOARD_SOUND_CREATE",
            Self::GuildSoundboardSoundUpdate(_) => "GUILD_SOUNDBOARD_SOUND_UPDATE",
            Self::GuildSoundboardSoundDelete(_) => "GUILD_SOUNDBOARD_SOUND_DELETE",
            Self::VoiceChannelEffectSend(_) => "VOICE_CHANNEL_EFFECT_SEND",
            Self::EntranceSoundsUpdate(_) => "ENTRANCE_SOUNDS_UPDATE",
            Self::MessageDeleteBulk(_) => "MESSAGE_DELETE_BULK",
            Self::GuildAuditLogEntryCreate(_) => "GUILD_AUDIT_LOG_ENTRY_CREATE",
            Self::AutoModerationRuleCreate(_) => "AUTO_MODERATION_RULE_CREATE",
            Self::AutoModerationRuleUpdate(_) => "AUTO_MODERATION_RULE_UPDATE",
            Self::AutoModerationRuleDelete(_) => "AUTO_MODERATION_RULE_DELETE",
            Self::InviteCreate(_) => "INVITE_CREATE",
            Self::InviteDelete(_) => "INVITE_DELETE",
            Self::GuildLayoutUpdate(_) => "GUILD_LAYOUT_UPDATE",
            Self::DesktopVersion(_) => "DESKTOP_VERSION",
            Self::GuildJoinRequestCreate(_) => "GUILD_JOIN_REQUEST_CREATE",
            Self::GuildJoinRequestUpdate(_) => "GUILD_JOIN_REQUEST_UPDATE",
            Self::GuildJoinRequestDelete(_) => "GUILD_JOIN_REQUEST_DELETE",
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
            Self::GuildEmojisUpdate(value) => serde_json::to_value(value),
            Self::PresenceUpdate(value) => serde_json::to_value(value),
            Self::UserUpdate(value) => serde_json::to_value(value),
            Self::MessageAck(value) => serde_json::to_value(value),
            Self::RelationshipAdd(value) => serde_json::to_value(value),
            Self::GuildScheduledEventCreate(value) | Self::GuildScheduledEventUpdate(value) | Self::GuildScheduledEventDelete(value) => {
                serde_json::to_value(value)
            }
            Self::GuildScheduledEventUserAdd(value) | Self::GuildScheduledEventUserRemove(value) => serde_json::to_value(value),
            Self::GuildStickersUpdate(value) => serde_json::to_value(value),
            Self::BookmarkAdd(value) => serde_json::to_value(value),
            Self::BookmarkRemove(value) => serde_json::to_value(value),
            Self::ReminderCreate(value) | Self::ReminderDue(value) => serde_json::to_value(value),
            Self::ReminderDelete(value) => serde_json::to_value(value),
            Self::UserSettingsUpdate(value) => serde_json::to_value(value),
            Self::VoiceStateUpdate(value) => serde_json::to_value(value),
            Self::VoiceServerUpdate(value) => serde_json::to_value(value),
            Self::VoiceConnectFailed(value) => serde_json::to_value(value),
            Self::VoiceChannelStatusUpdate(value) => serde_json::to_value(value),
            Self::WatchTogetherUpdate(value) => serde_json::to_value(value),
            Self::StremioUpdate(value) => serde_json::to_value(value),
            Self::SpotifyUpdate(value) => serde_json::to_value(value),
            Self::GameUpdate(value) => serde_json::to_value(value),
            Self::GameMessage(value) => serde_json::to_value(value),
            Self::GuildGamesUpdate(value) => serde_json::to_value(value),
            Self::StageInstanceCreate(value) | Self::StageInstanceUpdate(value) | Self::StageInstanceDelete(value) => serde_json::to_value(value),
            Self::ThreadCreate(value) | Self::ThreadUpdate(value) => serde_json::to_value(value),
            Self::ThreadDelete(value) => serde_json::to_value(value),
            Self::ThreadMemberUpdate(value) => serde_json::to_value(value),
            Self::ThreadMembersUpdate(value) => serde_json::to_value(value),
            Self::InteractionCreate(value) => serde_json::to_value(value),
            Self::InteractionFailure(value) => serde_json::to_value(value),
            Self::AutocompleteResponse(value) => serde_json::to_value(value),
            Self::WebhooksUpdate(value) => serde_json::to_value(value),
            Self::CallCreate(value) => serde_json::to_value(value),
            Self::CallUpdate(value) => serde_json::to_value(value),
            Self::CallDelete(value) => serde_json::to_value(value),
            Self::MessagePollVoteAdd(value) | Self::MessagePollVoteRemove(value) => serde_json::to_value(value),
            Self::GuildSoundboardSoundCreate(value) | Self::GuildSoundboardSoundUpdate(value) => serde_json::to_value(value),
            Self::GuildSoundboardSoundDelete(value) => serde_json::to_value(value),
            Self::VoiceChannelEffectSend(value) => serde_json::to_value(value),
            Self::EntranceSoundsUpdate(value) => serde_json::to_value(value),
            Self::MessageDeleteBulk(value) => serde_json::to_value(value),
            Self::GuildAuditLogEntryCreate(value) => serde_json::to_value(value),
            Self::AutoModerationRuleCreate(value) | Self::AutoModerationRuleUpdate(value) | Self::AutoModerationRuleDelete(value) => {
                serde_json::to_value(value)
            }
            Self::InviteCreate(value) => serde_json::to_value(value),
            Self::InviteDelete(value) => serde_json::to_value(value),
            Self::GuildLayoutUpdate(value) => serde_json::to_value(value),
            Self::DesktopVersion(value) => serde_json::to_value(value),
            Self::GuildJoinRequestCreate(value) | Self::GuildJoinRequestUpdate(value) => serde_json::to_value(value),
            Self::GuildJoinRequestDelete(value) => serde_json::to_value(value),
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
        json!({"id": "100", "username": "sam", "global_name": null, "avatar": null, "banner_color": "#5865f2", "bio": null, "bot": false, "banner": null, "pronouns": null, "theme_colors": null, "avatar_decoration": null, "profile_effect": null, "primary_guild": null, "nameplate": null, "display_name_styles": null, "profile_frame": null, "widgets": null})
    }

    #[test]
    fn member_search() {
        round_trip::<MemberSearchRequest>(json!({
            "limit": 12, "offset": 24, "sort": 2,
            "and_query": {
                "usernames": {"or_query": ["ryz"]}, "user_id": {"or_query": ["100"]}, "role_ids": {"or_query": ["301"]},
                "guild_joined_at": {"range": {"gte": 1_700_000_000_000_i64}}, "user_created_at": {"range": {"gte": 1, "lte": 2}},
                "source_invite_code": {"or_query": ["abc"]}, "join_source_type": {"or_query": [5]}
            }
        }));
        round_trip::<MemberSearchRequest>(json!({"and_query": {}}));
        let member = json!({"user": user(), "nick": null, "roles": [], "joined_at": "2026-10-11T00:00:00Z", "communication_disabled_until": null,
            "avatar": null, "banner": null, "bio": null, "pronouns": null, "theme_colors": null});
        round_trip::<MemberSearchResponse>(json!({
            "guild_id": "300", "page_result_count": 1, "total_result_count": 7,
            "members": [{"member": member, "source_invite_code": "abc", "join_source_type": 5, "inviter_id": "101"}]
        }));
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
            "id": "200", "type": 0, "guild_id": "300", "name": "general", "topic": null, "position": 0, "parent_id": "201", "nsfw": false, "last_message_id": null
        }));
        round_trip::<Channel>(json!({
            "id": "202", "type": 3, "guild_id": null, "name": null, "topic": null, "position": 0, "parent_id": null, "nsfw": false,
            "recipients": [user()], "last_message_id": "5", "owner_id": "100", "icon": null
        }));
    }

    #[test]
    fn guild_role_and_member() {
        let role = json!({"id": "300", "name": "@everyone", "color": 0, "hoist": false, "position": 0, "permissions": "1071698660929", "mentionable": false, "unicode_emoji": null});
        round_trip::<Role>(role.clone());
        round_trip::<Guild>(
            json!({"id": "300", "name": "Sam's server", "icon": null, "banner": null, "owner_id": "100", "roles": [role], "system_channel_id": "200", "tag": null, "theme": null, "verification_level": 0, "explicit_content_filter": 0, "nsfw_level": 0, "rules_channel_id": null, "join_mode": 0, "default_message_notifications": 0}),
        );
        round_trip::<Guild>(json!({
            "id": "300", "name": "g", "icon": null, "banner": null, "owner_id": "100", "roles": [], "system_channel_id": null,
            "tag": {"tag": "VKO", "badge": "bolt", "color_primary": 5793266, "color_secondary": 3878800}, "theme": {"preset": null, "primary": 1, "accent": 2},
            "verification_level": 3, "explicit_content_filter": 2, "nsfw_level": 3, "rules_channel_id": "201", "join_mode": 1, "default_message_notifications": 1
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
        perks["nameplate"] = json!("aurora");
        perks["display_name_styles"] = json!({"font_id": "serif", "effect_id": "gradient", "colors": [1, 2]});
        perks["profile_frame"] = json!("vines");
        round_trip::<User>(perks);
        let styled: UpdateUserRequest =
            serde_json::from_value(json!({"nameplate": null, "display_name_styles": {"font_id": "mono", "effect_id": "solid", "colors": [3]}}))
                .expect("styled");
        assert_eq!(styled.nameplate, Some(None));
        assert_eq!(styled.display_name_styles, Some(Some(DisplayNameStyles { font_id: "mono".into(), effect_id: "solid".into(), colors: vec![3] })));
        let edit: UpdateUserRequest = serde_json::from_value(json!({"pronouns": null, "theme_colors": [5, 6], "banner_attachment_id": "7"})).expect("edit");
        assert_eq!(edit.pronouns, Some(None));
        assert_eq!(edit.theme_colors, Some(Some([5, 6])));
        assert_eq!(edit.banner_attachment_id, Some(Some(Snowflake(7))));
        assert!(edit.bio.is_none() && edit.primary_guild_id.is_none());
        assert!(serde_json::from_value::<UpdateUserRequest>(json!({"theme_colors": [1, 2, 3]})).is_err());
        let mut with_widgets = user();
        with_widgets["widgets"] = json!({"favorite_game": {"name": "Hades", "image": "http://x/a.png", "image_attachment_id": "9", "reason": null, "tags": ["roguelike"]}, "games_i_like": []});
        round_trip::<User>(with_widgets);
        let edit: UpdateUserRequest =
            serde_json::from_value(json!({"widgets": {"games_i_like": [{"name": "Celeste", "image_attachment_id": "4"}], "favorite_game": null, "extra": 1}}))
                .expect("widgets");
        let board = edit.widgets.expect("present").expect("object");
        assert_eq!(board.favorite_game.map(|game| game.is_none()), Some(true));
        assert_eq!(board.games_i_like.expect("key").expect("list")[0].image_attachment_id, Some(Snowflake(4)));
        assert_eq!(board.unknown.keys().collect::<Vec<_>>(), ["extra"]);
        assert_eq!(serde_json::from_value::<UpdateUserRequest>(json!({"widgets": null})).expect("null").widgets.map(|board| board.is_none()), Some(true));
        let own: EditOwnMemberRequest = serde_json::from_value(json!({"bio": null, "avatar_attachment_id": null})).expect("own");
        assert_eq!((own.bio, own.avatar_attachment_id), (Some(None), Some(None)));
        let guild: UpdateGuildRequest = serde_json::from_value(json!({"tag": null})).expect("guild");
        assert_eq!(guild.tag, Some(None));
        assert!(guild.theme.is_none());
    }

    #[test]
    fn message_with_reply_attachment_and_reaction() {
        let attachment = json!({"id": "9", "filename": "a.png", "content_type": "image/png", "size": 12, "url": "http://x/a.png", "width": 4, "height": 3});
        let reaction = json!({
            "emoji": {"id": null, "name": "👍"}, "count": 3, "count_details": {"burst": 1, "normal": 2}, "burst_colors": [], "me": true, "me_burst": false
        });
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
            "edited_timestamp": null, "type": 0, "mentions": [], "mention_everyone": false, "attachments": [], "embeds": [], "reactions": [], "pinned": false, "tts": false,
            "message_reference": null, "referenced_message": null, "nonce": null
        });
        round_trip::<Message>(inner.clone());
        round_trip::<Message>(json!({
            "id": "12", "channel_id": "200", "guild_id": "300", "author": user(), "member": {"nick": "R", "roles": []}, "content": "re",
            "timestamp": "2026-10-11T10:01:00.000Z", "edited_timestamp": "2026-10-11T10:02:00.000Z", "type": 19, "mentions": [user()],
            "mention_everyone": true, "attachments": [attachment], "embeds": [embed], "reactions": [reaction], "pinned": true, "tts": false,
            "message_reference": {"message_id": "11", "channel_id": "200", "guild_id": "300"}, "referenced_message": inner, "nonce": "n1"
        }));
    }

    #[test]
    fn skip_needed_is_half_the_listeners_rounded_up() {
        let table: Vec<u32> = (0..=5).map(skip_needed).collect();
        assert_eq!(table, [1, 1, 1, 2, 2, 3]);
        assert_eq!(skip_needed(10), 5);
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
        assert_eq!(NAMED.len(), 54);
        assert_eq!(seen, ALL);
        assert_eq!(ALL & (1 << 47), 0, "bit 47 is unassigned");
        assert_eq!(NAMED.last().map(|(_, bit)| bit.trailing_zeros()), Some(60));
        // Discord's 27 plus Vokko's CONTROL_MEDIA.
        assert_eq!(DEFAULT_EVERYONE.count_ones(), 28);
        assert_ne!(DEFAULT_EVERYONE & CONTROL_MEDIA, 0);
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
            "pinned": false, "tts": false, "message_reference": {"type": 1, "message_id": "11", "channel_id": "200", "guild_id": "300"},
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
        let guild = json!({"id": "300", "name": "g", "icon": null, "banner": null, "owner_id": "100", "roles": [], "system_channel_id": null, "tag": null, "theme": null, "verification_level": 0, "explicit_content_filter": 0, "nsfw_level": 0, "rules_channel_id": null, "join_mode": 0, "default_message_notifications": 0});
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
            "guild_layout": {"guild_folders": [{"id": "9", "name": "games", "color": 5793266, "guild_ids": ["300"]}], "guild_positions": ["300"]},
            "media": {"voice_enabled": true, "voice_bitrate_ceiling": 128000, "screenshare_qualities": ["720p30", "1080p60"], "video_enabled": false}
        }));
        round_trip::<GuildMemberAdd>(
            json!({"user": user(), "nick": null, "roles": [], "joined_at": "2026-10-11T10:00:00.000Z", "communication_disabled_until": "2026-10-12T10:00:00.000Z", "avatar": null, "banner": null, "bio": null, "pronouns": null, "theme_colors": null, "guild_id": "300"}),
        );
        round_trip::<MessageDelete>(json!({"id": "1", "channel_id": "2", "guild_id": null}));
        round_trip::<MessageReaction>(
            json!({"user_id": "1", "channel_id": "2", "message_id": "3", "emoji": {"id": null, "name": "🎉"}, "type": 1, "burst": true}),
        );
        // an old payload without `type` reads as a normal reaction
        let old: MessageReaction =
            serde_json::from_value(json!({"user_id": "1", "channel_id": "2", "message_id": "3", "emoji": {"id": null, "name": "🎉"}})).expect("old");
        assert_eq!((old.kind, old.burst), (ReactionType::Normal, false));
        round_trip::<TypingStart>(json!({"channel_id": "2", "user_id": "1", "timestamp": 1_760_000_000}));
        round_trip::<MessageAck>(json!({"channel_id": "2", "message_id": "3"}));
    }

    #[test]
    fn moderation_shapes_match_types_ts() {
        let overwrite = json!({"id": "301", "type": 0, "allow": "0", "deny": "1024"});
        round_trip::<PermissionOverwrite>(overwrite.clone());
        round_trip::<PermissionOverwrite>(json!({"id": "100", "type": 1, "allow": "2048", "deny": "0"}));
        round_trip::<Channel>(json!({
            "id": "200", "type": 0, "guild_id": "300", "name": "mods", "topic": null, "position": 1, "parent_id": null, "nsfw": false, "last_message_id": null,
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
        let role = Role {
            id: Snowflake(301),
            name: "mod".to_owned(),
            color: 0,
            hoist: false,
            position: 1,
            permissions: "8192".to_owned(),
            mentionable: false,
            unicode_emoji: Some("🛡️".to_owned()),
        };
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

    fn scheduled_event() -> Value {
        json!({
            "id": "900", "guild_id": "300", "channel_id": null, "creator_id": "100", "creator": user(), "name": "Movie night", "description": null,
            "scheduled_start_time": "2026-10-20T18:00:00.000Z", "scheduled_end_time": "2026-10-20T20:00:00.000Z", "privacy_level": 2, "status": 1,
            "entity_type": 3, "entity_id": null, "entity_metadata": {"location": "The lounge"}, "user_count": 2, "user_rsvp": true, "image": null,
            "recurrence_rule": {"start": "2026-10-20T18:00:00.000Z", "end": null, "frequency": 2, "interval": 1, "by_weekday": [1], "count": null}
        })
    }

    #[test]
    fn community_shapes_match_types_ts() {
        round_trip::<GuildScheduledEvent>(scheduled_event());
        round_trip::<ScheduledEventUser>(json!({"guild_scheduled_event_id": "900", "user": user()}));
        round_trip::<ScheduledEventUserEvent>(json!({"guild_scheduled_event_id": "900", "user_id": "100", "guild_id": "300"}));
        let option =
            json!({"id": "7", "title": "Gamer", "description": null, "emoji": {"id": null, "name": "🎮"}, "channel_ids": ["200"], "role_ids": ["301"]});
        let prompt =
            json!({"id": "6", "type": 0, "title": "What do you play?", "options": [option], "single_select": false, "required": true, "in_onboarding": true});
        round_trip::<OnboardingPrompt>(prompt.clone());
        round_trip::<GuildOnboarding>(json!({
            "guild_id": "300", "prompts": [prompt], "default_channel_ids": ["200"], "enabled": true, "mode": 1,
            "rules": {"description": null, "items": ["Be kind"]}
        }));
        round_trip::<OnboardingResponses>(json!({"option_ids": ["7"]}));
        round_trip::<FriendSuggestionsResponse>(json!({
            "enabled": true, "suggestions": [{"user": user(), "mutual_guilds": [{"id": "300", "nick": null}], "mutual_friends_count": 1}]
        }));
        round_trip::<FriendSuggestionSettings>(json!({"enabled": false}));
        round_trip::<GuildMember>(
            json!({"user": user(), "nick": null, "roles": [], "joined_at": "2026-10-11T10:00:00.000Z", "communication_disabled_until": null, "avatar": null, "banner": null, "bio": null, "pronouns": null, "theme_colors": null, "flags": 8}),
        );
        let edit: EditScheduledEventRequest = serde_json::from_value(json!({"description": null, "status": 2})).expect("edit event");
        assert_eq!((edit.description, edit.status), (Some(None), Some(ScheduledEventStatus::Active)));
        assert!(edit.scheduled_end_time.is_none() && edit.image_attachment_id.is_none());
        let edit: EditOnboardingRequest = serde_json::from_value(json!({"rules": null, "enabled": true})).expect("edit onboarding");
        assert_eq!((edit.rules, edit.enabled), (Some(None), Some(true)));
        let created = GatewayEvent::GuildScheduledEventCreate(Box::new(serde_json::from_value(scheduled_event()).expect("event")));
        assert_eq!((created.name(), created.data()["name"].clone()), ("GUILD_SCHEDULED_EVENT_CREATE", json!("Movie night")));
        let added = GatewayEvent::GuildScheduledEventUserAdd(ScheduledEventUserEvent {
            guild_scheduled_event_id: Snowflake(900),
            user_id: Snowflake(100),
            guild_id: Snowflake(300),
        });
        assert_eq!(
            (added.name(), added.data()),
            ("GUILD_SCHEDULED_EVENT_USER_ADD", json!({"guild_scheduled_event_id": "900", "user_id": "100", "guild_id": "300"}))
        );
        assert!(
            serde_json::from_value::<CreateScheduledEventRequest>(json!({"name": "x", "entity_type": 9, "scheduled_start_time": "2026-10-20T18:00:00.000Z"}))
                .is_err()
        );
    }

    #[test]
    fn thread_and_forum_shapes_match_types_ts() {
        let tag = json!({"id": "900", "name": "bug", "moderated": false, "emoji_id": null, "emoji_name": "🐛"});
        round_trip::<ForumTag>(tag.clone());
        round_trip::<Channel>(json!({
            "id": "210", "type": 15, "guild_id": "300", "name": "help", "topic": null, "position": 2, "parent_id": null, "nsfw": false, "last_message_id": null,
            "permission_overwrites": [], "available_tags": [tag], "default_reaction_emoji": {"emoji_id": null, "emoji_name": "👍"},
            "default_sort_order": 1, "default_forum_layout": 2, "default_auto_archive_duration": 4320, "flags": 16
        }));
        let thread = json!({
            "id": "11", "type": 11, "guild_id": "300", "name": "a thread", "topic": null, "position": 0, "parent_id": "200", "nsfw": false, "last_message_id": "12",
            "owner_id": "100", "permission_overwrites": [], "message_count": 3, "member_count": 2, "newly_created": true, "applied_tags": ["900"],
            "member": {"id": "11", "user_id": "100", "join_timestamp": "2026-10-11T10:00:00.000Z", "flags": 0, "muted": false, "mute_config": null},
            "thread_metadata": {"archived": false, "auto_archive_duration": 1440, "archive_timestamp": "2026-10-11T10:00:00.000Z", "locked": false, "invitable": true, "create_timestamp": "2026-10-11T10:00:00.000Z"}
        });
        round_trip::<Channel>(thread.clone());
        round_trip::<ThreadListResponse>(json!({"threads": [thread.clone()], "members": [], "has_more": false}));
        let message = json!({
            "id": "11", "channel_id": "200", "guild_id": "300", "author": user(), "content": "start", "timestamp": "2026-10-11T10:00:00.000Z",
            "edited_timestamp": null, "type": 0, "mentions": [], "mention_everyone": false, "attachments": [], "embeds": [], "reactions": [], "pinned": false, "tts": false,
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
        let member = ThreadMember {
            id: Snowflake(11),
            user_id: Snowflake(100),
            join_timestamp: "2026-10-11T10:00:00.000Z".to_owned(),
            flags: 0,
            muted: false,
            mute_config: None,
        };
        let deleted = GatewayEvent::ThreadDelete(ThreadDelete {
            id: Snowflake(11),
            guild_id: Snowflake(300),
            parent_id: Snowflake(200),
            kind: ChannelType::PublicThread,
        });
        assert_eq!((deleted.name(), deleted.data()), ("THREAD_DELETE", json!({"id": "11", "guild_id": "300", "parent_id": "200", "type": 11})));
        let update = GatewayEvent::ThreadMemberUpdate(ThreadMemberUpdate { member: member.clone(), guild_id: Snowflake(300) });
        assert_eq!(update.name(), "THREAD_MEMBER_UPDATE");
        assert_eq!(
            update.data(),
            json!({"id": "11", "user_id": "100", "join_timestamp": "2026-10-11T10:00:00.000Z", "flags": 0, "muted": false, "mute_config": null, "guild_id": "300"})
        );
        let muted: ThreadMember =
            serde_json::from_value(json!({"id": "11", "user_id": "100", "join_timestamp": "t", "flags": 3, "muted": true, "mute_config": {"end_time": null}}))
                .expect("muted");
        assert_eq!(muted.mute_config, Some(MuteConfig { end_time: None }));
        let patch: UpdateThreadMemberRequest = serde_json::from_value(json!({"muted": false, "mute_config": null})).expect("patch");
        assert_eq!((patch.flags, patch.muted, patch.mute_config), (None, Some(false), Some(None)));
        assert_eq!(serde_json::from_value::<UpdateThreadMemberRequest>(json!({})).expect("empty").mute_config, None);
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
    fn custom_emoji_shapes_match_types_ts() {
        let emoji = json!({
            "id": "700", "name": "blob_wave", "roles": ["301"], "require_colons": true, "managed": false, "animated": true, "available": true,
            "url": "http://x/api/v1/attachments/9/k/blob.gif"
        });
        round_trip::<GuildEmoji>(emoji.clone());
        let mut with_user = emoji.clone();
        with_user["user"] = user();
        round_trip::<GuildEmoji>(with_user);
        round_trip::<ReactionEmoji>(json!({"id": "700", "name": "blob_wave", "animated": true}));
        round_trip::<ReactionEmoji>(json!({"id": null, "name": "👍"}));
        let guild = json!({
            "id": "300", "name": "g", "icon": null, "owner_id": "100", "roles": [], "system_channel_id": null, "tag": null, "theme": null, "banner": null, "verification_level": 0, "explicit_content_filter": 0, "nsfw_level": 0, "rules_channel_id": null, "join_mode": 0, "default_message_notifications": 0,
            "channels": [], "members": [], "member_count": 0, "stickers": [], "emojis": [emoji.clone()], "voice_states": []
        });
        round_trip::<GuildWithState>(guild);
        let update = GatewayEvent::GuildEmojisUpdate(GuildEmojisUpdate {
            guild_id: Snowflake(300),
            emojis: vec![serde_json::from_value(emoji.clone()).expect("emoji")],
        });
        assert_eq!((update.name(), update.data()), ("GUILD_EMOJIS_UPDATE", json!({"guild_id": "300", "emojis": [emoji]})));
        let create: CreateGuildEmojiRequest = serde_json::from_value(json!({"name": "wave", "image_attachment_id": "9"})).expect("create");
        assert_eq!((create.name.as_str(), create.image_attachment_id, create.roles), ("wave", Snowflake(9), None));
        let edit: EditGuildEmojiRequest = serde_json::from_value(json!({"roles": null})).expect("edit");
        assert_eq!((edit.name, edit.roles), (None, Some(None)));
        assert!(serde_json::from_value::<EditGuildEmojiRequest>(json!({})).expect("empty").roles.is_none());
    }

    #[test]
    fn poll_shapes_match_types_ts() {
        let poll = json!({
            "question": {"text": "Lunch?"},
            "answers": [
                {"answer_id": 1, "poll_media": {"text": "Pizza", "emoji": {"id": null, "name": "🍕"}}},
                {"answer_id": 2, "poll_media": {"text": "Sushi"}}
            ],
            "expiry": "2026-10-12T10:00:00.000Z", "allow_multiselect": false, "layout_type": 1,
            "results": {"is_finalized": false, "answer_counts": [{"id": 1, "count": 2, "me_voted": true}, {"id": 2, "count": 0, "me_voted": false}]}
        });
        round_trip::<Poll>(poll.clone());
        let message = json!({
            "id": "11", "channel_id": "200", "guild_id": "300", "author": user(), "content": "", "timestamp": "2026-10-11T10:00:00.000Z",
            "edited_timestamp": null, "type": 0, "mentions": [], "mention_everyone": false, "attachments": [], "embeds": [], "reactions": [], "pinned": false, "tts": false,
            "message_reference": null, "referenced_message": null, "nonce": null, "poll": poll
        });
        round_trip::<Message>(message);
        let create: CreateMessageRequest = serde_json::from_value(json!({
            "poll": {"question": {"text": "Q"}, "answers": [{"poll_media": {"text": "A"}}], "duration": 4, "allow_multiselect": true}
        }))
        .expect("create");
        let poll = create.poll.expect("poll");
        assert_eq!((poll.question.text.as_deref(), poll.answers.len(), poll.duration, poll.allow_multiselect), (Some("Q"), 1, Some(4), Some(true)));
        let vote = GatewayEvent::MessagePollVoteAdd(PollVote {
            user_id: Snowflake(100),
            channel_id: Snowflake(200),
            message_id: Snowflake(11),
            guild_id: None,
            answer_id: 2,
        });
        assert_eq!(
            (vote.name(), vote.data()),
            ("MESSAGE_POLL_VOTE_ADD", json!({"user_id": "100", "channel_id": "200", "message_id": "11", "guild_id": null, "answer_id": 2}))
        );
        assert_eq!(MessageType::from_u8(46), Some(MessageType::PollResult));
        round_trip::<Embed>(
            json!({"type": "poll_result", "fields": [{"name": "poll_question_text", "value": "Lunch?"}, {"name": "total_votes", "value": "2"}]}),
        );
        round_trip::<PollAnswerVotersResponse>(json!({"users": [user()]}));
    }

    #[test]
    fn user_settings_shapes_and_allow_list() {
        round_trip::<UserSettings>(json!({"version": 3, "settings": {"theme": "light", "keybinds": [{"action": "mark-read", "keys": "Shift+Escape"}]}}));
        round_trip::<PatchUserSettingsRequest>(json!({"version": 3, "settings": {"theme": null, "time_format": "24"}}));
        round_trip::<UserSettingsConflict>(json!({"code": 40090, "message": "Settings version conflict", "version": 4, "settings": {}}));
        round_trip::<UserDataExport>(json!({
            "exported_at": "2026-10-12T10:00:00.000Z", "user": user(), "settings": {"version": 0, "settings": {}}, "relationships": [],
            "guilds": [{"id": "300", "name": "g", "nick": null, "joined_at": "2026-10-11T10:00:00.000Z"}],
            "channels": [{"id": "201", "type": 1, "guild_id": null, "name": null, "recipient_ids": ["101"]}],
            "messages": [{"id": "11", "channel_id": "201", "content": "hi", "timestamp": "2026-10-11T10:00:00.000Z", "edited_timestamp": null, "attachments": ["a.png"]}],
            "messages_truncated": false, "dm_restricted_guild_ids": ["300"]
        }));
        let event = GatewayEvent::UserSettingsUpdate(Box::new(UserSettings { version: 2, settings: serde_json::Map::new() }));
        assert_eq!((event.name(), event.data()), ("USER_SETTINGS_UPDATE", json!({"version": 2, "settings": {}})));
        use user_settings::validate;
        assert!(validate("theme", &json!("onyx")).is_ok());
        assert!(validate("theme", &json!("x".repeat(33))).is_err());
        assert!(validate("time_format", &json!("25")).is_err());
        assert!(validate("nope", &json!(true)).is_err());
        assert!(validate("font_size", &json!(30)).is_err());
        assert!(validate("disabled_sounds", &json!(["message", "message"])).is_err());
        assert!(validate("keybinds", &json!([{"action": "a", "keys": "Ctrl+K", "global": true}])).is_ok());
        assert!(validate("keybinds", &json!([{"action": "a", "keys": "Ctrl+K", "extra": 1}])).is_err());
    }

    #[test]
    fn invite_and_settings_shapes_match_types_ts() {
        let invite = json!({
            "code": "abc", "guild": {"id": "300", "name": "g", "icon": null, "member_count": 2, "presence_count": 1, "join_mode": 1}, "channel": {"id": "200", "name": "general"},
            "expires_at": "2026-10-12T10:00:00.000Z", "inviter": null
        });
        round_trip::<Invite>(invite.clone());
        let mut metadata = invite;
        metadata["inviter"] = user();
        metadata["uses"] = json!(1);
        metadata["max_uses"] = json!(5);
        metadata["max_age"] = json!(86400);
        metadata["temporary"] = json!(false);
        metadata["created_at"] = json!("2026-10-11T10:00:00.000Z");
        round_trip::<InviteMetadata>(metadata.clone());
        round_trip::<CreateInviteRequest>(json!({"max_age": 1800, "max_uses": 10, "temporary": true, "unique": true}));
        round_trip::<CreateInviteRequest>(json!({}));
        let created = GatewayEvent::InviteCreate(Box::new(serde_json::from_value(metadata).expect("metadata")));
        assert_eq!((created.name(), created.data()["inviter"]["id"].clone()), ("INVITE_CREATE", json!("100")));
        let deleted = GatewayEvent::InviteDelete(InviteDelete { code: "abc".to_owned(), guild_id: Snowflake(300), channel_id: Snowflake(200) });
        assert_eq!((deleted.name(), deleted.data()), ("INVITE_DELETE", json!({"code": "abc", "guild_id": "300", "channel_id": "200"})));
        round_trip::<GuildLayout>(
            json!({"guild_folders": [{"id": "9", "name": null, "color": null, "guild_ids": ["300", "301"]}], "guild_positions": ["301", "300"]}),
        );
        round_trip::<UpdateGuildLayoutRequest>(json!({"guild_positions": ["300"]}));
        let empty: GuildLayout = serde_json::from_value(json!({})).expect("defaults");
        assert!(empty.guild_folders.is_empty() && empty.guild_positions.is_empty());
        let update = GatewayEvent::GuildLayoutUpdate(empty);
        assert_eq!((update.name(), update.data()), ("GUILD_LAYOUT_UPDATE", json!({"guild_folders": [], "guild_positions": []})));
        let desktop = GatewayEvent::DesktopVersion(DesktopVersion { version: "0.1.9".to_owned() });
        assert_eq!((desktop.name(), desktop.data()), ("DESKTOP_VERSION", json!({"version": "0.1.9"})));
    }

    #[test]
    fn event_names_match_the_contract() {
        let event = GatewayEvent::MessageAck(MessageAck { channel_id: Snowflake(2), message_id: Snowflake(3) });
        assert_eq!(event.name(), "MESSAGE_ACK");
        assert_eq!(event.data(), json!({"channel_id": "2", "message_id": "3"}));
    }

    #[test]
    fn server_admin_shapes_match_types_ts() {
        let guild: UpdateGuildRequest = serde_json::from_value(json!({"verification_level": 2, "explicit_content_filter": 1})).expect("safety");
        assert_eq!(
            (guild.verification_level, guild.explicit_content_filter),
            (Some(VerificationLevel::Medium), Some(ExplicitContentFilter::MembersWithoutRoles))
        );
        assert!(serde_json::from_value::<UpdateGuildRequest>(json!({"verification_level": 5})).is_err());
        let access: UpdateGuildRequest = serde_json::from_value(json!({"nsfw_level": 3, "rules_channel_id": null, "join_mode": 0})).expect("access");
        assert_eq!((access.nsfw_level, access.rules_channel_id), (Some(NsfwLevel::AgeRestricted), Some(None)));
        assert_eq!(serde_json::from_value::<UpdateGuildRequest>(json!({})).expect("empty").rules_channel_id, None);
        let role: RoleRequest = serde_json::from_value(json!({"unicode_emoji": null})).expect("role icon");
        assert_eq!(role.unicode_emoji, Some(None));
        let prune: PruneRequest = serde_json::from_value(json!({"days": 7, "include_roles": ["301"], "compute_prune_count": false})).expect("prune");
        assert_eq!((prune.days, prune.include_roles, prune.compute_prune_count), (Some(7), Some(vec![Snowflake(301)]), Some(false)));
        round_trip::<PruneResponse>(json!({"pruned": 3}));
        round_trip::<PruneResponse>(json!({"pruned": null}));
        let entry = json!({
            "id": "900", "guild_id": "300", "user_id": "100", "target_id": "301", "action_type": 31,
            "changes": [{"key": "name", "old_value": "a", "new_value": "b"}, {"key": "$add", "new_value": [{"id": "301", "name": "mod"}]}],
            "reason": "tidy up"
        });
        round_trip::<AuditLogEntry>(entry.clone());
        round_trip::<AuditLogEntry>(json!({
            "id": "901", "guild_id": "300", "user_id": "100", "target_id": "200", "action_type": 14,
            "options": {"id": "301", "type": "0", "role_name": "mod"}, "reason": null
        }));
        round_trip::<AuditLog>(json!({"audit_log_entries": [entry.clone()], "users": [user()]}));
        let created = GatewayEvent::GuildAuditLogEntryCreate(serde_json::from_value(entry).expect("entry"));
        assert_eq!((created.name(), created.data()["action_type"].as_u64()), ("GUILD_AUDIT_LOG_ENTRY_CREATE", Some(31)));
        assert_eq!(AuditLogEvent::from_u8(143), Some(AuditLogEvent::AutoModerationBlockMessage));
        assert_eq!(AuditLogEvent::from_u8(250), Some(AuditLogEvent::ReportUpdate));
        let rule = json!({
            "id": "950", "guild_id": "300", "name": "No slurs", "creator_id": "100", "event_type": 1, "trigger_type": 1,
            "trigger_metadata": {"keyword_filter": ["bad*"], "allow_list": ["badge"]}, "actions": [{"type": 1, "metadata": {"custom_message": "Nope"}}],
            "enabled": true, "exempt_roles": ["301"], "exempt_channels": []
        });
        round_trip::<AutoModerationRule>(rule.clone());
        let parsed: AutoModerationRule = serde_json::from_value(rule).expect("rule");
        assert_eq!(GatewayEvent::AutoModerationRuleDelete(parsed).name(), "AUTO_MODERATION_RULE_DELETE");
        let patch: AutoModerationRuleRequest = serde_json::from_value(json!({"enabled": false})).expect("patch");
        assert!(patch.name.is_none() && patch.enabled == Some(false));
        let bulk = GatewayEvent::MessageDeleteBulk(MessageDeleteBulk {
            ids: vec![Snowflake(1), Snowflake(2)],
            channel_id: Snowflake(3),
            guild_id: Some(Snowflake(4)),
        });
        assert_eq!((bulk.name(), bulk.data()), ("MESSAGE_DELETE_BULK", json!({"ids": ["1", "2"], "channel_id": "3", "guild_id": "4"})));
    }

    #[test]
    fn join_request_shapes() {
        let field = json!({"field_type": "MULTIPLE_CHOICE", "label": "Pick", "required": true, "values": ["a", "b"], "description": null, "placeholder": null, "response": 1});
        let text =
            json!({"field_type": "TEXT_INPUT", "label": "Why", "required": false, "values": null, "description": "d", "placeholder": "p", "response": "hi"});
        let terms = json!({"field_type": "TERMS", "label": "Rules", "required": true, "values": ["be nice"], "description": null, "placeholder": null, "response": true});
        round_trip::<MemberVerificationForm>(json!({"description": null, "form_fields": [field.clone(), text.clone(), terms.clone()]}));
        let bare: MemberVerificationField = serde_json::from_value(json!({"field_type": "PARAGRAPH", "label": "x", "required": false})).expect("bare field");
        assert_eq!((bare.values, bare.response), (None, None));
        assert!(serde_json::from_value::<MemberVerificationField>(json!({"field_type": "NOPE", "label": "x", "required": false})).is_err());
        let request = json!({
            "id": "900", "guild_id": "300", "user_id": "100", "user": user(), "created_at": "2026-10-13T10:00:00.000Z", "application_status": "SUBMITTED",
            "form_responses": [field, text, terms], "rejection_reason": null, "actioned_at": null, "actioned_by_user": null
        });
        round_trip::<GuildJoinRequest>(request.clone());
        round_trip::<GuildJoinRequestList>(json!({"guild_join_requests": [request.clone()], "total": 1}));
        round_trip::<SubmitJoinRequest>(json!({"invite_code": "abc", "form_fields": []}));
        let action: ActionJoinRequest = serde_json::from_value(json!({"action": "REJECTED", "rejection_reason": "no"})).expect("action");
        assert_eq!((action.action, action.rejection_reason.as_deref()), (JoinRequestStatus::Rejected, Some("no")));
        let created = GatewayEvent::GuildJoinRequestCreate(Box::new(
            serde_json::from_value(json!({"guild_id": "300", "status": "SUBMITTED", "request": request})).expect("event"),
        ));
        assert_eq!((created.name(), created.data()["status"].clone()), ("GUILD_JOIN_REQUEST_CREATE", json!("SUBMITTED")));
        let deleted = GatewayEvent::GuildJoinRequestDelete(GuildJoinRequestDelete { guild_id: Snowflake(300), id: Snowflake(900), user_id: Snowflake(100) });
        assert_eq!((deleted.name(), deleted.data()), ("GUILD_JOIN_REQUEST_DELETE", json!({"guild_id": "300", "id": "900", "user_id": "100"})));
        let guild: UpdateGuildRequest = serde_json::from_value(json!({"join_mode": 1})).expect("join mode");
        assert_eq!(guild.join_mode, Some(JoinMode::Apply));
        assert!(serde_json::from_value::<UpdateGuildRequest>(json!({"join_mode": 2})).is_err());
        let guild: UpdateGuildRequest = serde_json::from_value(json!({"default_message_notifications": 1})).expect("notifications");
        assert_eq!(guild.default_message_notifications, Some(DefaultMessageNotifications::OnlyMentions));
        assert!(serde_json::from_value::<UpdateGuildRequest>(json!({"default_message_notifications": 2})).is_err());
        round_trip::<Guild>(json!({
            "id": "300", "name": "g", "icon": null, "banner": null, "owner_id": "100", "roles": [], "system_channel_id": null, "tag": null, "theme": null,
            "verification_level": 0, "explicit_content_filter": 0, "nsfw_level": 0, "rules_channel_id": null, "join_mode": 0, "default_message_notifications": 1
        }));
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
            "id": "201", "type": 2, "guild_id": "300", "name": "General", "topic": null, "position": 0, "parent_id": null, "nsfw": false, "last_message_id": null,
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
            bitrate: Some(96_000),
        });
        assert_eq!(
            (server.name(), server.data()),
            (
                "VOICE_SERVER_UPDATE",
                json!({"guild_id": "300", "channel_id": "201", "endpoint": "wss://lk.example.org", "token": "t", "session_id": "abc", "bitrate": 96000})
            )
        );
        let status = GatewayEvent::VoiceChannelStatusUpdate(VoiceChannelStatusUpdate { id: Snowflake(201), guild_id: Snowflake(300), status: None });
        assert_eq!((status.name(), status.data()), ("VOICE_CHANNEL_STATUS_UPDATE", json!({"id": "201", "guild_id": "300", "status": null})));
        let watch = json!({
            "video_id": "dQw4w9WgXcQ", "playing": true, "position_ms": 5, "updated_at_ms": 9, "started_by": "7", "queue": ["aaaaaaaaaaa"],
            "queue_added_by": ["8"], "host_id": "7", "added_by": "7", "skip_votes": ["8"], "skip_needed": 2, "item_seq": 3
        });
        round_trip::<WatchTogetherState>(watch.clone());
        let update = GatewayEvent::WatchTogetherUpdate(WatchTogetherUpdate { channel_id: Snowflake(201), state: None });
        assert_eq!((update.name(), update.data()), ("WATCH_TOGETHER_UPDATE", json!({"channel_id": "201", "state": null})));
        round_trip::<WatchTogetherUpdate>(json!({"channel_id": "201", "state": watch}));
        let stremio = json!({
            "item": {"title": "Heat", "label": "1080p"}, "status": "paused", "playing": false, "position_ms": 5, "updated_at_ms": 9,
            "started_by": "7", "bot_identity": "bot:stremio:201", "queue": [{"title": "Alien", "label": "720p", "added_by": "8"}],
            "host_id": "7", "added_by": "7", "skip_votes": [], "skip_needed": 1, "item_seq": 3
        });
        round_trip::<StremioState>(stremio.clone());
        let tracks = json!({
            "item": {"title": "Heat", "label": "1080p"}, "status": "playing", "playing": true, "position_ms": 5, "updated_at_ms": 9,
            "started_by": "7", "bot_identity": "bot:stremio:201", "queue": [], "host_id": "8", "added_by": "7", "skip_votes": ["9"], "skip_needed": 2, "item_seq": 3,
            "audio_tracks": [{"id": 1, "language": "eng", "codec": "eac3", "default": true}, {"id": 2, "language": "swe", "title": "Commentary", "codec": "aac", "default": false}],
            "audio": 1,
            "subtitle_tracks": [{"id": 3, "kind": "text", "language": "eng", "codec": "subrip", "forced": false, "default": false},
                {"id": 4, "kind": "bitmap", "codec": "hdmv_pgs_subtitle", "forced": true, "default": false}],
            "burned_subtitle": 4
        });
        round_trip::<StremioState>(tracks);
        round_trip::<StremioAddonSubtitles>(json!({"subtitles": [{"sid": "s", "addon": "OpenSubtitles", "label": "x"}], "addon_errors": []}));
        round_trip::<StremioCues>(json!({"cues": [{"start_ms": 1, "end_ms": 2, "text": "Hi"}]}));
        let patch = |value: Value| serde_json::from_value::<StremioPatchRequest>(value).expect("patch");
        assert_eq!(patch(json!({"audio": 2, "burned_subtitle": 4})).burned_subtitle, Some(Some(4)));
        assert_eq!(patch(json!({"burned_subtitle": null})).burned_subtitle, Some(None));
        assert_eq!(patch(json!({})).burned_subtitle, None);
        let update = GatewayEvent::StremioUpdate(StremioUpdate { channel_id: Snowflake(201), state: None });
        assert_eq!((update.name(), update.data()), ("STREMIO_UPDATE", json!({"channel_id": "201", "state": null})));
        round_trip::<StremioUpdate>(json!({"channel_id": "201", "state": stremio}));
        let track = json!({"uri": "spotify:track:4uLU6hMCjMI75M1A2tKUQC", "title": "Song", "artists": ["A"], "duration_ms": 1000, "explicit": false});
        let spotify = json!({
            "status": "playing", "track": track, "playing": true, "position_ms": 5, "updated_at_ms": 9, "loop": "queue", "queue_len": 1,
            "can_previous": false, "started_by": "7", "bot_identity": "bot:spotify:201", "host_id": "7", "added_by": "8", "skip_votes": [], "skip_needed": 1, "item_seq": 3,
            "queue": [{"qid": "q1", "uri": "spotify:track:4uLU6hMCjMI75M1A2tKUQC", "title": "Song", "artists": ["A"], "duration_ms": 1000, "explicit": true, "added_by": "8"}]
        });
        round_trip::<SpotifyState>(spotify.clone());
        let mut with_left_out = spotify.clone();
        with_left_out["left_out"] = json!(3);
        let reply: SpotifyReply = serde_json::from_value(with_left_out).expect("reply");
        assert_eq!((reply.left_out, reply.state.queue.len()), (3, 1));
        assert!(serde_json::to_value(SpotifyReply { left_out: 0, ..reply }).expect("reply").get("left_out").is_none());
        let update = GatewayEvent::SpotifyUpdate(SpotifyUpdate { channel_id: Snowflake(201), state: None });
        assert_eq!((update.name(), update.data()), ("SPOTIFY_UPDATE", json!({"channel_id": "201", "state": null})));
        round_trip::<SpotifyUpdate>(json!({"channel_id": "201", "state": spotify}));
        let game = json!({
            "session_id": "0123456789abcdef", "started_by": "7", "started_at_ms": 9, "room_url": null,
            "game": {"id": "builtin:sketch", "name": "Sketch", "kind": "sdk", "url": "https://x.test/", "icon": "🎨", "min_players": 2, "max_players": 16, "aspect": "4:3"}
        });
        round_trip::<GameSession>(game.clone());
        round_trip::<GameUpdate>(json!({"channel_id": "201", "state": game}));
        let ended = GatewayEvent::GameUpdate(GameUpdate { channel_id: Snowflake(201), state: None });
        assert_eq!((ended.name(), ended.data()), ("GAME_UPDATE", json!({"channel_id": "201", "state": null})));
        let relayed = GatewayEvent::GameMessage(GameMessage { channel_id: Snowflake(201), session_id: "s".into(), from: "a".into(), data: json!({"x": 1}) });
        assert_eq!((relayed.name(), relayed.data()), ("GAME_MESSAGE", json!({"channel_id": "201", "session_id": "s", "from": "a", "data": {"x": 1}})));
        let failed =
            GatewayEvent::VoiceConnectFailed(VoiceConnectFailed { guild_id: None, channel_id: Snowflake(5), reason: VoiceConnectFailure::ChannelFull });
        assert_eq!((failed.name(), failed.data()), ("VOICE_CONNECT_FAILED", json!({"guild_id": null, "channel_id": "5", "reason": "channel_full"})));
        let parsed: VoiceState = serde_json::from_value(state).expect("state");
        assert_eq!(GatewayEvent::VoiceStateUpdate(Box::new(parsed)).name(), "VOICE_STATE_UPDATE");
        assert_eq!(serde_json::to_value(GatewayOp::VoiceStateUpdate).expect("op"), json!(4));
    }

    #[test]
    fn call_shapes_match_types_ts() {
        let state = json!({
            "guild_id": null, "channel_id": "202", "user_id": "100", "session_id": "abc", "deaf": false, "mute": false, "self_deaf": false,
            "self_mute": false, "self_video": false, "self_stream": false, "suppress": false, "request_to_speak_timestamp": null,
            "connected_at": "2026-10-12T18:00:00.000Z"
        });
        round_trip::<Call>(json!({"channel_id": "202", "message_id": "9", "region": null, "ringing": ["101"], "voice_states": [state]}));
        let update =
            GatewayEvent::CallUpdate(CallUpdate { channel_id: Snowflake(202), message_id: Snowflake(9), region: Some("eu".to_owned()), ringing: vec![] });
        assert_eq!((update.name(), update.data()), ("CALL_UPDATE", json!({"channel_id": "202", "message_id": "9", "region": "eu", "ringing": []})));
        let delete = GatewayEvent::CallDelete(CallDelete { channel_id: Snowflake(202) });
        assert_eq!((delete.name(), delete.data()), ("CALL_DELETE", json!({"channel_id": "202"})));
        let ring: CallRingRequest = serde_json::from_value(json!({})).expect("ring");
        assert_eq!(ring.recipients, None);
        round_trip::<CallRingRequest>(json!({"recipients": ["101", "102"]}));
        round_trip::<EditCallRequest>(json!({"region": null}));
        round_trip::<MessageCall>(json!({"participants": ["100", "101"], "ended_timestamp": "2026-10-12T18:05:00.000Z"}));
        assert_eq!(serde_json::to_value(MessageType::Call).expect("type"), json!(3));
        round_trip::<Message>(json!({
            "id": "9", "channel_id": "202", "guild_id": null, "author": user(), "content": "", "timestamp": "2026-10-12T18:00:00.000Z",
            "edited_timestamp": null, "type": 3, "mentions": [], "mention_everyone": false, "attachments": [], "embeds": [], "reactions": [], "pinned": false, "tts": false,
            "message_reference": null, "referenced_message": null, "nonce": null, "call": {"participants": ["100"], "ended_timestamp": null}
        }));
    }

    #[test]
    fn soundboard_and_entrance_sounds() {
        let sound = json!({
            "sound_id": "80", "name": "airhorn", "volume": 0.5, "emoji_id": null, "emoji_name": "📯", "guild_id": "300",
            "available": true, "user": user(), "url": "http://x/a.ogg"
        });
        round_trip::<SoundboardSound>(sound.clone());
        let default =
            json!({"sound_id": "1", "name": "chime", "volume": 1.0, "emoji_id": null, "emoji_name": null, "available": true, "url": "http://x/1.wav"});
        round_trip::<SoundboardSound>(default.clone());
        round_trip::<SoundboardSoundList>(json!({"items": [sound.clone()]}));
        round_trip::<CreateSoundboardSoundRequest>(json!({"name": "airhorn", "attachment_id": "9", "volume": 0.5, "emoji_name": "📯"}));
        let edit: EditSoundboardSoundRequest = serde_json::from_value(json!({"emoji_name": null, "volume": 0.2})).expect("edit");
        assert_eq!((edit.name, edit.volume, edit.emoji_id, edit.emoji_name), (None, Some(0.2), None, Some(None)));
        round_trip::<SendSoundboardSoundRequest>(json!({"sound_id": "80", "source_guild_id": "300"}));
        round_trip::<SendSoundboardSoundRequest>(json!({"sound_id": "1"}));
        round_trip::<EntranceSounds>(json!({"entrance_sounds": [
            {"guild_id": null, "sound_id": "1", "source_guild_id": null},
            {"guild_id": "300", "sound_id": "80", "source_guild_id": "300"}
        ]}));
        let set: SetEntranceSoundRequest = serde_json::from_value(json!({"sound_id": null})).expect("clear");
        assert_eq!((set.guild_id, set.sound_id, set.source_guild_id), (None, None, None));
        let effect = VoiceChannelEffectSend {
            channel_id: Snowflake(201),
            guild_id: Snowflake(300),
            user_id: Snowflake(100),
            sound_id: Snowflake(80),
            sound_volume: 0.5,
            emoji: Some(EffectEmoji { id: None, name: Some("📯".to_owned()) }),
            source_guild_id: Some(Snowflake(300)),
            sound_url: "http://x/a.ogg".to_owned(),
            entrance: false,
        };
        let event = GatewayEvent::VoiceChannelEffectSend(effect);
        assert_eq!(
            (event.name(), event.data()),
            (
                "VOICE_CHANNEL_EFFECT_SEND",
                json!({"channel_id": "201", "guild_id": "300", "user_id": "100", "sound_id": "80", "sound_volume": 0.5,
                       "emoji": {"id": null, "name": "📯"}, "source_guild_id": "300", "sound_url": "http://x/a.ogg"})
            )
        );
        let delete = GatewayEvent::GuildSoundboardSoundDelete(SoundboardSoundDelete { sound_id: Snowflake(80), guild_id: Snowflake(300) });
        assert_eq!((delete.name(), delete.data()), ("GUILD_SOUNDBOARD_SOUND_DELETE", json!({"sound_id": "80", "guild_id": "300"})));
        assert_ne!(permissions::DEFAULT_EVERYONE & permissions::USE_EXTERNAL_SOUNDS, 0, "the Nitro gate is free");
    }

    #[test]
    fn activity_names_must_show_something_and_hold_no_invisible_characters() {
        let playing = |name: &str| Activity {
            name: name.to_owned(),
            kind: Activity::PLAYING,
            timestamps: None,
            details: None,
            state: None,
            assets: None,
            sync_id: None,
            app: false,
        };
        assert!(Activity::list_is_valid(&[playing("Elden Ring")]));
        assert!(Activity::list_is_valid(&[playing("Pokémon 🎮")]));
        assert!(Activity::list_is_valid(&[playing(&"é".repeat(128))]));
        assert!(!Activity::list_is_valid(&[playing(&"é".repeat(129))]));
        for bad in ["", "   ", "\n", "A\nB", "\u{200B}", "A\u{200B}B", "A\u{202E}B", "\u{2066}x", "\u{FEFF}", "\u{3164}", "tab\there"] {
            assert!(!Activity::list_is_valid(&[playing(bad)]), "{bad:?} must be rejected");
        }
    }

    #[test]
    fn spotify_activities_follow_the_listening_rules() {
        let spotify = || Activity {
            name: "Spotify".into(),
            kind: Activity::LISTENING,
            timestamps: Some(ActivityTimestamps { start: Some(1_000), end: Some(2_000) }),
            details: Some("Song".into()),
            state: Some("A; B".into()),
            assets: Some(ActivityAssets { large_image: Some(format!("spotify:{}", "ab01".repeat(10))) }),
            sync_id: Some("4uLU6hMCjMI75M1A2tKUQC".into()),
            app: false,
        };
        let game = Activity {
            name: "Factorio".into(),
            kind: Activity::PLAYING,
            timestamps: None,
            details: None,
            state: None,
            assets: None,
            sync_id: None,
            app: false,
        };
        assert!(Activity::list_is_valid(&[spotify()]));
        assert!(Activity::list_is_valid(&[game.clone(), spotify()]), "a game and Spotify together");
        assert!(!Activity::list_is_valid(&[spotify(), spotify()]), "one of each kind");
        assert!(!Activity::list_is_valid(&[game.clone(), game.clone()]));
        type Change = fn(&mut Activity);
        let broken: [(&str, Change); 13] = [
            ("name", |a| a.name = "Apple Music".into()),
            ("type", |a| a.kind = 1),
            ("blank details", |a| a.details = Some("  ".into())),
            ("long state", |a| a.state = Some("x".repeat(129))),
            ("invisible details", |a| a.details = Some("a\u{200B}b".into())),
            ("image host", |a| a.assets = Some(ActivityAssets { large_image: Some("https://i.scdn.co/x".into()) })),
            ("image case", |a| a.assets = Some(ActivityAssets { large_image: Some(format!("spotify:{}", "AB01".repeat(10))) })),
            ("image length", |a| a.assets = Some(ActivityAssets { large_image: Some("spotify:ab01".into()) })),
            ("app image on Spotify", |a| a.assets = Some(ActivityAssets { large_image: Some(format!("app:{}", "ab01".repeat(16))) })),
            ("sync_id length", |a| a.sync_id = Some("4uLU6hMCjMI75M1A2tKUQ".into())),
            ("sync_id chars", |a| a.sync_id = Some("4uLU6hMCjMI75M1A2tKU/C".into())),
            ("end before start", |a| a.timestamps = Some(ActivityTimestamps { start: Some(5), end: Some(4) })),
            ("negative end", |a| a.timestamps = Some(ActivityTimestamps { start: None, end: Some(-1) })),
        ];
        for (what, change) in broken {
            let mut activity = spotify();
            change(&mut activity);
            assert!(!Activity::list_is_valid(&[activity]), "{what} must be rejected");
        }
        let spotify_only: [(&str, Change); 4] = [
            ("details", |a| a.details = Some("x".into())),
            ("state", |a| a.state = Some("x".into())),
            ("sync_id", |a| a.sync_id = Some("4uLU6hMCjMI75M1A2tKUQC".into())),
            ("end", |a| a.timestamps = Some(ActivityTimestamps { start: Some(1), end: Some(2) })),
        ];
        for (what, change) in spotify_only {
            let mut activity = game.clone();
            change(&mut activity);
            assert!(!Activity::list_is_valid(&[activity]), "a game must not carry {what}");
        }
        assert!(Activity::list_is_valid(&[Activity { app: true, ..game.clone() }]), "a program the user added is marked app");
        let json = serde_json::to_value(Activity { app: true, ..game.clone() }).unwrap();
        assert_eq!(json["app"], true);
        assert!(serde_json::to_value(&game).unwrap().get("app").is_none(), "a game omits the flag");
        assert!(!serde_json::from_str::<Activity>(r#"{"name":"Factorio","type":0}"#).unwrap().app, "a missing flag is a game");
        assert!(!Activity::list_is_valid(&[Activity { app: true, ..spotify() }]), "Spotify is never an app");
        let with_image = |image: &str| Activity { assets: Some(ActivityAssets { large_image: Some(image.into()) }), ..game.clone() };
        let hash = "ab01".repeat(16);
        assert!(Activity::list_is_valid(&[with_image(&format!("app:{hash}"))]), "a game may carry an app icon");
        assert_eq!(with_image(&format!("app:{hash}")).app_hash(), Some(hash.as_str()));
        assert!(Activity::list_is_valid(&[Activity { assets: Some(ActivityAssets { large_image: None }), ..game.clone() }]));
        for image in [
            format!("spotify:{}", "ab01".repeat(10)),
            format!("app:{}", "AB01".repeat(16)),
            format!("app:{}", "ab01".repeat(10)),
            format!("app:{hash}0"),
            hash.clone(),
            "https://x/y.png".into(),
        ] {
            assert!(!Activity::list_is_valid(&[with_image(&image)]), "{image} must be rejected on a game");
        }
    }

    #[test]
    fn permission_bits_match_discord() {
        assert_eq!(permissions::VIEW_CHANNEL, 1024);
        assert_eq!(permissions::SEND_MESSAGES, 2048);
        assert_eq!(permissions::MANAGE_MESSAGES, 8192);
        assert_eq!(permissions::ADMINISTRATOR, 8);
        assert_eq!(permissions::DEFAULT_EVERYONE & (1 | 64 | 1024 | 2048 | 32768 | 65536 | 131072), 1 | 64 | 1024 | 2048 | 32768 | 65536 | 131072);
    }

    #[test]
    fn app_and_command_shapes_match_types_ts() {
        let application = json!({
            "id": "700", "name": "Echo", "description": "", "icon": null, "owner_id": "100", "bot": user(), "bot_public": true,
            "install_params": {"permissions": "2048"}
        });
        round_trip::<Application>(application.clone());
        let mut with_token = application.clone();
        with_token["token"] = json!("abc");
        round_trip::<ApplicationWithToken>(with_token);
        let command = json!({
            "id": "701", "type": 1, "application_id": "700", "guild_id": null, "name": "roll", "description": "Roll a die",
            "options": [
                {"type": 4, "name": "sides", "description": "Sides", "required": true, "min_value": 2.0, "max_value": 100.0},
                {"type": 3, "name": "mode", "description": "Mode", "choices": [{"name": "Fast", "value": "fast"}, {"name": "Six", "value": 6}]}
            ],
            "default_member_permissions": null, "dm_permission": true, "version": "702"
        });
        round_trip::<ApplicationCommand>(command.clone());
        round_trip::<ApplicationCommandIndex>(
            json!({"applications": [{"id": "700", "name": "Echo", "icon": null, "bot_id": "700"}], "application_commands": [command]}),
        );
        let patch: ApplicationCommandRequest = serde_json::from_value(json!({"default_member_permissions": null})).expect("patch");
        assert_eq!(patch.default_member_permissions, Some(None));
        assert!(patch.name.is_none() && patch.kind.is_none());
        let edit: EditApplicationRequest = serde_json::from_value(json!({"icon_attachment_id": null, "bot_public": false})).expect("edit");
        assert_eq!((edit.icon_attachment_id, edit.bot_public), (Some(None), Some(false)));
        assert!(serde_json::from_value::<ApplicationCommandOption>(json!({"type": 1, "name": "sub", "description": "x"})).is_err());
    }

    #[test]
    fn interaction_shapes_match_types_ts() {
        let interaction = json!({
            "id": "800", "application_id": "700", "type": 2, "guild_id": "300", "channel_id": "200", "user": user(), "token": "tok",
            "app_permissions": "2048", "version": 1,
            "data": {"id": "701", "name": "echo", "type": 1, "options": [{"name": "text", "type": 3, "value": "hi"}],
                     "resolved": {"users": {"100": user()}}}
        });
        round_trip::<Interaction>(interaction.clone());
        let event = GatewayEvent::InteractionCreate(Box::new(serde_json::from_value(interaction).expect("interaction")));
        assert_eq!((event.name(), event.data()["data"]["options"][0]["value"].clone()), ("INTERACTION_CREATE", json!("hi")));
        let invoke: InvokeInteractionRequest = serde_json::from_value(json!({
            "type": 2, "application_id": "700", "channel_id": "200", "nonce": "n", "data": {"id": "701", "name": "roll", "type": 1, "options": [{"name": "sides", "type": 4, "value": 6}]}
        }))
        .expect("invoke");
        assert_eq!((invoke.kind, invoke.data.options.map(|options| options[0].value.clone())), (InteractionType::ApplicationCommand, Some(json!(6))));
        round_trip::<InteractionCreated>(json!({"id": "800", "nonce": null}));
        let response: InteractionResponse = serde_json::from_value(json!({"type": 4, "data": {"content": "hi", "flags": 64}})).expect("response");
        assert_eq!(
            (response.kind, response.data.and_then(|data| data.flags)),
            (InteractionCallbackType::ChannelMessageWithSource, Some(message_flags::EPHEMERAL))
        );
        let message = json!({
            "id": "801", "channel_id": "200", "guild_id": "300", "author": user(), "content": "hi", "timestamp": "2026-10-11T10:00:00.000Z",
            "edited_timestamp": null, "type": 20, "mentions": [], "mention_everyone": false, "attachments": [], "embeds": [], "reactions": [], "pinned": false, "tts": false,
            "message_reference": null, "referenced_message": null, "nonce": null, "flags": 64, "webhook_id": "700", "application_id": "700",
            "interaction_metadata": {"id": "800", "type": 2, "user": user(), "name": "echo", "command_type": 1}
        });
        round_trip::<Message>(message);
        let failure = GatewayEvent::InteractionFailure(InteractionFailure {
            id: Snowflake(800),
            nonce: None,
            channel_id: Snowflake(200),
            application_id: Snowflake(700),
        });
        assert_eq!(
            (failure.name(), failure.data()),
            ("INTERACTION_FAILURE", json!({"id": "800", "nonce": null, "channel_id": "200", "application_id": "700"}))
        );
        let choices = GatewayEvent::AutocompleteResponse(AutocompleteResponse {
            id: Snowflake(800),
            nonce: Some("n".to_owned()),
            choices: vec![ApplicationCommandOptionChoice { name: "a".to_owned(), value: json!("a") }],
        });
        assert_eq!(choices.name(), "APPLICATION_COMMAND_AUTOCOMPLETE_RESPONSE");
        assert_eq!(MessageType::from_u8(20), Some(MessageType::ChatInputCommand));
        assert_eq!(MessageType::from_u8(23), Some(MessageType::ContextMenuCommand));
    }

    #[test]
    fn webhook_shapes_match_types_ts() {
        round_trip::<Webhook>(json!({
            "id": "900", "type": 1, "guild_id": "300", "channel_id": "200", "name": "Hook", "avatar": null, "application_id": null,
            "user": user(), "token": "t", "url": "http://x/api/v1/webhooks/900/t"
        }));
        round_trip::<Webhook>(json!({"id": "900", "type": 1, "guild_id": "300", "channel_id": "200", "name": "Hook", "avatar": null, "application_id": null}));
        let edit: EditWebhookRequest = serde_json::from_value(json!({"avatar_attachment_id": null})).expect("edit");
        assert_eq!(edit.avatar_attachment_id, Some(None));
        round_trip::<WebhookMessageRequest>(json!({"content": "hi", "username": "Alerts", "avatar_url": "https://x.io/a.png"}));
        let update = GatewayEvent::WebhooksUpdate(WebhooksUpdate { guild_id: Snowflake(300), channel_id: Snowflake(200) });
        assert_eq!((update.name(), update.data()), ("WEBHOOKS_UPDATE", json!({"guild_id": "300", "channel_id": "200"})));
        round_trip::<GuildIntegration>(json!({
            "id": "700", "type": "bot", "name": "Echo", "enabled": true, "user": null, "role_id": "301",
            "application": {"id": "700", "name": "Echo", "description": "", "icon": null, "bot": user()}
        }));
    }

    #[test]
    fn stage_and_voice_moderation_shapes_match_types_ts() {
        let instance = json!({"id": "9", "guild_id": "300", "channel_id": "201", "topic": "Town hall", "privacy_level": 2});
        round_trip::<StageInstance>(instance.clone());
        let parsed: StageInstance = serde_json::from_value(instance.clone()).expect("instance");
        for (event, name) in [
            (GatewayEvent::StageInstanceCreate(parsed.clone()), "STAGE_INSTANCE_CREATE"),
            (GatewayEvent::StageInstanceUpdate(parsed.clone()), "STAGE_INSTANCE_UPDATE"),
            (GatewayEvent::StageInstanceDelete(parsed.clone()), "STAGE_INSTANCE_DELETE"),
        ] {
            assert_eq!((event.name(), event.data()), (name, instance.clone()));
        }
        assert!(serde_json::from_value::<StageInstance>(json!({"id": "9", "guild_id": "1", "channel_id": "2", "topic": "x", "privacy_level": 1})).is_err());
        let create: CreateStageInstanceRequest = serde_json::from_value(json!({"channel_id": "201", "topic": "hi"})).expect("create");
        assert_eq!((create.channel_id, create.privacy_level), (Snowflake(201), None));
        let hand: EditVoiceStateRequest = serde_json::from_value(json!({"channel_id": "201", "request_to_speak_timestamp": null})).expect("lower hand");
        assert_eq!((hand.suppress, hand.request_to_speak_timestamp), (None, Some(None)));
        let invite: EditVoiceStateRequest = serde_json::from_value(json!({"channel_id": "201", "suppress": false})).expect("invite");
        assert_eq!((invite.suppress, invite.request_to_speak_timestamp), (Some(false), None));
        let edit: EditMemberRequest = serde_json::from_value(json!({"mute": true, "deaf": false, "channel_id": null})).expect("voice edit");
        assert_eq!((edit.mute, edit.deaf, edit.channel_id), (Some(true), Some(false), Some(None)));
        let untouched: EditMemberRequest = serde_json::from_value(json!({"nick": "x"})).expect("nick only");
        assert_eq!((untouched.mute, untouched.deaf, untouched.channel_id), (None, None, None));
        let mut member = json!({
            "user": user(), "nick": null, "roles": [], "joined_at": "2026-10-11T10:00:00.000Z", "communication_disabled_until": null,
            "avatar": null, "banner": null, "bio": null, "pronouns": null, "theme_colors": null
        });
        round_trip::<GuildMember>(member.clone());
        member["mute"] = json!(true);
        member["deaf"] = json!(true);
        round_trip::<GuildMember>(member);
    }

    #[test]
    fn message_tts_is_always_serialized_and_optional_on_create() {
        let request: CreateMessageRequest = serde_json::from_str(r#"{"content":"hi"}"#).expect("request");
        assert_eq!(request.tts, None);
        assert!(!serde_json::to_string(&request).expect("json").contains("tts"));
        let request: CreateMessageRequest = serde_json::from_str(r#"{"content":"hi","tts":true}"#).expect("request");
        assert_eq!(request.tts, Some(true));
        let mut message = json!({
            "id": "1", "channel_id": "2", "guild_id": null,
            "author": {"id": "3", "username": "a", "discriminator": "0", "avatar": null, "bot": false},
            "content": "x", "timestamp": "2026-01-01T00:00:00.000Z", "edited_timestamp": null, "type": 0,
            "mentions": [], "mention_everyone": false, "attachments": [], "embeds": [], "reactions": [],
            "pinned": false, "tts": true, "message_reference": null, "referenced_message": null, "nonce": null
        });
        let parsed: Message = serde_json::from_value(message.clone()).unwrap_or_else(|error| panic!("{error}"));
        assert!(parsed.tts);
        assert_eq!(serde_json::to_value(&parsed).expect("json")["tts"], true);
        message.as_object_mut().expect("object").remove("tts");
        let parsed: Message = serde_json::from_value(message).expect("message without tts");
        assert_eq!(serde_json::to_value(&parsed).expect("json")["tts"], false, "always serialized");
    }
}
