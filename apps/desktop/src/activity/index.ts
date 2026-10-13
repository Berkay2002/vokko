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
import { readNowPlaying } from "../desktop/spotify";
import { resendOwnStatus } from "../shell/actions";
import { cleanName } from "./format";
import { setOwnActivities } from "./own";
import { sameSpotifyMoment, spotifyActivity } from "./spotify";

// Game detection and the user's own activity. The desktop shell lists running executables; this store matches them against
// the shipped list and the games the user added, and keeps the signed-in user's presence activities in step.

const SHARE_KEY = "vokko.activity.share";
export const POLL_MS = 15_000;
/** Op 3 is limited to 5 per minute per session; presence updates from this module are spaced at least this far apart. */
const MIN_SEND_GAP_MS = 12_000;
export { cleanName };
const SPOTIFY_KEY = "vokko.activity.spotify";
/** The local Spotify app is cheap to ask, so this polls faster than the process list. */
export const SPOTIFY_POLL_MS = 5_000;

/** A stored switch: "1" on, "0" off, anything else (never set, storage blocked) `fallback`. */
function loadFlag(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value !== "0";
  } catch {
    return fallback;
  }
}

interface ActivityState {
  /** "Share my activity": whether the detected game goes out as presence. */
  share: boolean;
  /** "Show Spotify as my status" (off until turned on): whether the song playing in the Spotify app goes out too (also needs `share`). */
  spotify: boolean;
  registered: GameEntry[];
  /** The last process list, null until the first listing finished. */
  running: RunningProcess[] | null;
  detected: DetectedGame | null;
  /** The track playing in the Spotify app now, null when none. */
  listening: Activity | null;
}

export const useActivity = create<ActivityState>(() => ({
  share: loadFlag(SHARE_KEY, true),
  // opt-in: what someone listens to never goes out until they turn it on
  spotify: loadFlag(SPOTIFY_KEY, false),
  registered: loadRegisteredGames(),
  running: null,
  detected: null,
  listening: null,
}));

/** The activities that go out with the user's presence for a given state: the game and Spotify, one of each at most. */
export function activitiesFor(state: Pick<ActivityState, "share" | "detected"> & Partial<Pick<ActivityState, "spotify" | "listening">>): Activity[] {
  if (!state.share) return [];
  const list: Activity[] = [];
  const name = state.detected ? cleanName(state.detected.name) : "";
  if (state.detected && name) list.push({ name, type: 0, ...(state.detected.startedAt > 0 ? { timestamps: { start: state.detected.startedAt } } : {}) });
  if (state.spotify && state.listening) list.push(state.listening);
  return list;
}

function saveFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    /* kept for this session only */
  }
}

export function setShareActivity(on: boolean): void {
  saveFlag(SHARE_KEY, on);
  useActivity.setState({ share: on });
}

export function setShowSpotify(on: boolean): void {
  saveFlag(SPOTIFY_KEY, on);
  useActivity.setState({ spotify: on });
}

let spotifyBusy = false;

/** Asks the local Spotify app what it plays and keeps `listening` stable while the same track plays (no resend per poll). */
export async function refreshSpotify(): Promise<void> {
  const { spotify, share, listening } = useActivity.getState();
  if (!isDesktop() || spotifyBusy) return;
  if (!spotify || !share) {
    if (listening) useActivity.setState({ listening: null });
    return;
  }
  spotifyBusy = true;
  try {
    const next = spotifyActivity(await readNowPlaying(), Date.now());
    if (!sameSpotifyMoment(useActivity.getState().listening, next)) useActivity.setState({ listening: next });
  } finally {
    spotifyBusy = false;
  }
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
    if (state.detected !== prev.detected || state.share !== prev.share || state.listening !== prev.listening || state.spotify !== prev.spotify) apply(false);
    // turning Spotify (or sharing) on looks right away instead of at the next poll; turning it off withdraws it
    if (state.spotify !== prev.spotify || state.share !== prev.share) void refreshSpotify();
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
  const spotifyPoll = setInterval(() => void refreshSpotify(), SPOTIFY_POLL_MS);
  void refreshSpotify();

  return () => {
    clearInterval(poll);
    clearInterval(spotifyPoll);
    useActivity.setState({ listening: null });
    if (timer) clearTimeout(timer);
    stopActivity();
    stopConnection();
    setOwnActivities([]);
    started = false;
  };
}
