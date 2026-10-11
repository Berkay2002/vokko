// Domain operations on the mock database, shared by the REST router, the seed and the dev hooks.

import { ChannelType, MessageType, type Attachment, type PermissionOverwrite, type PresenceStatus, type Role, type User } from "../types";
import { ApiRequestError } from "../errors";
import { hasBit } from "../permissions";
import { canView, channelPermsOf, guildPermsOf } from "./access";
import { db, everyoneRole, nextId, sortedMessages, userOf, type MockAccount, type MockChannel, type MockMessage } from "./db";
import { emit } from "./socket";
import { channelFor, messageFor } from "./views";

export const MISSING_PERMISSIONS = "Missing Permissions";

export function fail(status: number, code: number, message: string, errors?: Record<string, unknown>): never {
  throw new ApiRequestError(status, { code, message, errors });
}

export function createAccount(init: { id?: string; username: string; global_name?: string | null; email?: string; password?: string; status?: PresenceStatus; custom_status?: string | null; banner_color?: string | null; bio?: string | null }): MockAccount {
  const id = init.id ?? nextId();
  const user: User = {
    id,
    username: init.username,
    global_name: init.global_name ?? null,
    avatar: null,
    banner_color: init.banner_color ?? null,
    bio: init.bio ?? null,
    bot: false,
  };
  const account: MockAccount = {
    user,
    email: init.email ?? `${init.username}@vokko.local`,
    password: init.password ?? "vokko-dev",
    presence: { user_id: id, status: init.status ?? "offline", custom_status: init.custom_status ?? null },
    relationships: new Map(),
    readStates: new Map(),
  };
  db.accounts.set(id, account);
  return account;
}

export function guildAudience(guildId: string): string[] {
  return [...(db.guilds.get(guildId)?.members.keys() ?? [])];
}

/** Everyone who may see the channel (guild channels: members whose resolved permissions include VIEW_CHANNEL). */
export function channelAudience(channel: MockChannel): string[] {
  if (channel.guild_id) return guildAudience(channel.guild_id).filter(id => canView(channel, id));
  return channel.participant_ids ?? [];
}

export function canAccess(channel: MockChannel, viewerId: string): boolean {
  if (channel.guild_id) return canView(channel, viewerId);
  return channel.participant_ids?.includes(viewerId) ?? false;
}

export function requireGuildMember(guildId: string, viewerId: string) {
  const guild = db.guilds.get(guildId);
  if (!guild) fail(404, 10004, "Unknown Guild");
  if (!guild.members.has(viewerId)) fail(403, 50001, "Missing Access");
  return guild;
}

/** Guild member holding every bit of `permission` (guild level, timeout mask applied), else 403 50013. */
export function requireGuildPerm(guildId: string, viewerId: string, permission: bigint) {
  const guild = requireGuildMember(guildId, viewerId);
  if (!hasBit(guildPermsOf(guildId, viewerId), permission)) fail(403, 50013, MISSING_PERMISSIONS);
  return guild;
}

/** Channel-level check for a channel the viewer can already see. DMs always pass. */
export function requireChannelPerm(channel: MockChannel, viewerId: string, permission: bigint, code = 50013, message = MISSING_PERMISSIONS): void {
  if (!hasBit(channelPermsOf(channel, viewerId), permission)) fail(403, code, message);
}

/** channel id -> users who can see it, for every channel of the guild. */
export function visibilityOf(guildId: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const channel of db.channels.values()) if (channel.guild_id === guildId) out.set(channel.id, new Set(channelAudience(channel)));
  return out;
}

/**
 * Diff channel visibility against a snapshot taken before a permission change: CHANNEL_CREATE to members who gained a
 * channel, CHANNEL_DELETE to those who lost it, CHANNEL_UPDATE (only for ids in `updated`) to everyone who kept it.
 */
export function emitVisibilityChanges(guildId: string, before: Map<string, Set<string>>, updated: Iterable<string> = []): void {
  const touched = new Set(updated);
  const after = visibilityOf(guildId);
  for (const [channelId, now] of after) {
    const channel = db.channels.get(channelId);
    if (!channel) continue;
    const was = before.get(channelId) ?? new Set<string>();
    for (const id of now) {
      if (!was.has(id)) emit([id], "CHANNEL_CREATE", channelFor(channel, id));
      else if (touched.has(channelId)) emit([id], "CHANNEL_UPDATE", channelFor(channel, id));
    }
    for (const id of was) if (!now.has(id) && db.guilds.get(guildId)?.members.has(id)) emit([id], "CHANNEL_DELETE", channelFor(channel, id));
  }
}

/** Same set of (id, type, allow, deny), order ignored ("synced" with a category). */
export function sameOverwrites(a: PermissionOverwrite[] | undefined, b: PermissionOverwrite[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  return left.every(o => right.some(p => p.id === o.id && p.type === o.type && p.allow === o.allow && p.deny === o.deny));
}

/** After a category's overwrites changed from `previous`: children that were synced follow it. Returns their ids. */
export function syncCategoryChildren(category: MockChannel, previous: PermissionOverwrite[]): string[] {
  const synced: string[] = [];
  for (const child of db.channels.values()) {
    if (child.guild_id !== category.guild_id || child.parent_id !== category.id) continue;
    if (!sameOverwrites(child.permission_overwrites, previous)) continue;
    child.permission_overwrites = (category.permission_overwrites ?? []).map(o => ({ ...o }));
    synced.push(child.id);
  }
  return synced;
}

export function requireChannel(channelId: string, viewerId: string): MockChannel {
  const channel = db.channels.get(channelId);
  if (!channel) fail(404, 10003, "Unknown Channel");
  if (!canAccess(channel, viewerId)) fail(403, 50001, "Missing Access");
  return channel;
}

export function requireMessage(channelId: string, messageId: string): MockMessage {
  const message = sortedMessages(channelId).find(m => m.id === messageId);
  if (!message) fail(404, 10008, "Unknown Message");
  return message;
}

export function createGuildRecord(ownerId: string, name: string, iconUrl: string | null = null, id: string = nextId()): string {
  const roles: Role[] = [everyoneRole(id)];
  const text = nextId();
  const voice = nextId();
  const general = nextId();
  const generalVoice = nextId();
  db.guilds.set(id, {
    guild: { id, name, icon: iconUrl, owner_id: ownerId, roles, system_channel_id: general },
    members: new Map([[ownerId, { nick: null, roles: [], joined_at: new Date().toISOString() }]]),
  });
  const base = { guild_id: id, topic: null, last_message_id: null };
  const add = (ch: MockChannel) => db.channels.set(ch.id, ch);
  add({ ...base, id: text, type: ChannelType.GuildCategory, name: "Text Channels", position: 0, parent_id: null });
  add({ ...base, id: voice, type: ChannelType.GuildCategory, name: "Voice Channels", position: 1, parent_id: null });
  add({ ...base, id: general, type: ChannelType.GuildText, name: "general", position: 0, parent_id: text });
  add({ ...base, id: generalVoice, type: ChannelType.GuildVoice, name: "General", position: 0, parent_id: voice });
  return id;
}

export function addChannel(guildId: string, init: { name: string; type: ChannelType; parent_id?: string | null; topic?: string | null; id?: string; permission_overwrites?: PermissionOverwrite[] }): MockChannel {
  const siblings = [...db.channels.values()].filter(c => c.guild_id === guildId && c.parent_id === (init.parent_id ?? null) && c.type === init.type);
  const channel: MockChannel = {
    id: init.id ?? nextId(),
    type: init.type,
    guild_id: guildId,
    name: init.name,
    topic: init.topic ?? null,
    position: siblings.length,
    parent_id: init.parent_id ?? null,
    last_message_id: null,
    permission_overwrites: (init.permission_overwrites ?? (init.parent_id ? db.channels.get(init.parent_id)?.permission_overwrites : undefined) ?? []).map(o => ({ ...o })),
  };
  db.channels.set(channel.id, channel);
  return channel;
}

/** Existing 1:1 DM between exactly these two users, or a new one. Emits CHANNEL_CREATE to `viewerId` when un-hiding/creating. */
export function openDM(viewerId: string, otherId: string): MockChannel {
  let channel = [...db.channels.values()].find(c => c.type === ChannelType.DM && c.participant_ids?.length === 2 && c.participant_ids.includes(viewerId) && c.participant_ids.includes(otherId));
  if (channel) {
    if (channel.hidden_for?.delete(viewerId)) emit([viewerId], "CHANNEL_CREATE", channelFor(channel, viewerId));
    return channel;
  }
  channel = { id: nextId(), type: ChannelType.DM, guild_id: null, name: null, topic: null, position: 0, parent_id: null, last_message_id: null, participant_ids: [viewerId, otherId], hidden_for: new Set() };
  db.channels.set(channel.id, channel);
  emit([viewerId], "CHANNEL_CREATE", channelFor(channel, viewerId));
  return channel;
}

export function openGroupDM(viewerId: string, otherIds: string[]): MockChannel {
  const participants = [viewerId, ...otherIds.filter((id, i) => id !== viewerId && otherIds.indexOf(id) === i)];
  const channel: MockChannel = { id: nextId(), type: ChannelType.GroupDM, guild_id: null, name: null, topic: null, position: 0, parent_id: null, last_message_id: null, participant_ids: participants, owner_id: viewerId, icon: null, hidden_for: new Set() };
  db.channels.set(channel.id, channel);
  for (const id of participants) emit([id], "CHANNEL_CREATE", channelFor(channel, id));
  return channel;
}

export interface NewMessage {
  channel: MockChannel;
  author_id: string;
  content: string;
  type?: MessageType;
  attachments?: Attachment[];
  reference_id?: string | null;
  nonce?: string | null;
  timestamp?: number;
  /** Seed mode: don't emit events. */
  silent?: boolean;
  /** False: the author lacks MENTION_EVERYONE, so @everyone/@here is kept as text but does not ping. Default true. */
  allowEveryone?: boolean;
}

function parseMentions(content: string, referenceAuthor: string | null): { ids: string[]; everyone: boolean } {
  const ids = new Set<string>();
  for (const match of content.matchAll(/<@!?(\d+)>/g)) if (match[1] && db.accounts.has(match[1])) ids.add(match[1]);
  if (referenceAuthor) ids.add(referenceAuthor);
  return { ids: [...ids], everyone: /(^|\s)@(everyone|here)\b/.test(content) };
}

/** Append a message, advance read states like the server does, and fan the event out. */
export function addMessage(input: NewMessage): MockMessage {
  const { channel } = input;
  const referenced = input.reference_id ? sortedMessages(channel.id).find(m => m.id === input.reference_id) : undefined;
  const mentions = parseMentions(input.content, referenced?.author_id ?? null);
  if (input.allowEveryone === false) mentions.everyone = false;
  const ms = input.timestamp ?? Date.now();
  const message: MockMessage = {
    id: nextId(ms),
    channel_id: channel.id,
    guild_id: channel.guild_id,
    author_id: input.author_id,
    content: input.content,
    timestamp: new Date(ms).toISOString(),
    edited_timestamp: null,
    type: input.type ?? (referenced ? MessageType.Reply : MessageType.Default),
    mention_ids: mentions.ids,
    mention_everyone: mentions.everyone,
    attachments: input.attachments ?? [],
    reactions: [],
    pinned: false,
    pinned_at: null,
    reference_id: referenced ? referenced.id : (input.reference_id ?? null),
    nonce: input.nonce ?? null,
  };
  const list = sortedMessages(channel.id);
  const previousLast = list.at(-1)?.id ?? null;
  list.push(message);
  channel.last_message_id = message.id;
  const audience = channelAudience(channel);
  for (const userId of audience) {
    const account = db.accounts.get(userId);
    if (!account) continue;
    const state = account.readStates.get(channel.id) ?? { channel_id: channel.id, last_message_id: previousLast, mention_count: 0 };
    if (userId === input.author_id) {
      state.last_message_id = message.id;
      state.mention_count = 0;
    } else if (mentions.ids.includes(userId) || mentions.everyone) {
      state.mention_count += 1;
    }
    account.readStates.set(channel.id, state);
  }
  if (!input.silent) {
    if (!channel.guild_id) {
      for (const id of audience) {
        if (channel.hidden_for?.delete(id)) emit([id], "CHANNEL_CREATE", channelFor(channel, id));
      }
    }
    for (const id of audience) emit([id], "MESSAGE_CREATE", messageFor(message, id));
  }
  return message;
}
