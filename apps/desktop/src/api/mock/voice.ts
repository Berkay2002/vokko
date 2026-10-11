// Mock voice server (docs/api.md "Voice (V1)"): op 4 joins / moves / leaves / toggles, VOICE_SERVER_UPDATE with the fake
// endpoint "mock://voice" (the client picks its FakeTransport for it) and VOICE_STATE_UPDATE to everyone who can see the channel.
// Also the voice channel status (PUT /channels/{id}/voice-status, VOICE_CHANNEL_STATUS_UPDATE, cleared when the channel empties).

import { ChannelType, type GatewayEvents, type GuildMember, type VoiceConnectFailure, type VoiceState, type VoiceStateUpdateCommand } from "../types";
import { Perm, hasBit } from "../permissions";
import { canView, channelPermsOf } from "./access";
import { fail, MISSING_PERMISSIONS } from "./ops";
import { db, type MockChannel } from "./db";
import { membersOf } from "./views";
import { callJoined, callReleased, dmRefusal } from "./calls";

export const MOCK_VOICE_ENDPOINT = "mock://voice";

/** userId → voice state (a user is in at most one channel). */
export const voiceStates = new Map<string, VoiceState>();
/** userId → gateway session that owns the voice state. */
const owners = new Map<string, string>();
let counter = 0;

type Emit = <K extends keyof GatewayEvents>(userIds: Iterable<string>, t: K, d: GatewayEvents[K]) => void;
type EmitToSession = <K extends keyof GatewayEvents>(sessionId: string, t: K, d: GatewayEvents[K]) => void;

const newSessionId = () => `mock-voice-${(counter += 1)}-${Math.random().toString(36).slice(2, 8)}`;

/** Users who can see a guild channel. */
function audience(channel: MockChannel): string[] {
  if (!channel.guild_id) return channel.participant_ids ?? [];
  const guild = channel.guild_id ? db.guilds.get(channel.guild_id) : undefined;
  return guild ? [...guild.members.keys()].filter(id => canView(channel, id)) : [];
}

function memberOf(guildId: string, userId: string): GuildMember | undefined {
  return membersOf(guildId).find(m => m.user.id === userId);
}

/** Voice states of a guild that `viewerId` can see (READY / GUILD_CREATE). */
export function voiceStatesFor(guildId: string, viewerId: string): VoiceState[] {
  return [...voiceStates.values()].filter(s => {
    if (s.guild_id !== guildId || !s.channel_id) return false;
    const channel = db.channels.get(s.channel_id);
    return !!channel && canView(channel, viewerId);
  });
}

function stateFor(
  userId: string,
  channel: MockChannel,
  sessionId: string,
  cmd: Pick<VoiceStateUpdateCommand, "self_mute" | "self_deaf"> & Partial<Pick<VoiceStateUpdateCommand, "self_video" | "self_stream">>,
  connectedAt?: string,
): VoiceState {
  const perms = channelPermsOf(channel, userId);
  return {
    guild_id: channel.guild_id,
    channel_id: channel.id,
    user_id: userId,
    session_id: sessionId,
    deaf: false,
    mute: false,
    self_deaf: cmd.self_deaf,
    self_mute: cmd.self_mute || cmd.self_deaf,
    self_video: !!cmd.self_video,
    self_stream: !!cmd.self_stream,
    suppress: !hasBit(perms, Perm.SPEAK),
    request_to_speak_timestamp: null,
    connected_at: connectedAt ?? new Date().toISOString(),
  };
}

function refusal(channel: MockChannel | undefined, userId: string): VoiceConnectFailure | null {
  if (channel && (channel.type === ChannelType.DM || channel.type === ChannelType.GroupDM)) return dmRefusal(channel, userId);
  if (!channel || channel.type !== ChannelType.GuildVoice || !channel.guild_id) return "missing_permissions";
  const perms = channelPermsOf(channel, userId);
  if (!hasBit(perms, Perm.VIEW_CHANNEL)) return "missing_permissions";
  if (!hasBit(perms, Perm.CONNECT)) {
    const until = db.guilds.get(channel.guild_id)?.members.get(userId)?.communication_disabled_until;
    return until && Date.parse(until) > Date.now() ? "timed_out" : "missing_permissions";
  }
  const limit = channel.user_limit ?? 0;
  const inside = [...voiceStates.values()].filter(s => s.channel_id === channel.id && s.user_id !== userId).length;
  if (limit > 0 && inside >= limit && !hasBit(perms, Perm.MOVE_MEMBERS)) return "channel_full";
  return null;
}

function broadcast(emit: Emit, state: VoiceState, channel: MockChannel): void {
  const member = channel.guild_id ? memberOf(channel.guild_id, state.user_id) : undefined;
  emit(audience(channel), "VOICE_STATE_UPDATE", member ? { ...state, member } : { ...state });
}

export const VOICE_STATUS_MAX = 500;

function emitStatus(emit: Emit, channel: MockChannel): void {
  if (!channel.guild_id) return;
  emit(audience(channel), "VOICE_CHANNEL_STATUS_UPDATE", { id: channel.id, guild_id: channel.guild_id, status: channel.status ?? null });
}

/** The last person left `channelId`: its status ends with the session (event with null), like the server. */
function releaseChannel(emit: Emit, channelId: string | null): void {
  if (!channelId) return;
  callReleased(channelId);
  const channel = db.channels.get(channelId);
  if (!channel?.status || [...voiceStates.values()].some(s => s.channel_id === channelId)) return;
  channel.status = null;
  emitStatus(emit, channel);
}

/** PUT /channels/{id}/voice-status: MANAGE_CHANNELS, or SET_VOICE_CHANNEL_STATUS while connected to that channel. */
export function setVoiceChannelStatus(viewerId: string, channel: MockChannel, raw: unknown, emit: Emit): void {
  if (channel.type !== ChannelType.GuildVoice || !channel.guild_id) {
    fail(400, 50035, "Invalid Form Body", { channel_id: { code: "CHANNEL_TYPE_INVALID", message: "Only voice channels have a status." } });
  }
  const perms = channelPermsOf(channel, viewerId);
  const inside = voiceStates.get(viewerId)?.channel_id === channel.id;
  if (!hasBit(perms, Perm.MANAGE_CHANNELS) && !(hasBit(perms, Perm.SET_VOICE_CHANNEL_STATUS) && inside)) fail(403, 50013, MISSING_PERMISSIONS);
  if (raw !== null && raw !== undefined && typeof raw !== "string") {
    fail(400, 50035, "Invalid Form Body", { status: { code: "BASE_TYPE_STRING", message: "Must be a string or null." } });
  }
  const status = typeof raw === "string" && raw.trim() ? raw.trim() : null;
  if (status && [...status].length > VOICE_STATUS_MAX) {
    fail(400, 50035, "Invalid Form Body", { status: { code: "BASE_TYPE_MAX_LENGTH", message: `Must be ${VOICE_STATUS_MAX} or fewer in length.` } });
  }
  channel.status = status;
  emitStatus(emit, channel);
}

function broadcastLeave(emit: Emit, old: VoiceState, except: Set<string> = new Set()): void {
  const channel = old.channel_id ? db.channels.get(old.channel_id) : undefined;
  if (!channel) return;
  const left: VoiceState = { ...old, channel_id: null };
  emit(
    audience(channel).filter(id => !except.has(id)),
    "VOICE_STATE_UPDATE",
    left,
  );
}

/** op 4 from a gateway session. */
export function handleVoiceStateUpdate(sessionId: string, userId: string, cmd: VoiceStateUpdateCommand, emit: Emit, emitToSession: EmitToSession): void {
  const current = voiceStates.get(userId);
  if (cmd.channel_id === null) {
    if (!current) return;
    voiceStates.delete(userId);
    owners.delete(userId);
    broadcastLeave(emit, current);
    releaseChannel(emit, current.channel_id);
    return;
  }
  const channel = db.channels.get(cmd.channel_id);
  const refused = refusal(channel, userId);
  if (refused || !channel) {
    emitToSession(sessionId, "VOICE_CONNECT_FAILED", { guild_id: cmd.guild_id, channel_id: cmd.channel_id, reason: refused ?? "missing_permissions" });
    return;
  }
  if (current && current.channel_id === channel.id && owners.get(userId) === sessionId) {
    const next = stateFor(userId, channel, current.session_id, cmd, current.connected_at);
    if (next.self_mute !== current.self_mute || next.self_deaf !== current.self_deaf || next.self_video !== current.self_video || next.self_stream !== current.self_stream) {
      // Same session, same channel, mute/deafen/camera/stream changed: a toggle, no new token.
      voiceStates.set(userId, next);
      broadcast(emit, next, channel);
      return;
    }
    // Unchanged op 4 from the bound session: the client reconnects; fresh token for the same voice session, no broadcast.
    emitToSession(sessionId, "VOICE_SERVER_UPDATE", serverUpdate(channel, userId, current.session_id));
    return;
  }
  // New binding (first join, move, other gateway session): new voice session id and token.
  const next = stateFor(userId, channel, newSessionId(), cmd);
  voiceStates.set(userId, next);
  owners.set(userId, sessionId);
  emitToSession(sessionId, "VOICE_SERVER_UPDATE", serverUpdate(channel, userId, next.session_id));
  if (!channel.guild_id) callJoined(channel, userId);
  if (current && current.channel_id && current.channel_id !== channel.id) {
    // Those who could see the old channel but not the new one see the user leave.
    broadcastLeave(emit, current, new Set(audience(channel)));
  }
  broadcast(emit, next, channel);
  if (current && current.channel_id !== channel.id) releaseChannel(emit, current.channel_id);
}

let nonce = 0;
function serverUpdate(channel: MockChannel, userId: string, voiceSessionId: string): GatewayEvents["VOICE_SERVER_UPDATE"] {
  nonce += 1;
  return { guild_id: channel.guild_id, channel_id: channel.id, endpoint: MOCK_VOICE_ENDPOINT, token: `mock-voice:${userId}:${channel.id}:${voiceSessionId}:${nonce}`, session_id: voiceSessionId };
}

/** Test / dev hook: put another user into a voice channel (or out with null). */
export function setMockVoice(userId: string, channelId: string | null, emit: Emit, opts: { selfMute?: boolean; selfDeaf?: boolean; selfVideo?: boolean; selfStream?: boolean } = {}): void {
  const current = voiceStates.get(userId);
  if (channelId === null) {
    if (!current) return;
    voiceStates.delete(userId);
    owners.delete(userId);
    broadcastLeave(emit, current);
    releaseChannel(emit, current.channel_id);
    return;
  }
  const channel = db.channels.get(channelId);
  if (!channel) throw new Error("unknown channel");
  const same = current?.channel_id === channelId;
  const next = stateFor(userId, channel, same && current ? current.session_id : newSessionId(), { self_mute: !!opts.selfMute, self_deaf: !!opts.selfDeaf, self_video: !!opts.selfVideo, self_stream: !!opts.selfStream }, same ? current?.connected_at : undefined);
  voiceStates.set(userId, next);
  if (!channel.guild_id && !same) callJoined(channel, userId);
  if (current?.channel_id && !same) broadcastLeave(emit, current, new Set(audience(channel)));
  broadcast(emit, next, channel);
  if (current?.channel_id && !same) releaseChannel(emit, current.channel_id);
}

/** Seed: users already in voice before anyone connects (no events). */
export function seedVoiceState(userId: string, channelId: string, minutesAgo: number): void {
  const channel = db.channels.get(channelId);
  if (!channel) return;
  voiceStates.set(userId, stateFor(userId, channel, newSessionId(), { self_mute: false, self_deaf: false }, new Date(Date.now() - minutesAgo * 60_000).toISOString()));
}
