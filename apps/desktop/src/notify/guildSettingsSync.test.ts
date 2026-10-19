import { beforeEach, describe, expect, it, vi } from "vitest";

const { request } = vi.hoisted(() => {
  const items = new Map<string, string>();
  const storage = { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v), removeItem: (k: string) => void items.delete(k), clear: () => items.clear() };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  return { request: vi.fn() };
});
vi.mock("../api/rest", () => ({ request, resolveUrl: (url: string) => url, listActiveThreads: vi.fn() }));
vi.mock("../api/gateway", () => ({ gateway: { on: () => () => undefined, onStatus: () => () => undefined } }));

import { UNREADS_ONLY_MENTIONS, type ReadyEvent, type UserGuildSettings } from "../api/types";
import { FOREVER, muteFor, setNotifyLevel, toggleFlag, useLocalState } from "../shell/localState";
import { onReady, patchesBetween, withEntries } from "./guildSettingsSync";

const EMPTY = { mutedUntil: {}, notify: {}, hideMuted: {}, suppressEveryone: {}, suppressRoles: {} };
const ready = (entries: UserGuildSettings[]) =>
  ({
    user: { id: "u1" },
    guilds: [{ id: "g1", channels: [{ id: "c1", guild_id: "g1" }, { id: "cat1", guild_id: "g1" }] }, { id: "g2", channels: [{ id: "c2", guild_id: "g2" }] }],
    private_channels: [{ id: "dm1" }],
    user_guild_settings: entries,
  }) as unknown as ReadyEvent;
const entry = (guild_id: string | null, fields: Partial<UserGuildSettings> = {}): UserGuildSettings => ({
  guild_id, muted: false, mute_config: null, message_notifications: 3, flags: 0, suppress_everyone: false, suppress_roles: false, hide_muted_channels: false, channel_overrides: [], ...fields,
});

beforeEach(() => {
  localStorage.clear();
  request.mockReset().mockResolvedValue({});
  useLocalState.setState({ ...EMPTY });
});

describe("guild settings mapping", () => {
  it("turns local changes into per-guild PATCHes and server entries back into the cache", async () => {
    await onReady(ready([]));
    request.mockClear();
    const before = useLocalState.getState();
    const after = { ...before, mutedUntil: { g1: FOREVER, c1: Date.parse("2099-01-01T00:00:00Z"), thread9: FOREVER }, notify: { cat1: "unreads-mentions" as const, dm1: "none" as const }, suppressEveryone: { g1: true } };
    const patches = patchesBetween(before, after);
    expect(Object.fromEntries(patches)).toEqual({
      g1: {
        muted: true, mute_config: null, message_notifications: 3, flags: 0, suppress_everyone: true, suppress_roles: false, hide_muted_channels: false,
        channel_overrides: {
          c1: { muted: true, mute_config: { end_time: "2099-01-01T00:00:00.000Z" }, message_notifications: 3, flags: 0 },
          cat1: { muted: false, mute_config: null, message_notifications: 1, flags: UNREADS_ONLY_MENTIONS },
        },
      },
      "@me": { channel_overrides: { dm1: { muted: false, mute_config: null, message_notifications: 2, flags: 0 } } },
    });
    // The server's entries replace their guilds' ids; other ids (a thread mute) stay.
    const cache = withEntries(after, [entry("g1", { message_notifications: 0, channel_overrides: [{ channel_id: "c1", muted: true, mute_config: { end_time: null }, message_notifications: 3, flags: 0, collapsed: false }] })], guild => guild === "g1");
    expect(cache.mutedUntil).toEqual({ c1: FOREVER, thread9: FOREVER });
    expect(cache.notify).toEqual({ g1: "all", dm1: "none" });
    expect(cache.suppressEveryone).toEqual({});
  });

  it("PATCHes local changes after READY and applies nothing twice", async () => {
    await onReady(ready([]));
    request.mockClear();
    muteFor("c2", FOREVER);
    setNotifyLevel("g2", "mentions");
    toggleFlag("hideMuted", "g2");
    expect(request.mock.calls.map(call => [call[1], call[2]])).toEqual([
      ["/users/@me/guilds/g2/settings", { channel_overrides: { c2: { muted: true, mute_config: null, message_notifications: 3, flags: 0 } } }],
      ["/users/@me/guilds/g2/settings", expect.objectContaining({ message_notifications: 1, flags: 0 })],
      ["/users/@me/guilds/g2/settings", expect.objectContaining({ hide_muted_channels: true })],
    ]);
  });
});

describe("first sync on a device", () => {
  it("uploads live local values for guilds the account has nothing saved for, then takes the server's", async () => {
    useLocalState.setState({ mutedUntil: { g1: FOREVER, c2: Date.now() - 1000, dm1: FOREVER }, notify: { g2: "none" }, hideMuted: {}, suppressEveryone: {}, suppressRoles: {} });
    request.mockClear(); // (a previous test left the sync active, so that was PATCHed as a change)
    await onReady(ready([entry("g2", { message_notifications: 0 })]));
    expect(request.mock.calls.map(call => call[1]).sort()).toEqual(["/users/@me/guilds/@me/settings", "/users/@me/guilds/g1/settings"]);
    expect(useLocalState.getState().notify).toEqual({ g2: "all" });
    expect(localStorage.getItem("vokko.notify.syncedFor")).toBe("u1");

    // Later READYs upload nothing: the server is the truth for every guild.
    request.mockClear();
    await onReady(ready([entry("g1", { muted: true })]));
    expect(request).not.toHaveBeenCalled();
    expect(useLocalState.getState().mutedUntil).toEqual({ g1: FOREVER });
  });

  it("retries at the next READY when an upload fails", async () => {
    useLocalState.setState({ ...EMPTY, mutedUntil: { g1: FOREVER } });
    request.mockRejectedValueOnce(new Error("offline"));
    await onReady(ready([]));
    expect(localStorage.getItem("vokko.notify.syncedFor")).toBeNull();
  });
});
