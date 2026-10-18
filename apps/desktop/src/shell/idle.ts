import { appStore } from "../api/store";
import { getVoice } from "../voice";
import { loadStoredStatus, setOwnStatus, type SelectableStatus } from "./actions";

/** No input for this long: Online becomes Idle (Discord uses 10 minutes). */
export const IDLE_AFTER_MS = 10 * 60_000;
const CHECK_MS = 15_000;

export interface IdleEnv {
  now(): number;
  /** The status the user picked (persisted). Only "online" is ever turned into Idle. */
  chosen(): SelectableStatus;
  connected(): boolean;
  inVoice(): boolean;
  /** Send Idle (true) or Online (false) without touching the stored choice. */
  send(idle: boolean): void;
}

/**
 * Pure state machine behind the automatic Idle: `input()` on every user input, `check()` on a timer. Comparing timestamps (not counting a
 * timer down) makes a machine that slept go Idle on wake and not after another ten minutes. A manual DND, Invisible or Idle is never
 * touched, and a call keeps you Online.
 */
export function createIdle(env: IdleEnv, after = IDLE_AFTER_MS) {
  let last = env.now();
  let idle = false;
  return {
    get idle() {
      return idle;
    },
    input() {
      last = env.now();
      if (!idle) return;
      idle = false;
      // The user may have picked another status while Idle: the choice wins, so only Online is restored.
      if (env.chosen() === "online") env.send(false);
    },
    check() {
      if (idle) return;
      if (env.inVoice()) last = env.now();
      if (env.now() - last < after || env.chosen() !== "online" || !env.connected()) return;
      idle = true;
      env.send(true);
    },
    /** A new gateway session starts as "online": say Idle again. */
    resync() {
      if (idle) env.send(true);
    },
  };
}

const INPUTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;

/** Mounted once from main.tsx (not the shell). Returns a stop function. */
export function startIdlePresence(): () => void {
  const tracker = createIdle({
    now: Date.now,
    chosen: () => loadStoredStatus().status,
    connected: () => appStore.getState().connection === "ready",
    inVoice: () => {
      const voice = getVoice();
      return voice.meId !== null && voice.states[voice.meId]?.channel_id != null;
    },
    send: idle => setOwnStatus(idle ? "idle" : "online", loadStoredStatus().custom, false),
  });
  const onInput = () => tracker.input();
  for (const type of INPUTS) window.addEventListener(type, onInput, { passive: true, capture: true });
  const timer = window.setInterval(() => tracker.check(), CHECK_MS);
  // Waking from sleep fires no input: check at once so the elapsed time counts.
  const onVisible = () => document.visibilityState === "visible" && tracker.check();
  document.addEventListener("visibilitychange", onVisible);
  const unsubscribe = appStore.subscribe((state, prev) => state.connection === "ready" && prev.connection !== "ready" && tracker.resync());
  return () => {
    for (const type of INPUTS) window.removeEventListener(type, onInput, { capture: true });
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
    unsubscribe();
  };
}
