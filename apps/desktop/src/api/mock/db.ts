// In-memory backend state shared by the mock REST router and the mock gateway socket.

import { timestampToSnowflake } from "../snowflake";
import type { Attachment, Channel, Guild, GuildMember, Message, MessageType, Presence, ReadState, Relationship, RelationshipType, Role, User } from "../types";

export interface MockAccount {
  user: User;
  email: string;
  password: string;
  presence: Presence;
  /** other user id → relationship type from this user's point of view */
  relationships: Map<string, RelationshipType>;
  readStates: Map<string, ReadState>;
}

export interface MockChannel extends Channel {
  /** DM / group DM participants (including the viewer). */
  participant_ids?: string[];
  /** Users who closed this DM; it comes back on the next message. */
  hidden_for?: Set<string>;
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
  reference_id: string | null;
  nonce: string | null;
}

export interface MockGuild {
  guild: Guild;
  members: Map<string, Pick<GuildMember, "nick" | "roles" | "joined_at">>;
}

export interface MockInvite {
  code: string;
  guild_id: string;
  channel_id: string;
  expires_at: string | null;
}

export interface Db {
  accounts: Map<string, MockAccount>;
  channels: Map<string, MockChannel>;
  messages: Map<string, MockMessage[]>;
  guilds: Map<string, MockGuild>;
  invites: Map<string, MockInvite>;
  pending: Map<string, { attachment: Attachment; owner: string }>;
}

export const db: Db = {
  accounts: new Map(),
  channels: new Map(),
  messages: new Map(),
  guilds: new Map(),
  invites: new Map(),
  pending: new Map(),
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
  return { id: guildId, name: "@everyone", color: 0, hoist: false, position: 0, permissions: "1071698660929", mentionable: false };
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
