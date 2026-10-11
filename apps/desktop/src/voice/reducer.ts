// Pure voice model: every gateway event, user action and transport callback is an action; the zustand store in ./store.ts
// wraps this reducer and the engine (./engine.ts) turns model changes into op 4 frames and transport calls.
// Wire contract: docs/api.md "Voice (V1)"; client plan: docs/design/voice.md §3.

import type { Channel, Snowflake, VoiceConnectFailure, VoiceState } from "../api/types";

export type VoiceStatus = "idle" | "connecting" | "rtc_connecting" | "connected" | "reconnecting" | "disconnected";
export type InputMode = "vad" | "ptt";
export type ConnectionQuality = "excellent" | "good" | "poor" | "lost" | "unknown";

/** Why the client is not (or no longer) in voice. Server refusals keep their wire names. */
export type VoiceErrorReason = VoiceConnectFailure | "moved" | "kicked" | "connection_lost" | "permission_denied" | "no_microphone";

export interface VoiceError {
  reason: VoiceErrorReason;
  channelId: Snowflake | null;
}

export interface VoiceDevice {
  deviceId: string;
  label: string;
}

export interface VoiceSettings {
  inputMode: InputMode;
  /** Accelerator ("Ctrl+Shift+K", "F13", "`"); null = not bound. */
  pttKey: string | null;
  pttReleaseMs: number;
  /** Manual gate threshold in dBFS (-100..0). */
  vadThresholdDb: number;
  /** "Automatically determine input sensitivity": noise floor + 15 dB. */
  vadAuto: boolean;
  inputDeviceId: string;
  outputDeviceId: string;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

export const DEFAULT_SETTINGS: VoiceSettings = {
  inputMode: "vad",
  pttKey: null,
  pttReleaseMs: 20,
  vadThresholdDb: -60,
  vadAuto: true,
  inputDeviceId: "default",
  outputDeviceId: "default",
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

export const VOLUME_MAX = 200;

export interface VoiceModel {
  meId: Snowflake | null;
  /** READY `media.voice_enabled`; false when the server has no LiveKit (absent media = unavailable). */
  enabled: boolean;
  /** Every visible voice state, by user id (a user is in at most one channel). */
  states: Record<Snowflake, VoiceState>;
  /** Channel we are in or joining; null = not in voice. */
  channelId: Snowflake | null;
  guildId: Snowflake | null;
  /** Our voice session id, adopted from an own VOICE_STATE_UPDATE whose session_id a VOICE_SERVER_UPDATE gave us. */
  sessionId: string | null;
  /** session_id of the last VOICE_SERVER_UPDATE this client received for the current call: the only one it may adopt. */
  serverSessionId: string | null;
  /** Set when op 4 (join / move / reconnect) is sent and its answer has not arrived yet. */
  pendingJoin: boolean;
  server: { endpoint: string; token: string } | null;
  status: VoiceStatus;
  error: VoiceError | null;
  /** Users currently speaking in our call (remote from the SFU, self from the local gate). */
  speaking: Record<Snowflake, true>;
  selfMute: boolean;
  selfDeaf: boolean;
  /** Mute state before deafening, restored by undeafen (Discord behaviour). */
  muteBeforeDeaf: boolean;
  quality: ConnectionQuality;
  pingMs: number | null;
  /** Per-user volume in percent (0..200), stored locally by user id. Missing = 100. */
  volumes: Record<Snowflake, number>;
  /** Locally muted users (volume 0 + unsubscribed), stored locally. */
  localMutes: Record<Snowflake, true>;
  devices: { input: VoiceDevice[]; output: VoiceDevice[]; outputSelectable: boolean };
  settings: VoiceSettings;
  /** Voice channel status text by channel id (Channel.status, VOICE_CHANNEL_STATUS_UPDATE); unset channels are absent. */
  channelStatus: Record<Snowflake, string>;
}

export const initialVoiceModel: VoiceModel = {
  meId: null,
  enabled: false,
  states: {},
  channelId: null,
  guildId: null,
  sessionId: null,
  serverSessionId: null,
  pendingJoin: false,
  server: null,
  status: "idle",
  error: null,
  speaking: {},
  selfMute: false,
  selfDeaf: false,
  muteBeforeDeaf: false,
  quality: "unknown",
  pingMs: null,
  volumes: {},
  localMutes: {},
  devices: { input: [], output: [], outputSelectable: false },
  settings: DEFAULT_SETTINGS,
  channelStatus: {},
};

interface GuildVoiceEntry {
  id: Snowflake;
  voice_states?: VoiceState[];
  channels?: Pick<Channel, "id" | "type" | "status">[];
}

export type VoiceAction =
  | { type: "ready"; meId: Snowflake; voiceEnabled: boolean; guilds: GuildVoiceEntry[] }
  | { type: "guildCreate"; guild: GuildVoiceEntry }
  | { type: "guildDelete"; guildId: Snowflake }
  | { type: "voiceStateUpdate"; state: VoiceState }
  | { type: "voiceServerUpdate"; guildId: Snowflake | null; channelId: Snowflake; endpoint: string; token: string; sessionId: string }
  | { type: "connectFailed"; guildId: Snowflake | null; channelId: Snowflake; reason: VoiceConnectFailure }
  | { type: "join"; guildId: Snowflake | null; channelId: Snowflake }
  | { type: "leave"; error?: VoiceError | null }
  | { type: "transportStatus"; status: Exclude<VoiceStatus, "idle" | "disconnected" | "connecting"> }
  /** The media connection ended. `final` (moved / kicked / gave up retrying) leaves voice; otherwise the engine retries. */
  | { type: "transportClosed"; final: boolean; reason?: VoiceErrorReason }
  | { type: "speaking"; userIds: Snowflake[] }
  | { type: "selfSpeaking"; speaking: boolean }
  | { type: "quality"; quality: ConnectionQuality; pingMs: number | null }
  | { type: "setSelfMute"; mute: boolean }
  | { type: "setSelfDeaf"; deaf: boolean }
  | { type: "setUserVolume"; userId: Snowflake; volume: number }
  | { type: "setLocalMute"; userId: Snowflake; muted: boolean }
  | { type: "devices"; input: VoiceDevice[]; output: VoiceDevice[]; outputSelectable: boolean }
  | { type: "settings"; settings: Partial<VoiceSettings> }
  | { type: "dismissError" }
  /** Show an error without changing the call (client-side pre-check refused a join). */
  | { type: "error"; error: VoiceError }
  /** Re-sending op 4 for the current channel (gateway re-identify, media reconnect): wait for its VOICE_SERVER_UPDATE. */
  | { type: "rejoin" }
  /** CHANNEL_CREATE / CHANNEL_UPDATE: picks up `status`. */
  | { type: "channelUpdate"; channel: Pick<Channel, "id" | "type" | "status"> }
  | { type: "channelDelete"; channelId: Snowflake }
  /** VOICE_CHANNEL_STATUS_UPDATE. */
  | { type: "channelStatus"; channelId: Snowflake; status: string | null };

const isOwn = (model: VoiceModel, state: VoiceState) => model.meId !== null && state.user_id === model.meId;

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

/** Leaves voice locally (no op 4: the caller decides whether the server needs to hear about it). */
function leaveLocally(model: VoiceModel, error: VoiceError | null): VoiceModel {
  return {
    ...model,
    channelId: null,
    guildId: null,
    sessionId: null,
    serverSessionId: null,
    pendingJoin: false,
    server: null,
    status: model.channelId ? "disconnected" : model.status === "idle" ? "idle" : "disconnected",
    error,
    speaking: {},
    quality: "unknown",
    pingMs: null,
  };
}

/** Speaking entries only make sense for users in our channel. */
function pruneSpeaking(model: VoiceModel): VoiceModel {
  const ids = Object.keys(model.speaking);
  if (ids.length === 0) return model;
  const keep = ids.filter(id => model.channelId !== null && model.states[id]?.channel_id === model.channelId);
  if (keep.length === ids.length) return model;
  return { ...model, speaking: Object.fromEntries(keep.map(id => [id, true as const])) };
}

function replaceGuildStates(states: Record<Snowflake, VoiceState>, guildId: Snowflake, list: VoiceState[]): Record<Snowflake, VoiceState> {
  const next: Record<Snowflake, VoiceState> = {};
  for (const [id, state] of Object.entries(states)) if (state.guild_id !== guildId) next[id] = state;
  for (const state of list) if (state.channel_id) next[state.user_id] = { ...state, guild_id: state.guild_id ?? guildId };
  return next;
}

function setStatus(map: Record<Snowflake, string>, channelId: Snowflake, status: string | null | undefined): Record<Snowflake, string> {
  if (!status) return without(map, channelId);
  return map[channelId] === status ? map : { ...map, [channelId]: status };
}

/** Replaces the statuses of the given channels (READY / GUILD_CREATE carry every channel of the guild). */
function seedStatuses(map: Record<Snowflake, string>, channels: GuildVoiceEntry["channels"]): Record<Snowflake, string> {
  let next = map;
  for (const channel of channels ?? []) next = setStatus(next, channel.id, channel.status);
  return next;
}

function onOwnState(model: VoiceModel, state: VoiceState): VoiceModel {
  if (state.channel_id === null) {
    const states = without(model.states, state.user_id);
    // Our current session left (server timeout, kick, our own leave echo): we are out. A null for an older session while
    // a join is pending (move between channels, re-identify) only removes the old entry.
    if (model.channelId && !model.pendingJoin && (model.sessionId === null || state.session_id === model.sessionId)) {
      return pruneSpeaking(leaveLocally({ ...model, states }, null));
    }
    return pruneSpeaking({ ...model, states });
  }
  const states = { ...model.states, [state.user_id]: state };
  if (model.channelId !== null && model.sessionId !== null && state.session_id === model.sessionId) {
    // Same session: server-side move or a mute/deafen echo. While our own move is pending the channel stays the target.
    if (model.pendingJoin) return pruneSpeaking({ ...model, states });
    return pruneSpeaking({ ...model, states, channelId: state.channel_id, guildId: state.guild_id });
  }
  if (model.channelId !== null && model.serverSessionId !== null && state.session_id === model.serverSessionId) {
    // The session our VOICE_SERVER_UPDATE named: ours.
    return pruneSpeaking({ ...model, states, pendingJoin: false, sessionId: state.session_id, channelId: state.channel_id, guildId: state.guild_id });
  }
  if (model.channelId !== null && (model.sessionId !== null || model.serverSessionId !== null)) {
    // A session id we were not given: voice moved to another device or gateway session. Tear down our media, no retry.
    return pruneSpeaking(leaveLocally({ ...model, states }, { reason: "moved", channelId: model.channelId }));
  }
  // Idle, or a join whose answer has not arrived yet: another device's state is only listed.
  return pruneSpeaking({ ...model, states });
}

export function voiceReducer(model: VoiceModel, action: VoiceAction): VoiceModel {
  switch (action.type) {
    case "ready": {
      let states: Record<Snowflake, VoiceState> = {};
      for (const guild of action.guilds) states = replaceGuildStates(states, guild.id, guild.voice_states ?? []);
      // Keep our own call: the engine re-sends op 4 after a re-identify and the server re-binds without a leave (§1.6).
      const own = model.meId === action.meId ? model : { ...leaveLocally(model, null), status: "idle" as const };
      let channelStatus: Record<Snowflake, string> = {};
      for (const guild of action.guilds) channelStatus = seedStatuses(channelStatus, guild.channels);
      return pruneSpeaking({ ...own, meId: action.meId, enabled: action.voiceEnabled, states, channelStatus });
    }
    case "guildCreate": {
      const next = {
        ...model,
        states: replaceGuildStates(model.states, action.guild.id, action.guild.voice_states ?? []),
        channelStatus: seedStatuses(model.channelStatus, action.guild.channels),
      };
      return pruneSpeaking(next);
    }
    case "guildDelete": {
      const states = replaceGuildStates(model.states, action.guildId, []);
      const next = model.guildId === action.guildId ? leaveLocally({ ...model, states }, null) : { ...model, states };
      return pruneSpeaking(next);
    }
    case "voiceStateUpdate": {
      const { state } = action;
      if (isOwn(model, state)) return onOwnState(model, state);
      const states = state.channel_id === null ? without(model.states, state.user_id) : { ...model.states, [state.user_id]: state };
      return pruneSpeaking({ ...model, states });
    }
    case "voiceServerUpdate": {
      // Only the requesting session gets this; ignore it if we gave up on voice meanwhile.
      if (model.channelId === null || action.channelId !== model.channelId) return model;
      if (model.server?.token === action.token && model.server.endpoint === action.endpoint) return model;
      // Unasked (no op 4 pending) and not for our session: stale, e.g. an answer to an op 4 we already gave up on.
      if (!model.pendingJoin && action.sessionId !== model.sessionId) return model;
      const reconnecting = model.status === "reconnecting";
      const next: VoiceModel = {
        ...model,
        server: { endpoint: action.endpoint, token: action.token },
        serverSessionId: action.sessionId,
        status: reconnecting ? "reconnecting" : "connecting",
      };
      // A fresh token for the session we already have (reconnect): the op 4 is answered.
      if (action.sessionId === model.sessionId) return { ...next, pendingJoin: false };
      // Our own state may already be listed (e.g. in READY).
      const own = model.meId ? model.states[model.meId] : undefined;
      if (own && own.session_id === action.sessionId && own.channel_id) {
        return { ...next, pendingJoin: false, sessionId: own.session_id, channelId: own.channel_id, guildId: own.guild_id };
      }
      return next;
    }
    case "connectFailed": {
      if (!model.pendingJoin && model.channelId !== action.channelId) return model;
      const error: VoiceError = { reason: action.reason, channelId: action.channelId };
      const own = model.meId ? model.states[model.meId] : undefined;
      // A refused move keeps the call we are already in.
      if (model.sessionId && own && own.session_id === model.sessionId && own.channel_id) {
        return { ...model, pendingJoin: false, channelId: own.channel_id, guildId: own.guild_id, error };
      }
      return leaveLocally(model, error);
    }
    case "join": {
      if (model.channelId === action.channelId && !model.pendingJoin && model.sessionId) return model;
      // A move keeps the current media status until the new token arrives (a refused move must not look disconnected).
      const moving = model.sessionId !== null && model.channelId !== null;
      return { ...model, channelId: action.channelId, guildId: action.guildId, pendingJoin: true, status: moving ? model.status : "connecting", error: null };
    }
    case "leave": {
      const own = model.meId ? model.states[model.meId] : undefined;
      // Optimistic: drop our own entry now, the server's channel_id: null echo is a no-op afterwards.
      const states = own && model.sessionId && own.session_id === model.sessionId && model.meId ? without(model.states, model.meId) : model.states;
      return leaveLocally({ ...model, states }, action.error ?? null);
    }
    case "transportStatus": {
      if (model.channelId === null) return model;
      return { ...model, status: action.status };
    }
    case "transportClosed": {
      if (model.channelId === null) return model;
      if (action.final) return leaveLocally(model, { reason: action.reason ?? "connection_lost", channelId: model.channelId });
      return { ...model, status: "reconnecting", server: null, speaking: {} };
    }
    case "speaking": {
      if (model.channelId === null) return model.speaking === initialVoiceModel.speaking ? model : { ...model, speaking: {} };
      const speaking: Record<Snowflake, true> = {};
      for (const id of action.userIds) if (id !== model.meId) speaking[id] = true;
      if (model.meId && model.speaking[model.meId]) speaking[model.meId] = true;
      return pruneSpeaking({ ...model, speaking });
    }
    case "selfSpeaking": {
      if (!model.meId) return model;
      const on = action.speaking && model.channelId !== null && !model.selfMute;
      if (!!model.speaking[model.meId] === on) return model;
      return { ...model, speaking: on ? { ...model.speaking, [model.meId]: true } : without(model.speaking, model.meId) };
    }
    case "quality":
      return { ...model, quality: action.quality, pingMs: action.pingMs };
    case "setSelfMute": {
      if (!action.mute && model.selfDeaf) {
        // Unmuting while deafened undeafens too.
        return { ...model, selfMute: false, selfDeaf: false, muteBeforeDeaf: false };
      }
      const speaking = action.mute && model.meId ? without(model.speaking, model.meId) : model.speaking;
      return { ...model, selfMute: action.mute, speaking };
    }
    case "setSelfDeaf": {
      if (action.deaf === model.selfDeaf) return model;
      if (action.deaf) {
        const speaking = model.meId ? without(model.speaking, model.meId) : model.speaking;
        return { ...model, selfDeaf: true, muteBeforeDeaf: model.selfMute, selfMute: true, speaking };
      }
      return { ...model, selfDeaf: false, selfMute: model.muteBeforeDeaf };
    }
    case "setUserVolume": {
      const volume = Math.round(Math.max(0, Math.min(VOLUME_MAX, action.volume)));
      const volumes = volume === 100 ? without(model.volumes, action.userId) : { ...model.volumes, [action.userId]: volume };
      return { ...model, volumes };
    }
    case "setLocalMute": {
      const localMutes = action.muted ? { ...model.localMutes, [action.userId]: true as const } : without(model.localMutes, action.userId);
      return { ...model, localMutes };
    }
    case "devices":
      return { ...model, devices: { input: action.input, output: action.output, outputSelectable: action.outputSelectable } };
    case "settings":
      return { ...model, settings: { ...model.settings, ...action.settings } };
    case "error":
      return { ...model, error: action.error };
    case "rejoin":
      return model.channelId === null || model.pendingJoin ? model : { ...model, pendingJoin: true };
    case "dismissError":
      return model.error ? { ...model, error: null, status: model.channelId ? model.status : "idle" } : model;
    case "channelUpdate": {
      if (action.channel.status === undefined) return model; // not a voice channel payload: nothing to say about the status
      const channelStatus = setStatus(model.channelStatus, action.channel.id, action.channel.status);
      return channelStatus === model.channelStatus ? model : { ...model, channelStatus };
    }
    case "channelDelete": {
      const channelStatus = without(model.channelStatus, action.channelId);
      return channelStatus === model.channelStatus ? model : { ...model, channelStatus };
    }
    case "channelStatus": {
      const channelStatus = setStatus(model.channelStatus, action.channelId, action.status);
      return channelStatus === model.channelStatus ? model : { ...model, channelStatus };
    }
    default:
      return model;
  }
}

// ---- selectors ----

/** Users in a channel, in join order. */
export function channelOccupants(model: Pick<VoiceModel, "states">, channelId: Snowflake): VoiceState[] {
  return Object.values(model.states)
    .filter(s => s.channel_id === channelId)
    .sort((a, b) => (a.connected_at < b.connected_at ? -1 : a.connected_at > b.connected_at ? 1 : a.user_id < b.user_id ? -1 : 1));
}

/** Speaking ring: only for people in the same call as us, never for muted users. */
export function isSpeaking(model: Pick<VoiceModel, "speaking" | "channelId" | "states" | "status">, userId: Snowflake): boolean {
  if (!model.speaking[userId] || model.channelId === null) return false;
  const state = model.states[userId];
  if (!state || state.channel_id !== model.channelId) return false;
  return !state.mute && !state.self_mute && !state.suppress;
}

/** Effective playback volume for a user in 0..2 (local mute = 0). */
export function playbackVolume(model: Pick<VoiceModel, "volumes" | "localMutes">, userId: Snowflake): number {
  if (model.localMutes[userId]) return 0;
  return (model.volumes[userId] ?? 100) / 100;
}

/** Is our media connection in this channel up (or on its way)? */
export function inChannel(model: Pick<VoiceModel, "channelId">, channelId: Snowflake): boolean {
  return model.channelId === channelId;
}
