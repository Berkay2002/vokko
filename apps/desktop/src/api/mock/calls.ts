// Mock DM calls (docs/api.md "DM calls"): the first op 4 into a DM starts the call (type 3 message, CALL_CREATE ringing the
// others), joiners are added to `call.participants`, the last leave ends it (ended_timestamp, CALL_DELETE). Ring / stop-ringing
// / region routes, block rules, the 10-person cap and the 3-minute ring timeout behave like the server.

import { CALL_PARTICIPANT_MAX, CALL_RING_TIMEOUT_MS, ChannelType, MessageType, RelationshipType, type Call, type VoiceConnectFailure } from "../types";
import { compareIds } from "../snowflake";
import { db, sortedMessages, type MockChannel } from "./db";
import { addMessage, channelAudience, fail, requireChannel } from "./ops";
import { ID, route } from "./router";
import { emit, emitToSession } from "./socket";
import { messageFor, relationship } from "./views";
import { voiceStates } from "./voice";
import { watchOf } from "./watch";
import { stremioOf } from "./stremio";

interface MockCall {
  message_id: string;
  region: string | null;
  /** user id → ring timeout */
  ringing: Map<string, ReturnType<typeof setTimeout>>;
}

/** channel id → ongoing call */
export const calls = new Map<string, MockCall>();

/** How long the mock rings (tests shorten it). */
export const ringTimeout = { ms: CALL_RING_TIMEOUT_MS };

const inCall = (channelId: string, userId: string) => voiceStates.get(userId)?.channel_id === channelId;
const statesIn = (channelId: string) => [...voiceStates.values()].filter(s => s.channel_id === channelId);

/** A block in either direction between two users (the DM message rule). */
export function blockedBetween(a: string, b: string): boolean {
  return relationship(a, b)?.type === RelationshipType.Blocked || relationship(b, a)?.type === RelationshipType.Blocked;
}

/** op 4 into a DM: recipients only, blocks close a 1:1 DM, at most 10 people. */
export function dmRefusal(channel: MockChannel, userId: string): VoiceConnectFailure | null {
  const recipients = channel.participant_ids ?? [];
  if (!recipients.includes(userId)) return "missing_permissions";
  if (channel.type === ChannelType.DM && recipients.some(id => id !== userId && blockedBetween(userId, id))) return "blocked";
  if (statesIn(channel.id).filter(s => s.user_id !== userId).length >= CALL_PARTICIPANT_MAX) return "channel_full";
  return null;
}

function sortedRinging(call: MockCall): string[] {
  return [...call.ringing.keys()].sort(compareIds);
}

function callObject(channelId: string, call: MockCall): Call {
  const watching = watchOf(channelId);
  const stremio = stremioOf(channelId);
  return {
    channel_id: channelId,
    message_id: call.message_id,
    region: call.region,
    ringing: sortedRinging(call),
    voice_states: statesIn(channelId).map(s => ({ ...s })),
    ...(watching ? { watch_together: { ...watching, queue: [...watching.queue] } } : {}),
    ...(stremio ? { stremio: [{ channel_id: channelId, state: { ...stremio, queue: stremio.queue.map(q => ({ ...q })) } }] } : {}),
  };
}

function announceUpdate(channel: MockChannel, call: MockCall): void {
  emit(channelAudience(channel), "CALL_UPDATE", { channel_id: channel.id, message_id: call.message_id, region: call.region, ringing: sortedRinging(call) });
}

function callMessage(channel: MockChannel, call: MockCall) {
  return sortedMessages(channel.id).find(m => m.id === call.message_id);
}

function emitMessageUpdate(channel: MockChannel, messageId: string): void {
  const message = sortedMessages(channel.id).find(m => m.id === messageId);
  if (message) for (const id of channelAudience(channel)) emit([id], "MESSAGE_UPDATE", messageFor(message, id));
}

function ring(channel: MockChannel, call: MockCall, userIds: string[]): void {
  for (const userId of userIds) {
    clearTimeout(call.ringing.get(userId));
    call.ringing.set(
      userId,
      setTimeout(() => {
        if (calls.get(channel.id) !== call || !call.ringing.delete(userId)) return;
        announceUpdate(channel, call);
      }, ringTimeout.ms),
    );
  }
}

function stopRinging(call: MockCall, userIds: string[]): boolean {
  let changed = false;
  for (const userId of userIds) {
    const timer = call.ringing.get(userId);
    if (timer === undefined) continue;
    clearTimeout(timer);
    call.ringing.delete(userId);
    changed = true;
  }
  return changed;
}

/** Someone got a voice state in the DM: start the call or join it. */
export function callJoined(channel: MockChannel, userId: string): void {
  const call = calls.get(channel.id);
  if (call) {
    const message = callMessage(channel, call);
    if (message?.call && !message.call.participants.includes(userId)) {
      message.call.participants.push(userId);
      emitMessageUpdate(channel, message.id);
    }
    if (stopRinging(call, [userId])) announceUpdate(channel, call);
    return;
  }
  const message = addMessage({ channel, author_id: userId, content: "", type: MessageType.Call });
  message.call = { participants: [userId], ended_timestamp: null };
  const created: MockCall = { message_id: message.id, region: null, ringing: new Map() };
  calls.set(channel.id, created);
  const others = (channel.participant_ids ?? []).filter(id => id !== userId && !blockedBetween(userId, id) && !inCall(channel.id, id));
  ring(channel, created, others);
  emit(channelAudience(channel), "CALL_CREATE", callObject(channel.id, created));
}

/** Nobody is left in the DM's voice: the call ends. */
export function callReleased(channelId: string): void {
  const call = calls.get(channelId);
  const channel = db.channels.get(channelId);
  if (!call || !channel || statesIn(channelId).length > 0) return;
  stopRinging(call, [...call.ringing.keys()]);
  calls.delete(channelId);
  const message = callMessage(channel, call);
  if (message?.call) {
    message.call.ended_timestamp = new Date().toISOString();
    emitMessageUpdate(channel, message.id);
  }
  emit(channelAudience(channel), "CALL_DELETE", { channel_id: channelId });
}

/** A recipient left the group DM: no longer rung (routes.ts takes them out of the voice call). */
export function callRecipientRemoved(channelId: string, userId: string): void {
  const call = calls.get(channelId);
  const channel = db.channels.get(channelId);
  if (call && channel && stopRinging(call, [userId])) announceUpdate(channel, call);
}

/** After READY (socket.ts): CALL_CREATE for the ongoing calls of the user's DMs. */
export function sendActiveCalls(sessionId: string, userId: string): void {
  for (const [channelId, call] of calls) {
    const channel = db.channels.get(channelId);
    if (channel?.participant_ids?.includes(userId)) emitToSession(sessionId, "CALL_CREATE", callObject(channelId, call));
  }
}

// ---- routes ----

function dmWithCall(channelId: string, viewerId: string, needCall: boolean): { channel: MockChannel; call: MockCall | undefined } {
  const channel = requireChannel(channelId, viewerId);
  if (channel.guild_id) fail(400, 50035, "Invalid Form Body", { channel_id: { code: "CHANNEL_TYPE_INVALID", message: "Only DMs and group DMs have calls." } });
  const call = calls.get(channel.id);
  if (!call && needCall) fail(400, 50035, "Invalid Form Body", { channel_id: { code: "NO_CALL", message: "There is no call in this channel." } });
  return { channel, call };
}

function recipientsOf(channel: MockChannel, raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return null;
  const list = Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
  if (!Array.isArray(raw) || list.some(id => !channel.participant_ids?.includes(id))) {
    fail(400, 50035, "Invalid Form Body", { recipients: { code: "INVALID_RECIPIENTS", message: "Every recipient must be in this channel." } });
  }
  return [...new Set(list)];
}

route("POST", `/channels/${ID}/call/ring`, ({ viewer, params, body }) => {
  const me = viewer.user.id;
  const { channel, call } = dmWithCall(params[0] ?? "", me, true);
  if (!call) return undefined;
  if (!inCall(channel.id, me)) fail(403, 50013, "Missing Permissions");
  const explicit = recipientsOf(channel, body.recipients);
  const candidates = (explicit ?? channel.participant_ids ?? []).filter(id => id !== me);
  const blocked = candidates.filter(id => blockedBetween(me, id));
  if (blocked.length > 0 && (channel.type === ChannelType.DM || explicit)) fail(403, 50007, "Cannot send messages to this user");
  const users = candidates.filter(id => !blocked.includes(id) && !inCall(channel.id, id));
  if (users.length === 0) return undefined;
  ring(channel, call, users);
  announceUpdate(channel, call);
  return undefined;
});

route("POST", `/channels/${ID}/call/stop-ringing`, ({ viewer, params, body }) => {
  const me = viewer.user.id;
  const { channel, call } = dmWithCall(params[0] ?? "", me, false);
  const users = recipientsOf(channel, body.recipients) ?? [me];
  if (users.some(id => id !== me) && !inCall(channel.id, me)) fail(403, 50013, "Missing Permissions");
  if (call && stopRinging(call, users)) announceUpdate(channel, call);
  return undefined;
});

route("PATCH", `/channels/${ID}/call`, ({ viewer, params, body }) => {
  const { channel, call } = dmWithCall(params[0] ?? "", viewer.user.id, true);
  const region = body.region;
  if (region !== null && (typeof region !== "string" || !/^[a-z0-9-]{1,32}$/.test(region))) {
    fail(400, 50035, "Invalid Form Body", { region: { code: "INVALID_REGION", message: "Must be null or 1-32 characters of a-z, 0-9 and -." } });
  }
  if (!call) return undefined;
  call.region = region;
  announceUpdate(channel, call);
  return undefined;
});
