// Mock voice server (docs/api.md "Voice (V1)"): op 4 joins / moves / leaves / toggles, VOICE_SERVER_UPDATE with the fake
// endpoint "mock://voice" (the client picks its FakeTransport for it) and VOICE_STATE_UPDATE to everyone who can see the channel.
// Also the voice channel status (PUT /channels/{id}/voice-status, VOICE_CHANNEL_STATUS_UPDATE, cleared when the channel empties).

import {
  ChannelType,
  StagePrivacyLevel,
  STAGE_TOPIC_MAX_CHARS,
  type GatewayEvents,
  type GuildMember,
  type StageInstance,
  type VoiceConnectFailure,
  type VoiceState,
  type VoiceStateUpdateCommand,
} from "../types";
import { Perm, hasBit } from "../permissions";
import { canView, channelPermsOf, guildPermsOf } from "./access";
import { fail, MISSING_PERMISSIONS } from "./ops";
import { db, nextId, type MockChannel } from "./db";
import { emit as emitAll, emitToSession as emitToSessionAll } from "./socket";
import { membersOf } from "./views";
import { callJoined, callReleased, dmRefusal } from "./calls";

export const MOCK_VOICE_ENDPOINT = "mock://voice";

/** userId → voice state (a user is in at most one channel). */
export const voiceStates = new Map<string, VoiceState>();
/** Called after a user enters a channel (join or move, not a toggle or a reconnect): the soundboard plays entrance sounds. */
export const voiceJoinListeners: ((userId: string, channel: MockChannel) => void)[] = [];
const entered = (userId: string, channel: MockChannel): void => voiceJoinListeners.forEach(listener => listener(userId, channel));

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
  const record = channel.guild_id ? db.guilds.get(channel.guild_id)?.members.get(userId) : undefined;
  return {
    guild_id: channel.guild_id,
    channel_id: channel.id,
    user_id: userId,
    session_id: sessionId,
    deaf: !!record?.deaf,
    mute: !!record?.mute,
    self_deaf: cmd.self_deaf,
    self_mute: cmd.self_mute || cmd.self_deaf,
    self_video: !!cmd.self_video,
    self_stream: !!cmd.self_stream,
    // Stage: everyone joins the audience.
    suppress: channel.type === ChannelType.GuildStage || !hasBit(perms, Perm.SPEAK),
    request_to_speak_timestamp: null,
    connected_at: connectedAt ?? new Date().toISOString(),
  };
}

/** Stages keep the speaker/audience state across toggles; a suppressed stage member can't publish camera or screen. */
function stageAware(channel: MockChannel, fresh: VoiceState, current: VoiceState): VoiceState {
  if (channel.type !== ChannelType.GuildStage) return fresh;
  const next = { ...fresh, suppress: current.suppress, request_to_speak_timestamp: current.request_to_speak_timestamp };
  return next.suppress ? { ...next, self_video: false, self_stream: false } : next;
}

function refusal(channel: MockChannel | undefined, userId: string): VoiceConnectFailure | null {
  if (channel && (channel.type === ChannelType.DM || channel.type === ChannelType.GroupDM)) return dmRefusal(channel, userId);
  if (!channel || !isVoiceLike(channel) || !channel.guild_id) return "missing_permissions";
  const perms = channelPermsOf(channel, userId);
  if (!hasBit(perms, Perm.VIEW_CHANNEL)) return "missing_permissions";
  if (!hasBit(perms, Perm.CONNECT)) {
    const until = db.guilds.get(channel.guild_id)?.members.get(userId)?.communication_disabled_until;
    return until && Date.parse(until) > Date.now() ? "timed_out" : "missing_permissions";
  }
  const limit = channel.user_limit ?? 0;
  const inside = [...voiceStates.values()].filter(s => s.channel_id === channel.id && s.user_id !== userId).length;
  if (channel.type !== ChannelType.GuildStage && limit > 0 && inside >= limit && !hasBit(perms, Perm.MOVE_MEMBERS)) return "channel_full";
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

/** The last person left `channelId`: its status ends with the session (event with null), like the server. A live stage ends
 * when no stage moderator is left inside. */
function releaseChannel(emit: Emit, channelId: string | null): void {
  if (!channelId) return;
  callReleased(channelId);
  const channel = db.channels.get(channelId);
  if (channel && stageInstances.has(channelId) && ![...voiceStates.values()].some(s => s.channel_id === channelId && isStageModerator(channel, s.user_id))) {
    endStage(channelId, emit);
  }
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
    const next = stageAware(channel, stateFor(userId, channel, current.session_id, cmd, current.connected_at), current);
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
  const fresh = stateFor(userId, channel, newSessionId(), cmd);
  // Every stage join starts in the audience, which can't publish camera or screen.
  const next = channel.type === ChannelType.GuildStage ? { ...fresh, self_video: false, self_stream: false } : fresh;
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
  if (current?.channel_id !== channel.id) entered(userId, channel);
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
  if (!same) entered(userId, channel);
}

/** Seed: users already in voice before anyone connects (no events). */
export function seedVoiceState(userId: string, channelId: string, minutesAgo: number): void {
  const channel = db.channels.get(channelId);
  if (!channel) return;
  voiceStates.set(userId, stateFor(userId, channel, newSessionId(), { self_mute: false, self_deaf: false }, new Date(Date.now() - minutesAgo * 60_000).toISOString()));
}

const isVoiceLike = (channel: MockChannel) => channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStage;

// ---- server mute / deafen / move / disconnect (PATCH /guilds/{id}/members/{uid}) ----

/** Re-evaluates a state after its flags or permissions changed: drop it without VIEW_CHANNEL / CONNECT, else refresh. */
function refresh(emit: Emit, userId: string): void {
  const current = voiceStates.get(userId);
  const channel = current?.channel_id ? db.channels.get(current.channel_id) : undefined;
  if (!current || !channel) return;
  if (refusal(channel, userId) === "missing_permissions" || refusal(channel, userId) === "timed_out") {
    voiceStates.delete(userId);
    owners.delete(userId);
    broadcastLeave(emit, current);
    releaseChannel(emit, current.channel_id);
    return;
  }
  const fresh = stateFor(userId, channel, current.session_id, current, current.connected_at);
  const next = stageAware(channel, fresh, current);
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  voiceStates.set(userId, next);
  broadcast(emit, next, channel);
}

/** Validates the voice keys of a member PATCH (throws like the server); `store` writes the flags, `apply` acts on voice. */
export function memberVoiceEdit(guildId: string, viewerId: string, targetId: string, body: Record<string, unknown>) {
  const actorBits = guildPermsOf(guildId, viewerId);
  const flag = (key: "mute" | "deaf", bit: bigint): boolean | undefined => {
    if (!(key in body)) return undefined;
    if (typeof body[key] !== "boolean") fail(400, 50035, "Invalid Form Body", { [key]: { code: "BASE_TYPE_BOOLEAN", message: "Must be a boolean." } });
    if (!hasBit(actorBits, bit)) fail(403, 50013, MISSING_PERMISSIONS);
    return body[key] as boolean;
  };
  const mute = flag("mute", Perm.MUTE_MEMBERS);
  const deaf = flag("deaf", Perm.DEAFEN_MEMBERS);
  let move: { channel: MockChannel | null } | undefined;
  if ("channel_id" in body) {
    const current = voiceStates.get(targetId);
    const from = current?.guild_id === guildId && current.channel_id ? db.channels.get(current.channel_id) : undefined;
    if (!from) fail(400, 40032, "Target user is not connected to voice.");
    if (!hasBit(channelPermsOf(from, viewerId), Perm.MOVE_MEMBERS)) fail(403, 50013, MISSING_PERMISSIONS);
    const raw = body.channel_id;
    if (raw === null) move = { channel: null };
    else {
      const to = typeof raw === "string" ? db.channels.get(raw) : undefined;
      if (!to || to.guild_id !== guildId || !isVoiceLike(to)) fail(400, 50035, "Invalid Form Body", { channel_id: { code: "CHANNEL_TYPE_INVALID", message: "Must be a voice or stage channel." } });
      if (!hasBit(channelPermsOf(to, viewerId), Perm.MOVE_MEMBERS)) fail(403, 50013, MISSING_PERMISSIONS);
      const theirs = channelPermsOf(to, targetId);
      if (!hasBit(theirs, Perm.VIEW_CHANNEL) || !hasBit(theirs, Perm.CONNECT)) fail(403, 50013, MISSING_PERMISSIONS);
      move = { channel: to };
    }
  }
  return {
    store(record: { mute?: boolean; deaf?: boolean }): void {
      if (mute !== undefined) record.mute = mute;
      if (deaf !== undefined) record.deaf = deaf;
    },
    apply(permissionsChanged: boolean): void {
      if (mute !== undefined || deaf !== undefined || permissionsChanged) refresh(emitAll, targetId);
      if (move?.channel === null) setMockVoice(targetId, null, emitAll);
      else if (move?.channel) moveVoice(targetId, move.channel);
    },
  };
}


/** Server-side move: same voice session, fresh token for the new channel on the owning gateway session. */
function moveVoice(userId: string, channel: MockChannel): void {
  const current = voiceStates.get(userId);
  if (!current || current.channel_id === channel.id) return;
  const next: VoiceState = { ...stateFor(userId, channel, current.session_id, current), self_video: false, self_stream: false };
  voiceStates.set(userId, next);
  const session = owners.get(userId);
  if (session) emitToSessionAll(session, "VOICE_SERVER_UPDATE", serverUpdate(channel, userId, current.session_id));
  broadcastLeave(emitAll, current, new Set(audience(channel)));
  broadcast(emitAll, next, channel);
  releaseChannel(emitAll, current.channel_id);
}

// ---- stage channels ----

/** channelId → live stage. */
export const stageInstances = new Map<string, StageInstance>();

export function isStageModerator(channel: MockChannel, userId: string): boolean {
  const bits = channelPermsOf(channel, userId);
  return hasBit(bits, Perm.ADMINISTRATOR) || (hasBit(bits, Perm.MANAGE_CHANNELS) && hasBit(bits, Perm.MUTE_MEMBERS) && hasBit(bits, Perm.MOVE_MEMBERS));
}

export function stageInstancesFor(guildId: string, viewerId: string): StageInstance[] {
  return [...stageInstances.values()].filter(i => {
    const channel = db.channels.get(i.channel_id);
    return i.guild_id === guildId && !!channel && canView(channel, viewerId);
  });
}

function stageChannel(channelId: string, viewerId: string): MockChannel {
  const channel = db.channels.get(channelId);
  if (!channel) fail(404, 10003, "Unknown Channel");
  if (!canView(channel, viewerId)) fail(403, 50001, "Missing Access");
  if (channel.type !== ChannelType.GuildStage) fail(400, 50024, "Cannot execute action on this channel type");
  return channel;
}

function topicOf(raw: unknown): string {
  const topic = typeof raw === "string" ? raw.trim() : "";
  if (topic.length < 1 || [...topic].length > STAGE_TOPIC_MAX_CHARS) {
    fail(400, 50035, "Invalid Form Body", { topic: { code: "BASE_TYPE_BAD_LENGTH", message: `Must be between 1 and ${STAGE_TOPIC_MAX_CHARS} in length.` } });
  }
  return topic;
}

export function createStage(viewerId: string, body: Record<string, unknown>, emit: Emit): StageInstance {
  const channel = stageChannel(typeof body.channel_id === "string" ? body.channel_id : "", viewerId);
  if (!isStageModerator(channel, viewerId)) fail(403, 50013, MISSING_PERMISSIONS);
  const topic = topicOf(body.topic);
  if (stageInstances.has(channel.id)) fail(400, 150006, "Stage already open");
  const instance: StageInstance = { id: nextId(), guild_id: channel.guild_id ?? "", channel_id: channel.id, topic, privacy_level: StagePrivacyLevel.GuildOnly };
  stageInstances.set(channel.id, instance);
  emit(audience(channel), "STAGE_INSTANCE_CREATE", instance);
  return instance;
}

export function getStage(viewerId: string, channelId: string): StageInstance {
  stageChannel(channelId, viewerId);
  return stageInstances.get(channelId) ?? fail(404, 10067, "Unknown Stage Instance");
}

export function editStage(viewerId: string, channelId: string, body: Record<string, unknown>, emit: Emit): StageInstance {
  const channel = stageChannel(channelId, viewerId);
  if (!isStageModerator(channel, viewerId)) fail(403, 50013, MISSING_PERMISSIONS);
  const current = stageInstances.get(channelId) ?? fail(404, 10067, "Unknown Stage Instance");
  const next = "topic" in body ? { ...current, topic: topicOf(body.topic) } : current;
  stageInstances.set(channelId, next);
  emit(audience(channel), "STAGE_INSTANCE_UPDATE", next);
  return next;
}

export function deleteStage(viewerId: string, channelId: string, emit: Emit): void {
  const channel = stageChannel(channelId, viewerId);
  if (!isStageModerator(channel, viewerId)) fail(403, 50013, MISSING_PERMISSIONS);
  if (!stageInstances.has(channelId)) fail(404, 10067, "Unknown Stage Instance");
  endStage(channelId, emit);
}

/** STAGE_INSTANCE_DELETE, speakers back to the audience, hands lowered. */
export function endStage(channelId: string, emit: Emit): void {
  const instance = stageInstances.get(channelId);
  const channel = db.channels.get(channelId);
  if (!instance || !channel) return;
  stageInstances.delete(channelId);
  emit(audience(channel), "STAGE_INSTANCE_DELETE", instance);
  for (const state of [...voiceStates.values()]) {
    if (state.channel_id !== channelId || (state.suppress && !state.request_to_speak_timestamp)) continue;
    const next = { ...state, suppress: true, request_to_speak_timestamp: null };
    voiceStates.set(state.user_id, next);
    broadcast(emit, next, channel);
  }
}

/** PATCH /guilds/{id}/voice-states/@me | {user_id}. */
export function editVoiceState(guildId: string, viewerId: string, target: string, body: Record<string, unknown>, emit: Emit): void {
  const own = target === "@me";
  const userId = own ? viewerId : target;
  const channel = stageChannel(typeof body.channel_id === "string" ? body.channel_id : "", viewerId);
  if (channel.guild_id !== guildId) fail(404, 10003, "Unknown Channel");
  const current = voiceStates.get(userId);
  if (!current || current.channel_id !== channel.id) fail(400, 40032, "Target user is not connected to voice.");
  const moderator = isStageModerator(channel, viewerId);
  const next: VoiceState = { ...current };
  if (own) {
    if ("request_to_speak_timestamp" in body) {
      if (body.request_to_speak_timestamp === null) next.request_to_speak_timestamp = null;
      else {
        if (!hasBit(channelPermsOf(channel, viewerId), Perm.REQUEST_TO_SPEAK)) fail(403, 50013, MISSING_PERMISSIONS);
        next.request_to_speak_timestamp = new Date().toISOString();
      }
    }
    if (body.suppress === false && !moderator) fail(403, 50013, MISSING_PERMISSIONS);
  } else {
    if (!moderator) fail(403, 50013, MISSING_PERMISSIONS);
    if (typeof body.suppress !== "boolean") fail(400, 50035, "Invalid Form Body", { suppress: { code: "BASE_TYPE_REQUIRED", message: "Required." } });
  }
  if (typeof body.suppress === "boolean") {
    next.suppress = body.suppress;
    if (!body.suppress) next.request_to_speak_timestamp = null;
    // The audience grant has no camera or screen sources (server token.rs).
    if (body.suppress) Object.assign(next, { self_video: false, self_stream: false });
  }
  voiceStates.set(userId, next);
  broadcast(emit, next, channel);
}
