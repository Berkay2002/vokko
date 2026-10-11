import { create } from "zustand";
import { appStore } from "../api/store";
import type { Activity } from "../api/types";
import { isDesktop } from "../desktop";
import {
  guessDisplayName,
  listProcesses,
  loadRegisteredGames,
  matchGame,
  normalizeExe,
  saveRegisteredGames,
  type DetectedGame,
  type GameEntry,
  type RunningProcess,
} from "../desktop/games";
import { resendOwnStatus } from "../shell/actions";
import { setOwnActivities } from "./own";

// Game detection and the user's own activity. The desktop shell lists running executables; this store matches them against
// the shipped list and the games the user added, and keeps the signed-in user's presence activities in step.

const SHARE_KEY = "vokko.activity.share";
export const POLL_MS = 15_000;
/** Op 3 is limited to 5 per minute per session; presence updates from this module are spaced at least this far apart. */
const MIN_SEND_GAP_MS = 12_000;
/** The server counts Unicode code points (not UTF-16 units) and closes the connection (4002) on control or invisible characters. */
const MAX_GAME_NAME = 128;
const UNSHOWN_CHARS = /[\p{Cc}­͏؜ᅟᅠ᠎​-‏‪-‮⁠-⁩ㅤ﻿ﾠ]/gu;

/** A name the server accepts: no control or zero-width/bidi characters, at most 128 code points (never splitting a surrogate pair). */
export function cleanName(name: string): string {
  return Array.from(name.replace(UNSHOWN_CHARS, "").trim()).slice(0, MAX_GAME_NAME).join("").trim();
}

function loadShare(): boolean {
  try {
    return localStorage.getItem(SHARE_KEY) !== "0";
  } catch {
    return true;
  }
}

interface ActivityState {
  /** "Share my activity": whether the detected game goes out as presence. */
  share: boolean;
  registered: GameEntry[];
  /** The last process list, null until the first listing finished. */
  running: RunningProcess[] | null;
  detected: DetectedGame | null;
}

export const useActivity = create<ActivityState>(() => ({ share: loadShare(), registered: loadRegisteredGames(), running: null, detected: null }));

/** The activities that go out with the user's presence for a given state. */
export function activitiesFor(state: Pick<ActivityState, "share" | "detected">): Activity[] {
  const game = state.share ? state.detected : null;
  if (!game) return [];
  const name = cleanName(game.name);
  if (!name) return [];
  return [{ name, type: 0, ...(game.startedAt > 0 ? { timestamps: { start: game.startedAt } } : {}) }];
}

export function setShareActivity(on: boolean): void {
  try {
    localStorage.setItem(SHARE_KEY, on ? "1" : "0");
  } catch {
    /* kept for this session only */
  }
  useActivity.setState({ share: on });
}

function publishRunning(running: RunningProcess[]): void {
  const { registered } = useActivity.getState();
  useActivity.setState({ running, detected: matchGame(running, registered) });
}

/** Lists the running executables now and re-matches. A no-op outside the desktop app. */
export async function refreshProcesses(): Promise<void> {
  if (!isDesktop()) return;
  publishRunning(await listProcesses());
}

/** "Add it!": registers a running executable as a game, named after its file until the user renames it. */
export function addRegisteredGame(process: RunningProcess, name = guessDisplayName(process.name)): void {
  const { registered, running } = useActivity.getState();
  const exe = process.name;
  if (registered.some(game => game.exe.some(known => normalizeExe(known) === normalizeExe(exe)))) return;
  const next = [...registered, { name: cleanName(name) || cleanName(exe) || "Game", exe: [exe] }];
  saveRegisteredGames(next);
  useActivity.setState({ registered: next, detected: matchGame(running ?? [], next) });
}

export function removeRegisteredGame(exe: string): void {
  const { registered, running } = useActivity.getState();
  const next = registered.filter(game => !game.exe.some(known => normalizeExe(known) === normalizeExe(exe)));
  saveRegisteredGames(next);
  useActivity.setState({ registered: next, detected: matchGame(running ?? [], next) });
}

let started = false;

/**
 * Polls for games and keeps the user's presence activities current: sends when the detected game (or the sharing switch)
 * changes and again whenever the gateway becomes ready (READY or RESUMED), since the server drops a session's activity
 * when its connection closes. Returns a teardown.
 */
export function startGameDetection(): () => void {
  if (!isDesktop() || started) return () => undefined;
  started = true;

  let sent = "[]";
  let lastSendAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const connected = () => appStore.getState().connection === "ready";

  const push = () => {
    timer = null;
    if (!connected()) return;
    lastSendAt = Date.now();
    resendOwnStatus();
  };
  const schedule = () => {
    if (timer) return;
    const wait = Math.max(0, lastSendAt + MIN_SEND_GAP_MS - Date.now());
    timer = setTimeout(push, wait);
  };
  const apply = (force: boolean) => {
    const list = activitiesFor(useActivity.getState());
    setOwnActivities(list);
    const key = JSON.stringify(list);
    if (!force && key === sent) return;
    sent = key;
    if (connected()) schedule();
  };

  const stopActivity = useActivity.subscribe((state, prev) => {
    if (state.detected !== prev.detected || state.share !== prev.share) apply(false);
  });
  let wasConnected = connected();
  const stopConnection = appStore.subscribe(() => {
    const now = connected();
    if (now === wasConnected) return;
    wasConnected = now;
    // The gateway is ready again (a fresh READY or a RESUMED after a drop): the server holds no activity for this session
    // until we send it once more (nothing to send when there is none).
    if (now) {
      sent = "[]";
      apply(false);
    }
  });

  const poll = setInterval(() => void refreshProcesses(), POLL_MS);
  void refreshProcesses();

  return () => {
    clearInterval(poll);
    if (timer) clearTimeout(timer);
    stopActivity();
    stopConnection();
    setOwnActivities([]);
    started = false;
  };
}
