// DM call actions and wiring: CALL_* gateway events into the call store (and the call's voice states into the voice store),
// the ring / outgoing tones, the desktop notification for an incoming call, and the user actions (start, accept, decline,
// ring again, hang up). Joining is the voice engine's op 4 into the DM channel; the server starts the call and rings.

import { gateway } from "../api/gateway";
import { request } from "../api/rest";
import { appStore, dmName } from "../api/store";
import type { CallRingRequest, Channel, Snowflake } from "../api/types";
import { notificationAdapter } from "../notify/desktop";
import { dmPath, go } from "../shell/nav";
import { openModal } from "../shell/modalStore";
import { getPrefs } from "../ui/prefs";
import { joinVoiceChannel, leaveVoice } from "../voice/engine";
import type { VoiceErrorReason } from "../voice/reducer";
import { getVoice, voiceStore } from "../voice/store";
import { setTone, type Tone } from "./ringtone";
import { callStore, incomingCalls, outgoingRinging, type CallModel } from "./store";

const dispatch = callStore.getState().dispatch;

function channelOf(channelId: Snowflake): Channel | undefined {
  return appStore.getState().channels[channelId];
}

/** Header call buttons: join the DM's voice (which starts the call and rings the others). `video` opens the camera preview
 *  (publishing a camera is not built yet, see VoiceModals). Returns the voice refusal, if any. */
export function startCall(channel: Channel, video = false): VoiceErrorReason | null {
  const refusal = joinVoiceChannel(channel);
  if (!refusal && video) openModal({ type: "cameraPreview" });
  return refusal;
}

/** Accept an incoming call: open the DM and join its voice. */
export function acceptCall(channelId: Snowflake, video = false): void {
  const channel = channelOf(channelId);
  if (!channel) return;
  go(dmPath(channelId));
  startCall(channel, video);
}

/** Decline: stop ringing ourselves on the server (the other side sees it in CALL_UPDATE). */
export async function declineCall(channelId: Snowflake): Promise<void> {
  dispatch({ type: "dismiss", channelId });
  await request<void>("POST", `/channels/${channelId}/call/stop-ringing`, {} satisfies CallRingRequest);
}

/** Ring recipients (again); absent = everyone not in the call. */
export async function ringCall(channelId: Snowflake, recipients?: Snowflake[]): Promise<void> {
  await request<void>("POST", `/channels/${channelId}/call/ring`, (recipients ? { recipients } : {}) satisfies CallRingRequest);
}

/** Stop ringing someone we are calling (we must be in the call). */
export async function stopRinging(channelId: Snowflake, recipients: Snowflake[]): Promise<void> {
  await request<void>("POST", `/channels/${channelId}/call/stop-ringing`, { recipients } satisfies CallRingRequest);
}

export function hangUp(): void {
  leaveVoice();
}

// ---- tones and notifications ----

/** Which tone the current state calls for: a ring for an incoming call, a ringback while only we are in a call we ring out of. */
export function wantedTone(calls: CallModel, voice: { channelId: Snowflake | null; meId: Snowflake | null; states: Record<Snowflake, { channel_id: Snowflake | null }> }): Tone | null {
  if (incomingCalls(calls, voice.channelId).length > 0) return "incoming";
  const here = voice.channelId;
  if (!here || !calls.calls[here] || outgoingRinging(calls, here).length === 0) return null;
  const others = Object.entries(voice.states).some(([id, state]) => id !== voice.meId && state.channel_id === here);
  return others ? null : "outgoing";
}

function syncTone(): void {
  setTone(wantedTone(callStore.getState(), getVoice()));
}

let notified = new Set<Snowflake>();

/** A desktop notification for every newly ringing call while the window is in the background. */
function notifyIncoming(): void {
  const incoming = incomingCalls(callStore.getState(), getVoice().channelId);
  const ids = new Set(incoming.map(call => call.messageId));
  const fresh = incoming.filter(call => !notified.has(call.messageId));
  notified = ids;
  if (fresh.length === 0 || !getPrefs().desktopNotifications) return;
  const background = typeof document !== "undefined" && (document.hidden || !document.hasFocus());
  if (!background) return;
  for (const call of fresh) {
    const channel = channelOf(call.channelId);
    notificationAdapter().show({
      title: channel ? dmName(channel) : "Incoming call",
      body: "Incoming call",
      tag: `call-${call.channelId}`,
      onClick: () => go(dmPath(call.channelId)),
    });
  }
}

// ---- wiring ----

let wired = false;

/** Subscribes the call store to the gateway. Idempotent; called once at start-up (src/calls/index.ts). */
export function wireCalls(): void {
  if (wired) return;
  wired = true;
  gateway.on("READY", ready => dispatch({ type: "ready", meId: ready.user.id }));
  gateway.on("CALL_CREATE", call => {
    // The call's voice states (READY carries no DM voice states): into the voice store like VOICE_STATE_UPDATE.
    for (const state of call.voice_states) voiceStore.getState().dispatch({ type: "voiceStateUpdate", state });
    for (const update of call.stremio ?? []) voiceStore.getState().dispatch({ type: "stremio", channelId: update.channel_id, state: update.state });
    for (const update of call.spotify ?? []) voiceStore.getState().dispatch({ type: "spotify", channelId: update.channel_id, state: update.state });
    if (call.game) voiceStore.getState().dispatch({ type: "game", channelId: call.channel_id, state: call.game });
    if (call.watch_together) voiceStore.getState().dispatch({ type: "watchTogether", channelId: call.channel_id, state: call.watch_together });
    dispatch({ type: "create", call });
  });
  gateway.on("CALL_UPDATE", call => dispatch({ type: "update", call }));
  gateway.on("CALL_DELETE", ({ channel_id }) => dispatch({ type: "delete", channelId: channel_id }));
  callStore.subscribe(() => {
    syncTone();
    notifyIncoming();
  });
  voiceStore.subscribe((next, prev) => {
    if (next.channelId !== prev.channelId || next.states !== prev.states) syncTone();
  });
}
