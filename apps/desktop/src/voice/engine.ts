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
import { resolveAudio } from "./audioProfile";
import { voiceDebug } from "./debugLog";
import { getMedia, resetMedia, setLiveScreen, setLocalState, setStreamQuality, setVideo, setWatching, useMedia, type VideoSource } from "./mediaStore";
import { bindPtt } from "./ptt";
import { channelOccupants, playbackVolume, type VoiceAction, type VoiceDevice, type VoiceErrorReason, type VoiceModel, type VoiceSettings } from "./reducer";
import { getVoice, voiceStore } from "./store";
import { FakeTransport } from "./fakeTransport";
import { isMockEndpoint, type TransportCallbacks, type VoiceTransport } from "./transport";
import { sensitivityToDb } from "./vad";
import { parseBackground } from "./video/backgrounds";
import { openCamera, type CameraSession } from "./video/cameraSession";
import { DEFAULT_SCREEN_SHARE, isCameraResolution, isViewerQuality, type ScreenShareChoice, type ViewerQuality } from "./video/options";

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
  // DM calls (src/calls): every recipient may join; the server checks blocks and the 10-person cap.
  if (channel.type === ChannelType.DM || channel.type === ChannelType.GroupDM) return null;
  if ((channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStage) || !channel.guild_id) return "missing_permissions";
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
  if (channel.type === ChannelType.GuildVoice && isChannelFull(channel, model) && !hasBit(bits, Perm.MOVE_MEMBERS)) return "channel_full";
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

// ---- camera, screen share, watching ----

/** The streaming defaults from User Settings > Voice & Video, as a Go Live choice. */
export function screenChoiceFromPrefs(prefs: Prefs = getPrefs()): ScreenShareChoice {
  const resolution = (["720p", "1080p", "1440p", "source"] as const).find(r => r === prefs.streamResolution) ?? DEFAULT_SCREEN_SHARE.resolution;
  const fps = prefs.streamFps === 15 || prefs.streamFps === 60 ? prefs.streamFps : 30;
  return { resolution, fps, audio: prefs.streamAudio };
}

export const cameraResolutionFromPrefs = (prefs: Prefs = getPrefs()) => (isCameraResolution(prefs.cameraResolution) ? prefs.cameraResolution : "720p");

const inCall = (): boolean => getVoice().channelId !== null && getVoice().status === "connected";

/**
 * Publishes our camera. `session` is the preview modal's open (and background processed) capture; without it the transport
 * opens the camera itself. Resolves true once published; failures arrive as `media.error`.
 */
export async function startCamera(session?: CameraSession | null): Promise<boolean> {
  if (!transport?.setCamera || !inCall()) {
    await session?.stop();
    return false;
  }
  const prefs = getPrefs();
  const resolution = cameraResolutionFromPrefs(prefs);
  let capture = session ?? null;
  if (!capture && transportKind !== "fake") {
    // No preview was open: capture here so the saved background applies before the first frame is published
    // (the fake transport paints its own picture when it gets no capture).
    try {
      capture = await openCamera({ deviceId: prefs.cameraDevice || undefined, resolution });
      const background = parseBackground(prefs.videoBackground);
      if (background.kind !== "none") await capture.setBackground(background).catch(() => undefined);
    } catch (error) {
      const name = (error as { name?: string } | null)?.name;
      setLocalState({ error: VIDEO_ERRORS[name === "NotAllowedError" || name === "SecurityError" ? "permission_denied" : name === "NotFoundError" || name === "OverconstrainedError" ? "not_found" : "failed"] });
      return false;
    }
  }
  await transport.setCamera(true, { resolution, session: capture, deviceId: prefs.cameraDevice || undefined });
  if (!getMedia().cameraOn) await capture?.stop();
  return getMedia().cameraOn;
}

export async function stopCamera(): Promise<void> {
  await transport?.setCamera?.(false);
}

export async function startScreenShare(choice: ScreenShareChoice = screenChoiceFromPrefs()): Promise<boolean> {
  if (!transport?.setScreenShare || !inCall()) return false;
  await transport.setScreenShare(true, choice);
  return getMedia().screenOn;
}

export async function stopScreenShare(): Promise<void> {
  await transport?.setScreenShare?.(false);
}

/** "Watch Stream" / stop watching another user's screen share (costs nothing until watched). */
export function watchStream(userId: Snowflake, watch: boolean): void {
  setWatching(userId, watch);
  transport?.watchStream?.(userId, watch);
  if (!watch) setVideo(userId, "screen", null);
}

export function setViewerQuality(userId: Snowflake, source: VideoSource, quality: ViewerQuality): void {
  setStreamQuality(userId, source, quality);
  transport?.setViewerQuality?.(userId, source, quality);
}

export function dismissVideoError(): void {
  setLocalState({ error: null });
}

const VIDEO_ERRORS = {
  permission_denied: "Vokko needs permission to use the camera or screen. Allow it in your system or browser settings and try again.",
  not_found: "No camera or screen source was found.",
  failed: "Could not start the video. Try again.",
} as const;

/** Per-user stream quality: the user's own choice, or the default from settings. */
function viewerQualityOf(userId: Snowflake, source: VideoSource): ViewerQuality {
  const chosen = getMedia().quality[`${userId}:${source}`];
  if (chosen) return chosen;
  const preferred = getPrefs().viewerQuality;
  return isViewerQuality(preferred) ? preferred : "auto";
}

// ---- op 4 ----

function sendOp4(guildId: Snowflake | null, channelId: Snowflake | null): void {
  const { selfMute, selfDeaf } = getVoice();
  const { cameraOn, screenOn } = getMedia();
  gateway.sendVoiceStateUpdate({
    guild_id: guildId,
    channel_id: channelId,
    self_mute: selfMute,
    self_deaf: selfDeaf,
    self_video: channelId !== null && cameraOn,
    // The real server derives the stream flag from LiveKit; the mock backend (fake transport) has no LiveKit to ask.
    ...(transportKind === "fake" ? { self_stream: channelId !== null && screenOn } : {}),
  });
}

// ---- transport ----

const callbacks: TransportCallbacks = {
  status: status => {
    if (getVoice().channelId === null) return;
    voiceDebug("status", status);
    dispatch({ type: "transportStatus", status });
    if (status === "connected") stopRetry();
  },
  speaking: userIds => dispatch({ type: "speaking", userIds }),
  selfSpeaking: speaking => dispatch({ type: "selfSpeaking", speaking }),
  quality: (quality, pingMs) => {
    voiceDebug("quality", { quality, pingMs });
    dispatch({ type: "quality", quality, pingMs });
  },
  devices: (input, output, outputSelectable) => dispatch({ type: "devices", input, output, outputSelectable }),
  micFailed: reason => {
    dispatch({ type: "setSelfMute", mute: true });
    dispatch({ type: "error", error: { reason, channelId: getVoice().channelId } });
  },
  video: (userId, source, handle) => {
    voiceDebug("video", { userId, source, on: !!handle });
    setVideo(userId, source, handle);
    if (userId !== getVoice().meId) return;
    setLocalState(source === "camera" ? { cameraOn: !!handle } : { screenOn: !!handle });
  },
  screenLive: (userId, live) => {
    voiceDebug("screenLive", { userId, live });
    setLiveScreen(userId, live);
  },
  localVideoEnded: source => setLocalState(source === "camera" ? { cameraOn: false } : { screenOn: false }),
  videoFailed: (source, reason) => {
    voiceDebug("video failed", { source, reason });
    setLocalState({ error: VIDEO_ERRORS[reason], ...(source === "camera" ? { cameraOn: false } : { screenOn: false }) });
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
    selfId: model.meId,
    videoOf: (userId: Snowflake) => {
      const state = getVoice().states[userId];
      return { camera: !!state?.self_video, screen: !!state?.self_stream };
    },
    viewerQuality: viewerQualityOf,
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

/** 0..1: how far other voices are lowered while we watch a stream with "stream attenuation" on. */
function duckFor(prefs: Prefs, watching: boolean): number {
  if (!prefs.streamAttenuation || !watching) return 1;
  return 1 - Math.max(0, Math.min(100, prefs.streamAttenuationStrength)) / 100;
}

export function settingsFromPrefs(prefs: Prefs, watching = Object.keys(getMedia().watching).length > 0): Partial<VoiceSettings> {
  const audio = resolveAudio(prefs);
  return {
    inputMode: prefs.inputMode,
    vadThresholdDb: sensitivityToDb(prefs.inputSensitivity),
    vadAuto: prefs.autoSensitivity,
    inputDeviceId: prefs.inputDevice || "default",
    outputDeviceId: prefs.outputDevice || "default",
    echoCancellation: audio.echoCancellation,
    noiseSuppression: audio.noiseSuppression,
    autoGainControl: audio.autoGainControl,
    rnnoise: audio.rnnoise,
    inputGain: Math.max(0, Math.min(2, prefs.inputVolume / 100)),
    outputGain: Math.max(0, Math.min(2, prefs.outputVolume / 100)),
    duck: duckFor(prefs, watching),
  };
}

function syncPtt(model: VoiceModel): void {
  const want = model.channelId && model.settings.inputMode === "ptt" && model.settings.pttKey ? model.settings.pttKey : null;
  if (want === boundPtt) return;
  unbindPtt?.();
  unbindPtt = null;
  boundPtt = want;
  if (want)
    unbindPtt = bindPtt(want, pressed => {
      transport?.setPttPressed(pressed);
      playSound(pressed ? "ptt-activate" : "ptt-deactivate");
    });
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
    resetMedia();
    if (prev.status === "connected" || prev.status === "reconnecting") playSound("voice-disconnected");
  } else if (next.server && next.channelId && next.server.token !== activeToken && next.server !== prev.server) {
    // A new token always means the server expects it to be used (join, move, re-identify, reconnect answer); the
    // server only sends one while we are not connecting with another for the same session (see reconnect()).
    void connect(next.server.endpoint, next.server.token);
  }

  // Own join / others joining or leaving our call.
  if (next.status === "connected" && prev.status === "reconnecting") playSound("connection-restored");
  else if (next.status === "reconnecting" && prev.status === "connected") playSound("connection-lost");
  else if (next.status === "connected" && prev.status !== "connected" && prev.status !== "reconnecting") playSound("voice-connected");
  else if (next.status === "connected" && prev.status === "connected" && next.channelId === prev.channelId && next.states !== prev.states) {
    const before = occupantIds(prev);
    const after = occupantIds(next);
    const joined = [...after].filter(id => !before.has(id) && id !== next.meId);
    const left = [...before].filter(id => !after.has(id) && id !== next.meId);
    // A user who shows up from, or goes to, another voice channel was moved (or moved themselves) rather than joining.
    const elsewhere = (state: VoiceModel, id: Snowflake) => state.states[id]?.channel_id != null && state.states[id]?.channel_id !== state.channelId;
    if (joined.length) playSound(joined.every(id => elsewhere(prev, id)) ? "user-moved" : "user-join");
    else if (left.length) playSound(left.every(id => elsewhere(next, id)) ? "user-moved" : "user-leave");
    // A moderator muting or deafening us.
    const me = next.meId ? next.states[next.meId] : undefined;
    const was = prev.meId ? prev.states[prev.meId] : undefined;
    if (me && was) {
      if (me.deaf && !was.deaf) playSound("server-deaf");
      else if (me.mute && !was.mute && !me.deaf) playSound("server-mute");
    }
  }

  // Self mute / deafen: transport + op 4 so others see the icons.
  if (next.selfMute !== prev.selfMute || next.selfDeaf !== prev.selfDeaf) {
    transport?.setSelfMute(next.selfMute);
    transport?.setSelfDeaf(next.selfDeaf);
    if (next.channelId) sendOp4(next.guildId, next.channelId);
    if (next.selfDeaf !== prev.selfDeaf) playSound(next.selfDeaf ? "deafen" : "undeafen");
    else playSound(next.selfMute ? "mute" : "unmute");
  }

  // Others' cameras and screen shares follow the voice states (self_video / self_stream).
  if (next.states !== prev.states && next.channelId) transport?.syncVideo?.();

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
  useMedia.subscribe((next, prev) => {
    // Our own camera / screen share started or ended: play the sound. Only the mock backend (fake transport) learns it from
    // op 4; the real server reads it from LiveKit's webhook, and to it an op 4 with unchanged mute/deafen means "reconnect
    // me" (a fresh token), which tore the call down and dropped the camera / screen share it was announcing.
    if (next.cameraOn !== prev.cameraOn || next.screenOn !== prev.screenOn) {
      const { guildId, channelId } = getVoice();
      if (channelId) {
        if (transportKind === "fake") sendOp4(guildId, channelId);
        if (next.cameraOn !== prev.cameraOn) playSound(next.cameraOn ? "camera-on" : "camera-off");
        if (next.screenOn !== prev.screenOn) playSound(next.screenOn ? "stream-start" : "stream-stop");
      }
    }
    // Stream attenuation follows whether we watch anything.
    if (Object.keys(next.watching).length !== Object.keys(prev.watching).length) {
      const a = settingsFromPrefs(getPrefs(), Object.keys(next.watching).length > 0);
      if (a.duck !== getVoice().settings.duck) dispatch({ type: "settings", settings: a });
    }
  });

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
  gateway.on("WATCH_TOGETHER_UPDATE", d => dispatch({ type: "watchTogether", channelId: d.channel_id, state: d.state }));
  gateway.on("STREMIO_UPDATE", d => dispatch({ type: "stremio", channelId: d.channel_id, state: d.state }));
  gateway.on("SPOTIFY_UPDATE", d => dispatch({ type: "spotify", channelId: d.channel_id, state: d.state }));
  gateway.on("GAME_UPDATE", d => dispatch({ type: "game", channelId: d.channel_id, state: d.state }));
  gateway.on("STAGE_INSTANCE_CREATE", instance => dispatch({ type: "stageInstance", instance, ended: false }));
  gateway.on("STAGE_INSTANCE_UPDATE", instance => dispatch({ type: "stageInstance", instance, ended: false }));
  gateway.on("STAGE_INSTANCE_DELETE", instance => dispatch({ type: "stageInstance", instance, ended: true }));
  // Logout or a rejected token: the gateway is gone for good, so is the call (a reconnecting gateway keeps media running).
  gateway.onStatus(status => {
    if (status !== "disconnected" || getVoice().channelId === null) return;
    stopRetry();
    dispatch({ type: "leave" });
  });
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") window.addEventListener("beforeunload", () => void transport?.dispose());
}
