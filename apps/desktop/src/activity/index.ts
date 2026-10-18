import { create } from "zustand";
import { appStore } from "../api/store";
import type { Activity, SpotifyTrack } from "../api/types";
import { isDesktop } from "../desktop";
import { uploadAppIcon } from "../api/appIcons";
import {
  guessDisplayName,
  isIconData,
  listProcesses,
  loadRegisteredGames,
  matchGame,
  normalizeExe,
  readAppInfo,
  saveRegisteredGames,
  type AppInfo,
  type DetectedGame,
  type GameEntry,
  type RunningProcess,
} from "../desktop/games";
import { readNowPlaying } from "../desktop/spotify";
import { resendOwnStatus } from "../shell/actions";
import { cleanName } from "./format";
import { setOwnActivities } from "./own";
import { lookUpTrack, playsInCall, sameSpotifyMoment, spotifyActivity, withCatalog } from "./spotify";
import { voiceStore } from "../voice/store";
import { getPrefs, setPref, usePrefs } from "../ui/prefs";

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
  /** Icons read from running apps this session (base64 PNG by normalized executable name), for apps that are not registered. */
  icons: Record<string, string>;
  /** `app:<hash>` assets the server accepted this session, by normalized executable name. Set only while the app is detected and shared. */
  assets: Record<string, string>;
}

// The two switches are account-synced prefs now; a choice made before that (stored on this device) is carried over once.
function migrateFlag(key: string, pref: "shareActivity" | "shareSpotify"): void {
  const stored = loadFlag(key, getPrefs()[pref]);
  if (stored !== getPrefs()[pref]) setPref(pref, stored);
  try {
    localStorage.removeItem(key);
  } catch {
    /* nothing stored */
  }
}
migrateFlag(SHARE_KEY, "shareActivity");
migrateFlag(SPOTIFY_KEY, "shareSpotify");

export const useActivity = create<ActivityState>(() => ({
  share: getPrefs().shareActivity,
  // opt-in: what someone listens to never goes out until they turn it on
  spotify: getPrefs().shareSpotify,
  registered: loadRegisteredGames(),
  running: null,
  detected: null,
  listening: null,
  icons: {},
  assets: {},
}));

/** The activities that go out with the user's presence for a given state: the game and Spotify, one of each at most. */
export function activitiesFor(
  state: Pick<ActivityState, "share" | "detected"> & Partial<Pick<ActivityState, "spotify" | "listening" | "assets">>,
  /** What the Spotify sessions in calls play right now; the local Spotify activity is left out while it is one of them. */
  callTracks: SpotifyTrack[] = [],
): Activity[] {
  if (!state.share) return [];
  const list: Activity[] = [];
  const name = state.detected ? cleanName(state.detected.name) : "";
  const asset = state.detected ? state.assets?.[normalizeExe(state.detected.exe)] : undefined;
  if (state.detected && name) {
    list.push({
      name,
      type: 0,
      ...(state.detected.app ? { app: true } : {}),
      ...(state.detected.startedAt > 0 ? { timestamps: { start: state.detected.startedAt } } : {}),
      ...(asset ? { assets: { large_image: asset } } : {}),
    });
  }
  if (state.spotify && state.listening && !playsInCall(state.listening, callTracks)) list.push(state.listening);
  return list;
}

/** The tracks the call Spotify sessions this client knows of are playing. */
const callTracks = (): SpotifyTrack[] => Object.values(voiceStore.getState().spotify).flatMap(s => (s.playing && s.track ? [s.track] : []));

// another device (or Activity Privacy) changing the synced switches
usePrefs.subscribe(prefs => {
  const { share, spotify } = useActivity.getState();
  if (prefs.shareActivity !== share || prefs.shareSpotify !== spotify) useActivity.setState({ share: prefs.shareActivity, spotify: prefs.shareSpotify });
});

export function setShareActivity(on: boolean): void {
  setPref("shareActivity", on);
  useActivity.setState({ share: on });
}

export function setShowSpotify(on: boolean): void {
  setPref("shareSpotify", on);
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
    const playing = await readNowPlaying();
    let next = spotifyActivity(playing, Date.now());
    // Windows gives no track id or art: the server's catalog search fills them in, once per track (a failed lookup is retried on a
    // later poll, and the changed sync_id and art go out then); macOS already has them. Spotifast names its artists in one string.
    const artist = cleanName(playing?.lookup_artist ?? playing?.artists[0] ?? "");
    if (next?.details && !next.sync_id && artist) next = withCatalog(next, await lookUpTrack(next.details, artist));
    const now = useActivity.getState();
    if (!now.spotify || !now.share) return;
    if (!sameSpotifyMoment(useActivity.getState().listening, next)) useActivity.setState({ listening: next });
  } finally {
    spotifyBusy = false;
  }
}

function publishRunning(running: RunningProcess[]): void {
  const { registered } = useActivity.getState();
  useActivity.setState({ running, detected: matchGame(running, registered) });
  // Name and icon are read only for the app that matched and for registered apps that are running and still lack them, never for the whole list.
  const wanted = new Map<string, string>();
  const { detected } = useActivity.getState();
  if (detected) wanted.set(normalizeExe(detected.exe), detected.exe);
  for (const entry of registered) {
    if (entry.icon) continue;
    const process = running.find(candidate => entry.exe.some(exe => normalizeExe(exe) === normalizeExe(candidate.name)));
    if (process) wanted.set(normalizeExe(process.name), process.name);
  }
  for (const exe of wanted.values()) void learnApp(exe);
}

/** Per session and executable: the answer of the shell (null when it had none), so the 15 s poll never asks twice. */
const appInfo = new Map<string, Promise<AppInfo | null>>();

/** Applies what the shell knows about a running executable: the display name (while the entry still carries the guessed one) and the icon. */
async function learnApp(exe: string): Promise<void> {
  const key = normalizeExe(exe);
  let pending = appInfo.get(key);
  if (!pending) {
    pending = readAppInfo(exe).catch(() => null);
    appInfo.set(key, pending);
  }
  const info = await pending;
  if (!info) return;
  const icon = isIconData(info.icon) ? info.icon : undefined;
  const nice = cleanName(info.name);
  const { registered, running } = useActivity.getState();
  let changed = false;
  const next = registered.map(entry => {
    if (!entry.exe.some(known => normalizeExe(known) === key)) return entry;
    const guessed = entry.name === (cleanName(guessDisplayName(entry.exe[0] ?? "")) || entry.name);
    const name = guessed && nice ? nice : entry.name;
    const merged = { ...entry, name, ...(icon && !entry.icon ? { icon } : {}) };
    if (merged.name !== entry.name || merged.icon !== entry.icon) changed = true;
    return merged;
  });
  if (changed) saveRegisteredGames(next);
  useActivity.setState(state => ({
    ...(changed ? { registered: next, detected: matchGame(running ?? [], next) } : {}),
    icons: icon && state.icons[key] !== icon ? { ...state.icons, [key]: icon } : state.icons,
  }));
  void shareAppIcon();
}

/** The icon known for an executable: read this session, else the one stored with the registered entry. */
export function iconOf(exe: string, state: Pick<ActivityState, "icons" | "registered"> = useActivity.getState()): string | undefined {
  const key = normalizeExe(exe);
  return state.icons[key] ?? state.registered.find(entry => entry.exe.some(known => normalizeExe(known) === key))?.icon;
}

/** Wait this long before offering an icon the server refused (or could not be reached for) again. */
const UPLOAD_RETRY_MS = 5 * 60_000;
const uploads = new Map<string, number>();

/**
 * Uploads the icon of the detected app once per session, and only while sharing is on: until then nothing about the app leaves this
 * computer. The activity carries the asset only after the upload succeeded, so the server never sees an `app:` hash ahead of its icon.
 */
export async function shareAppIcon(): Promise<void> {
  const { share, detected, assets } = useActivity.getState();
  if (!isDesktop() || !share || !detected) return;
  const key = normalizeExe(detected.exe);
  const icon = iconOf(detected.exe);
  const last = uploads.get(key);
  if (!icon || assets[key] || (last !== undefined && Date.now() - last < UPLOAD_RETRY_MS)) return;
  uploads.set(key, Date.now());
  try {
    const asset = await uploadAppIcon(icon);
    useActivity.setState(state => ({ assets: { ...state.assets, [key]: asset } }));
    uploads.set(key, Number.POSITIVE_INFINITY);
  } catch {
    /* the activity goes out without an icon; tried again after UPLOAD_RETRY_MS */
  }
}

/** Lists the running executables now and re-matches. A no-op outside the desktop app. */
export async function refreshProcesses(): Promise<void> {
  if (!isDesktop()) return;
  publishRunning(await listProcesses());
}

/** "Add it!": registers a running executable as an app, named after its file until the shell has read its real name. */
export function addRegisteredGame(process: RunningProcess, name = guessDisplayName(process.name)): void {
  const { registered, running } = useActivity.getState();
  const exe = process.name;
  if (registered.some(game => game.exe.some(known => normalizeExe(known) === normalizeExe(exe)))) return;
  const next = [...registered, { name: cleanName(name) || cleanName(exe) || "Game", exe: [exe] }];
  saveRegisteredGames(next);
  useActivity.setState({ registered: next, detected: matchGame(running ?? [], next) });
  void learnApp(exe);
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
    const list = activitiesFor(useActivity.getState(), callTracks());
    setOwnActivities(list);
    const key = JSON.stringify(list);
    if (!force && key === sent) return;
    sent = key;
    if (connected()) schedule();
  };

  const stopActivity = useActivity.subscribe((state, prev) => {
    if (state.detected !== prev.detected || state.share !== prev.share || state.listening !== prev.listening || state.spotify !== prev.spotify || state.assets !== prev.assets) apply(false);
    if (state.detected !== prev.detected || state.share !== prev.share) void shareAppIcon();
    // turning Spotify (or sharing) on looks right away instead of at the next poll; turning it off withdraws it
    if (state.spotify !== prev.spotify || state.share !== prev.share) void refreshSpotify();
  });
  const stopCalls = voiceStore.subscribe((state, prev) => {
    if (state.spotify !== prev.spotify) apply(false);
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
    stopCalls();
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

/** Forgets this session's lookups and uploads (tests). */
export function resetAppIconCache(): void {
  appInfo.clear();
  uploads.clear();
}
