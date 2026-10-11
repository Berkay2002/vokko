// Per-viewer JSON builders: the mock stores neutral rows and renders them like the server would.

import { RelationshipType, type Channel, type GatewayEvents, type GuildMember, type Message, type Reaction, type ReadyEvent, type Relationship } from "../types";
import { compareIds } from "../snowflake";
import { db, sortedMessages, userOf, type MockChannel, type MockMessage } from "./db";

export function messageFor(m: MockMessage, viewerId: string, depth = 0): Message {
  const guild = m.guild_id ? db.guilds.get(m.guild_id) : undefined;
  const member = guild?.members.get(m.author_id);
  const reference = m.reference_id ? sortedMessages(m.channel_id).find(x => x.id === m.reference_id) : undefined;
  const reactions: Reaction[] = m.reactions
    .filter(r => r.user_ids.length > 0)
    .map(r => ({ emoji: { ...r.emoji }, count: r.user_ids.length, me: r.user_ids.includes(viewerId) }));
  return {
    id: m.id,
    channel_id: m.channel_id,
    guild_id: m.guild_id,
    author: userOf(m.author_id),
    member: member ? { nick: member.nick, roles: [...member.roles] } : undefined,
    content: m.content,
    timestamp: m.timestamp,
    edited_timestamp: m.edited_timestamp,
    type: m.type,
    mentions: m.mention_ids.map(userOf),
    mention_everyone: m.mention_everyone,
    attachments: m.attachments.map(a => ({ ...a })),
    reactions,
    pinned: m.pinned,
    message_reference: m.reference_id ? { message_id: m.reference_id, channel_id: m.channel_id, guild_id: m.guild_id } : null,
    referenced_message: reference && depth === 0 ? messageFor(reference, viewerId, 1) : null,
    nonce: m.nonce,
  };
}

export function channelFor(ch: MockChannel, viewerId: string): Channel {
  const { participant_ids, hidden_for, ...rest } = ch;
  void hidden_for;
  const last = sortedMessages(ch.id).at(-1);
  const out: Channel = { ...rest, last_message_id: last?.id ?? null };
  if (participant_ids) out.recipients = participant_ids.filter(id => id !== viewerId).map(userOf);
  return out;
}

export function privateChannelsFor(viewerId: string): Channel[] {
  return [...db.channels.values()]
    .filter(c => c.participant_ids?.includes(viewerId) && !c.hidden_for?.has(viewerId))
    .map(c => channelFor(c, viewerId))
    .sort((a, b) => compareIds(b.last_message_id ?? b.id, a.last_message_id ?? a.id));
}

export function membersOf(guildId: string): (GuildMember & { guild_id?: never })[] {
  const g = db.guilds.get(guildId);
  if (!g) return [];
  return [...g.members.entries()].map(([id, m]) => ({ user: userOf(id), nick: m.nick, roles: [...m.roles], joined_at: m.joined_at }));
}

export function guildPayload(guildId: string, viewerId: string): GatewayEvents["GUILD_CREATE"] {
  const g = db.guilds.get(guildId);
  if (!g) throw new Error("unknown guild");
  const channels = [...db.channels.values()].filter(c => c.guild_id === guildId).map(c => channelFor(c, viewerId));
  const members = membersOf(guildId);
  return { ...g.guild, roles: g.guild.roles.map(r => ({ ...r })), channels, members, member_count: members.length };
}

export function guildIdsFor(viewerId: string): string[] {
  return [...db.guilds.values()].filter(g => g.members.has(viewerId)).map(g => g.guild.id);
}

export function relationshipsFor(viewerId: string): Relationship[] {
  const account = db.accounts.get(viewerId);
  if (!account) return [];
  return [...account.relationships.entries()].map(([id, type]) => ({ id, type, user: userOf(id) }));
}

export function relationship(viewerId: string, otherId: string): Relationship | null {
  const type = db.accounts.get(viewerId)?.relationships.get(otherId);
  return type === undefined ? null : { id: otherId, type, user: userOf(otherId) };
}

export function setRelationship(a: string, b: string, aSees: RelationshipType | null, bSees: RelationshipType | null): void {
  const set = (viewer: string, other: string, type: RelationshipType | null) => {
    const map = db.accounts.get(viewer)?.relationships;
    if (!map) return;
    if (type === null) map.delete(other);
    else map.set(other, type);
  };
  set(a, b, aSees);
  set(b, a, bSees);
}

export function readyFor(viewerId: string, sessionId: string): ReadyEvent {
  const account = db.accounts.get(viewerId);
  if (!account) throw new Error("unknown viewer");
  const guilds = guildIdsFor(viewerId).map(id => guildPayload(id, viewerId));
  const presences = [...db.accounts.values()].map(a => ({ ...a.presence }));
  return {
    v: 1,
    user: account.user,
    session_id: sessionId,
    guilds,
    private_channels: privateChannelsFor(viewerId),
    presences,
    read_states: [...account.readStates.values()],
    relationships: relationshipsFor(viewerId).filter(r => r.type !== RelationshipType.Blocked || true),
  };
}
