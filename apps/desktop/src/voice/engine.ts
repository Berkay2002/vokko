// Voice engine: feeds gateway events into the voice store, sends op 4, and drives the media transport from store changes
// (connect on every new token, disconnect when we leave, mute/deafen/volume/settings). One call at a time.
//
// Media reconnect (docs/design/voice.md §3.6): an unchanged op 4 makes the server reissue the token, which restarts the
// connect, so op 4 is only re-sent once the transport has reported the connection closed, never while a token is in use.

import { gateway } from "../api/gateway";
import { request } from "../api/rest";
import { appStore } from "../api/store";
import { Perm, channelPermissions, hasBit } from "../api/permissions";
import { ChannelType, type Channel, type Snowflake } from "../api/types";
import { playSound } from "../notify/sounds";
import { getPrefs, usePrefs, type Prefs } from "../ui/prefs";
import { bindPtt } from "./ptt";
import { channelOccupants, playbackVolume, type VoiceAction, type VoiceDevice, type VoiceErrorReason, type VoiceModel, type VoiceSettings } from "./reducer";
import { getVoice, voiceStore } from "./store";
import { FakeTransport } from "./fakeTransport";
import { isMockEndpoint, type TransportCallbacks, type VoiceTransport } from "./transport";
import { sensitivityToDb } from "./vad";

/** Media reconnect: re-send op 4 with this backoff (1 s → 5 s) after a close and give up after two minutes (§3.6). */
export const RETRY_BASE_MS = 1000;
export const RETRY_MAX_MS = 5000;
export const RETRY_GIVE_UP_MS = 2 * 60_000;
/** An op 4 sent for a reconnect that gets no VOICE_SERVER_UPDATE in this time (gateway down, lost frame) is sent again. */
export const TOKEN_WAIT_MS = 10_000;

const dispatch = (action: VoiceAction): void => getVoice().dispatch(action);

type TransportKind = "fake" | "livekit";
type TransportFactory = (kind: TransportKind, callbacks: TransportCallbacks) => VoiceTransport | Promise<VoiceTransport>;

const defaultFactory: TransportFactory = async (kind, cb) => {
  if (kind === "fake") return new FakeTransport(cb);
  const { LiveKitTransport } = await import("./livekitTransport");
  return new LiveKitTransport(cb);
};
let factory: TransportFactory = defaultFactory;

/** Tests: build transports with `make` instead of FakeTransport / LiveKitTransport (null restores the default). */
export function setTransportFactory(make: TransportFactory | null): void {
  factory = make ?? defaultFactory;
}

let transport: VoiceTransport | null = null;
let transportKind: TransportKind | null = null;
/** Token the transport is connecting or connected with; null once it reported the connection closed. */
let activeToken: string | null = null;
/**
 * Reconnect state from the first unexpected close until connected again (or given up). `timer` is either the backoff
 * before the next op 4 or, after an op 4, the wait for its token; it is cleared as soon as a token starts a connect.
 */
let retry: { startedAt: number; attempt: number; timer: ReturnType<typeof setTimeout> | null } | null = null;
let unbindPtt: (() => void) | null = null;
let boundPtt: string | null = null;

// ---- public actions ----

/** Client-side pre-check before op 4 (the server checks again). null = allowed. */
export function joinRefusal(channel: Channel): VoiceErrorReason | null {
  const model = getVoice();
  if (!model.enabled) return "media_unavailable";
  if (channel.type !== ChannelType.GuildVoice || !channel.guild_id) return "missing_permissions";
  const state = appStore.getState();
  const guild = state.guilds[channel.guild_id];
  const meId = state.me?.id;
  const member = meId ? state.members[channel.guild_id]?.[meId] : undefined;
  if (!guild || !meId || !member) return "missing_permissions";
  const bits = channelPermissions(guild, { id: meId, roles: member.roles, communication_disabled_until: member.communication_disabled_until }, channel);
  if (!hasBit(bits, Perm.VIEW_CHANNEL) || !hasBit(bits, Perm.CONNECT)) {
    const timedOut = !!member.communication_disabled_until && Date.parse(member.communication_disabled_until) > Date.now();
    return timedOut ? "timed_out" : "missing_permissions";
  }
  if (isChannelFull(channel, model) && !hasBit(bits, Perm.MOVE_MEMBERS)) return "channel_full";
  return null;
}

/** user_limit reached (not counting ourselves when we are already inside). */
export function isChannelFull(channel: Channel, model: Pick<VoiceModel, "states" | "meId"> = getVoice()): boolean {
  const limit = channel.user_limit ?? 0;
  if (limit <= 0) return false;
  const others = channelOccupants(model, channel.id).filter(s => s.user_id !== model.meId).length;
  return others >= limit;
}

/** Click on a voice channel: join (or move to) it. Returns the refusal reason, if any. */
export function joinVoiceChannel(channel: Channel): VoiceErrorReason | null {
  const model = getVoice();
  if (model.channelId === channel.id) {
    // Already there (or joining): an op 4 now would be an unchanged one, which restarts the media connection.
    if (model.error) dispatch({ type: "dismissError" });
    return null;
  }
  const refusal = joinRefusal(channel);
  if (refusal) {
    dispatch({ type: "error", error: { reason: refusal, channelId: channel.id } });
    return refusal;
  }
  stopRetry();
  dispatch({ type: "join", guildId: channel.guild_id, channelId: channel.id });
  sendOp4(channel.guild_id, channel.id);
  return null;
}

export function leaveVoice(): void {
  const model = getVoice();
  if (model.channelId === null && !model.pendingJoin) return;
  const guildId = model.guildId;
  stopRetry();
  dispatch({ type: "leave" });
  sendOp4(guildId, null);
}

export function setSelfMute(mute: boolean): void {
  dispatch({ type: "setSelfMute", mute });
}

export function setSelfDeaf(deaf: boolean): void {
  dispatch({ type: "setSelfDeaf", deaf });
}

export const toggleSelfMute = (): void => setSelfMute(!getVoice().selfMute);
export const toggleSelfDeaf = (): void => setSelfDeaf(!getVoice().selfDeaf);

export function setUserVolume(userId: Snowflake, volume: number): void {
  dispatch({ type: "setUserVolume", userId, volume });
}

export function setLocalMute(userId: Snowflake, muted: boolean): void {
  dispatch({ type: "setLocalMute", userId, muted });
}

export function setPttKey(accelerator: string | null): void {
  dispatch({ type: "settings", settings: { pttKey: accelerator } });
}

export function setPttReleaseMs(ms: number): void {
  dispatch({ type: "settings", settings: { pttReleaseMs: Math.max(0, Math.min(2000, Math.round(ms))) } });
}

export function dismissVoiceError(): void {
  dispatch({ type: "dismissError" });
}

/**
 * Sets (or with null / "" clears) a voice channel's status: `PUT /channels/{id}/voice-status`. Allowed with MANAGE_CHANNELS,
 * or SET_VOICE_CHANNEL_STATUS while connected to that channel; at most 500 characters. The store follows the
 * VOICE_CHANNEL_STATUS_UPDATE that comes back. Rejects with the API error (403 50013, 400 50035).
 */
export async function setVoiceChannelStatus(channelId: Snowflake, status: string | null): Promise<void> {
  const text = status?.trim() ? status.trim() : null;
  await request<void>("PUT", `/channels/${channelId}/voice-status`, { status: text });
}

/** Re-enumerate audio devices (device menus call this when they open). */
export async function refreshVoiceDevices(): Promise<void> {
  if (transport) return transport.refreshDevices();
  const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  if (!media?.enumerateDevices) return;
  try {
    const list = await media.enumerateDevices();
    const devices = (kind: MediaDeviceKind): VoiceDevice[] => [
      { deviceId: "default", label: "Default" },
      ...list.filter(d => d.kind === kind && d.deviceId && d.deviceId !== "default").map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Device ${i + 1}` })),
    ];
    const outputSelectable = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
    dispatch({ type: "devices", input: devices("audioinput"), output: devices("audiooutput"), outputSelectable });
  } catch {
    /* no device access: menus show "Default" only */
  }
}

// ---- op 4 ----

function sendOp4(guildId: Snowflake | null, channelId: Snowflake | null): void {
  const { selfMute, selfDeaf } = getVoice();
  gateway.sendVoiceStateUpdate({ guild_id: guildId, channel_id: channelId, self_mute: selfMute, self_deaf: selfDeaf, self_video: false });
}

// ---- transport ----

const callbacks: TransportCallbacks = {
  status: status => {
    if (getVoice().channelId === null) return;
    dispatch({ type: "transportStatus", status });
    if (status === "connected") stopRetry();
  },
  speaking: userIds => dispatch({ type: "speaking", userIds }),
  selfSpeaking: speaking => dispatch({ type: "selfSpeaking", speaking }),
  quality: (quality, pingMs) => dispatch({ type: "quality", quality, pingMs }),
  devices: (input, output, outputSelectable) => dispatch({ type: "devices", input, output, outputSelectable }),
  micFailed: reason => {
    dispatch({ type: "setSelfMute", mute: true });
    dispatch({ type: "error", error: { reason, channelId: getVoice().channelId } });
  },
  closed: ({ final, reason }) => {
    activeToken = null;
    if (getVoice().channelId === null) return;
    if (final) {
      // Moved / kicked: the server already knows, so no op 4 (it would disconnect the other device).
      dispatch({ type: "transportClosed", final: true, reason });
      return;
    }
    dispatch({ type: "transportClosed", final: false });
    scheduleRetry();
  },
};

async function transportFor(endpoint: string): Promise<VoiceTransport> {
  const kind: TransportKind = isMockEndpoint(endpoint) ? "fake" : "livekit";
  if (transport && transportKind === kind) return transport;
  const old = transport;
  transport = null;
  transportKind = null;
  await old?.dispose();
  const next = await factory(kind, callbacks);
  transport = next;
  transportKind = kind;
  return next;
}

function transportOptions(model: VoiceModel) {
  return {
    selfMute: model.selfMute,
    selfDeaf: model.selfDeaf,
    settings: model.settings,
    volumeOf: (userId: Snowflake) => playbackVolume(getVoice(), userId),
    participants: () => {
      const now = getVoice();
      return now.channelId ? channelOccupants(now, now.channelId).map(s => s.user_id).filter(id => id !== now.meId) : [];
    },
  };
}

async function connect(endpoint: string, token: string): Promise<void> {
  activeToken = token;
  // A token is in use: no op 4 until this connect has failed or closed.
  clearRetryTimer();
  try {
    const t = await transportFor(endpoint);
    if (activeToken !== token) return; // superseded meanwhile
    await t.connect(endpoint, token, transportOptions(getVoice()));
  } catch (error) {
    // The transport could not even start (e.g. the LiveKit chunk failed to load): same as a lost connection.
    console.warn("voice: connect failed", error);
    if (activeToken === token) callbacks.closed({ final: false });
  }
}

function clearRetryTimer(): void {
  if (retry?.timer) clearTimeout(retry.timer);
  if (retry) retry.timer = null;
}

/** The connection closed (or an op 4 went unanswered): next attempt after the backoff, or give up after two minutes. */
function scheduleRetry(delay?: number): void {
  if (getVoice().channelId === null) return stopRetry();
  const now = Date.now();
  retry ??= { startedAt: now, attempt: 0, timer: null };
  if (retry.timer) return;
  if (now - retry.startedAt >= RETRY_GIVE_UP_MS) return giveUp();
  const wait = delay ?? Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** retry.attempt);
  if (delay === undefined) retry.attempt += 1;
  retry.timer = setTimeout(reconnect, Math.min(wait, Math.max(0, retry.startedAt + RETRY_GIVE_UP_MS - now)));
}

function reconnect(): void {
  if (!retry) return;
  retry.timer = null;
  const model = getVoice();
  if (model.channelId === null) return stopRetry();
  // Never while a token is in use: re-sending op 4 would reissue the token and restart that connect.
  if (activeToken !== null) return;
  if (Date.now() - retry.startedAt >= RETRY_GIVE_UP_MS) return giveUp();
  dispatch({ type: "rejoin" });
  sendOp4(model.guildId, model.channelId);
  scheduleRetry(TOKEN_WAIT_MS);
}

function giveUp(): void {
  const { guildId, channelId } = getVoice();
  stopRetry();
  activeToken = null;
  dispatch({ type: "leave", error: { reason: "connection_lost", channelId } });
  sendOp4(guildId, null);
}

function stopRetry(): void {
  clearRetryTimer();
  retry = null;
}

// ---- store → transport ----

function settingsFromPrefs(prefs: Prefs): Partial<VoiceSettings> {
  return {
    inputMode: prefs.inputMode,
    vadThresholdDb: sensitivityToDb(prefs.inputSensitivity),
    vadAuto: prefs.autoSensitivity,
    inputDeviceId: prefs.inputDevice || "default",
    outputDeviceId: prefs.outputDevice || "default",
    echoCancellation: prefs.echoCancellation,
    noiseSuppression: prefs.noiseSuppression,
    autoGainControl: prefs.autoGainControl,
  };
}

function syncPtt(model: VoiceModel): void {
  const want = model.channelId && model.settings.inputMode === "ptt" && model.settings.pttKey ? model.settings.pttKey : null;
  if (want === boundPtt) return;
  unbindPtt?.();
  unbindPtt = null;
  boundPtt = want;
  if (want) unbindPtt = bindPtt(want, pressed => transport?.setPttPressed(pressed));
}

function occupantIds(model: VoiceModel): Set<Snowflake> {
  return new Set(model.channelId ? channelOccupants(model, model.channelId).map(s => s.user_id) : []);
}

function sync(next: VoiceModel, prev: VoiceModel): void {
  // Connection lifecycle.
  if (next.channelId === null && prev.channelId !== null) {
    activeToken = null;
    stopRetry();
    void transport?.disconnect();
    if (prev.status === "connected" || prev.status === "reconnecting") playSound("voice-leave");
  } else if (next.server && next.channelId && next.server.token !== activeToken && next.server !== prev.server) {
    // A new token always means the server expects it to be used (join, move, re-identify, reconnect answer); the
    // server only sends one while we are not connecting with another for the same session (see reconnect()).
    void connect(next.server.endpoint, next.server.token);
  }

  // Own join / others joining or leaving our call.
  if (next.status === "connected" && prev.status !== "connected" && prev.status !== "reconnecting") playSound("voice-join");
  else if (next.status === "connected" && prev.status === "connected" && next.channelId === prev.channelId && next.states !== prev.states) {
    const before = occupantIds(prev);
    const after = occupantIds(next);
    if ([...after].some(id => !before.has(id))) playSound("voice-join");
    else if ([...before].some(id => !after.has(id))) playSound("voice-leave");
  }

  // Self mute / deafen: transport + op 4 so others see the icons.
  if (next.selfMute !== prev.selfMute || next.selfDeaf !== prev.selfDeaf) {
    transport?.setSelfMute(next.selfMute);
    transport?.setSelfDeaf(next.selfDeaf);
    if (next.channelId) sendOp4(next.guildId, next.channelId);
  }

  if (next.volumes !== prev.volumes || next.localMutes !== prev.localMutes) {
    const ids = new Set([...Object.keys(next.volumes), ...Object.keys(prev.volumes), ...Object.keys(next.localMutes), ...Object.keys(prev.localMutes)]);
    for (const id of ids) if (playbackVolume(next, id) !== playbackVolume(prev, id)) transport?.setUserVolume(id, playbackVolume(next, id));
  }

  if (next.settings !== prev.settings) transport?.applySettings(next.settings);
  if (next.settings !== prev.settings || next.channelId !== prev.channelId) syncPtt(next);
}

// ---- wiring ----

let wired = false;

/** Subscribes the voice store to the gateway and the prefs. Idempotent; called once at start-up (src/voice/index.ts). */
export function wireVoice(): void {
  if (wired) return;
  wired = true;
  dispatch({ type: "settings", settings: settingsFromPrefs(getPrefs()) });
  usePrefs.subscribe((prefs, prev) => {
    const a = settingsFromPrefs(prefs);
    const b = settingsFromPrefs(prev);
    if ((Object.keys(a) as (keyof VoiceSettings)[]).some(k => a[k] !== b[k])) dispatch({ type: "settings", settings: a });
  });
  voiceStore.subscribe((next, prev) => sync(next, prev));

  gateway.on("READY", ready => {
    dispatch({ type: "ready", meId: ready.user.id, voiceEnabled: !!ready.media?.voice_enabled, guilds: ready.guilds });
    // Re-identified while in voice: re-send op 4 so the server re-binds us without a leave (§1.6).
    const model = getVoice();
    if (model.channelId) {
      dispatch({ type: "rejoin" });
      sendOp4(model.guildId, model.channelId);
      // A reconnect in progress now waits for this op 4's token instead of sending its own.
      if (retry && activeToken === null) {
        clearRetryTimer();
        scheduleRetry(TOKEN_WAIT_MS);
      }
    }
  });
  gateway.on("GUILD_CREATE", guild => dispatch({ type: "guildCreate", guild }));
  gateway.on("GUILD_DELETE", ({ id }) => dispatch({ type: "guildDelete", guildId: id }));
  gateway.on("VOICE_STATE_UPDATE", state => dispatch({ type: "voiceStateUpdate", state }));
  gateway.on("VOICE_SERVER_UPDATE", d =>
    dispatch({ type: "voiceServerUpdate", guildId: d.guild_id, channelId: d.channel_id, endpoint: d.endpoint, token: d.token, sessionId: d.session_id }),
  );
  gateway.on("VOICE_CONNECT_FAILED", d => dispatch({ type: "connectFailed", guildId: d.guild_id, channelId: d.channel_id, reason: d.reason }));
  gateway.on("VOICE_CHANNEL_STATUS_UPDATE", d => dispatch({ type: "channelStatus", channelId: d.id, status: d.status }));
  gateway.on("CHANNEL_CREATE", channel => dispatch({ type: "channelUpdate", channel }));
  gateway.on("CHANNEL_UPDATE", channel => dispatch({ type: "channelUpdate", channel }));
  gateway.on("CHANNEL_DELETE", channel => dispatch({ type: "channelDelete", channelId: channel.id }));
  // Logout or a rejected token: the gateway is gone for good, so is the call (a reconnecting gateway keeps media running).
  gateway.onStatus(status => {
    if (status !== "disconnected" || getVoice().channelId === null) return;
    stopRetry();
    dispatch({ type: "leave" });
  });
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") window.addEventListener("beforeunload", () => void transport?.dispose());
}
