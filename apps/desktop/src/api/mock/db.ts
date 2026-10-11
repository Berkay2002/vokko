// In-memory backend state shared by the mock REST router and the mock gateway socket.

import { DEFAULT_EVERYONE } from "../permissions";
import { timestampToSnowflake } from "../snowflake";
import type { Attachment, Channel, Embed, Gif, GifProvider, Guild, GuildMember, Message, MessageInteractionMetadata, MessageSnapshot, MessageType, Presence, ReadState, Relationship, RelationshipType, Reminder, Role, Sticker, StickerItem, User, GuildLayout } from "../types";

export interface MockAccount {
  user: User;
  email: string;
  password: string;
  presence: Presence;
  /** other user id → relationship type from this user's point of view */
  relationships: Map<string, RelationshipType>;
  readStates: Map<string, ReadState>;
  /** GET/PATCH /users/@me/guild-layout; absent = defaults. */
  guildLayout?: GuildLayout;
}

export interface MockChannel extends Channel {
  /** DM / group DM participants (including the viewer). */
  participant_ids?: string[];
  /** Users who closed this DM; it comes back on the next message. */
  hidden_for?: Set<string>;
  /** Threads: joined members (user id → join timestamp). */
  thread_members?: Map<string, string>;
}

export interface MockReaction {
  emoji: { id: string | null; name: string };
  user_ids: string[];
}

export interface MockMessage {
  id: string;
  channel_id: string;
  guild_id: string | null;
  author_id: string;
  content: string;
  timestamp: string;
  edited_timestamp: string | null;
  type: MessageType;
  mention_ids: string[];
  mention_everyone: boolean;
  attachments: Attachment[];
  reactions: MockReaction[];
  pinned: boolean;
  /** ISO time of the (latest) pin; null while unpinned. */
  pinned_at: string | null;
  reference_id: string | null;
  /** Channel of `reference_id` when it is not this one (thread starters, published copies, thread-created notices). */
  reference_channel_id?: string | null;
  /** MessageFlags; absent = 0. */
  flags?: number;
  nonce: string | null;
  /** Webhook and interaction messages (mock/apps.ts): identity shown instead of the author's profile, embeds, command metadata. */
  webhook_id?: string;
  application_id?: string;
  interaction_metadata?: MessageInteractionMetadata;
  author_name?: string;
  author_avatar?: string | null;
  /** Sticker copies (they outlive the sticker). */
  stickers?: StickerItem[];
  /** Link unfurls (only generated for mock GIF links). */
  embeds?: Embed[];
  /** Forward (message_reference.type 1): the source ids and the frozen copy. */
  forward?: { message_id: string; channel_id: string; guild_id: string | null; snapshot: MessageSnapshot };
}

export interface MockReminder extends Omit<Reminder, "message"> {
  owner_id: string;
}

export interface MockGuild {
  guild: Guild;
  /** Members who joined through a temporary invite (docs/api.md "Invites"); the mock keeps the flag but never removes them. */
  temporary?: Set<string>;
  members: Map<string, Pick<GuildMember, "nick" | "roles" | "joined_at" | "communication_disabled_until" | "avatar" | "banner" | "bio" | "pronouns" | "theme_colors">>;
}

export interface MockInvite {
  code: string;
  guild_id: string;
  channel_id: string;
  expires_at: string | null;
  /** Absent on seeded invites: the guild owner, 0 uses, no limits, created at seed time. */
  inviter_id?: string;
  uses?: number;
  max_uses?: number;
  max_age?: number;
  temporary?: boolean;
  created_at?: string;
}

/** An announcement channel followed into another channel (`id` is the follow, the API's webhook id). */
export interface MockFollower {
  id: string;
  source_channel_id: string;
  target_channel_id: string;
  created_by: string;
}

export interface Db {
  accounts: Map<string, MockAccount>;
  channels: Map<string, MockChannel>;
  messages: Map<string, MockMessage[]>;
  guilds: Map<string, MockGuild>;
  invites: Map<string, MockInvite>;
  /** guild id → banned user id → reason */
  bans: Map<string, Map<string, string | null>>;
  pending: Map<string, { attachment: Attachment; owner: string }>;
  followers: Map<string, MockFollower>;
  /** guild id -> stickers, oldest first */
  stickers: Map<string, Sticker[]>;
  /** user id -> favourite GIFs, newest first */
  gifFavorites: Map<string, Gif[]>;
  /** user id -> "channel:message" -> saved_at ISO */
  bookmarks: Map<string, Map<string, string>>;
  /** reminder id -> reminder */
  reminders: Map<string, MockReminder>;
  /** What GET /gifs/* answers with; "none" = no provider configured. */
  gifProvider: GifProvider;
}

export const db: Db = {
  accounts: new Map(),
  channels: new Map(),
  messages: new Map(),
  guilds: new Map(),
  invites: new Map(),
  bans: new Map(),
  pending: new Map(),
  followers: new Map(),
  stickers: new Map(),
  gifFavorites: new Map(),
  bookmarks: new Map(),
  reminders: new Map(),
  gifProvider: "klipy",
};

let lastNow = 0;
let inc = 0;
let pastSeq = 0;
/** Unique, ascending snowflake. With an explicit past timestamp (seeding) the increment bits keep ids unique and ordered. */
export function nextId(ms?: number): string {
  if (ms !== undefined && ms < Date.now() - 1000) {
    pastSeq = (pastSeq + 1) & 0xfff;
    return timestampToSnowflake(ms, pastSeq);
  }
  const now = Math.max(ms ?? Date.now(), lastNow);
  inc = now === lastNow ? inc + 1 : 0;
  lastNow = now;
  return timestampToSnowflake(now, inc & 0xfff);
}

export function everyoneRole(guildId: string): Role {
  return { id: guildId, name: "@everyone", color: 0, hoist: false, position: 0, permissions: DEFAULT_EVERYONE.toString(), mentionable: false };
}

export function userOf(id: string): User {
  const account = db.accounts.get(id);
  if (!account) throw new Error(`unknown mock user ${id}`);
  return account.user;
}

export function sortedMessages(channelId: string): MockMessage[] {
  let list = db.messages.get(channelId);
  if (!list) db.messages.set(channelId, (list = []));
  return list;
}
