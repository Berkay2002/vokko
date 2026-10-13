// Wire contract for the Vokko server (REST /api/v1 + gateway). Mirrors docs/api.md.
// Shapes follow Discord's public API where it fits; IDs are snowflakes serialized as strings.

export type Snowflake = string;
export type ISO8601 = string;

export type PresenceStatus = "online" | "idle" | "dnd" | "invisible" | "offline"; // invisible only in op 3 and your own presence

export interface User {
  id: Snowflake;
  username: string; // unique, lowercase, 2-32 chars [a-z0-9_.]
  global_name: string | null; // display name
  avatar: string | null; // attachment URL or null → default avatar (client derives colour from id)
  banner_color: string | null; // "#rrggbb"
  bio: string | null;
  bot: boolean;
  // Profile perks (free for everyone in Vokko; Discord gates them behind Nitro). Absent = not set.
  banner?: string | null; // banner image URL (static or animated)
  pronouns?: string | null; // max 40 chars
  theme_colors?: [number, number] | null; // profile theme primary/accent (RGB ints)
  avatar_decoration?: string | null; // id of a Vokko-owned decoration asset
  profile_effect?: string | null; // id of a Vokko-owned profile effect
  primary_guild?: UserPrimaryGuild | null; // server tag shown next to the name
  nameplate?: string | null; // id of a Vokko-owned nameplate (background of the user's member/DM list row)
  display_name_styles?: DisplayNameStyles | null;
  widgets?: ProfileWidgets | null; // profile editor board widgets; absent/null = none
}
/** Display name style: font and effect ids from Vokko's own set, one or two RGB colours. */
export interface DisplayNameStyles {
  font_id: string;
  effect_id: string;
  colors: number[]; // 1-2 RGB ints
}
/** Profile board widgets (max two kinds). Images are the owner's uploads. */
export interface ProfileWidgets {
  favorite_game?: FavoriteGameWidget | null;
  games_i_like?: GameEntry[] | null; // up to 20
}
export interface GameEntry {
  name: string; // 1-64 chars
  image: string | null; // attachment URL
  image_attachment_id: Snowflake | null;
}
export interface FavoriteGameWidget extends GameEntry {
  reason: string | null; // up to 190 chars
  tags: string[]; // up to 5, each 1-20 chars
}
/** What a client sends: images by attachment id (an unchanged image is echoed back by its `image_attachment_id`). */
export interface GameEntryInput {
  name: string;
  image_attachment_id?: Snowflake | null;
}
export interface FavoriteGameInput extends GameEntryInput {
  reason?: string | null;
  tags?: string[];
}
export interface ProfileWidgetsInput {
  favorite_game?: FavoriteGameInput | null;
  games_i_like?: GameEntryInput[] | null;
}
export interface UserPrimaryGuild {
  guild_id: Snowflake;
  tag: string; // 1-4 chars
  badge: string; // badge id (Vokko asset set)
  color_primary: number;
  color_secondary: number;
}

/** What a user is doing. Only type 0 ("Playing") exists; `timestamps.start` is unix ms. At most one per presence. */
export interface Activity {
  name: string; // 1-128 chars
  type: 0;
  timestamps?: { start?: number };
}

export interface Presence {
  user_id: Snowflake;
  status: PresenceStatus;
  custom_status: string | null;
  activities?: Activity[]; // absent = none; hidden from others while offline/invisible
}

export enum ChannelType {
  GuildText = 0,
  DM = 1,
  GuildVoice = 2,
  GroupDM = 3,
  GuildCategory = 4,
  GuildAnnouncement = 5, // behaves like text; messages can be published (crossposted) to followers
  AnnouncementThread = 10, // thread in an announcement channel
  PublicThread = 11,
  PrivateThread = 12,
  GuildStage = 13, // stage channel: voice room with speakers and an audience, live while it has a StageInstance
  GuildForum = 15, // channel whose messages are posts (public threads)
}
export const isThreadType = (type: ChannelType): boolean => type === ChannelType.AnnouncementThread || type === ChannelType.PublicThread || type === ChannelType.PrivateThread;

export const THREAD_AUTO_ARCHIVE_DURATIONS = [60, 1440, 4320, 10080] as const; // minutes of inactivity; default 1440
export type ThreadAutoArchiveDuration = (typeof THREAD_AUTO_ARCHIVE_DURATIONS)[number];
export enum ChannelFlags {
  Pinned = 1 << 1, // forum post pinned to the top (MANAGE_THREADS)
  RequireTag = 1 << 4, // forum: a post needs at least one tag
}
export enum ForumSortOrder {
  LatestActivity = 0,
  CreationDate = 1,
}
export enum ForumLayout {
  NotSet = 0, // list
  List = 1,
  Gallery = 2,
}
export interface ThreadMetadata {
  archived: boolean;
  auto_archive_duration: ThreadAutoArchiveDuration;
  archive_timestamp: ISO8601; // when archived last changed
  locked: boolean; // only MANAGE_THREADS can send, unarchive or edit
  invitable?: boolean; // private threads: members without MANAGE_THREADS may add others (default true)
  create_timestamp?: ISO8601;
}
export interface ThreadMember {
  id: Snowflake; // thread id
  user_id: Snowflake;
  join_timestamp: ISO8601;
  flags: number; // ThreadMemberFlags bits; no notify bit = use the parent channel's setting
  muted: boolean; // false once a timed mute has ended
  mute_config: MuteConfig | null; // muted forever = {end_time: null}; null when not muted
}
export const ThreadMemberFlags = {
  HasInteracted: 1 << 0,
  AllMessages: 1 << 1,
  OnlyMentions: 1 << 2,
  NoMessages: 1 << 3,
} as const;
export interface MuteConfig {
  end_time: ISO8601 | null; // null = until turned back on; a timed mute ends (muted false, mute_config null) once end_time passes
}
// PATCH /channels/{id}/thread-members/@me: only sent keys change; only the notify bits of flags can change (at most one, else 400 50035)
export interface UpdateThreadMemberRequest {
  flags?: number;
  muted?: boolean;
  mute_config?: MuteConfig | null; // null while muting = forever
}
export interface ForumTag {
  id: Snowflake;
  name: string; // 1-20 chars
  moderated: boolean; // only MANAGE_THREADS may apply it
  emoji_id: Snowflake | null;
  emoji_name: string | null; // unicode emoji
}
export interface DefaultReaction {
  emoji_id: Snowflake | null;
  emoji_name: string | null;
}

export interface Channel {
  id: Snowflake;
  type: ChannelType;
  guild_id: Snowflake | null;
  name: string | null; // null for DMs
  topic: string | null;
  position: number;
  parent_id: Snowflake | null; // category
  recipients?: User[]; // DM / group DM only (excludes the current user)
  last_message_id: Snowflake | null;
  owner_id?: Snowflake | null; // group DM
  icon?: string | null; // group DM
  permission_overwrites?: PermissionOverwrite[]; // guild channels only
  bitrate?: number; // guild voice only: bps, 8000..guild max (default 64000)
  user_limit?: number; // guild voice only: 0 = unlimited, max 99
  status?: string | null; // guild voice only: shared channel status (max 500 chars), null when none
  // Threads (types 10-12; parent_id = the text/announcement/forum channel; owner_id = creator; id == starter message id when started from a message or forum post)
  thread_metadata?: ThreadMetadata;
  member_count?: number; // threads: members joined (max shown 50 in Discord, exact here)
  message_count?: number; // threads: messages sent, excluding the starter
  member?: ThreadMember; // threads: the current user's membership, when joined
  applied_tags?: Snowflake[]; // forum posts: ids from the forum's available_tags (max 5)
  newly_created?: boolean; // THREAD_CREATE and start-thread responses only
  flags?: number; // ChannelFlags
  nsfw?: boolean; // age-restricted guild channel (text, announcement, forum, voice); absent = false
  // Forum channels (type 15), always present there
  available_tags?: ForumTag[]; // max 20
  default_reaction_emoji?: DefaultReaction; // absent = none
  default_sort_order?: ForumSortOrder; // absent = LatestActivity
  default_forum_layout?: ForumLayout; // absent = NotSet
  default_auto_archive_duration?: ThreadAutoArchiveDuration; // text, announcement and forum channels; absent = 1440
}

export enum OverwriteType {
  Role = 0,
  Member = 1,
}
export interface PermissionOverwrite {
  id: Snowflake; // role id or user id
  type: OverwriteType;
  allow: string; // bitfield as decimal string
  deny: string;
}

export interface Role {
  id: Snowflake; // @everyone role id == guild id
  name: string;
  color: number; // 0 = no colour
  hoist: boolean; // shown separately in member list
  position: number;
  permissions: string; // bitfield as decimal string (Discord bit values)
  mentionable: boolean;
  unicode_emoji?: string | null; // role icon as an emoji (free in Vokko, no boost level); always sent by the server
}

export interface Guild {
  id: Snowflake;
  name: string;
  icon: string | null; // null → client renders initials ("Sam's server" → "Rs")
  owner_id: Snowflake;
  roles: Role[];
  system_channel_id: Snowflake | null;
  tag?: GuildTag | null; // server tag members can adopt (MANAGE_GUILD edits it)
  theme?: GuildTheme | null;
  banner?: string | null; // banner image URL (MANAGE_GUILD sets it via banner_attachment_id); null/absent = none
  verification_level?: VerificationLevel; // safety setup (MANAGE_GUILD); always sent by the server
  explicit_content_filter?: ExplicitContentFilter;
  nsfw_level?: NsfwLevel; // Access (MANAGE_GUILD); always sent by the server. AgeRestricted gates every channel of the server
  rules_channel_id?: Snowflake | null; // Access: the rules channel (a text channel of the guild); always sent, null when unset
  join_mode?: JoinMode; // Access: how people get in (MANAGE_GUILD); absent = InviteOnly
}
/** docs/api.md "Apply to Join": with ApplyToJoin nobody becomes a member (invite accept included) without an approved request. */
export enum JoinMode {
  InviteOnly = 0,
  ApplyToJoin = 1,
}
export type MemberVerificationFieldType = "TERMS" | "TEXT_INPUT" | "PARAGRAPH" | "MULTIPLE_CHOICE";
export interface MemberVerificationField {
  field_type: MemberVerificationFieldType;
  label: string; // 1-300
  required: boolean;
  values?: string[] | null; // TERMS: the rules (1-16 x 1-300); MULTIPLE_CHOICE: the choices (1-8 x 1-150)
  description?: string | null;
  placeholder?: string | null;
  response?: boolean | number | string | null; // applicant's answer: TERMS true, text, or the choice index
}
export interface MemberVerificationForm {
  description: string | null;
  form_fields: MemberVerificationField[];
}
export type JoinRequestStatus = "SUBMITTED" | "APPROVED" | "REJECTED";
export interface GuildJoinRequest {
  id: Snowflake;
  guild_id: Snowflake;
  user_id: Snowflake;
  user: User;
  created_at: ISO8601;
  application_status: JoinRequestStatus;
  form_responses: MemberVerificationField[];
  rejection_reason: string | null;
  actioned_at: ISO8601 | null;
  actioned_by_user: User | null;
}
/** GET /guilds/{id}/requests. */
export interface GuildJoinRequestList {
  guild_join_requests: GuildJoinRequest[];
  total: number;
}
/** Discord's guild NSFW level; only Default and AgeRestricted can be set. */
export enum NsfwLevel {
  Default = 0,
  Explicit = 1,
  Safe = 2,
  AgeRestricted = 3,
}
/** Who may send messages; members with any role bypass it (Discord rule). */
export enum VerificationLevel {
  None = 0,
  Low = 1, // Discord: verified email. Vokko has no email verification: every account passes
  Medium = 2, // account older than 5 minutes
  High = 3, // also a member for longer than 10 minutes
  VeryHigh = 4, // Discord: verified phone. Vokko: same as High
}
/** Stored and shown; Vokko does not scan media yet. */
export enum ExplicitContentFilter {
  Disabled = 0,
  MembersWithoutRoles = 1,
  AllMembers = 2,
}
export interface GuildTag {
  tag: string; // 1-4 chars
  badge: string;
  color_primary: number;
  color_secondary: number;
}
export interface GuildTheme {
  preset: string | null; // Vokko theme preset id, or null for custom
  primary: number;
  accent: number;
}

export interface GuildMember {
  user: User;
  nick: string | null;
  roles: Snowflake[];
  joined_at: ISO8601;
  communication_disabled_until?: ISO8601 | null; // timeout end; null/absent = not timed out
  flags?: number; // MemberFlags bitfield; absent = 0
  // Per-server profile (overrides the user profile inside this guild). Absent/null = use the user's.
  avatar?: string | null;
  banner?: string | null;
  bio?: string | null;
  pronouns?: string | null;
  theme_colors?: [number, number] | null;
  mute?: boolean; // server muted in voice (MUTE_MEMBERS); persists across rejoin; absent = false
  deaf?: boolean; // server deafened in voice (DEAFEN_MEMBERS); absent = false
}

export interface Attachment {
  id: Snowflake;
  filename: string;
  content_type: string | null;
  size: number;
  url: string; // absolute URL served by the server
  width: number | null;
  height: number | null;
  description?: string | null; // alt text, max 1024 chars
  // Spoiler: Discord convention, filename starts with "SPOILER_" (clients blur until clicked).
}

export interface EmbedMedia {
  url: string;
  proxy_url?: string;
  width?: number;
  height?: number;
}
export interface Embed {
  type: "rich" | "link" | "image" | "video" | "article" | "gifv" | "poll_result"; // poll_result: only on a MessageType.PollResult message, data in `fields`
  title?: string;
  description?: string;
  url?: string;
  timestamp?: ISO8601;
  color?: number;
  footer?: { text: string; icon_url?: string };
  image?: EmbedMedia;
  thumbnail?: EmbedMedia;
  video?: EmbedMedia;
  provider?: { name?: string; url?: string };
  author?: { name: string; url?: string; icon_url?: string };
  fields?: { name: string; value: string; inline?: boolean }[];
}

export interface ReactionEmoji {
  id: Snowflake | null; // custom emoji id (null for unicode); routes take `name:id` for custom emoji
  name: string; // unicode character(s) or custom name
  animated?: boolean; // custom emoji only: true for an animated one (absent for unicode)
}

// Custom emoji uploaded to a guild. Message content references them as <:name:id> (static) or <a:name:id> (animated).
// Vokko gives every Nitro emoji perk free: members can use any emoji of any guild they are in, anywhere (DMs included).
export interface GuildEmoji {
  id: Snowflake;
  name: string; // 2-32 chars [A-Za-z0-9_]
  roles: Snowflake[]; // roles allowed to use it; [] = every member
  user?: User; // uploader; only in REST responses (GET/POST/PATCH /guilds/{id}/emojis), absent in gateway payloads
  require_colons: boolean; // always true
  managed: boolean; // always false (no integrations)
  animated: boolean; // GIF or animated WebP
  available: boolean; // always true (no boost tiers to lose)
  url: string; // absolute image URL; the same file is also served by id at GET /emojis/{id}
}
export interface CreateGuildEmojiRequest {
  name: string;
  image_attachment_id: Snowflake; // PNG/GIF/WebP uploaded with POST /channels/{id}/attachments, max 256 KiB
  roles?: Snowflake[]; // default []
}
export interface EditGuildEmojiRequest {
  name?: string;
  roles?: Snowflake[] | null; // null or [] = every member
}

/** Reaction `type`: normal or burst (super reaction). Vokko has no burst limit. */
export enum ReactionType {
  Normal = 0,
  Burst = 1,
}

export interface Reaction {
  emoji: ReactionEmoji;
  count: number; // normal + burst
  count_details: { burst: number; normal: number };
  burst_colors: string[]; // "#rrggbb"; the Vokko server sends [] and clients compute the glow from the emoji
  me: boolean; // the viewer reacted normally
  me_burst: boolean; // the viewer super reacted
}

export enum MessageType {
  Default = 0,
  RecipientAdd = 1,
  RecipientRemove = 2,
  Call = 3, // DM / group DM call; author = who started it, `call` carries participants and ended_timestamp
  ChannelNameChange = 4,
  ChannelPinnedMessage = 6,
  UserJoin = 7,
  ThreadCreated = 18, // in the parent when a thread is started without a message; content = thread name, message_reference.channel_id = thread id
  Reply = 19,
  ThreadStarterMessage = 21, // first message of a thread started from a message; message_reference points at the original, referenced_message is filled
  ChatInputCommand = 20, // response to a slash command (interaction_metadata says who used which command)
  ContextMenuCommand = 23, // response to a User/Message command
  PollResult = 46, // posted once when a poll ends, by the poll's author; message_reference = the poll message, embeds[0] is a "poll_result" embed (PollResultField)
}
export enum MessageFlags {
  Crossposted = 1 << 0, // announcement message published to followers
  IsCrosspost = 1 << 1, // copy delivered by a follow; message_reference points at the source message
  SuppressEmbeds = 1 << 2,
  Ephemeral = 1 << 6, // interaction response visible only to the user who ran the command ("Only you can see this")
  Loading = 1 << 7, // deferred interaction response: "<bot> is thinking..." until the bot edits @original
}

export enum MessageReferenceType {
  Default = 0, // reply
  Forward = 1, // `message_snapshots` carries the copy; channel_id/guild_id/message_id point at the source
}
export interface MessageReference {
  type?: MessageReferenceType; // absent = 0
  message_id: Snowflake;
  channel_id: Snowflake;
  guild_id: Snowflake | null;
}

// ---- Stickers (guild stickers; every member can use them everywhere, no upsell) ----
export enum StickerFormat {
  PNG = 1,
  APNG = 2,
  GIF = 4, // Discord's LOTTIE (3) is not supported
  WebP = 5, // Vokko addition
}
export interface Sticker {
  id: Snowflake;
  guild_id: Snowflake;
  name: string; // 2-30 chars
  description: string | null; // max 100
  tags: string; // comma separated search words, 2-200 chars
  format_type: StickerFormat;
  url: string; // absolute asset URL
  available: boolean; // always true
  user?: User; // uploader
}
export interface StickerItem {
  id: Snowflake;
  name: string;
  format_type: StickerFormat;
  url: string;
}
export interface MessageSnapshot {
  message: {
    type: MessageType;
    content: string;
    timestamp: ISO8601;
    edited_timestamp: ISO8601 | null;
    mentions: User[];
    attachments: Attachment[];
    embeds: Embed[];
    sticker_items?: StickerItem[];
  };
}
export interface CreateStickerRequest {
  name: string;
  description?: string;
  tags: string;
  attachment_id: Snowflake; // pending upload from POST /channels/{id}/attachments: PNG/APNG/GIF/WebP, ≤512 KiB, ≤512x512
}
export interface EditStickerRequest {
  name?: string;
  description?: string | null;
  tags?: string;
}

// ---- Soundboard and entrance sounds (every guild gets the top tier; using other servers' sounds is free) ----
export const SOUNDBOARD_MAX_BYTES = 512 * 1024; // MP3, OGG or WAV
export const SOUNDBOARD_MAX_DURATION_MS = 5200;
export const SOUNDBOARD_SOUNDS_PER_GUILD = 48;
export interface SoundboardSound {
  sound_id: Snowflake; // default sounds have small fixed ids
  name: string; // 2-32 chars
  volume: number; // 0..1
  emoji_id: Snowflake | null;
  emoji_name: string | null; // unicode emoji on the tile
  guild_id?: Snowflake; // absent for default sounds
  available: boolean;
  user?: User; // uploader (guild sounds)
  url: string; // Vokko addition: absolute URL of the audio file, opaque
}
export interface SoundboardSoundList {
  items: SoundboardSound[]; // GET /guilds/{id}/soundboard-sounds
}
export interface CreateSoundboardSoundRequest {
  name: string;
  attachment_id: Snowflake; // pending upload from POST /channels/{id}/attachments: MP3/OGG/WAV, ≤512 KiB, ≤5.2 s
  volume?: number; // default 1
  emoji_id?: Snowflake;
  emoji_name?: string;
}
export interface EditSoundboardSoundRequest {
  name?: string;
  volume?: number;
  emoji_id?: Snowflake | null;
  emoji_name?: string | null;
}
export interface SendSoundboardSoundRequest {
  sound_id: Snowflake;
  source_guild_id?: Snowflake; // absent = a default sound or a sound of the channel's guild
}
export interface EntranceSound {
  guild_id: Snowflake | null; // scope: a guild, or null = every guild without its own
  sound_id: Snowflake;
  source_guild_id: Snowflake | null; // null = a default sound
}
export interface SetEntranceSoundRequest {
  guild_id: Snowflake | null;
  sound_id: Snowflake | null; // null clears this scope
  source_guild_id?: Snowflake | null;
}
export interface EntranceSounds {
  entrance_sounds: EntranceSound[]; // GET/PUT /users/@me/entrance-sounds, ENTRANCE_SOUNDS_UPDATE
}
export interface VoiceChannelEffectSend {
  channel_id: Snowflake;
  guild_id: Snowflake;
  user_id: Snowflake;
  sound_id: Snowflake;
  sound_volume: number;
  emoji: { id: Snowflake | null; name: string | null } | null;
  source_guild_id: Snowflake | null; // Vokko addition; null = a default sound
  sound_url: string; // Vokko addition: the audio file, playable by members outside the source guild
  entrance?: true; // Vokko addition: the sender's entrance sound on joining
}

// ---- GIFs (proxied by the server; the provider key never reaches clients) ----
export type GifProvider = "klipy" | "giphy" | "tenor" | "none"; // none = picker shows favourites only
export interface Gif {
  id: string; // "<provider>:<provider id>"
  title: string;
  url: string; // direct media URL; sending a GIF = a message whose content is this URL
  preview_url: string; // small image for the picker grid
  width: number;
  height: number;
}
export interface GifPage {
  provider: GifProvider;
  results: Gif[];
  next: string | null; // opaque cursor for ?pos=
}
export interface GifCategory {
  name: string; // searching for it lists the category
  image: string;
}
export interface GifCategories {
  provider: GifProvider;
  categories: GifCategory[];
}

// ---- Recent avatars and banners ----
/** GET /users/@me/avatars, /users/@me/banners: the last 6 the caller set, newest first. Set one again with PATCH /users/@me `avatar_attachment_id` / `banner_attachment_id: id`. */
export interface RecentImage {
  id: Snowflake; // the attachment id
  url: string;
}
/** POST /users/@me/avatars/gif, /users/@me/banners/gif: the server downloads a picked GIF (`Gif.url`, a media URL of the configured provider) and answers with the pending upload. */
export interface ImageGifRequest {
  channel_id: Snowflake; // a channel the caller may upload to
  url: string;
}

// ---- Bookmarks (saved messages) and reminders ----
export interface Bookmark {
  message: Message;
  saved_at: ISO8601;
}
export interface BookmarksPage {
  items: Bookmark[]; // newest saved first; items the owner can no longer read are left out
  has_more: boolean;
}
export interface CreateReminderRequest {
  channel_id: Snowflake;
  message_id: Snowflake;
  remind_at: ISO8601; // in the future, at most one year ahead; presets (1h, 3h, tomorrow) are computed by the client
}
export interface Reminder {
  id: Snowflake;
  channel_id: Snowflake;
  message_id: Snowflake;
  guild_id: Snowflake | null;
  remind_at: ISO8601;
  created_at: ISO8601;
  delivered_at: ISO8601 | null; // set when REMINDER_DUE fired; stays listed until dismissed
  message: Message | null; // null when the owner can no longer read it
}

// ---- User settings (synced preferences, docs/api.md "User settings") ----
/** Allow-listed keys (crates/protocol `user_settings::KEYS`); values are JSON. Absent key = the client default. */
export type UserSettingsData = Record<string, unknown>;
export interface UserSettings {
  version: number; // 0 = nothing saved yet; +1 per accepted PATCH
  settings: UserSettingsData;
}
export interface PatchUserSettingsRequest {
  version: number; // the version this change is based on; another one → 409 UserSettingsConflict
  settings: UserSettingsData; // keys to set; null removes a key (back to the default)
}
/** GET/PATCH /users/@me/guilds/{id}/privacy: `direct_messages` is false once the caller restricted DMs from this guild's members. */
export interface GuildPrivacySettings {
  direct_messages: boolean;
}
/** 409 body of PATCH /users/@me/settings: code 40090 plus the current blob. */
export interface UserSettingsConflict extends ApiError, UserSettings {}
export interface Keybind {
  action: string; // client action id (≤64 chars)
  keys: string; // "Ctrl+Shift+K" (≤64 chars)
  global?: boolean; // desktop only: registered with the OS while the app is in the background
}

// ---- "Request my data" (GET /users/@me/export, once per 24 h) ----
export interface ExportedGuild {
  id: Snowflake;
  name: string;
  nick: string | null;
  joined_at: ISO8601;
}
export interface ExportedChannel {
  id: Snowflake;
  type: ChannelType;
  guild_id: Snowflake | null;
  name: string | null;
  recipient_ids: Snowflake[]; // DMs: the other recipients
}
export interface ExportedMessage {
  id: Snowflake;
  channel_id: Snowflake;
  content: string;
  timestamp: ISO8601;
  edited_timestamp: ISO8601 | null;
  attachments: string[]; // file names
}
export interface UserDataExport {
  exported_at: ISO8601;
  user: User;
  settings: UserSettings;
  relationships: Relationship[];
  guilds: ExportedGuild[];
  channels: ExportedChannel[]; // channels the user wrote in plus open DMs
  messages: ExportedMessage[]; // own messages, newest first, at most 20000
  messages_truncated: boolean;
  dm_restricted_guild_ids: Snowflake[]; // guilds with Privacy Settings > Direct Messages off
}

export interface Message {
  id: Snowflake;
  channel_id: Snowflake;
  guild_id: Snowflake | null;
  author: User;
  member?: Pick<GuildMember, "nick" | "roles">; // guild messages
  content: string; // raw markdown, max 2000 chars; never rendered as HTML
  timestamp: ISO8601;
  edited_timestamp: ISO8601 | null;
  type: MessageType;
  mentions: User[];
  mention_everyone: boolean;
  attachments: Attachment[];
  embeds: Embed[]; // link unfurls (server-generated); [] when none
  reactions: Reaction[];
  pinned: boolean;
  tts: boolean; // read aloud; always present (false unless the sender held SEND_TTS_MESSAGES)
  message_reference: MessageReference | null;
  referenced_message: Message | null; // for replies; null if deleted
  nonce: string | null; // echoed from the send request for optimistic UI
  flags?: number; // MessageFlags; absent = 0
  thread?: Channel; // present when a thread was started from this message (thread.id == message id)
  poll?: Poll; // present on poll messages; results are per viewer (me_voted)
  sticker_items?: StickerItem[]; // absent = none
  message_snapshots?: MessageSnapshot[]; // exactly one on a forward (message_reference.type 1)
  webhook_id?: Snowflake; // posted by a webhook (or an interaction response: then == application_id); author is then the webhook identity
  application_id?: Snowflake; // interaction responses and followups
  interaction_metadata?: MessageInteractionMetadata; // interaction responses: who used which command
  call?: MessageCall; // type 3 only
}

export interface MessageCall {
  participants: Snowflake[]; // everyone who joined the call (the starter first)
  ended_timestamp: ISO8601 | null; // null while the call goes on; nobody but the starter joined = a missed call for the others
}

// ---- polls ----

export const POLL_MAX_ANSWERS = 10;
export const POLL_QUESTION_MAX = 300; // characters
export const POLL_ANSWER_MAX = 55; // characters
export const POLL_DURATIONS_HOURS = [1, 4, 8, 24, 72, 168, 336] as const; // what the client offers; the server accepts 1-768 hours
export enum PollLayoutType {
  Default = 1,
}
export interface PollMedia {
  text?: string; // question: 1-300 chars (required); answer: 1-55 chars (required)
  emoji?: ReactionEmoji; // answers only: unicode `{id: null, name}` or custom `{id, name}`
}
export interface PollAnswer {
  answer_id: number; // 1-based, in creation order
  poll_media: PollMedia;
}
export interface PollAnswerCount {
  id: number; // answer_id
  count: number;
  me_voted: boolean;
}
export interface PollResults {
  is_finalized: boolean; // true once the poll ended and its counts are final (the result message was posted)
  answer_counts: PollAnswerCount[]; // one per answer, in answer order (zero counts included)
}
export interface Poll {
  question: PollMedia; // text only
  answers: PollAnswer[]; // 1-10
  expiry: ISO8601; // votes are refused from this moment on; "End Poll Now" moves it to now
  allow_multiselect: boolean;
  layout_type: PollLayoutType;
  results: PollResults;
}
// `CreateMessageRequest.poll`
export interface PollCreateRequest {
  question: { text: string };
  answers: { poll_media: PollMedia }[]; // answer ids are assigned by the server
  duration?: number; // hours, 1-768 (32 days), default 24
  allow_multiselect?: boolean; // default false
  layout_type?: PollLayoutType; // default 1
}
// GET /channels/{id}/polls/{message_id}/answers/{answer_id}
export interface PollAnswerVotersResponse {
  users: User[]; // ordered by user id, paged with ?after=<user id>&limit=1-100 (default 25)
}
// MESSAGE_POLL_VOTE_ADD / MESSAGE_POLL_VOTE_REMOVE
export interface PollVoteEvent {
  user_id: Snowflake;
  channel_id: Snowflake;
  message_id: Snowflake;
  guild_id: Snowflake | null;
  answer_id: number;
}
// `fields` of the "poll_result" embed (Discord's names; `value` is always a string). victor_* are absent when nobody voted or the top answers tie.
export type PollResultField =
  | "poll_question_text"
  | "total_votes"
  | "victor_answer_id"
  | "victor_answer_text"
  | "victor_answer_votes"
  | "victor_answer_emoji_id"
  | "victor_answer_emoji_name";

export interface ReadState {
  channel_id: Snowflake;
  last_message_id: Snowflake | null; // last message the user has read
  mention_count: number;
}

// ---- Voice (docs/design/voice.md §2) ----

export const VOICE_BITRATE_DEFAULT = 64000; // new voice channels
export const VOICE_BITRATE_MIN = 8000;

export interface VoiceState {
  guild_id: Snowflake | null; // null for DM / group DM calls
  channel_id: Snowflake | null; // null = left voice
  user_id: Snowflake;
  member?: GuildMember; // guild VOICE_STATE_UPDATE only (READY/GUILD_CREATE already carry members)
  session_id: string; // voice session (not the gateway session id); changes on every new binding (e.g. another device)
  deaf: boolean; // server deafened
  mute: boolean; // server muted
  self_deaf: boolean;
  self_mute: boolean;
  self_video: boolean; // camera published (truth from LiveKit)
  self_stream: boolean; // screen share published (truth from LiveKit)
  suppress: boolean; // no SPEAK in this channel (or stage audience)
  request_to_speak_timestamp: ISO8601 | null; // stage raised hand
  connected_at: ISO8601;
}

export type ScreenshareQuality = "720p30" | "1080p60";
export interface InstanceMediaConfig {
  voice_enabled: boolean; // false when the server has no LiveKit configured
  voice_bitrate_ceiling: number; // default 128000, configurable up to 384000
  screenshare_qualities: ScreenshareQuality[];
  video_enabled: boolean;
}

// op 4, client → server
export interface VoiceStateUpdateCommand {
  guild_id: Snowflake | null;
  channel_id: Snowflake | null; // null = leave
  self_mute: boolean;
  self_deaf: boolean;
  self_video: boolean; // hint only; truth comes from LiveKit
  self_stream?: boolean; // mock backend only (no LiveKit to ask); the real server derives it from the published screen share
}
export interface VoiceStatusRequest {
  status: string | null; // PUT /channels/{id}/voice-status; null or "" clears
}
export type VoiceConnectFailure =
  | "missing_permissions"
  | "channel_full"
  | "video_full"
  | "blocked"
  | "timed_out"
  | "media_unavailable";

// ---- DM and group DM calls (docs/api.md "DM calls") ----

export const CALL_PARTICIPANT_MAX = 10; // people in one call
export const CALL_VIDEO_MAX = 25; // cameras + screen shares in one call
export const CALL_RING_TIMEOUT_MS = 180_000; // ringing stops after 3 minutes (missed call)

export interface Call {
  channel_id: Snowflake; // DM or group DM
  message_id: Snowflake; // the type 3 message recording the call
  region: string | null; // preferred media region, null = automatic (stored and echoed only: one media server)
  ringing: Snowflake[]; // users being rung right now
  voice_states: VoiceState[]; // who is in the call (guild_id null)
}
export interface CallRingRequest {
  recipients?: Snowflake[] | null; // POST /call/ring: absent = every recipient not in the call; POST /call/stop-ringing: absent = yourself
}
export interface EditCallRequest {
  region: string | null; // PATCH /channels/{id}/call
}

// ---- Stage channels (type 13) ----

export enum StagePrivacyLevel {
  GuildOnly = 2, // the only level Vokko has (Discord's public level is deprecated)
}
export const STAGE_TOPIC_MAX_CHARS = 120;
export interface StageInstance {
  id: Snowflake;
  guild_id: Snowflake;
  channel_id: Snowflake; // one live stage per stage channel
  topic: string; // 1-120 chars
  privacy_level: StagePrivacyLevel;
}
export interface CreateStageInstanceRequest {
  channel_id: Snowflake;
  topic: string;
  privacy_level?: StagePrivacyLevel;
}
export interface EditStageInstanceRequest {
  topic?: string;
  privacy_level?: StagePrivacyLevel;
}
// PATCH /guilds/{id}/voice-states/@me and /{user_id}; channel_id = the stage the user is in
export interface EditVoiceStateRequest {
  channel_id: Snowflake;
  suppress?: boolean; // true = back to the audience; false = speaker (moderator, or inviting someone)
  request_to_speak_timestamp?: ISO8601 | null; // @me only: raise (now) / lower (null) the hand; needs REQUEST_TO_SPEAK
}

// ---- REST payloads ----

export interface AuthRequest {
  login: string; // username or email
  password: string;
}
export interface RegisterRequest {
  email: string;
  username: string; // 2-32 chars [a-z0-9_.], no ".."; trimmed and lowercased by the server
  global_name?: string;
  password: string; // 8-128 chars, not too weak or common
  date_of_birth: string; // YYYY-MM-DD; at least InstanceInfo.min_age years old
  consent?: boolean; // required true when InstanceInfo.terms is not null
}
export interface AuthResponse {
  token: string;
  user: User;
}

// ---- accounts ----

export interface InstanceInfo {
  registration: "open" | "closed"; // VOKKO_REGISTRATION
  min_age: number; // VOKKO_MIN_AGE (default 13)
  terms: string | null; // plain-text checkbox label; null = no consent checkbox
  terms_url: string | null;
}
export interface UsernameAttemptRequest {
  username: string;
}
export interface UsernameAttemptResponse {
  taken: boolean;
}
export interface VerifyEmailRequest {
  token: string; // from the emailed /verify#token=... link
}
export interface AccountInfo {
  email: string;
  pending_email: string | null; // requested change waiting for its verification link
  verified: boolean; // email verified
  has_password: boolean; // false for accounts created through OAuth that never set one
  mfa_enabled: boolean; // TOTP two-factor
}
export interface EditAccountRequest {
  password?: string; // current password; required for every change when has_password
  username?: string;
  email?: string; // becomes pending_email until verified
  new_password?: string; // revokes the user's other sessions
  code?: string; // accounts without a password but with two-factor on: TOTP or backup code
}
export interface EditAccountResponse {
  user: User;
  account: AccountInfo;
}
export interface PasswordConfirmRequest {
  password?: string; // POST /users/@me/disable and /users/@me/delete; omitted only when has_password is false
  code?: string; // required when mfa_enabled: TOTP or backup code
}
export interface MfaRequiredResponse {
  token: null;
  mfa: true;
  ticket: string; // POST /auth/mfa/totp {ticket, code}; valid 5 minutes
  totp: boolean;
  backup: boolean;
}
export type LoginResponse = AuthResponse | MfaRequiredResponse; // POST /auth/login, /auth/reset
export interface MfaLoginRequest {
  ticket: string;
  code: string; // 6-digit TOTP code or a backup code
}
export interface EnableTotpRequest {
  password?: string;
  secret: string; // base32 (RFC 4648, no padding), at least 16 chars; made by the client
  code: string;
}
export interface BackupCode {
  code: string | null; // only in clear right after (re)generation
  consumed: boolean;
}
export interface BackupCodesResponse {
  backup_codes: BackupCode[];
}
export interface BackupCodesRequest {
  password?: string;
  code?: string; // accounts without a password
  regenerate: boolean;
}
export interface UserSession {
  id_hash: string;
  approx_last_used_time: ISO8601;
  client_info: { os: string | null; platform: string | null };
  current: boolean; // the session making the request
}
export interface AuthProvider {
  id: string; // "github", "google" or a lowercased OIDC name ("gitlab", "keycloak"...)
  name: string; // display name
  kind: "github" | "google" | "oidc";
}
export interface OAuthAuthorizeRequest {
  target: "web" | "desktop"; // where the server sends the browser back: <web>/oauth/callback or vokko://auth/callback
  client_challenge: string; // base64url(SHA-256(client_verifier)), verifier kept by the client
  link?: boolean; // link to the signed-in caller (needs Authorization) instead of signing in
  password?: string; // with link: identity check of accounts with a password
  code?: string; // with link: TOTP or backup code of accounts without a password but with two-factor
}
export interface OAuthCompleteRequest {
  code: string; // result code from the callback redirect
  client_verifier: string;
}
export interface OAuthRegistration {
  ticket: string; // POST /auth/oauth/register; valid 10 minutes
  provider: string;
  email: string | null; // verified email from the provider; null = the form asks for one
  suggested_username: string | null;
  global_name: string | null;
}
export type OAuthCompleteResponse =
  | { kind: "login"; login: LoginResponse }
  | { kind: "register"; registration: OAuthRegistration }
  | { kind: "linked"; provider: string }
  | { kind: "reauthenticated"; provider: string }; // a link flow for an already linked provider: the session counts as freshly signed in for 5 minutes
export interface OAuthRegisterRequest {
  ticket: string;
  username: string;
  date_of_birth: string; // YYYY-MM-DD
  consent?: boolean;
  email?: string; // only when OAuthRegistration.email is null
  global_name?: string;
}
export interface LinkedProvider {
  provider: string; // AuthProvider.id
  name: string;
  email: string | null;
  linked_at: ISO8601;
}
export interface ForgotPasswordRequest {
  login: string; // email or username
}
export interface ResetPasswordRequest {
  token: string; // from the /reset#token=... link
  password: string;
}

export interface CreateMessageRequest {
  content?: string;
  nonce?: string;
  message_reference?: { message_id: Snowflake; channel_id?: Snowflake; type?: MessageReferenceType }; // type 1 (forward) needs channel_id, no content/attachments/stickers
  sticker_ids?: Snowflake[]; // max 3; content may then be empty
  tts?: boolean; // needs SEND_TTS_MESSAGES; without it the message is sent with tts false
  attachment_ids?: Snowflake[]; // ids returned by POST /channels/{id}/attachments; max 10 per message
  attachments?: PendingAttachmentMeta[]; // same ids with optional rename / alt text; use instead of attachment_ids
  allowed_mentions?: AllowedMentions; // omitted = parse everything, replied_user true
  poll?: PollCreateRequest; // makes a poll message: content optional, no attachments (SEND_POLLS in guild channels)
}
export interface AllowedMentions {
  parse?: ("users" | "roles" | "everyone")[];
  users?: Snowflake[];
  roles?: Snowflake[];
  replied_user?: boolean; // false = reply without pinging the replied-to author (the @ON/OFF toggle)
}
export interface PinnedMessagesPage {
  items: { message: Message; pinned_at: ISO8601 }[];
  has_more: boolean;
}
// GET /guilds/{id}/messages/search and GET /channels/{id}/messages/search (Discord-shaped; array filters use repeated keys).
export type SearchHas = "link" | "embed" | "file" | "image" | "video" | "sound" | "sticker";
export interface MessageSearchQuery {
  content?: string; // all words must match (case-insensitive); "quoted phrase" and -excluded supported
  author_id?: Snowflake[];
  mentions?: Snowflake[];
  has?: SearchHas[]; // all must hold
  channel_id?: Snowflake[]; // guild route only
  pinned?: boolean;
  min_id?: Snowflake; // exclusive: "after"
  max_id?: Snowflake; // exclusive: "before"
  offset?: number; // 0-9975
  limit?: number; // 1-25, default 25
  sort_by?: "timestamp" | "relevance";
  sort_order?: "desc" | "asc";
}
export interface MessageSearchResponse {
  total_results: number; // all matches the caller may read, before offset/limit
  messages: Message[][]; // each hit is a one-element array (Discord's shape)
}

// ---- Members page: POST /guilds/{id}/members-search (Discord's member-safety search) ----

export enum MemberSearchSort {
  MemberSinceNewestFirst = 1,
  MemberSinceOldestFirst = 2,
  JoinedVokkoNewestFirst = 3,
  JoinedVokkoOldestFirst = 4,
}
export enum JoinSourceType {
  Unspecified = 0, // members from before tracking, the owner, and every path other than an invite
  Bot = 1,
  Integration = 2,
  Discovery = 3,
  Hub = 4,
  Invite = 5,
  VanityUrl = 6,
  ManualMemberVerification = 7,
}
export interface OrQuery<T> {
  or_query: T[];
}
export interface AndOrQuery<T> {
  and_query?: T[]; // every listed value
  or_query?: T[]; // any of them
}
export interface RangeQuery {
  range: { gte?: number; lte?: number }; // inclusive, unix ms
}
export interface MemberSearchQuery {
  user_id?: OrQuery<Snowflake>;
  usernames?: OrQuery<string>; // case-insensitive prefix of username, display name or nickname, or an exact user id
  role_ids?: AndOrQuery<Snowflake>;
  guild_joined_at?: RangeQuery;
  user_created_at?: RangeQuery; // read from the user id (snowflake)
  source_invite_code?: OrQuery<string>;
  join_source_type?: OrQuery<JoinSourceType>;
}
export interface MemberSearchRequest {
  limit?: number; // 1-1000, default 25
  offset?: number; // 0-100000, default 0 (Vokko pages by offset, not Discord's before/after cursors)
  sort?: MemberSearchSort; // default MemberSinceNewestFirst
  and_query: MemberSearchQuery;
}
export interface SupplementalGuildMember {
  member: GuildMember;
  source_invite_code: string | null; // null: joined before tracking, the owner, or not through an invite
  join_source_type: JoinSourceType;
  inviter_id: Snowflake | null;
}
export interface MemberSearchResponse {
  guild_id: Snowflake;
  members: SupplementalGuildMember[];
  page_result_count: number;
  total_result_count: number; // all matches, before offset/limit
}
export interface RateLimitError {
  message: string;
  retry_after: number; // seconds (float); also sent as the Retry-After header
  global: boolean;
}
export interface PendingAttachmentMeta {
  id: Snowflake; // pending attachment id from POST /channels/{id}/attachments
  filename?: string; // rename before sending; prefix "SPOILER_" marks a spoiler
  description?: string; // alt text, max 1024 chars
}
export interface EditMessageRequest {
  content?: string;
  flags?: number; // 1 << 2 SUPPRESS_EMBEDS
  attachments?: { id: Snowflake }[]; // attachments to keep; omitted = unchanged; can only remove, not add
}

// ---- Threads, forums, announcements ----
export interface StartThreadFromMessageRequest {
  name: string; // 1-100
  auto_archive_duration?: ThreadAutoArchiveDuration; // default: parent's default_auto_archive_duration, else 1440
}
export interface StartThreadRequest {
  name: string;
  auto_archive_duration?: ThreadAutoArchiveDuration;
  type?: ChannelType.PublicThread | ChannelType.PrivateThread | ChannelType.AnnouncementThread; // default PublicThread (AnnouncementThread in an announcement channel)
  invitable?: boolean; // private threads
}
export interface StartForumPostRequest {
  name: string; // post title, 1-100
  auto_archive_duration?: ThreadAutoArchiveDuration;
  applied_tags?: Snowflake[];
  message: CreateMessageRequest; // the first message; its id becomes the thread id
}
export type ForumPost = Channel & { message: Message }; // response of POST /channels/{forum}/threads
export interface ThreadListResponse {
  threads: Channel[];
  members: ThreadMember[]; // the caller's memberships among `threads`
  has_more: boolean; // archived lists only; always false for active lists
}
// GET /channels/{id}/threads/search (forum page: tag filter, sort, search box). Array filters use repeated keys.
export interface ThreadSearchQuery {
  name?: string; // case-insensitive substring of the title
  tag?: Snowflake[];
  tag_setting?: "match_some" | "match_all"; // default match_some
  archived?: boolean; // absent = active and archived, true = only archived, false = only active
  sort_by?: "last_message_time" | "creation_time"; // default from the forum's default_sort_order
  sort_order?: "desc" | "asc"; // default desc; pinned posts always come first
  limit?: number; // 1-25, default 25
  offset?: number;
}
export interface ThreadSearchResponse {
  threads: Channel[];
  members: ThreadMember[];
  first_messages: Message[]; // starter message of each thread, same order (missing when deleted)
  has_more: boolean;
  total_results: number;
}
export interface ForumTagRequest {
  id?: Snowflake; // existing tag to keep/rename; absent = new tag
  name: string;
  moderated?: boolean;
  emoji_id?: Snowflake | null;
  emoji_name?: string | null;
}
export interface FollowChannelRequest {
  webhook_channel_id: Snowflake; // channel that receives the published messages (needs MANAGE_WEBHOOKS there)
}
export interface FollowedChannel {
  channel_id: Snowflake; // the followed announcement channel
  webhook_id: Snowflake; // follow id; use it to unfollow
}
export interface ChannelFollower {
  id: Snowflake; // follow id
  channel_id: Snowflake; // target channel (the one this list belongs to)
  guild_id: Snowflake;
  source_channel_id: Snowflake;
  source_channel_name: string;
  source_guild_id: Snowflake;
  source_guild_name: string;
}

export interface MessageReactionEvent {
  user_id: Snowflake;
  channel_id: Snowflake;
  message_id: Snowflake;
  emoji: ReactionEmoji;
  type: ReactionType;
  burst: boolean; // type === Burst
}

export interface EditUserRequest {
  global_name?: string | null;
  bio?: string | null;
  banner_color?: string | null;
  avatar_attachment_id?: Snowflake | null; // PNG/JPEG/WebP/GIF (animated allowed), ≤10 MiB, stored as uploaded
  banner_attachment_id?: Snowflake | null; // ≤10 MiB, animated allowed
  pronouns?: string | null;
  theme_colors?: [number, number] | null;
  avatar_decoration?: string | null;
  profile_effect?: string | null;
  primary_guild_id?: Snowflake | null; // adopt that guild's tag (must be a member and the guild must have a tag); null clears
  nameplate?: string | null;
  display_name_styles?: DisplayNameStyles | null;
  widgets?: ProfileWidgetsInput | null; // replaces the whole value; null clears
}
export interface EditOwnMemberRequest {
  nick?: string | null;
  avatar_attachment_id?: Snowflake | null;
  banner_attachment_id?: Snowflake | null;
  bio?: string | null;
  pronouns?: string | null;
  theme_colors?: [number, number] | null;
}

export interface UserProfile {
  user: User;
  mutual_guilds: { id: Snowflake; nick: string | null }[];
  mutual_friends_count: number;
  guild_member?: GuildMember; // when ?guild_id= is given and the user is a member
}

// ---- Moderation payloads ----
export interface BanRequest {
  delete_message_seconds?: number; // 0..604800, deletes the user's recent messages in the guild
  reason?: string;
}
export interface Ban {
  user: User;
  reason: string | null;
}
export interface EditMemberRequest {
  nick?: string | null;
  roles?: Snowflake[]; // full replacement list (without @everyone)
  communication_disabled_until?: ISO8601 | null; // max 28 days ahead
  mute?: boolean; // server mute, MUTE_MEMBERS
  deaf?: boolean; // server deafen, DEAFEN_MEMBERS
  channel_id?: Snowflake | null; // voice move (MOVE_MEMBERS in both channels) or null = disconnect; member must be in voice (400 40032)
}
export interface RoleRequest {
  name?: string;
  color?: number;
  hoist?: boolean;
  permissions?: string;
  mentionable?: boolean;
  unicode_emoji?: string | null; // null removes the role icon
}
export interface RolePositionUpdate {
  id: Snowflake;
  position: number;
}
export interface OverwriteRequest {
  type: OverwriteType;
  allow: string;
  deny: string;
}

// ---- Community: scheduled events, onboarding, friend suggestions ----

export const MemberFlags = {
  DidRejoin: 1 << 0,
  CompletedOnboarding: 1 << 1,
  BypassesVerification: 1 << 2,
  StartedOnboarding: 1 << 3, // set when a member joins a guild whose onboarding is enabled; CompletedOnboarding is added when they finish
} as const;

export enum ScheduledEventEntityType {
  StageInstance = 1, // Vokko has no stage channels yet: channel_id must be a voice channel
  Voice = 2,
  External = 3,
}
export enum ScheduledEventStatus {
  Scheduled = 1,
  Active = 2,
  Completed = 3,
  Canceled = 4,
}
// Allowed status changes (PATCH): Scheduled -> Active, Scheduled -> Canceled, Active -> Completed.
export enum RecurrenceFrequency {
  Yearly = 0,
  Monthly = 1,
  Weekly = 2,
  Daily = 3,
}
export interface ScheduledEventRecurrenceRule {
  start: ISO8601; // first occurrence (normally scheduled_start_time)
  end: ISO8601 | null; // no occurrences after this
  frequency: RecurrenceFrequency;
  interval: number; // 1-12 (every N days/weeks/months/years)
  by_weekday: number[] | null; // 0 = Monday .. 6 = Sunday (weekly rules)
  count: number | null; // total occurrences, 1-1000
}
// Stored and returned as given. Vokko does not spawn follow-up occurrences yet; clients show the rule as text.

export interface GuildScheduledEvent {
  id: Snowflake;
  guild_id: Snowflake;
  channel_id: Snowflake | null; // voice/stage events; null for External
  creator_id: Snowflake | null; // null when the creator's account is gone
  creator?: User;
  name: string; // 1-100 chars
  description: string | null; // max 1000 chars
  scheduled_start_time: ISO8601;
  scheduled_end_time: ISO8601 | null; // required for External
  privacy_level: 2; // GUILD_ONLY, the only level Discord has
  status: ScheduledEventStatus;
  entity_type: ScheduledEventEntityType;
  entity_id: Snowflake | null; // always null (no stage instances)
  entity_metadata: { location: string | null } | null; // External: location 1-100 chars
  user_count: number; // members who marked Interested
  user_rsvp: boolean; // the viewer is Interested (viewer-specific, also in gateway events)
  image: string | null; // cover image URL (attachment); null = none
  recurrence_rule: ScheduledEventRecurrenceRule | null;
}
export interface CreateScheduledEventRequest {
  name: string;
  description?: string | null;
  entity_type: ScheduledEventEntityType;
  channel_id?: Snowflake | null; // required for Voice/StageInstance, must be a voice channel the creator can VIEW_CHANNEL + CONNECT
  entity_metadata?: { location: string } | null; // required for External
  scheduled_start_time: ISO8601; // must be in the future
  scheduled_end_time?: ISO8601 | null; // required for External, after the start
  privacy_level?: 2;
  image_attachment_id?: Snowflake | null; // pending attachment from POST /channels/{id}/attachments (any channel the creator can send in)
  recurrence_rule?: ScheduledEventRecurrenceRule | null;
}
export interface EditScheduledEventRequest {
  name?: string;
  description?: string | null;
  entity_type?: ScheduledEventEntityType; // only while Scheduled
  channel_id?: Snowflake | null;
  entity_metadata?: { location: string } | null;
  scheduled_start_time?: ISO8601;
  scheduled_end_time?: ISO8601 | null;
  image_attachment_id?: Snowflake | null; // null removes the cover
  recurrence_rule?: ScheduledEventRecurrenceRule | null;
  status?: ScheduledEventStatus; // see allowed transitions above
}
export interface ScheduledEventUser {
  guild_scheduled_event_id: Snowflake;
  user: User;
  member?: GuildMember; // with ?with_member=true
}

export enum OnboardingPromptType {
  MultipleChoice = 0,
  Dropdown = 1,
}
export enum OnboardingMode {
  Default = 0, // only default channels count
  Advanced = 1, // default channels plus answers
}
export interface OnboardingOption {
  id: Snowflake;
  title: string; // 1-50 chars
  description: string | null; // max 100 chars
  emoji: ReactionEmoji | null;
  channel_ids: Snowflake[]; // channels this answer points the member at (visibility still follows permissions)
  role_ids: Snowflake[]; // roles this answer grants
}
export interface OnboardingPrompt {
  id: Snowflake;
  type: OnboardingPromptType;
  title: string; // 1-100 chars
  options: OnboardingOption[]; // 1-50
  single_select: boolean;
  required: boolean;
  in_onboarding: boolean; // asked during onboarding (false = only on the Channels & Roles page)
}
export interface OnboardingRules {
  description: string | null; // max 300 chars
  items: string[]; // 1-16 rules, each 1-300 chars
}
export interface GuildOnboarding {
  guild_id: Snowflake;
  prompts: OnboardingPrompt[]; // max 15
  default_channel_ids: Snowflake[]; // max 50
  enabled: boolean;
  mode: OnboardingMode;
  rules: OnboardingRules | null; // when set the member must accept before completing
}
export interface OnboardingOptionInput {
  id?: Snowflake; // keep an existing option (and the answers members gave); absent/unknown = new
  title: string;
  description?: string | null;
  emoji?: ReactionEmoji | null;
  channel_ids?: Snowflake[];
  role_ids?: Snowflake[];
}
export interface OnboardingPromptInput {
  id?: Snowflake;
  type: OnboardingPromptType;
  title: string;
  options: OnboardingOptionInput[];
  single_select?: boolean;
  required?: boolean;
  in_onboarding?: boolean;
}
// PUT /guilds/{id}/onboarding. Only the sent keys change; `prompts` replaces the whole list.
export interface EditOnboardingRequest {
  prompts?: OnboardingPromptInput[];
  default_channel_ids?: Snowflake[];
  enabled?: boolean;
  mode?: OnboardingMode;
  rules?: OnboardingRules | null;
}
// PUT /guilds/{id}/onboarding-responses
export interface OnboardingResponsesRequest {
  option_ids: Snowflake[]; // the full set of answers; replaces earlier answers
  rules_accepted?: boolean; // must be true when the guild has rules
}
export interface OnboardingResponses {
  option_ids: Snowflake[];
}
export interface OnboardingCompletion {
  member: GuildMember; // roles granted, flags include CompletedOnboarding
  channel_ids: Snowflake[]; // default channels then the answers' channels, only ones the member can view, no duplicates
}

export interface FriendSuggestion {
  user: User;
  mutual_guilds: { id: Snowflake; nick: string | null }[]; // guilds (max 200 members) both are in; nick = the suggested user's
  mutual_friends_count: number;
}
export interface FriendSuggestionsResponse {
  enabled: boolean; // the caller's own setting; false = suggestions is [] and the caller is not suggested to others either
  suggestions: FriendSuggestion[]; // best first (mutual friends, then mutual guilds), max `limit`
}
export interface FriendSuggestionSettings {
  enabled: boolean;
}

// ---- Server admin: prune, audit log, AutoMod ----
/** GET /guilds/{id}/prune?days&include_roles (comma-separated) and POST /guilds/{id}/prune. */
export interface PruneRequest {
  days?: number; // 1..30, default 7
  include_roles?: Snowflake[]; // members holding only these roles are pruned too
  compute_prune_count?: boolean; // POST only, default true; false → { pruned: null }
}
export interface PruneResponse {
  pruned: number | null;
}

/** Discord's audit log event numbers (Vokko records the ones whose routes exist, see docs/api.md). */
export enum AuditLogEvent {
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
  ReportUpdate = 250, // Vokko-only: a report closed or reopened; target_id is the report, the change is `status`
}
/** One changed key; a missing side means it was not set before (create) or after (delete). */
export interface AuditLogChange {
  key: string; // "$add" / "$remove" carry [{id, name}] role lists on MemberRoleUpdate
  old_value?: unknown;
  new_value?: unknown;
}
/** Extra context per action type (numbers are strings, like Discord). */
export interface AuditEntryInfo {
  channel_id?: Snowflake;
  message_id?: Snowflake;
  count?: string;
  delete_member_days?: string;
  members_removed?: string;
  id?: Snowflake; // overwrite target
  type?: string; // overwrite target type: "0" role, "1" member
  role_name?: string;
  auto_moderation_rule_name?: string;
  auto_moderation_rule_trigger_type?: string;
}
export interface AuditLogEntry {
  id: Snowflake;
  guild_id: Snowflake;
  user_id: Snowflake | null; // who acted
  target_id: string | null; // affected user / role / channel / invite code / rule
  action_type: AuditLogEvent;
  changes?: AuditLogChange[];
  options?: AuditEntryInfo;
  reason: string | null; // X-Audit-Log-Reason header (URL-encoded, max 512 chars)
}
/** GET /guilds/{id}/audit-logs query. */
export interface AuditLogQuery {
  user_id?: Snowflake;
  action_type?: AuditLogEvent;
  before?: Snowflake;
  after?: Snowflake;
  limit?: number; // 1..100, default 50
}
export interface AuditLog {
  audit_log_entries: AuditLogEntry[]; // newest first
  users: User[]; // every actor and user target referenced
}

export enum AutoModerationTriggerType {
  Keyword = 1,
}
export enum AutoModerationEventType {
  MessageSend = 1,
}
export enum AutoModerationActionType {
  BlockMessage = 1,
}
export interface AutoModerationTriggerMetadata {
  keyword_filter: string[]; // max 1000, each ≤60 chars; "*" at the start/end = prefix / suffix / substring match
  allow_list: string[]; // max 100, same syntax
}
export interface AutoModerationAction {
  type: AutoModerationActionType;
  metadata?: { custom_message?: string }; // ≤150 chars, shown to the blocked author
}
export interface AutoModerationRule {
  id: Snowflake;
  guild_id: Snowflake;
  name: string;
  creator_id: Snowflake;
  event_type: AutoModerationEventType;
  trigger_type: AutoModerationTriggerType;
  trigger_metadata: AutoModerationTriggerMetadata;
  actions: AutoModerationAction[];
  enabled: boolean;
  exempt_roles: Snowflake[];
  exempt_channels: Snowflake[];
}
/** POST (name, event_type, trigger_type, actions required) and PATCH (all optional; trigger_type cannot change). */
export interface AutoModerationRuleRequest {
  name?: string;
  event_type?: AutoModerationEventType;
  trigger_type?: AutoModerationTriggerType;
  trigger_metadata?: Partial<AutoModerationTriggerMetadata>;
  actions?: AutoModerationAction[];
  enabled?: boolean;
  exempt_roles?: Snowflake[];
  exempt_channels?: Snowflake[];
}

export interface EditChannelRequest {
  // ---- shared (guild channels) ----
  name?: string;
  topic?: string;
  position?: number;
  parent_id?: Snowflake; // "0" moves out of the category
  lock_permissions?: boolean;
  // ---- threads ----
  archived?: boolean; // owner or MANAGE_THREADS; a locked thread needs MANAGE_THREADS
  locked?: boolean; // MANAGE_THREADS
  auto_archive_duration?: ThreadAutoArchiveDuration;
  invitable?: boolean; // private threads
  applied_tags?: Snowflake[]; // forum posts: owner or MANAGE_THREADS; moderated tags need MANAGE_THREADS
  flags?: number; // forum post: ChannelFlags.Pinned (MANAGE_THREADS); forum channel: ChannelFlags.RequireTag (MANAGE_CHANNELS)
  // ---- forum channels (MANAGE_CHANNELS) ----
  available_tags?: ForumTagRequest[]; // full replacement list; ids not listed are deleted (and removed from posts)
  default_reaction_emoji?: DefaultReaction | null; // null clears
  default_sort_order?: ForumSortOrder;
  default_forum_layout?: ForumLayout;
  default_auto_archive_duration?: ThreadAutoArchiveDuration;
  // ---- voice channels (MANAGE_CHANNELS) ----
  bitrate?: number; // 8000..guild max (else 400 50035)
  user_limit?: number; // 0..99
}
export interface CreateChannelRequest {
  name: string;
  type: ChannelType; // text, voice, category, announcement, stage, forum
  parent_id?: Snowflake;
  topic?: string;
  permission_overwrites?: PermissionOverwrite[];
  available_tags?: ForumTagRequest[]; // forum
  default_reaction_emoji?: DefaultReaction;
  default_sort_order?: ForumSortOrder;
  default_forum_layout?: ForumLayout;
  default_auto_archive_duration?: ThreadAutoArchiveDuration;
  flags?: number;
  bitrate?: number; // voice only
  user_limit?: number; // voice only
}

// ---- Invites ----
export type InviteMaxAge = 0 | 1800 | 3600 | 21600 | 43200 | 86400 | 604800; // seconds the client offers; 0 = never expires
export type InviteMaxUses = 0 | 1 | 5 | 10 | 25 | 50 | 100; // the client offers these; 0 = no limit
export interface CreateInviteRequest {
  max_age?: number; // 0..604800 seconds, default 86400 (the server accepts any value in range)
  max_uses?: number; // 0..100, default 0
  temporary?: boolean; // members who join through it are removed when their last gateway connection closes, unless given a role
  unique?: boolean; // false (default): the server returns a live invite of the same inviter + channel with the same settings if one exists
}
export interface InviteGuild {
  id: Snowflake;
  name: string;
  icon: string | null;
  member_count: number;
  join_mode?: JoinMode; // Apply to Join: a non-member must apply instead of accepting
}
export interface InviteChannel {
  id: Snowflake;
  name: string | null;
}
/** GET /invites/{code} (preview). */
export interface Invite {
  code: string;
  guild: InviteGuild;
  channel: InviteChannel;
  expires_at: ISO8601 | null;
}
/** POST /channels/{id}/invites, GET /channels/{id}/invites, GET /guilds/{id}/invites, DELETE /invites/{code}, INVITE_CREATE. */
export interface InviteMetadata extends Invite {
  inviter: User | null; // null when the inviter's account is gone
  uses: number;
  max_uses: number; // 0 = no limit
  max_age: number; // seconds, 0 = never
  temporary: boolean;
  created_at: ISO8601;
}

// ---- Guild layout: server folders and rail order (GET/PATCH /users/@me/guild-layout, READY guild_layout, GUILD_LAYOUT_UPDATE) ----
export interface GuildFolder {
  id: Snowflake; // chosen by the client, unique among the user's folders
  name: string | null; // 1-32 chars; null = unnamed (the client shows the server names)
  color: number | null; // RGB int; null = default folder colour
  guild_ids: Snowflake[]; // 1-200, in display order
}
export interface GuildLayout {
  guild_folders: GuildFolder[]; // max 100 folders, a guild in at most one
  guild_positions: Snowflake[]; // rail order of guild ids (folder members in place, contiguous, in folder order); max 200, no duplicates
}
export type UpdateGuildLayoutRequest = Partial<GuildLayout>; // only sent keys change

export interface ApiError {
  code: number; // Discord-like numeric code, e.g. 10003 unknown channel, 50001 missing access, 50035 invalid form body
  message: string;
  errors?: Record<string, unknown>;
}

// ---- Gateway (WebSocket /gateway, JSON text frames) ----

export enum GatewayOp {
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
}

export interface GatewayPayload<T = unknown> {
  op: GatewayOp;
  d: T;
  s: number | null; // sequence, dispatch only
  t: string | null; // event name, dispatch only
}

export interface ReadyEvent {
  v: 1;
  user: User;
  session_id: string;
  // voice_states: always sent by the server (optional here so fixtures without voice stay valid); threads = active threads the user can see (not in channels); emojis absent = none
  guilds: (Guild & { channels: Channel[]; members: GuildMember[]; member_count: number; stickers?: Sticker[]; soundboard_sounds?: SoundboardSound[]; voice_states?: VoiceState[]; threads?: Channel[]; emojis?: GuildEmoji[]; stage_instances?: StageInstance[] })[]; // stage_instances: live stages the user can see, omitted when none
  private_channels: Channel[]; // DMs and group DMs
  presences: Presence[];
  read_states: ReadState[];
  relationships: Relationship[];
  guild_layout: GuildLayout;
  media?: InstanceMediaConfig; // always sent by the server; absent = voice unavailable
}

export enum RelationshipType {
  Friend = 1,
  Blocked = 2,
  IncomingRequest = 3,
  OutgoingRequest = 4,
}
export interface Relationship {
  id: Snowflake; // the other user's id
  type: RelationshipType;
  user: User;
}

// Dispatch event names and payloads (t → d)
export interface GatewayEvents {
  READY: ReadyEvent;
  MESSAGE_CREATE: Message;
  MESSAGE_UPDATE: Message;
  MESSAGE_DELETE: { id: Snowflake; channel_id: Snowflake; guild_id: Snowflake | null };
  MESSAGE_REACTION_ADD: MessageReactionEvent;
  MESSAGE_REACTION_REMOVE: MessageReactionEvent;
  TYPING_START: { channel_id: Snowflake; user_id: Snowflake; timestamp: number };
  CHANNEL_CREATE: Channel;
  CHANNEL_UPDATE: Channel;
  CHANNEL_DELETE: Channel;
  GUILD_CREATE: ReadyEvent["guilds"][number] & { presences?: Presence[] }; // presences of the guild's online members (Discord-style)
  GUILD_UPDATE: Guild; // roles included, no channels/members
  GUILD_DELETE: { id: Snowflake };
  GUILD_MEMBER_ADD: GuildMember & { guild_id: Snowflake };
  GUILD_MEMBER_REMOVE: { guild_id: Snowflake; user: User };
  GUILD_MEMBER_UPDATE: GuildMember & { guild_id: Snowflake };
  GUILD_BAN_ADD: { guild_id: Snowflake; user: User };
  GUILD_BAN_REMOVE: { guild_id: Snowflake; user: User };
  GUILD_JOIN_REQUEST_CREATE: { guild_id: Snowflake; status: JoinRequestStatus; request: GuildJoinRequest }; // to the applicant and KICK_MEMBERS/MANAGE_GUILD members
  GUILD_JOIN_REQUEST_UPDATE: { guild_id: Snowflake; status: JoinRequestStatus; request: GuildJoinRequest };
  GUILD_JOIN_REQUEST_DELETE: { guild_id: Snowflake; id: Snowflake; user_id: Snowflake }; // withdrawn, replaced or the applicant was banned
  GUILD_ROLE_CREATE: { guild_id: Snowflake; role: Role };
  GUILD_ROLE_UPDATE: { guild_id: Snowflake; role: Role };
  GUILD_ROLE_DELETE: { guild_id: Snowflake; role_id: Snowflake };
  GUILD_EMOJIS_UPDATE: { guild_id: Snowflake; emojis: GuildEmoji[] }; // the guild's full emoji list after any create/edit/delete (no `user`)
  RESUMED: Record<string, never>; // after a successful op 6 replay
  PRESENCE_UPDATE: Presence;
  USER_UPDATE: User; // profile/avatar change; sent to the user and everyone sharing a guild, DM or relationship with them
  MESSAGE_ACK: { channel_id: Snowflake; message_id: Snowflake };
  RELATIONSHIP_ADD: Relationship;
  RELATIONSHIP_REMOVE: { id: Snowflake };
  // Scheduled events: sent to every member of the guild; `user_rsvp` is filled per receiver. CREATE/UPDATE/DELETE carry the event
  // (DELETE: its last state), USER_ADD/USER_REMOVE are Interested toggles (receivers adjust `user_count`).
  GUILD_SCHEDULED_EVENT_CREATE: GuildScheduledEvent;
  GUILD_SCHEDULED_EVENT_UPDATE: GuildScheduledEvent;
  GUILD_SCHEDULED_EVENT_DELETE: GuildScheduledEvent;
  GUILD_SCHEDULED_EVENT_USER_ADD: { guild_scheduled_event_id: Snowflake; user_id: Snowflake; guild_id: Snowflake };
  GUILD_SCHEDULED_EVENT_USER_REMOVE: { guild_scheduled_event_id: Snowflake; user_id: Snowflake; guild_id: Snowflake };
  GUILD_STICKERS_UPDATE: { guild_id: Snowflake; stickers: Sticker[] }; // full list after a create/edit/delete
  BOOKMARK_ADD: Bookmark; // to the owner's sessions only
  BOOKMARK_REMOVE: { channel_id: Snowflake; message_id: Snowflake };
  REMINDER_CREATE: Reminder;
  REMINDER_DUE: Reminder; // delivered_at set; the "notice from the instance"
  REMINDER_DELETE: { id: Snowflake };
  USER_SETTINGS_UPDATE: UserSettings; // the full blob after a change, to every session of that user (the one that saved it included)
  VOICE_STATE_UPDATE: VoiceState; // to everyone who can see the channel
  VOICE_SERVER_UPDATE: { guild_id: Snowflake | null; channel_id: Snowflake; endpoint: string; token: string; session_id: string }; // requesting session only; session_id = the VoiceState.session_id this token is for
  VOICE_CONNECT_FAILED: { guild_id: Snowflake | null; channel_id: Snowflake; reason: VoiceConnectFailure }; // Vokko-only, requesting session only
  VOICE_CHANNEL_STATUS_UPDATE: { id: Snowflake; guild_id: Snowflake; status: string | null }; // to viewers of the channel; cleared (null) when the channel empties
  STAGE_INSTANCE_CREATE: StageInstance; // to viewers of the stage channel
  STAGE_INSTANCE_UPDATE: StageInstance;
  STAGE_INSTANCE_DELETE: StageInstance; // End Stage, or the last stage moderator left
  THREAD_CREATE: Channel; // newly_created: true for a fresh thread; also sent when the user gains access to a private thread
  THREAD_UPDATE: Channel; // archive/lock/rename/tags/pin changes, auto-archive
  THREAD_DELETE: { id: Snowflake; guild_id: Snowflake; parent_id: Snowflake; type: ChannelType };
  THREAD_MEMBER_UPDATE: ThreadMember & { guild_id: Snowflake }; // the current user joined a thread
  THREAD_MEMBERS_UPDATE: { id: Snowflake; guild_id: Snowflake; member_count: number; added_members?: ThreadMember[]; removed_member_ids?: Snowflake[] };
  INTERACTION_CREATE: Interaction; // to the bot only
  INTERACTION_FAILURE: { id: Snowflake; nonce: string | null; channel_id: Snowflake; application_id: Snowflake }; // to the invoking user: no callback within 3 s
  APPLICATION_COMMAND_AUTOCOMPLETE_RESPONSE: { id: Snowflake; nonce: string | null; choices: ApplicationCommandOptionChoice[] }; // to the invoking user
  WEBHOOKS_UPDATE: { guild_id: Snowflake; channel_id: Snowflake }; // a webhook of the channel was created, edited or deleted (to MANAGE_WEBHOOKS holders)
  CALL_CREATE: Call; // to the DM's recipients when a call starts, and after READY for every ongoing call in the user's DMs
  CALL_UPDATE: Omit<Call, "voice_states">; // ringing or region changed
  CALL_DELETE: { channel_id: Snowflake }; // the last participant left
  MESSAGE_POLL_VOTE_ADD: PollVoteEvent; // to everyone who can see the channel
  MESSAGE_POLL_VOTE_REMOVE: PollVoteEvent;
  GUILD_SOUNDBOARD_SOUND_CREATE: SoundboardSound & { guild_id: Snowflake }; // to the guild's members
  GUILD_SOUNDBOARD_SOUND_UPDATE: SoundboardSound & { guild_id: Snowflake };
  GUILD_SOUNDBOARD_SOUND_DELETE: { sound_id: Snowflake; guild_id: Snowflake };
  VOICE_CHANNEL_EFFECT_SEND: VoiceChannelEffectSend; // only to the users connected to that voice channel
  ENTRANCE_SOUNDS_UPDATE: EntranceSounds; // to the user's own sessions
  MESSAGE_DELETE_BULK: { ids: Snowflake[]; channel_id: Snowflake; guild_id: Snowflake | null }; // ban with message history deletion
  GUILD_AUDIT_LOG_ENTRY_CREATE: AuditLogEntry; // only to members with VIEW_AUDIT_LOG
  AUTO_MODERATION_RULE_CREATE: AutoModerationRule; // AUTO_MODERATION_RULE_*: only to members with MANAGE_GUILD
  AUTO_MODERATION_RULE_UPDATE: AutoModerationRule;
  AUTO_MODERATION_RULE_DELETE: AutoModerationRule;
  INVITE_CREATE: InviteMetadata; // to members who can list it: MANAGE_GUILD, or MANAGE_CHANNELS on the invite's channel
  INVITE_DELETE: { code: string; guild_id: Snowflake; channel_id: Snowflake }; // same audience; revoked (not on expiry or last use)
  GUILD_LAYOUT_UPDATE: GuildLayout; // the user's own sessions only
}

// ---- Applications, bots, slash commands, interactions, webhooks (docs/api.md "Apps") ----

// A bot application. The bot user's id equals the application id; its User has `bot: true`.
export interface Application {
  id: Snowflake;
  name: string; // 2-32 chars
  description: string; // max 400
  icon: string | null;
  owner_id: Snowflake;
  bot: User;
  bot_public: boolean; // false = only the owner can add the bot to a server
  install_params: { permissions: string }; // default permissions of the invite URL (decimal bitfield)
}
export type ApplicationWithToken = Application & { token: string }; // POST /applications only: the bot token, shown once
export interface CreateApplicationRequest {
  name: string;
  description?: string;
}
export interface EditApplicationRequest {
  name?: string;
  description?: string;
  icon_attachment_id?: Snowflake | null;
  bot_public?: boolean;
  install_params?: { permissions: string };
}
export interface BotTokenResponse {
  token: string; // POST /applications/{id}/bot/reset: the new token, the old one stops working (its gateway sessions close 4004)
}
// GET /oauth2/authorize?client_id&permissions&scope: what the "Add to server" page shows.
export interface OAuth2AuthorizeInfo {
  application: Application;
  bot: User;
  permissions: string; // requested bits (defaults to install_params.permissions)
  guilds: { id: Snowflake; name: string; icon: string | null; permissions: string }[]; // guilds where the caller has MANAGE_GUILD and the bot is not a member
}
export interface OAuth2AuthorizeRequest {
  guild_id: Snowflake;
  permissions?: string; // bits for the bot's role; only bits the caller has are kept
}
export interface OAuth2AuthorizeResponse {
  guild_id: Snowflake;
  role_id: Snowflake | null; // role created for the bot ("<bot name>"), null when no permissions were granted
}

export enum ApplicationCommandType {
  ChatInput = 1, // slash command
  User = 2, // user context menu (User > Apps)
  Message = 3, // message context menu (Message > Apps)
}
export enum ApplicationCommandOptionType {
  String = 3,
  Integer = 4,
  Boolean = 5,
  User = 6,
  Channel = 7,
  Role = 8,
  Number = 10,
}
export interface ApplicationCommandOptionChoice {
  name: string; // 1-100
  value: string | number; // string for String options, number for Integer/Number
}
export interface ApplicationCommandOption {
  type: ApplicationCommandOptionType;
  name: string; // 1-32, lowercase [-_a-z0-9] (unicode letters allowed)
  description: string; // 1-100
  required?: boolean; // required options come before optional ones
  choices?: ApplicationCommandOptionChoice[]; // max 25; String/Integer/Number only; not with autocomplete
  autocomplete?: boolean; // String/Integer/Number: the client asks the bot for choices while typing
  min_value?: number;
  max_value?: number;
  min_length?: number; // String: 0-6000
  max_length?: number; // String: 1-6000
  channel_types?: ChannelType[];
}
export interface ApplicationCommand {
  id: Snowflake;
  type: ApplicationCommandType;
  application_id: Snowflake;
  guild_id: Snowflake | null; // null = global command
  name: string; // ChatInput: 1-32 lowercase; User/Message: 1-32, any case, spaces allowed
  description: string; // ChatInput 1-100; "" for User/Message
  options?: ApplicationCommandOption[]; // ChatInput only, max 25
  default_member_permissions: string | null; // caller needs all these bits; null = everyone with USE_APPLICATION_COMMANDS
  dm_permission?: boolean; // global commands: usable in DMs with the bot (default true)
  version: Snowflake; // changes on every edit
}
// Body of POST/PUT/PATCH /applications/{id}/commands (and the guild variants). PATCH: every field optional.
export interface ApplicationCommandRequest {
  name: string;
  type?: ApplicationCommandType; // default ChatInput
  description?: string;
  options?: ApplicationCommandOption[];
  default_member_permissions?: string | null;
  dm_permission?: boolean;
}
// GET /channels/{id}/application-commands: what the caller may use in that channel.
export interface ApplicationCommandIndex {
  applications: { id: Snowflake; name: string; icon: string | null; bot_id: Snowflake }[];
  application_commands: ApplicationCommand[];
}

export enum InteractionType {
  Ping = 1,
  ApplicationCommand = 2,
  ApplicationCommandAutocomplete = 4,
}
export interface InteractionDataOption {
  name: string;
  type: ApplicationCommandOptionType;
  value: string | number | boolean; // user/channel/role options carry the id as a string
  focused?: boolean; // autocomplete: the option being typed
}
export interface InteractionResolved {
  users?: Record<Snowflake, User>;
  members?: Record<Snowflake, Pick<GuildMember, "nick" | "roles" | "joined_at">>;
  roles?: Record<Snowflake, Role>;
  channels?: Record<Snowflake, Pick<Channel, "id" | "type" | "name" | "parent_id">>;
  messages?: Record<Snowflake, Message>;
}
export interface InteractionData {
  id: Snowflake; // command id
  name: string;
  type: ApplicationCommandType;
  guild_id?: Snowflake; // guild commands
  options?: InteractionDataOption[];
  resolved?: InteractionResolved;
  target_id?: Snowflake; // User/Message commands: the user or message
}
// INTERACTION_CREATE (sent to the bot over its gateway).
export interface Interaction {
  id: Snowflake;
  application_id: Snowflake;
  type: InteractionType;
  data: InteractionData;
  guild_id: Snowflake | null;
  channel_id: Snowflake;
  member?: GuildMember; // guild: the invoking member
  user: User; // the invoking user
  token: string; // valid 15 minutes for callback + followups (the callback itself must come within 3 s)
  app_permissions: string; // the bot's permissions in the channel
  version: 1;
}
// POST /interactions (user auth): run a command. Answers 200 InteractionCreated; the result arrives as MESSAGE_CREATE,
// INTERACTION_FAILURE (bot did not answer in 3 s) or APPLICATION_COMMAND_AUTOCOMPLETE_RESPONSE.
export interface InvokeInteractionRequest {
  type: InteractionType.ApplicationCommand | InteractionType.ApplicationCommandAutocomplete;
  application_id: Snowflake;
  channel_id: Snowflake;
  data: { id: Snowflake; name: string; type: ApplicationCommandType; options?: InteractionDataOption[]; target_id?: Snowflake };
  nonce?: string; // echoed in INTERACTION_FAILURE / autocomplete responses
}
export interface InteractionCreated {
  id: Snowflake;
  nonce: string | null;
}
export enum InteractionCallbackType {
  ChannelMessageWithSource = 4,
  DeferredChannelMessageWithSource = 5, // shows "<bot> is thinking..." (message flags Loading) until @original is edited
  ApplicationCommandAutocompleteResult = 8,
}
export interface InteractionCallbackData {
  content?: string; // max 2000
  embeds?: Embed[]; // max 10
  flags?: number; // MessageFlags.Ephemeral only
  allowed_mentions?: AllowedMentions;
  choices?: ApplicationCommandOptionChoice[]; // type 8, max 25
}
export interface InteractionResponse {
  type: InteractionCallbackType;
  data?: InteractionCallbackData;
}
// Followups: POST /webhooks/{app_id}/{token}, PATCH /webhooks/{app_id}/{token}/messages/{@original|id}.
export interface WebhookMessageRequest {
  content?: string;
  embeds?: Embed[];
  flags?: number; // followups: MessageFlags.Ephemeral
  allowed_mentions?: AllowedMentions;
  username?: string; // execute only: override the webhook's name (1-80)
  avatar_url?: string; // execute only: override the avatar (http/https URL)
}
export interface MessageInteractionMetadata {
  id: Snowflake; // interaction id
  type: InteractionType;
  user: User; // who ran the command
  name: string; // command name, for the "used /name" line
  command_type: ApplicationCommandType;
  target_user?: User; // User commands
  target_message_id?: Snowflake; // Message commands
}

export enum WebhookType {
  Incoming = 1,
  ChannelFollower = 2,
  Application = 3,
}
export interface Webhook {
  id: Snowflake;
  type: WebhookType;
  guild_id: Snowflake | null;
  channel_id: Snowflake;
  name: string; // 1-80
  avatar: string | null;
  application_id: Snowflake | null;
  user?: User; // creator; MANAGE_WEBHOOKS views only
  token?: string; // Incoming, MANAGE_WEBHOOKS views only
  url?: string; // execute URL (absolute), when token is present
}
export interface CreateWebhookRequest {
  name: string;
  avatar_attachment_id?: Snowflake | null;
}
export interface EditWebhookRequest {
  name?: string;
  avatar_attachment_id?: Snowflake | null;
  channel_id?: Snowflake; // move to another channel of the same guild (MANAGE_WEBHOOKS there too)
}
// GET /guilds/{id}/integrations (MANAGE_GUILD): bots added to the server.
export interface GuildIntegration {
  id: Snowflake; // application id
  type: "bot";
  name: string;
  enabled: true;
  application: Pick<Application, "id" | "name" | "description" | "icon" | "bot">;
  user: User | null; // who added it
  role_id: Snowflake | null; // the bot's role
}

// ---- Reports (MOD-009) ----
export type ReportReason = "spam" | "harassment" | "hate" | "sexual" | "violence" | "self_harm" | "impersonation" | "other";
export type ReportStatus = "open" | "resolved" | "dismissed";
export const REPORT_DETAILS_MAX = 1000;
export interface CreateReportRequest {
  reason: ReportReason;
  details?: string | null; // trimmed server-side, at most REPORT_DETAILS_MAX, blank = null
}
export interface Report {
  id: Snowflake;
  guild_id: Snowflake | null; // null for a DM message
  target_type: "message" | "user";
  reporter: User;
  target_user: User;
  channel_id: Snowflake | null;
  message_id: Snowflake | null;
  message_content: string | null; // text when reported
  reason: ReportReason;
  details: string | null;
  status: ReportStatus;
  created_at: string;
  closed_by: Snowflake | null;
  closed_at: string | null;
}
