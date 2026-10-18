// Main-window side of the in-game overlay: turns the voice store, the app store and Settings > Game Overlay into one OverlayState,
// sends it to the overlay window on every change, tells Rust when the overlay has something to show, and runs the overlay's buttons.
// Desktop (Tauri) only; it reads stores and never imports the voice or call UI, so the startup bundle stays as it is.

import { emit } from "@tauri-apps/api/event";
import { appStore, avatarUrl, displayName, dmName, type AppState } from "../api/store";
import { call, isDesktop, onDesktopEvent } from "../desktop/tauri";
import { openMessage } from "../notify/controller";
import { toAccelerator } from "../ui/keybinds";
import { toggleSelfDeaf, toggleSelfMute } from "../voice/engine";
import { isSpeaking, type VoiceModel } from "../voice/reducer";
import { voiceStore } from "../voice/store";
import { ACTION_EVENT, READY_EVENT, STATE_EVENT, TOAST_MAX, TOAST_MS, type OverlayAction, type OverlayCall, type OverlayState, type OverlayToast } from "./protocol";
import { useOverlaySettings, type OverlaySettings } from "./settings";

type AppSlice = Pick<AppState, "channels" | "guilds" | "users" | "members">;
type VoiceSlice = Pick<VoiceModel, "channelId" | "guildId" | "states" | "speaking" | "status" | "selfMute" | "selfDeaf">;

export function overlayCall(voice: VoiceSlice, app: AppSlice): OverlayCall | null {
  const channelId = voice.channelId;
  if (!channelId || (voice.status !== "connected" && voice.status !== "reconnecting")) return null;
  const channel = app.channels[channelId];
  const guildId = voice.guildId ?? channel?.guild_id ?? null;
  const members = Object.values(voice.states)
    .filter(s => s.channel_id === channelId)
    .sort((a, b) => (a.connected_at < b.connected_at ? -1 : a.connected_at > b.connected_at ? 1 : a.user_id < b.user_id ? -1 : 1))
    .map(s => {
      const member = (guildId ? app.members[guildId]?.[s.user_id] : undefined) ?? s.member;
      const user = app.users[s.user_id] ?? member?.user;
      return {
        id: s.user_id,
        name: user ? displayName(user, member) : "Unknown",
        avatar: user ? avatarUrl(user) : avatarUrl({ id: s.user_id, avatar: null }),
        speaking: isSpeaking(voice, s.user_id),
        muted: s.self_mute || s.mute,
        deafened: s.self_deaf || s.deaf,
      };
    });
  return {
    channel: channel ? (guildId ? (channel.name ?? "Voice") : dmName(channel)) : "Voice",
    guild: guildId ? (app.guilds[guildId]?.name ?? null) : null,
    members,
  };
}

export function overlayState(voice: VoiceSlice, app: AppSlice, settings: OverlaySettings, toasts: OverlayToast[]): OverlayState {
  return {
    view: { corner: settings.corner, notifications: settings.notifications, opacity: settings.opacity, hotkey: settings.hotkey },
    call: overlayCall(voice, app),
    selfMute: voice.selfMute,
    selfDeaf: voice.selfDeaf,
    toasts: settings.notifications === "off" ? [] : toasts,
  };
}

/** Whether the overlay window should be up at all: in a call, or a toast is showing and toasts are allowed outside calls. */
export function overlayActive(state: OverlayState, settings: OverlaySettings): boolean {
  return settings.enabled && (state.call !== null || (!settings.onlyInCall && state.toasts.length > 0));
}

let toasts: OverlayToast[] = [];
let schedule: () => void = () => undefined;

/** Called by notify/controller.ts for a mention or DM that passed the notification rules (mutes, levels, DND, streamer mode). */
export function pushOverlayToast(toast: OverlayToast): void {
  const settings = useOverlaySettings.getState();
  if (!isDesktop() || !settings.enabled || settings.notifications === "off") return;
  if (settings.onlyInCall && !voiceStore.getState().channelId) return;
  toasts = [...toasts.filter(t => t.channelId !== toast.channelId), toast].slice(-TOAST_MAX);
  setTimeout(() => {
    toasts = toasts.filter(t => t.id !== toast.id);
    schedule();
  }, TOAST_MS);
  schedule();
}

function onAction(action: OverlayAction): void {
  switch (action.type) {
    case "mute":
      toggleSelfMute();
      return;
    case "deafen":
      toggleSelfDeaf();
      return;
    case "open": {
      const toast = toasts.find(t => t.id === action.toastId);
      if (toast) openMessage(toast.channelId, toast.guildId, toast.messageId);
      toasts = toasts.filter(t => t.id !== action.toastId);
      schedule();
      return;
    }
    case "dismiss":
      toasts = toasts.filter(t => t.id !== action.toastId);
      schedule();
  }
}

let wired = false;

export function wireOverlay(): void {
  if (wired || !isDesktop()) return;
  wired = true;
  let sentState = "";
  let sentConfig = "";
  let queued = false;
  const flush = () => {
    queued = false;
    const settings = useOverlaySettings.getState();
    const state = overlayState(voiceStore.getState(), appStore.getState(), settings, toasts);
    const config = { enabled: settings.enabled, hotkey: toAccelerator(settings.hotkey) ?? "", always: settings.always, active: overlayActive(state, settings) };
    const configJson = JSON.stringify(config);
    if (configJson !== sentConfig) {
      sentConfig = configJson;
      void call("desktop_overlay_configure", { config }, undefined);
    }
    const stateJson = JSON.stringify(state);
    if (stateJson !== sentState && settings.enabled) {
      sentState = stateJson;
      emit(STATE_EVENT, state).catch(() => undefined);
    }
  };
  // Many store updates arrive together (a VOICE_STATE_UPDATE touches several fields): one send per task.
  schedule = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(flush);
  };
  voiceStore.subscribe(schedule);
  let { channels, guilds, users, members } = appStore.getState();
  appStore.subscribe(s => {
    if (s.channels === channels && s.guilds === guilds && s.users === users && s.members === members) return;
    ({ channels, guilds, users, members } = s);
    schedule();
  });
  useOverlaySettings.subscribe(schedule);
  void onDesktopEvent<OverlayAction>(ACTION_EVENT, onAction);
  void onDesktopEvent<null>(READY_EVENT, () => {
    sentState = "";
    schedule();
  });
  schedule();
}
