// Per-viewer JSON builders: the mock stores neutral rows and renders them like the server would.

import { ChannelType, MessageReferenceType, MessageType, RelationshipType, isThreadType, type Channel, type GatewayEvents, type GuildMember, type Message, type MessageSnapshot, type Reaction, type ReadState, type ReadyEvent, type Relationship, type ThreadMember } from "../types";
import { compareIds } from "../snowflake";
import { MAX_UPLOAD_BYTES } from "../limits";
import { canView } from "./access";
import { db, sortedMessages, userOf, type MockAccount, type MockChannel, type MockMessage } from "./db";
import { flagsField } from "./memberFlags";
import { memberProfileFields } from "./perks";
import { guildEmojis } from "./emojis";
import { pollEmbedsFor, pollFor } from "./pollData";
import { stageInstancesFor, voiceStatesFor } from "./voice";
import { watchFor } from "./watch";
import { stremioFor } from "./stremio";
import { spotifyFor } from "./spotify";
import { gamesFor } from "./games";
import { guildSettingsFor } from "./guildSettings";

export function messageFor(m: MockMessage, viewerId: string, depth = 0): Message {
  const guild = m.guild_id ? db.guilds.get(m.guild_id) : undefined;
  const member = guild?.members.get(m.author_id);
  // Thread starters and published copies point at a message in another channel.
  const refChannelId = m.reference_channel_id ?? m.channel_id;
  const reference = m.reference_id ? sortedMessages(refChannelId).find(x => x.id === m.reference_id) : undefined;
  // A thread started from this message (thread.id == message id) rides along for the viewers who can see it.
  const thread = depth === 0 ? db.channels.get(m.id) : undefined;
  const startedThread = thread && isThreadType(thread.type) && thread.parent_id === m.channel_id && canView(thread, viewerId) ? channelFor(thread, viewerId) : undefined;
  const poll = pollFor(m.id, viewerId);
  const reactions: Reaction[] = m.reactions
    .filter(r => r.user_ids.length + (r.burst_ids?.length ?? 0) > 0)
    .map(r => {
      const burst = r.burst_ids ?? [];
      return {
        emoji: { ...r.emoji },
        count: r.user_ids.length + burst.length,
        count_details: { normal: r.user_ids.length, burst: burst.length },
        burst_colors: [],
        me: r.user_ids.includes(viewerId),
        me_burst: burst.includes(viewerId),
      };
    });
  return {
    id: m.id,
    channel_id: m.channel_id,
    guild_id: m.guild_id,
    author: m.author_name !== undefined ? { ...userOf(m.author_id), username: m.author_name, global_name: null, avatar: m.author_avatar ?? null } : userOf(m.author_id),
    member: member && m.author_name === undefined ? { nick: member.nick, roles: [...member.roles] } : undefined,
    content: m.content,
    timestamp: m.timestamp,
    edited_timestamp: m.edited_timestamp,
    type: m.type,
    mentions: m.mention_ids.map(userOf),
    mention_roles: [...(m.mention_role_ids ?? [])],
    mention_everyone: m.mention_everyone,
    attachments: m.attachments.map(a => ({ ...a })),
    embeds: [...(m.embeds ?? []).map(e => ({ ...e })), ...pollEmbedsFor(m.id)],
    reactions,
    pinned: m.pinned,
    tts: m.tts === true,
    message_reference: m.forward
      ? { type: MessageReferenceType.Forward, message_id: m.forward.message_id, channel_id: m.forward.channel_id, guild_id: m.forward.guild_id }
      : m.reference_id ? { message_id: m.reference_id, channel_id: refChannelId, guild_id: db.channels.get(refChannelId)?.guild_id ?? m.guild_id } : null,
    referenced_message: reference && depth === 0 && m.type !== MessageType.ThreadCreated ? messageFor(reference, viewerId, 1) : null,
    nonce: m.nonce,
    ...(m.flags ? { flags: m.flags } : {}),
    ...(startedThread ? { thread: startedThread } : {}),
    ...(poll ? { poll } : {}),
    ...(m.stickers?.length ? { sticker_items: m.stickers.map(s => ({ ...s })) } : {}),
    ...(m.call ? { call: { participants: [...m.call.participants], ended_timestamp: m.call.ended_timestamp } } : {}),
    ...(m.forward ? { message_snapshots: [JSON.parse(JSON.stringify(m.forward.snapshot)) as MessageSnapshot] } : {}),
    ...(m.webhook_id ? { webhook_id: m.webhook_id } : {}),
    ...(m.application_id ? { application_id: m.application_id } : {}),
    ...(m.interaction_metadata ? { interaction_metadata: m.interaction_metadata } : {}),
  };
}

/** Message count of a thread: everything after the starter (the type 21 pointer, or a forum post's first message). */
function threadMessageCount(thread: MockChannel): number {
  return sortedMessages(thread.id).filter(m => m.id !== thread.id && m.type !== MessageType.ThreadStarterMessage).length;
}

/** The user's membership of a thread with their notification settings; an ended timed mute reads as unmuted. */
export function threadMemberOf(thread: MockChannel, userId: string): ThreadMember | null {
  const joined = thread.thread_members?.get(userId);
  if (!joined) return null;
  const s = thread.thread_member_settings?.get(userId);
  const muted = !!s?.muted && (s.end_time === null || Date.parse(s.end_time) > Date.now());
  return { id: thread.id, user_id: userId, join_timestamp: joined, flags: s?.flags ?? 0, muted, mute_config: muted ? { end_time: s?.end_time ?? null } : null };
}

export function channelFor(ch: MockChannel, viewerId: string): Channel {
  const { participant_ids, hidden_for, thread_members, thread_member_settings, ...rest } = ch;
  void hidden_for;
  void thread_member_settings;
  const last = sortedMessages(ch.id).at(-1);
  const out: Channel = { ...rest, last_message_id: last?.id ?? null };
  if (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildVoice) out.rate_limit_per_user = ch.rate_limit_per_user ?? 0;
  if (rest.permission_overwrites) out.permission_overwrites = rest.permission_overwrites.map(o => ({ ...o }));
  if (rest.thread_metadata) out.thread_metadata = { ...rest.thread_metadata };
  if (rest.available_tags) out.available_tags = rest.available_tags.map(t => ({ ...t }));
  if (rest.applied_tags) out.applied_tags = [...rest.applied_tags];
  if (isThreadType(ch.type)) {
    out.member_count = thread_members?.size ?? 0;
    out.message_count = threadMessageCount(ch);
    const member = threadMemberOf(ch, viewerId);
    if (member) out.member = member;
  }
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
  return [...g.members.entries()].map(([id, m]) => ({
    user: userOf(id),
    nick: m.nick,
    roles: [...m.roles],
    joined_at: m.joined_at,
    ...(m.communication_disabled_until ? { communication_disabled_until: m.communication_disabled_until } : {}),
    ...memberProfileFields(m),
    ...flagsField(guildId, id),
    ...(m.mute ? { mute: true } : {}),
    ...(m.deaf ? { deaf: true } : {}),
  }));
}

export function guildPayload(guildId: string, viewerId: string): GatewayEvents["GUILD_CREATE"] {
  const g = db.guilds.get(guildId);
  if (!g) throw new Error("unknown guild");
  const channels = [...db.channels.values()].filter(c => c.guild_id === guildId && !isThreadType(c.type) && canView(c, viewerId)).map(c => channelFor(c, viewerId));
  const threads = [...db.channels.values()]
    .filter(c => c.guild_id === guildId && isThreadType(c.type) && !c.thread_metadata?.archived && canView(c, viewerId))
    .map(c => channelFor(c, viewerId));
  const members = membersOf(guildId);
  const presences = members.flatMap(m => {
    const p = db.accounts.get(m.user.id)?.presence;
    return p && p.status !== "offline" ? [{ ...p }] : [];
  });
  const stickers = (db.stickers.get(guildId) ?? []).map(s => ({ ...s }));
  const emojis = guildEmojis(guildId);
  const soundboard_sounds = (db.soundboard.get(guildId) ?? []).map(s => ({ ...s }));
  const watch = watchFor(guildId, viewerId);
  const stremio = stremioFor(guildId, viewerId);
  const spotify = spotifyFor(guildId, viewerId);
  const games = gamesFor(guildId, viewerId);
  return { ...(games.length > 0 ? { games } : {}), ...g.guild, roles: g.guild.roles.map(r => ({ ...r })), channels, threads, members, member_count: members.length, ...(emojis.length > 0 ? { emojis } : {}), presences, stickers, soundboard_sounds, voice_states: voiceStatesFor(guildId, viewerId), stage_instances: stageInstancesFor(guildId, viewerId), ...(watch.length > 0 ? { watch_together: watch } : {}), ...(stremio.length > 0 ? { stremio } : {}), ...(spotify.length > 0 ? { spotify } : {}) };
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

/**
 * Like gateway.rs: read states only for what the viewer can see (guild channels except categories, active threads, private channels);
 * the stored one where there is one, else an empty one for a channel that has messages.
 */
function readStatesFor(account: MockAccount, guilds: ReturnType<typeof guildPayload>[], privateChannels: Channel[]): ReadState[] {
  const visible = [...guilds.flatMap(g => [...g.channels, ...(g.threads ?? [])]).filter(c => c.type !== ChannelType.GuildCategory), ...privateChannels];
  return visible.flatMap(channel => {
    const stored = account.readStates.get(channel.id);
    if (stored) return [stored];
    return channel.last_message_id ? [{ channel_id: channel.id, last_message_id: null, mention_count: 0 }] : [];
  });
}

export function readyFor(viewerId: string, sessionId: string): ReadyEvent {
  const account = db.accounts.get(viewerId);
  if (!account) throw new Error("unknown viewer");
  const guilds = guildIdsFor(viewerId).map(id => guildPayload(id, viewerId));
  const privateChannels = privateChannelsFor(viewerId);
  const presences = [...db.accounts.values()].map(a => ({ ...a.presence }));
  return {
    v: 1,
    user: account.user,
    session_id: sessionId,
    guilds,
    private_channels: privateChannels,
    presences,
    read_states: readStatesFor(account, guilds, privateChannels),
    relationships: relationshipsFor(viewerId).filter(r => r.type !== RelationshipType.Blocked || true),
    guild_layout: account.guildLayout ?? { guild_folders: [], guild_positions: [] },
    user_guild_settings: guildSettingsFor(viewerId),
    media: { voice_enabled: true, voice_bitrate_ceiling: 128000, screenshare_qualities: ["720p30"], video_enabled: false },
    max_upload_bytes: MAX_UPLOAD_BYTES,
  };
}
