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
  Reply = 19,
}

export interface MessageReference {
  message_id: Snowflake;
  channel_id: Snowflake;
  guild_id: Snowflake | null;
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
}

export interface ReadState {
  channel_id: Snowflake;
  last_message_id: Snowflake | null; // last message the user has read
  mention_count: number;
}

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
  message_reference?: { message_id: Snowflake };
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
  guilds: (Guild & { channels: Channel[]; members: GuildMember[]; member_count: number })[];
  private_channels: Channel[]; // DMs and group DMs
  presences: Presence[];
  read_states: ReadState[];
  relationships: Relationship[];
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
}
