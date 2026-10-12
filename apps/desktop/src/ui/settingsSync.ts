// Account-synced preferences (GET/PATCH /users/@me/settings + USER_SETTINGS_UPDATE, docs/api.md "User settings").
//
// Every pref lives in `usePrefs` (localStorage cache, applied at once). Prefs that opt in through `syncPref()` also live on the
// account: local changes are pushed debounced, remote changes are applied live. Every other pref is listed in DEVICE_LOCAL and never
// leaves the device (a test checks that each pref is in exactly one of the two lists). To sync a new pref: one `syncPref("myPref")`
// line below plus its key in the server allow-list (`vokko_protocol::api::user_settings::KEYS`) and the mock's table
// (src/api/mock/settings.ts).
//
// Conflicts: a PATCH carries the version it is based on. On 409 the server wins for every key another device changed since that
// version; our pending keys the server did not touch are re-applied on top of the new blob and pushed again.
//
// Accounts: localStorage is per device, so the cache remembers which account it was last synced with (`syncedFor`). A device that has
// never synced fills the keys the account never set from its local values; a device last synced with another account takes the new
// account's blob as is (it never uploads the other account's values). Unsent changes are kept per account (`loadPending`/`savePending`)
// so a quit, a crash or a network error does not lose them; they are retried on the next start and with backoff while online.

import { ApiRequestError } from "../api/errors";
import type { UserSettings, UserSettingsData } from "../api/types";
import { isSoundId, parseDisabledSounds, serializeDisabledSounds } from "../notify/soundCatalog";
import { snapStepped } from "./a11y";
import { DEFAULT_PREFS, GROUP_GAPS, isThemeChoice, type Prefs } from "./prefs";

type PrefKey = keyof Prefs;

/** Converts between the pref's local shape and its value on the wire, when they differ. */
interface Codec {
  toWire(value: unknown): unknown;
  /** `undefined` when the wire value is unusable (the pref then falls back to its default). */
  fromWire(value: unknown): unknown;
}

const registry = new Map<PrefKey, string>();
/** Extra checks for values whose type alone is not enough (enums the client must know). */
const validators = new Map<PrefKey, (value: unknown) => boolean>();
const codecs = new Map<PrefKey, Codec>();

/** camelCase pref name → snake_case wire key ("use24hTime" → "use_24h_time"). */
export function wireKey(key: string): string {
  return key.replace(/([a-z])([A-Z0-9])/g, "$1_$2").replace(/([0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** Opts a pref into account sync; `valid` rejects server values this build cannot use (they fall back to the default). */
export function syncPref(key: PrefKey, valid?: (value: unknown) => boolean, codec?: Codec): void {
  registry.set(key, wireKey(key));
  if (valid) validators.set(key, valid);
  if (codec) codecs.set(key, codec);
}

const oneOf =
  (...values: string[]) =>
  (value: unknown): boolean =>
    typeof value === "string" && values.includes(value);

const isLocaleTag = (value: unknown): boolean => {
  if (typeof value !== "string") return false;
  if (value === "") return true; // follow the device
  try {
    return Intl.getCanonicalLocales(value).length === 1;
  } catch {
    return false;
  }
};

export const isSynced = (key: PrefKey): boolean => registry.has(key);
export const syncedKeys = (): PrefKey[] => [...registry.keys()];

// Appearance (theme, message display, spacing)
syncPref("theme", isThemeChoice);
syncPref("messageDisplay", oneOf("cozy", "compact"));
syncPref("density", oneOf("compact", "default", "cozy"));
syncPref("messageSpacing", oneOf("compact", "balanced", "roomy"));
syncPref("messageGroupGap", v => (GROUP_GAPS as readonly number[]).includes(v as number));
syncPref("showCompactAvatars");
// Chat
syncPref("inlineAttachmentMedia");
syncPref("inlineEmbedMedia");
syncPref("showEmbeds");
syncPref("showReactions");
syncPref("convertEmoticons");
syncPref("emojiAutocomplete");
syncPref("stickerSuggestions");
syncPref("stickerAutocomplete");
syncPref("previewMarkdown");
syncPref("spoilerContent", oneOf("click", "moderated", "always"));
syncPref("threadSplitView");
// Language & time
syncPref("locale", isLocaleTag);
syncPref("timeFormat", oneOf("auto", "12", "24"));
// Notification defaults
syncPref("desktopNotifications");
syncPref("notificationSounds");
syncPref("soundCurrentChannel");
syncPref("unreadBadge");
syncPref("taskbarFlash");
syncPref("friendsOnlineAlerts");
syncPref("reactionNotifications", oneOf("all", "dm", "never"));
// Message and voice sounds switched off (one list for Notifications and Voice & Video): a comma separated string here, a string array
// on the wire (the server checks it as a list of distinct short strings; ids this build does not know are dropped).
syncPref("disabledSounds", undefined, {
  toWire: value => {
    const list = typeof value === "string" ? serializeDisabledSounds(parseDisabledSounds(value)) : "";
    return list ? list.split(",") : [];
  },
  fromWire: value =>
    Array.isArray(value) && value.every(item => typeof item === "string") ? serializeDisabledSounds((value as string[]).filter(isSoundId)) : undefined,
});
// Keybinds
syncPref("keybinds");
// Streamer mode
syncPref("streamerMode");
syncPref("streamerAutoEnable");
syncPref("streamerHidePersonal");
syncPref("streamerHideInvites");
syncPref("streamerDisableSounds");
syncPref("streamerDisableNotifications");
syncPref("streamerHideWindow");
// Advanced
syncPref("developerMode");
// Data & privacy
syncPref("dmsFromServerMembers");
syncPref("messageRequests");
syncPref("friendRequestsEveryone");
syncPref("friendRequestsMutualFriends");
syncPref("friendRequestsMutualGuilds");

/**
 * Prefs that stay on this device on purpose. Hardware and per-machine choices (devices, volumes, processing that depends on the
 * microphone, camera and stream quality that depend on the GPU and the connection, the camera background whose uploads live in this
 * device's IndexedDB, diagnostics), the display of this screen (font size, zoom, saturation, contrast, motion: Accessibility) and the
 * app icon.
 */
export const DEVICE_LOCAL: readonly PrefKey[] = [
  // Appearance and accessibility of this screen
  "fontSize",
  "appIcon",
  "reducedMotionEnabled",
  "syncReducedMotion",
  "underlineLinks",
  "displayNameStyles",
  "roleColors",
  "zoom",
  "saturation",
  "saturateCustomColors",
  "highContrast",
  "syncContrast",
  "showSwitchIndicators",
  "minNotificationDuration",
  "playGifs",
  "playAnimatedEmoji",
  "stickerAnimation",
  "ttsRate",
  "ttsPlayback",
  "showImageDescriptions",
  "legacyChatInput",
  // Voice & video: devices and levels
  "inputDevice",
  "outputDevice",
  "cameraDevice",
  "inputVolume",
  "outputVolume",
  "soundboardVolume",
  "inputMode",
  "inputSensitivity",
  "autoSensitivity",
  // Voice processing (depends on the microphone and the machine: RNNoise, OS processing)
  "noiseSuppression",
  "noiseSuppressionKind",
  "echoCancellation",
  "autoGainControl",
  "inputProfile",
  "bypassSystemProcessing",
  // Camera, Go Live and viewing quality (GPU, camera and bandwidth of this machine)
  "alwaysPreviewVideo",
  "previewVideoDefaultMigrated",
  "cameraResolution",
  "videoBackground",
  "streamResolution",
  "streamFps",
  "streamAudio",
  "viewerQuality",
  "showStreamPreviews",
  "streamAttenuation",
  "streamAttenuationStrength",
  // Diagnostics
  "debugLogging",
];

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** A local-shaped value is used only when it has the default's shape (an old or foreign blob can't break the UI). */
function fits(key: PrefKey, value: unknown): boolean {
  const fallback = DEFAULT_PREFS[key];
  return (
    value !== null &&
    value !== undefined &&
    typeof value === typeof fallback &&
    Array.isArray(value) === Array.isArray(fallback) &&
    (validators.get(key)?.(value) ?? true)
  );
}

/** The value a pref takes from a blob: the stored one, or the default when absent or malformed. */
export function prefFromBlob(key: PrefKey, settings: UserSettingsData): Prefs[PrefKey] {
  const raw = settings[registry.get(key) ?? wireKey(key)];
  const codec = codecs.get(key);
  const value = codec && raw !== undefined && raw !== null ? codec.fromWire(raw) : raw;
  if (!fits(key, value)) return DEFAULT_PREFS[key] as Prefs[PrefKey];
  // A slider setting from another device (or an older build) may sit between two stops: snap it like stored prefs are.
  return (typeof value === "number" ? snapStepped(key, value) : value) as Prefs[PrefKey];
}

/** Wire value of a pref: `null` (remove the key) when it equals the default, so the blob only holds what the user changed. */
export function wireValue(key: PrefKey, value: unknown): unknown {
  if (same(value, DEFAULT_PREFS[key])) return null;
  const codec = codecs.get(key);
  return codec ? codec.toWire(value) : value;
}

/** Unsent local changes of one account, kept on the device between runs. */
export interface PendingRecord {
  /** Account version the changes were made on (null: before the first fetch). */
  version: number | null;
  /** Wire values of the changed keys in that version, to tell whether another device changed them since. */
  base: UserSettingsData;
  /** Local values of the changed prefs. */
  values: Partial<Record<string, unknown>>;
}

export interface SettingsSyncDeps {
  getPrefs(): Prefs;
  setPrefs(patch: Partial<Prefs>): void;
  /** Called with the new and previous prefs on every change; returns an unsubscribe. */
  subscribe(listener: (prefs: Prefs, previous: Prefs) => void): () => void;
  fetchSettings(): Promise<UserSettings>;
  /** Rejects with an ApiRequestError; a 409 carries the current blob in `api` (UserSettingsConflict). */
  patchSettings(body: { version: number; settings: UserSettingsData }): Promise<UserSettings>;
  /** The signed-in account (null while signed out). */
  accountId(): string | null;
  /** The account this device's prefs were last synced with (`vokko.prefs.syncedFor`), null when never. */
  getSyncedFor(): string | null;
  setSyncedFor(accountId: string): void;
  loadPending(accountId: string): PendingRecord | null;
  /** `null` clears the record. */
  savePending(accountId: string, record: PendingRecord | null): void;
  debounceMs?: number;
  /** Retry delays after a network error or a 5xx (default 5 s, 30 s, 120 s; the last one repeats). */
  retryMs?: readonly number[];
}

export interface SettingsSync {
  /** Loads the account blob (after READY). A device that never synced uploads the values the account does not have yet. */
  start(): Promise<void>;
  stop(): void;
  /** USER_SETTINGS_UPDATE. */
  applyRemote(blob: UserSettings): void;
  /** Push pending changes now (tests, page unload). */
  flush(): Promise<void>;
  readonly version: number | null;
  readonly pending: PrefKey[];
}

/** Network errors (status 0, or not an API error at all), rate limits and server errors are worth retrying. */
const retryable = (error: unknown): boolean => !(error instanceof ApiRequestError) || error.status === 0 || error.status === 429 || error.status >= 500;

export function createSettingsSync(deps: SettingsSyncDeps): SettingsSync {
  const debounceMs = deps.debounceMs ?? 600;
  const retryMs = deps.retryMs ?? [5_000, 30_000, 120_000];
  let base: UserSettings | null = null;
  /** The account this sync runs for (set by start, cleared by stop). */
  let owner: string | null = null;
  /** Synced keys changed locally and not acknowledged yet. */
  const pending = new Set<PrefKey>();
  let applying = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retries = 0;
  let inflight: Promise<void> | null = null;
  let again = false;
  let unsubscribe: (() => void) | null = null;
  let generation = 0;

  /** Writes the pending keys (with their values) to the device so they survive a quit. */
  const persist = () => {
    if (!owner) return;
    if (pending.size === 0) {
      deps.savePending(owner, null);
      return;
    }
    const prefs = deps.getPrefs();
    const record: PendingRecord = { version: base?.version ?? null, base: {}, values: {} };
    for (const key of pending) {
      const wire = registry.get(key);
      if (!wire) continue;
      record.values[key] = prefs[key];
      if (base) record.base[wire] = base.settings[wire] ?? null;
    }
    deps.savePending(owner, record);
  };

  const setLocal = (patch: Partial<Record<PrefKey, unknown>>) => {
    if (Object.keys(patch).length === 0) return;
    applying = true;
    try {
      deps.setPrefs(patch as Partial<Prefs>);
    } finally {
      applying = false;
    }
  };

  /** Sets prefs from a blob, leaving the keys in `keep` (local edits not pushed yet) alone. */
  const adopt = (blob: UserSettings, keep: ReadonlySet<PrefKey>) => {
    const current = deps.getPrefs();
    const patch: Partial<Record<PrefKey, unknown>> = {};
    for (const key of registry.keys()) {
      if (keep.has(key)) continue;
      const value = prefFromBlob(key, blob.settings);
      if (!same(value, current[key])) patch[key] = value;
    }
    setLocal(patch);
  };

  const schedule = (delay = debounceMs) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, delay);
  };

  const push = async (): Promise<void> => {
    if (!base || pending.size === 0) return;
    const run = generation;
    const sentBase = base;
    const prefs = deps.getPrefs();
    const sent = new Map<PrefKey, unknown>();
    const settings: UserSettingsData = {};
    for (const key of pending) {
      const wire = registry.get(key);
      if (!wire) continue;
      sent.set(key, prefs[key]);
      settings[wire] = wireValue(key, prefs[key]);
    }
    try {
      const saved = await deps.patchSettings({ version: sentBase.version, settings });
      if (run !== generation) return;
      retries = 0;
      if (!base || saved.version > base.version) base = saved;
      // A key edited again while the request was out stays pending.
      for (const [key, value] of sent) if (same(deps.getPrefs()[key], value)) pending.delete(key);
      persist();
    } catch (error) {
      if (run !== generation) return;
      if (error instanceof ApiRequestError && error.status === 400) {
        // The server refused some values (an allow-list it does not have yet, an out-of-range value): stop sending those keys,
        // keep them on this device, and push the rest again.
        const rejected = Object.keys((error.api.errors as { settings?: Record<string, unknown> } | undefined)?.settings ?? {});
        const keys = [...pending].filter(key => rejected.includes(registry.get(key) ?? ""));
        console.warn("[settings] the server refused", rejected.length ? rejected.join(", ") : "the change");
        for (const key of keys.length ? keys : [...pending]) pending.delete(key);
        persist();
        if (pending.size > 0) again = true;
        return;
      }
      if (!(error instanceof ApiRequestError) || error.status !== 409) throw error;
      const current = error.api as unknown as UserSettings;
      // Server wins for keys another device changed since the version this PATCH was based on; the rest of our edits are re-applied.
      for (const key of [...pending]) {
        const wire = registry.get(key) ?? "";
        if (!same(current.settings?.[wire] ?? null, sentBase.settings[wire] ?? null)) pending.delete(key);
      }
      base = { version: current.version, settings: current.settings ?? {} };
      adopt(base, pending);
      persist();
      if (pending.size > 0) again = true;
    }
  };

  const flush = async (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (inflight) {
      again = true;
      return inflight;
    }
    const run = generation;
    inflight = (async () => {
      try {
        do {
          again = false;
          await push();
        } while (again && pending.size > 0);
      } catch (error) {
        if (run === generation && retryable(error) && pending.size > 0) {
          const delay = retryMs[Math.min(retries, retryMs.length - 1)] ?? 120_000;
          retries += 1;
          console.warn(`[settings] sync failed; retrying in ${Math.round(delay / 1000)} s`, error);
          schedule(delay);
        } else {
          console.warn("[settings] sync failed", error);
        }
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };

  const onChange = (prefs: Prefs, previous: Prefs) => {
    if (applying) return;
    let changed = false;
    for (const key of registry.keys()) {
      if (!same(prefs[key], previous[key])) {
        pending.add(key);
        changed = true;
      }
    }
    if (!changed) return;
    persist();
    if (base) schedule();
  };

  return {
    async start() {
      generation += 1;
      const run = generation;
      const account = deps.accountId();
      owner = account;
      unsubscribe ??= deps.subscribe(onChange);
      const blob = await deps.fetchSettings();
      if (run !== generation) return;
      base = blob;
      const syncedFor = deps.getSyncedFor();
      const neverSynced = syncedFor === null;
      const sameAccount = account !== null && syncedFor === account;

      // Changes of this account that did not reach the server last time (quit inside the debounce, offline, server error).
      const stored = account ? deps.loadPending(account) : null;
      const restore: Partial<Record<PrefKey, unknown>> = {};
      if (stored) {
        for (const [name, value] of Object.entries(stored.values)) {
          const key = name as PrefKey;
          const wire = registry.get(key);
          if (!wire || !fits(key, value)) continue;
          // Another device changed this key after the edit was made: the server wins, as for a 409.
          const changedElsewhere = stored.version !== null && blob.version > stored.version && !same(blob.settings[wire] ?? null, stored.base[wire] ?? null);
          if (changedElsewhere) continue;
          pending.add(key);
          restore[key] = value;
        }
      }

      const prefs = deps.getPrefs();
      if (neverSynced || (sameAccount && blob.version === 0)) {
        // This device's own values: the account keeps what it has, local non-default values fill the keys it never set
        // (on a fresh account that is every key).
        for (const key of registry.keys()) {
          const wire = registry.get(key) ?? "";
          if (blob.settings[wire] === undefined && !same(prefs[key], DEFAULT_PREFS[key])) pending.add(key);
        }
      }
      // Last synced with another account: its values are not this one's, so nothing is uploaded and the blob (or the default) wins.
      adopt(blob, pending);
      setLocal(restore);
      if (account) deps.setSyncedFor(account);
      persist();
      if (pending.size > 0) await flush();
    },
    stop() {
      generation += 1;
      unsubscribe?.();
      unsubscribe = null;
      if (timer) clearTimeout(timer);
      timer = null;
      retries = 0;
      base = null;
      owner = null;
      // The stored record of the account stays: it is restored when that account signs in again.
      pending.clear();
    },
    applyRemote(blob) {
      if (!base || blob.version <= base.version) return;
      base = blob;
      adopt(blob, pending);
    },
    flush,
    get version() {
      return base?.version ?? null;
    },
    get pending() {
      return [...pending];
    },
  };
}
