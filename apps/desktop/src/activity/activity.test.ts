import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreApi, UseBoundStore } from "zustand";
import type { RunningProcess } from "../desktop/games";

const mocks = vi.hoisted(() => ({ processes: [] as RunningProcess[], resend: vi.fn() }));
const fakeApp = vi.hoisted(() => ({ store: null as unknown }));

vi.mock("../desktop", () => ({ isDesktop: () => true }));
vi.mock("../desktop/games", async importOriginal => ({ ...(await importOriginal<typeof import("../desktop/games")>()), listProcesses: async () => mocks.processes }));
vi.mock("../shell/actions", () => ({ resendOwnStatus: mocks.resend }));
// Only `connection` matters here; the real gateway drives it in activity.reconnect.test.ts.
vi.mock("../api/store", async () => {
  const { create: make } = await import("zustand");
  const store = make<{ connection: string }>(() => ({ connection: "disconnected" }));
  fakeApp.store = store;
  return { appStore: store };
});

import { activitiesFor, addRegisteredGame, removeRegisteredGame, setShareActivity, startGameDetection, useActivity } from "./index";
import { formatClock, formatPlaytime, playingActivity } from "./format";
import { getOwnActivities } from "./own";

type Fake = UseBoundStore<StoreApi<{ connection: string }>>;
const app = () => fakeApp.store as Fake;
const proc = (name: string, startedAt = 60_000): RunningProcess => ({ name, startedAt, system: false });

beforeEach(() => {
  vi.useFakeTimers();
  mocks.processes = [];
  mocks.resend.mockReset();
  app().setState({ connection: "disconnected" });
  useActivity.setState({ share: true, registered: [], running: null, detected: null });
});

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
  vi.useRealTimers();
});

/** Advances the clock a little past `ms`, so timers that a poll schedules for "now" have run too. */
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms + 50);

describe("activitiesFor", () => {
  it("never sends Spotify until the user turns it on", () => {
    expect(useActivity.getState().spotify).toBe(false);
  });

  it("is a single Playing activity with the start time", () => {
    expect(activitiesFor({ share: true, detected: { name: "Factorio", exe: "factorio.exe", startedAt: 1234 } })).toEqual([{ name: "Factorio", type: 0, timestamps: { start: 1234 } }]);
  });

  it("omits timestamps when the start is unknown, and is empty when sharing is off or nothing is detected", () => {
    expect(activitiesFor({ share: true, detected: { name: "Factorio", exe: "f.exe", startedAt: 0 } })).toEqual([{ name: "Factorio", type: 0 }]);
    expect(activitiesFor({ share: false, detected: { name: "Factorio", exe: "f.exe", startedAt: 5 } })).toEqual([]);
    expect(activitiesFor({ share: true, detected: null })).toEqual([]);
  });

  it("keeps names within the server's 128 characters", () => {
    const [activity] = activitiesFor({ share: true, detected: { name: "x".repeat(300), exe: "x.exe", startedAt: 1 } });
    expect(activity?.name).toHaveLength(128);
  });

  it("counts code points like the server and never cuts an emoji in half", () => {
    // 127 letters, then an emoji that is two UTF-16 units: the 128th code point must stay whole.
    const [activity] = activitiesFor({ share: true, detected: { name: `${"x".repeat(127)}🎮🎮🎮`, exe: "x.exe", startedAt: 1 } });
    expect(Array.from(activity?.name ?? "")).toHaveLength(128);
    expect(activity?.name.endsWith("🎮")).toBe(true);
    // a lone surrogate would be serialised as a \udXXX escape, which the server's JSON parser rejects
    expect(JSON.stringify(activity).toLowerCase()).not.toContain("\\ud");
  });

  it("drops control, zero-width and bidi characters the server would close the connection for", () => {
    const [activity] = activitiesFor({ share: true, detected: { name: "El​den‮ Ring\n\u0007", exe: "x.exe", startedAt: 1 } });
    expect(activity?.name).toBe("Elden Ring");
    expect(activitiesFor({ share: true, detected: { name: "​ ‮", exe: "x.exe", startedAt: 1 } })).toEqual([]);
  });
});

describe("presence sync", () => {
  it("sends once when a game is detected, again after a reconnect, and clears when it closes", async () => {
    app().setState({ connection: "ready" });
    stop = startGameDetection();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.resend).not.toHaveBeenCalled();

    mocks.processes = [proc("factorio.exe", 42_000)];
    await tick(15_000);
    expect(mocks.resend).toHaveBeenCalledTimes(1);
    expect(getOwnActivities()).toEqual([{ name: "Factorio", type: 0, timestamps: { start: 42_000 } }]);

    // the same game on the next poll is not sent again
    await tick(15_000);
    expect(mocks.resend).toHaveBeenCalledTimes(1);

    // a new connection starts without an activity on the server
    app().setState({ connection: "reconnecting" });
    app().setState({ connection: "ready" });
    await tick(12_000);
    expect(mocks.resend).toHaveBeenCalledTimes(2);

    mocks.processes = [];
    await tick(15_000);
    expect(mocks.resend).toHaveBeenCalledTimes(3);
    expect(getOwnActivities()).toEqual([]);
  });

  it("does not send while not connected, then sends once ready", async () => {
    mocks.processes = [proc("terraria.exe")];
    stop = startGameDetection();
    await vi.advanceTimersByTimeAsync(0);
    expect(useActivity.getState().detected?.name).toBe("Terraria");
    expect(mocks.resend).not.toHaveBeenCalled();
    app().setState({ connection: "ready" });
    await tick(12_000);
    expect(mocks.resend).toHaveBeenCalledTimes(1);
  });

  it("turning sharing off clears the activity", async () => {
    app().setState({ connection: "ready" });
    mocks.processes = [proc("terraria.exe")];
    stop = startGameDetection();
    await vi.advanceTimersByTimeAsync(0);
    await tick(12_000);
    expect(getOwnActivities()).toHaveLength(1);
    setShareActivity(false);
    await tick(12_000);
    expect(getOwnActivities()).toEqual([]);
    expect(mocks.resend).toHaveBeenCalledTimes(2);
  });

  it("spaces updates so op 3 stays under its 5 per minute", async () => {
    app().setState({ connection: "ready" });
    stop = startGameDetection();
    await vi.advanceTimersByTimeAsync(0);
    for (const exe of ["terraria.exe", "factorio.exe", "valheim.exe", "hades.exe"]) {
      mocks.processes = [proc(exe)];
      useActivity.setState({ detected: null });
      await tick(15_000);
    }
    expect(mocks.resend.mock.calls.length).toBeLessThanOrEqual(5);
  });
});

describe("registered games", () => {
  it("adds a running app by executable and detects it", () => {
    useActivity.setState({ running: [proc("mygame.exe")] });
    addRegisteredGame(proc("mygame.exe"));
    expect(useActivity.getState().registered).toEqual([{ name: "mygame", exe: ["mygame.exe"] }]);
    expect(useActivity.getState().detected?.name).toBe("mygame");
    addRegisteredGame(proc("MyGame.EXE"));
    expect(useActivity.getState().registered).toHaveLength(1);
    removeRegisteredGame("mygame.exe");
    expect(useActivity.getState().registered).toEqual([]);
    expect(useActivity.getState().detected).toBeNull();
  });
});

describe("presence formatting", () => {
  it("finds the Playing activity of a presence", () => {
    expect(playingActivity({ activities: [{ name: "Factorio", type: 0 }] })?.name).toBe("Factorio");
    expect(playingActivity({ activities: [] })).toBeNull();
    expect(playingActivity(undefined)).toBeNull();
  });

  it("formats elapsed time compactly", () => {
    const start = 1_000_000;
    const at = (ms: number) => formatPlaytime(start, start + ms);
    expect(at(10_000)).toBe("<1m");
    expect(at(12 * 60_000)).toBe("12m");
    expect(at(65 * 60_000)).toBe("1h 05m");
    expect(at((26 * 60 + 5) * 60_000)).toBe("1d 2h");
    expect(formatPlaytime(undefined, start)).toBe("");
  });

  it("formats the live clock", () => {
    expect(formatClock(0, 5_000)).toBe("0:05");
    expect(formatClock(0, 12 * 60_000 + 3_000)).toBe("12:03");
    expect(formatClock(0, 3_723_000)).toBe("1:02:03");
  });
});
