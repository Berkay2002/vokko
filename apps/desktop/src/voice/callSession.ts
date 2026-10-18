// While in a call: keep a phone's screen awake (Screen Wake Lock) and give the OS call controls (Media Session: mute, hang up,
// camera). Both degrade silently where the browser or webview lacks them.

import { appStore, dmName } from "../api/store";
import { PHONE_QUERY } from "../ui/BottomSheet";
import { toggleSelfMute, leaveVoice } from "./engine";
import { toggleCamera } from "./videoControls";
import { voiceStore } from "./store";

// The conferencing actions are newer than TypeScript's MediaSessionAction, and setActionHandler throws for names it doesn't know.
const ACTIONS: [string, () => void][] = [
  ["togglemicrophone", toggleSelfMute],
  ["hangup", leaveVoice],
  ["togglecamera", toggleCamera],
];

type Sentinel = { release(): Promise<void>; addEventListener?(type: "release", listener: () => void): void };

let lock: Sentinel | null = null;
let requesting = false;
let active = false;

const onPhone = (): boolean => typeof matchMedia === "function" && matchMedia(PHONE_QUERY).matches;

async function holdScreen(): Promise<void> {
  if (!active || lock || requesting || document.visibilityState !== "visible" || !onPhone() || !("wakeLock" in navigator)) return;
  requesting = true;
  try {
    const sentinel = await navigator.wakeLock.request("screen");
    if (active) {
      lock = sentinel;
      // The browser drops the lock when the page is hidden: forget it so the next visibilitychange takes a new one.
      sentinel.addEventListener?.("release", () => {
        if (lock === sentinel) lock = null;
      });
    } else void sentinel.release().catch(() => undefined);
  } catch {
    // Denied (low battery, no user activation): the screen just sleeps as before.
  } finally {
    requesting = false;
  }
}

function releaseScreen(): void {
  const held = lock;
  lock = null;
  void held?.release().catch(() => undefined);
}

function setMediaSession(on: boolean, title: string, artist: string): void {
  const session = typeof navigator === "undefined" ? undefined : navigator.mediaSession;
  if (!session) return;
  try {
    session.metadata = on && typeof MediaMetadata !== "undefined" ? new MediaMetadata({ title, artist }) : null;
    (session as { setMicrophoneActive?: (active: boolean) => void }).setMicrophoneActive?.(on && !voiceStore.getState().selfMute);
  } catch {
    // Metadata is cosmetic.
  }
  for (const [action, handler] of ACTIONS) {
    try {
      session.setActionHandler(action as MediaSessionAction, on ? handler : null);
    } catch {
      // Not supported by this browser.
    }
  }
}

/** Follows the voice store: starts when a call begins, stops when it ends. Idempotent. */
let wired = false;
export function wireCallSession(): void {
  if (wired) return;
  wired = true;
  document.addEventListener("visibilitychange", () => void holdScreen());
  voiceStore.subscribe((next, prev) => {
    const inCall = next.channelId !== null;
    if (inCall && (!active || next.channelId !== prev.channelId)) {
      active = true;
      const channel = appStore.getState().channels[next.channelId as string];
      const guild = channel?.guild_id ? appStore.getState().guilds[channel.guild_id] : undefined;
      if (onPhone()) setMediaSession(true, (channel && !channel.guild_id ? dmName(channel) : channel?.name) ?? "Voice call", guild?.name ?? "Vokko");
      void holdScreen();
    } else if (!inCall && active) {
      active = false;
      setMediaSession(false, "", "");
      releaseScreen();
    } else if (inCall && next.selfMute !== prev.selfMute) {
      (navigator.mediaSession as { setMicrophoneActive?: (active: boolean) => void } | undefined)?.setMicrophoneActive?.(!next.selfMute);
    }
  });
}
