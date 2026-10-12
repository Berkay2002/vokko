import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "zustand";
import { ApiRequestError } from "../api/errors";
import type { UserSettings, UserSettingsData } from "../api/types";
import { DEFAULT_PREFS, type Prefs } from "./prefs";
import { DEVICE_LOCAL, createSettingsSync, isSynced, prefFromBlob, syncedKeys, wireKey, wireValue, type PendingRecord, type SettingsSync } from "./settingsSync";

/** In-memory twin of the server route: merge, null removes, version check → 409 with the current blob. */
class FakeServer {
  blob: UserSettings = { version: 0, settings: {} };
  patches: { version: number; settings: UserSettingsData }[] = [];
  async get(): Promise<UserSettings> {
    return structuredClone(this.blob);
  }
  async patch(body: { version: number; settings: UserSettingsData }): Promise<UserSettings> {
    this.patches.push(structuredClone(body));
    if (body.version !== this.blob.version) {
      throw new ApiRequestError(409, { code: 40090, message: "Settings version conflict", ...structuredClone(this.blob) } as never);
    }
    this.save(body.settings);
    return structuredClone(this.blob);
  }
  /** Another device saves. */
  save(settings: UserSettingsData): UserSettings {
    const next = { ...this.blob.settings };
    for (const [key, value] of Object.entries(settings)) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    this.blob = { version: this.blob.version + 1, settings: next };
    return structuredClone(this.blob);
  }
}

/** One device's localStorage: the syncedFor marker and the per-account pending records. */
class Device {
  syncedFor: string | null = null;
  pending = new Map<string, PendingRecord>();
}

interface SetupOptions {
  account?: string;
  device?: Device;
  server?: FakeServer;
  retryMs?: number[];
}

function setup(initial: Partial<Prefs> = {}, opts: SetupOptions = {}) {
  const server = opts.server ?? new FakeServer();
  const device = opts.device ?? new Device();
  const account = opts.account ?? "1";
  const store = create<Prefs>()(() => ({ ...DEFAULT_PREFS, ...initial }));
  const sync = createSettingsSync({
    getPrefs: () => store.getState(),
    setPrefs: patch => store.setState(patch),
    subscribe: listener => store.subscribe(listener),
    fetchSettings: () => server.get(),
    patchSettings: body => server.patch(body),
    accountId: () => account,
    getSyncedFor: () => device.syncedFor,
    setSyncedFor: id => {
      device.syncedFor = id;
    },
    loadPending: id => structuredClone(device.pending.get(id) ?? null),
    savePending: (id, record) => {
      if (record) device.pending.set(id, structuredClone(record));
      else device.pending.delete(id);
    },
    debounceMs: 500,
    retryMs: opts.retryMs,
  });
  const set = <K extends keyof Prefs>(key: K, value: Prefs[K]) => store.setState({ [key]: value } as Pick<Prefs, K>);
  return { server, store, sync, set, device };
}

/** A device that already synced with account "1" (the usual case after the first run). */
const syncedDevice = (account = "1"): Device => Object.assign(new Device(), { syncedFor: account });

let active: SettingsSync | null = null;
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  active?.stop();
  active = null;
  vi.useRealTimers();
});

describe("registry", () => {
  it("maps pref names to the server's snake_case keys", () => {
    expect(wireKey("use24hTime")).toBe("use_24h_time");
    expect(wireKey("timeFormat")).toBe("time_format");
    expect(wireKey("dmsFromServerMembers")).toBe("dms_from_server_members");
    expect(wireKey("theme")).toBe("theme");
  });

  it("syncs account prefs and keeps device prefs local", () => {
    for (const key of ["theme", "messageDisplay", "messageGroupGap", "locale", "keybinds", "streamerMode", "developerMode", "dmsFromServerMembers", "disabledSounds"] as const) {
      expect(isSynced(key), key).toBe(true);
    }
    for (const key of ["inputDevice", "outputDevice", "cameraDevice", "inputVolume", "outputVolume", "fontSize", "videoBackground", "noiseSuppression", "streamResolution"] as const) {
      expect(isSynced(key), key).toBe(false);
    }
  });

  it("puts every pref either in the synced registry or in DEVICE_LOCAL, never both", () => {
    const synced = new Set<string>(syncedKeys());
    const local = new Set<string>(DEVICE_LOCAL);
    expect([...local].filter(key => synced.has(key))).toEqual([]);
    expect(Object.keys(DEFAULT_PREFS).filter(key => !synced.has(key) && !local.has(key))).toEqual([]);
    expect([...local].filter(key => !(key in DEFAULT_PREFS))).toEqual([]);
  });

  it("stores defaults as removals and ignores malformed server values", () => {
    expect(wireValue("theme", DEFAULT_PREFS.theme)).toBeNull();
    expect(wireValue("theme", "light")).toBe("light");
    expect(prefFromBlob("fontSize", { font_size: "big" })).toBe(DEFAULT_PREFS.fontSize);
    expect(prefFromBlob("keybinds", { keybinds: "x" })).toEqual([]);
    expect(prefFromBlob("theme", { theme: "dark" })).toBe("dark");
    expect(prefFromBlob("theme", { theme: "a-theme-from-a-newer-build" })).toBe(DEFAULT_PREFS.theme);
    // a slider value between two stops (another device, an older build) is snapped like a stored one; ties go towards 1x
    expect(prefFromBlob("ttsRate", { [wireKey("ttsRate")]: 1.25 })).toBe(1.2);
    expect(prefFromBlob("ttsRate", { [wireKey("ttsRate")]: 0.75 })).toBe(0.8);
    expect(prefFromBlob("timeFormat", { time_format: "25" })).toBe("auto");
  });

  it("only takes a locale that is a BCP 47 tag and a group gap that is a slider stop", () => {
    expect(prefFromBlob("locale", { locale: "de-DE" })).toBe("de-DE");
    expect(prefFromBlob("locale", { locale: "not a tag!" })).toBe(DEFAULT_PREFS.locale);
    expect(prefFromBlob("messageGroupGap", { message_group_gap: 16 })).toBe(16);
    expect(prefFromBlob("messageGroupGap", { message_group_gap: 13 })).toBe(DEFAULT_PREFS.messageGroupGap);
  });

  it("sends disabled sounds as a list and reads the list back into the comma separated pref", () => {
    expect(wireValue("disabledSounds", "")).toBeNull();
    expect(wireValue("disabledSounds", "mute,message")).toEqual(["message", "mute"]);
    expect(prefFromBlob("disabledSounds", { disabled_sounds: ["user-join", "mention", "from-a-newer-build"] })).toBe("mention,user-join");
    expect(prefFromBlob("disabledSounds", { disabled_sounds: "mute" })).toBe("");
  });
});

describe("settings sync", () => {
  it("debounces a burst of local changes into one PATCH with only the synced keys", async () => {
    const { server, sync, set, store } = setup();
    active = sync;
    await sync.start();
    set("theme", "light");
    set("theme", "dark");
    set("timeFormat", "24");
    set("outputVolume", 40); // device-local
    await vi.advanceTimersByTimeAsync(499);
    expect(server.patches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.patches).toEqual([{ version: 0, settings: { theme: "dark", time_format: "24" } }]);
    expect(server.blob).toEqual({ version: 1, settings: { theme: "dark", time_format: "24" } });
    expect(sync.version).toBe(1);
    expect(sync.pending).toEqual([]);
    expect(store.getState().outputVolume).toBe(40);

    // Back to the default removes the key.
    set("timeFormat", "auto");
    await vi.advanceTimersByTimeAsync(500);
    expect(server.blob).toEqual({ version: 2, settings: { theme: "dark" } });
  });

  it("applies the account blob on start (server wins) and uploads local values on a fresh account", async () => {
    const fresh = setup({ theme: "light", inputVolume: 10 });
    active = fresh.sync;
    await fresh.sync.start();
    expect(fresh.server.blob).toEqual({ version: 1, settings: { theme: "light" } });
    expect(fresh.device.syncedFor).toBe("1");
    fresh.sync.stop();

    const existing = setup({ theme: "light", developerMode: true }, { device: syncedDevice() });
    active = existing.sync;
    existing.server.save({ theme: "ash" });
    await existing.sync.start();
    expect(existing.store.getState().theme).toBe("ash");
    // Absent on the account = default, even if this device had it on.
    expect(existing.store.getState().developerMode).toBe(false);
    expect(existing.server.patches).toHaveLength(0);
  });

  it("a second device's first sync keeps its own values for the keys the account never set", async () => {
    const keybinds = [{ action: "toggle-mute", keys: "Ctrl+Shift+M" }];
    const { server, sync, store } = setup({ theme: "light", developerMode: true, keybinds });
    active = sync;
    server.blob = { version: 3, settings: { locale: "de-DE" } };
    await sync.start();
    expect(store.getState().theme).toBe("light");
    expect(store.getState().developerMode).toBe(true);
    expect(store.getState().keybinds).toEqual(keybinds);
    expect(store.getState().locale).toBe("de-DE");
    expect(server.patches).toHaveLength(1);
    expect(server.patches[0]).toEqual({ version: 3, settings: { theme: "light", developer_mode: true, keybinds } });
    expect(server.blob.settings).toEqual({ locale: "de-DE", theme: "light", developer_mode: true, keybinds });
  });

  it("a device last synced with another account never uploads that account's values", async () => {
    // B's account is fresh: B starts from the defaults and nothing is sent.
    const fresh = setup({ dmsFromServerMembers: false, developerMode: true, locale: "sv-SE" }, { account: "2", device: syncedDevice("1") });
    active = fresh.sync;
    await fresh.sync.start();
    expect(fresh.server.patches).toHaveLength(0);
    expect(fresh.store.getState().dmsFromServerMembers).toBe(true);
    expect(fresh.store.getState().developerMode).toBe(false);
    expect(fresh.store.getState().locale).toBe("");
    expect(fresh.device.syncedFor).toBe("2");
    fresh.sync.stop();

    // B's account has settings: they win, and A's values for the keys B never set are not uploaded either.
    const existing = setup({ dmsFromServerMembers: false, theme: "light" }, { account: "2", device: syncedDevice("1") });
    active = existing.sync;
    existing.server.blob = { version: 2, settings: { theme: "dark" } };
    await existing.sync.start();
    expect(existing.server.patches).toHaveLength(0);
    expect(existing.store.getState().theme).toBe("dark");
    expect(existing.store.getState().dmsFromServerMembers).toBe(true);
  });

  it("applies USER_SETTINGS_UPDATE live without echoing it back, and ignores stale versions", async () => {
    const { server, sync, store } = setup();
    active = sync;
    await sync.start();
    sync.applyRemote(server.save({ developer_mode: true, locale: "en-GB" }));
    expect(store.getState().developerMode).toBe(true);
    expect(store.getState().locale).toBe("en-GB");
    await vi.advanceTimersByTimeAsync(2000);
    expect(server.patches).toHaveLength(0);
    sync.applyRemote({ version: 0, settings: { developer_mode: false } });
    expect(store.getState().developerMode).toBe(true);
  });

  it("on 409 takes the server's keys and re-applies our untouched edits", async () => {
    const { server, sync, set, store } = setup();
    active = sync;
    await sync.start();
    // Another device saves while this one has not heard about it (no event delivered).
    server.save({ theme: "dark", locale: "en-GB" });
    set("theme", "light"); // conflicts with the other device: server wins
    set("developerMode", true); // untouched elsewhere: re-applied
    await vi.advanceTimersByTimeAsync(500);
    expect(server.patches.map(p => p.version)).toEqual([0, 1]);
    expect(server.patches[1]).toEqual({ version: 1, settings: { developer_mode: true } });
    expect(server.blob).toEqual({ version: 2, settings: { theme: "dark", locale: "en-GB", developer_mode: true } });
    expect(store.getState().theme).toBe("dark");
    expect(store.getState().locale).toBe("en-GB");
    expect(store.getState().developerMode).toBe(true);
    expect(sync.pending).toEqual([]);
  });

  it("on 409 compares with the version the PATCH was based on, not one that arrived while it was out", async () => {
    const { server, sync, set, store } = setup();
    active = sync;
    await sync.start();
    let release: () => void = () => undefined;
    const original = server.patch.bind(server);
    server.patch = body => new Promise((resolve, reject) => (release = () => original(body).then(resolve, reject)));
    set("theme", "light");
    await vi.advanceTimersByTimeAsync(500);
    // Another device changes the theme and its event arrives while our PATCH (based on version 0) is out.
    sync.applyRemote(server.save({ theme: "dark" }));
    server.patch = original;
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(server.blob.settings).toEqual({ theme: "dark" });
    expect(store.getState().theme).toBe("dark");
    expect(sync.pending).toEqual([]);
  });

  it("keeps a key pending when it changes again while its PATCH is in flight", async () => {
    const { server, sync, set } = setup();
    active = sync;
    await sync.start();
    let release: () => void = () => undefined;
    const slow = server.patch.bind(server);
    server.patch = body => new Promise(resolve => (release = () => resolve(slow(body))));
    set("theme", "light");
    await vi.advanceTimersByTimeAsync(500);
    set("theme", "dark");
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(sync.pending).toEqual(["theme"]);
    server.patch = slow;
    await vi.advanceTimersByTimeAsync(500);
    expect(server.blob.settings).toEqual({ theme: "dark" });
    expect(sync.pending).toEqual([]);
  });
});

describe("unsent changes", () => {
  it("survive a quit inside the debounce and are pushed on the next start", async () => {
    const device = syncedDevice();
    const server = new FakeServer();
    server.save({ locale: "en-GB" });
    const first = setup({ locale: "en-GB" }, { device, server });
    active = first.sync;
    await first.sync.start();
    first.set("theme", "light");
    expect(device.pending.get("1")?.values).toEqual({ theme: "light" });
    // Quit: the debounce never fires and the instance is gone.
    first.sync.stop();
    expect(server.patches).toHaveLength(0);

    const second = setup({ locale: "en-GB", theme: "light" }, { device, server });
    active = second.sync;
    await second.sync.start();
    expect(second.store.getState().theme).toBe("light");
    expect(server.blob.settings).toEqual({ locale: "en-GB", theme: "light" });
    expect(device.pending.has("1")).toBe(false);
  });

  it("are restored for their account even after another account used the device", async () => {
    const device = syncedDevice();
    device.pending.set("1", { version: 0, base: { theme: null }, values: { theme: "light" } });
    device.syncedFor = "2";
    const { server, sync, store } = setup({ theme: "dark" }, { device });
    active = sync;
    await sync.start();
    expect(store.getState().theme).toBe("light");
    expect(server.blob.settings).toEqual({ theme: "light" });
  });

  it("lose to a change another device made to the same key after them", async () => {
    const device = syncedDevice();
    device.pending.set("1", { version: 0, base: { theme: null }, values: { theme: "light", developerMode: true } });
    const { server, sync, store } = setup({ theme: "light", developerMode: true }, { device });
    server.save({ theme: "ash" });
    active = sync;
    await sync.start();
    expect(store.getState().theme).toBe("ash");
    expect(server.blob.settings).toEqual({ theme: "ash", developer_mode: true });
  });

  it("are retried with backoff after a network error", async () => {
    const { server, sync, set } = setup({}, { device: syncedDevice(), retryMs: [5_000, 30_000] });
    active = sync;
    await sync.start();
    const original = server.patch.bind(server);
    let failures = 2;
    server.patch = async body => {
      if (failures > 0) {
        failures -= 1;
        throw new ApiRequestError(0, { code: 0, message: "Network error" });
      }
      return original(body);
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    set("theme", "light");
    await vi.advanceTimersByTimeAsync(500);
    expect(server.blob.settings).toEqual({});
    await vi.advanceTimersByTimeAsync(5_000);
    expect(server.blob.settings).toEqual({});
    await vi.advanceTimersByTimeAsync(29_999);
    expect(server.blob.settings).toEqual({});
    await vi.advanceTimersByTimeAsync(1);
    expect(server.blob.settings).toEqual({ theme: "light" });
    expect(sync.pending).toEqual([]);
    warn.mockRestore();
  });
});

describe("settings sync errors", () => {
  it("drops keys the server refuses and still pushes the others", async () => {
    const { server, sync, set } = setup();
    active = sync;
    await sync.start();
    const original = server.patch.bind(server);
    server.patch = async body => {
      if ("locale" in body.settings) {
        server.patches.push(structuredClone(body));
        throw new ApiRequestError(400, { code: 50035, message: "Invalid Form Body", errors: { settings: { locale: { _errors: [] } } } });
      }
      return original(body);
    };
    set("locale", "xx-unknown-and-too-long");
    set("developerMode", true);
    await vi.advanceTimersByTimeAsync(500);
    expect(server.blob.settings).toEqual({ developer_mode: true });
    expect(sync.pending).toEqual([]);
  });
});
