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
}
export interface UserPrimaryGuild {
  guild_id: Snowflake;
  tag: string; // 1-4 chars
  badge: string; // badge id (Vokko asset set)
  color_primary: number;
  color_secondary: number;
}

export interface Presence {
  user_id: Snowflake;
  status: PresenceStatus;
  custom_status: string | null;
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
  GuildStage = 13, // type stub until voice exists: can be created and listed, has no stage behaviour
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
  flags: number; // 0
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
  // Per-server profile (overrides the user profile inside this guild). Absent/null = use the user's.
  avatar?: string | null;
  banner?: string | null;
  bio?: string | null;
  pronouns?: string | null;
  theme_colors?: [number, number] | null;
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
  type: "rich" | "link" | "image" | "video" | "article" | "gifv";
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
  id: Snowflake | null; // custom emoji id (null for unicode)
  name: string; // unicode character(s) or custom name
}

export interface Reaction {
  emoji: ReactionEmoji;
  count: number;
  me: boolean;
}

export enum MessageType {
  Default = 0,
  RecipientAdd = 1,
  RecipientRemove = 2,
  ChannelNameChange = 4,
  ChannelPinnedMessage = 6,
  UserJoin = 7,
  ThreadCreated = 18, // in the parent when a thread is started without a message; content = thread name, message_reference.channel_id = thread id
  Reply = 19,
  ThreadStarterMessage = 21, // first message of a thread started from a message; message_reference points at the original, referenced_message is filled
}
export enum MessageFlags {
  Crossposted = 1 << 0, // announcement message published to followers
  IsCrosspost = 1 << 1, // copy delivered by a follow; message_reference points at the source message
  SuppressEmbeds = 1 << 2,
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
  message_reference: MessageReference | null;
  referenced_message: Message | null; // for replies; null if deleted
  nonce: string | null; // echoed from the send request for optimistic UI
  flags?: number; // MessageFlags; absent = 0
  thread?: Channel; // present when a thread was started from this message (thread.id == message id)
  sticker_items?: StickerItem[]; // absent = none
  message_snapshots?: MessageSnapshot[]; // exactly one on a forward (message_reference.type 1)
}

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

// ---- REST payloads ----

export interface AuthRequest {
  login: string; // username or email
  password: string;
}
export interface RegisterRequest {
  email: string;
  username: string;
  global_name?: string;
  password: string;
}
export interface AuthResponse {
  token: string;
  user: User;
}

export interface CreateMessageRequest {
  content?: string;
  nonce?: string;
  message_reference?: { message_id: Snowflake; channel_id?: Snowflake; type?: MessageReferenceType }; // type 1 (forward) needs channel_id, no content/attachments/stickers
  sticker_ids?: Snowflake[]; // max 3; content may then be empty
  attachment_ids?: Snowflake[]; // ids returned by POST /channels/{id}/attachments; max 10 per message
  attachments?: PendingAttachmentMeta[]; // same ids with optional rename / alt text; use instead of attachment_ids
  allowed_mentions?: AllowedMentions; // omitted = parse everything, replied_user true
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

export interface EditUserRequest {
  global_name?: string | null;
  bio?: string | null;
  banner_color?: string | null;
  avatar_attachment_id?: Snowflake | null; // PNG/JPEG/WebP/GIF (animated allowed), ≤8 MiB in, stored as 512x512
  banner_attachment_id?: Snowflake | null; // ≤10 MiB in, ≤1360x480 out
  pronouns?: string | null;
  theme_colors?: [number, number] | null;
  avatar_decoration?: string | null;
  profile_effect?: string | null;
  primary_guild_id?: Snowflake | null; // adopt that guild's tag (must be a member and the guild must have a tag); null clears
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
}
export interface RoleRequest {
  name?: string;
  color?: number;
  hoist?: boolean;
  permissions?: string;
  mentionable?: boolean;
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
  // voice_states: always sent by the server (optional here so fixtures without voice stay valid); threads = active threads the user can see (not in channels)
  guilds: (Guild & { channels: Channel[]; members: GuildMember[]; member_count: number; stickers?: Sticker[]; voice_states?: VoiceState[]; threads?: Channel[] })[];
  private_channels: Channel[]; // DMs and group DMs
  presences: Presence[];
  read_states: ReadState[];
  relationships: Relationship[];
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
  MESSAGE_REACTION_ADD: { user_id: Snowflake; channel_id: Snowflake; message_id: Snowflake; emoji: ReactionEmoji };
  MESSAGE_REACTION_REMOVE: { user_id: Snowflake; channel_id: Snowflake; message_id: Snowflake; emoji: ReactionEmoji };
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
  GUILD_ROLE_CREATE: { guild_id: Snowflake; role: Role };
  GUILD_ROLE_UPDATE: { guild_id: Snowflake; role: Role };
  GUILD_ROLE_DELETE: { guild_id: Snowflake; role_id: Snowflake };
  RESUMED: Record<string, never>; // after a successful op 6 replay
  PRESENCE_UPDATE: Presence;
  USER_UPDATE: User; // profile/avatar change; sent to the user and everyone sharing a guild, DM or relationship with them
  MESSAGE_ACK: { channel_id: Snowflake; message_id: Snowflake };
  RELATIONSHIP_ADD: Relationship;
  RELATIONSHIP_REMOVE: { id: Snowflake };
  GUILD_STICKERS_UPDATE: { guild_id: Snowflake; stickers: Sticker[] }; // full list after a create/edit/delete
  BOOKMARK_ADD: Bookmark; // to the owner's sessions only
  BOOKMARK_REMOVE: { channel_id: Snowflake; message_id: Snowflake };
  REMINDER_CREATE: Reminder;
  REMINDER_DUE: Reminder; // delivered_at set; the "notice from the instance"
  REMINDER_DELETE: { id: Snowflake };
  VOICE_STATE_UPDATE: VoiceState; // to everyone who can see the channel
  VOICE_SERVER_UPDATE: { guild_id: Snowflake | null; channel_id: Snowflake; endpoint: string; token: string; session_id: string }; // requesting session only; session_id = the VoiceState.session_id this token is for
  VOICE_CONNECT_FAILED: { guild_id: Snowflake | null; channel_id: Snowflake; reason: VoiceConnectFailure }; // Vokko-only, requesting session only
  VOICE_CHANNEL_STATUS_UPDATE: { id: Snowflake; guild_id: Snowflake; status: string | null }; // to viewers of the channel; cleared (null) when the channel empties
  THREAD_CREATE: Channel; // newly_created: true for a fresh thread; also sent when the user gains access to a private thread
  THREAD_UPDATE: Channel; // archive/lock/rename/tags/pin changes, auto-archive
  THREAD_DELETE: { id: Snowflake; guild_id: Snowflake; parent_id: Snowflake; type: ChannelType };
  THREAD_MEMBER_UPDATE: ThreadMember & { guild_id: Snowflake }; // the current user joined a thread
  THREAD_MEMBERS_UPDATE: { id: Snowflake; guild_id: Snowflake; member_count: number; added_members?: ThreadMember[]; removed_member_ids?: Snowflake[] };
}
