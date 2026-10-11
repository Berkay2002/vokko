import detectable from "./detectableGames.json";
import { call } from "./tauri";

/**
 * Game detection for rich presence. The shell lists running executables (names and start times only); matching happens here,
 * against the JSON list we ship (`detectableGames.json`: display name to executable names) plus the games the user registered.
 */

/** A running executable as reported by the shell. */
export interface RunningProcess {
  /** File name, e.g. `eldenring.exe`. */
  name: string;
  /** Unix ms, 0 when the OS did not say. */
  startedAt: number;
  /** Lives in an OS directory, so it is never a game. */
  system: boolean;
  /** False when the OS hides the executable path (services, other users): not offered under "Add it!", still matched. */
  pathKnown?: boolean;
}

/** An entry of the detectable list or a game the user added. */
export interface GameEntry {
  name: string;
  exe: string[];
  /** `"app"`: a program that is often open all day (an editor, OBS). Detected, but any running game takes its place. */
  kind?: string;
}

export interface DetectedGame {
  name: string;
  /** The executable that matched, as the OS reported it. */
  exe: string;
  startedAt: number;
}

export const DETECTABLE_GAMES: readonly GameEntry[] = detectable;

/** Lower-cased file name without a trailing `.exe`, so `Wow.exe`, `wow.EXE` and `Wow` (macOS) all compare equal. */
export function normalizeExe(name: string): string {
  const base = name.trim().split(/[\\/]/).pop() ?? "";
  return base.toLowerCase().replace(/\.exe$/, "");
}

/**
 * The game to show for a process list. The user's own entries win over the shipped list; games win over always-open apps
 * (`kind: "app"`); with several matches of the same rank the one that started first is kept, so a second game launched
 * later does not flip the status back and forth.
 */
export function matchGame(processes: readonly RunningProcess[], userGames: readonly GameEntry[] = [], shipped: readonly GameEntry[] = DETECTABLE_GAMES): DetectedGame | null {
  const index = new Map<string, GameEntry>();
  for (const list of [shipped, userGames]) {
    for (const game of list) for (const exe of game.exe) index.set(normalizeExe(exe), game);
  }
  let best: DetectedGame | null = null;
  let bestIsApp = false;
  for (const process of processes) {
    if (process.system) continue;
    const entry = index.get(normalizeExe(process.name));
    if (!entry) continue;
    const found: DetectedGame = { name: entry.name, exe: process.name, startedAt: process.startedAt };
    const isApp = entry.kind === "app";
    const earlier = found.startedAt > 0 && (!best || best.startedAt === 0 || found.startedAt < best.startedAt);
    if (!best || (bestIsApp && !isApp) || (bestIsApp === isApp && earlier)) {
      best = found;
      bestIsApp = isApp;
    }
  }
  return best;
}

/** Running executables worth offering under "Add it!": not an OS program and not already known. */
export function unregisteredProcesses(processes: readonly RunningProcess[], userGames: readonly GameEntry[] = [], shipped: readonly GameEntry[] = DETECTABLE_GAMES): RunningProcess[] {
  const known = new Set<string>();
  for (const list of [shipped, userGames]) for (const game of list) for (const exe of game.exe) known.add(normalizeExe(exe));
  return processes.filter(process => !process.system && process.pathKnown !== false && !known.has(normalizeExe(process.name)));
}

/** "Elden Ring" for `eldenring.exe` is not derivable; the best readable name for an unknown executable is its file name without `.exe`. */
export function guessDisplayName(exe: string): string {
  const base = exe.trim().split(/[\\/]/).pop()?.replace(/\.exe$/i, "") ?? exe;
  return base.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim() || exe;
}

/** The running executables. Empty outside the desktop shell or when listing fails. */
export function listProcesses(): Promise<RunningProcess[]> {
  return call<RunningProcess[]>("desktop_list_processes", undefined, []);
}

// ---- games the user registered ("Add it!") ----

const REGISTERED_KEY = "vokko.activity.games";

export function loadRegisteredGames(): GameEntry[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(REGISTERED_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is GameEntry =>
        !!entry && typeof entry === "object" && typeof (entry as GameEntry).name === "string" && Array.isArray((entry as GameEntry).exe) && (entry as GameEntry).exe.every(exe => typeof exe === "string"),
    );
  } catch {
    return [];
  }
}

export function saveRegisteredGames(games: readonly GameEntry[]): void {
  try {
    localStorage.setItem(REGISTERED_KEY, JSON.stringify(games));
  } catch {
    /* storage unavailable: the list lasts until the app closes */
  }
}
