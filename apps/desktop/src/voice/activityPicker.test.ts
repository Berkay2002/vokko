import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { filterActivities, loadRecent, MAX_RECENT, orderRecent, pushRecent, recentKey, saveRecent } from "./activityPicker";

const items = [
  { id: "watch-together", name: "Watch Together", description: "YouTube in sync" },
  { id: "builtin:chess", name: "Chess", description: "Classic two-player board game" },
  { id: "builtin:sketch", name: "Sketch", description: "Draw and guess" },
];

describe("filterActivities", () => {
  it("keeps everything for an empty or blank query", () => {
    expect(filterActivities(items, "")).toEqual(items);
    expect(filterActivities(items, "   ")).toEqual(items);
  });
  it("matches name and description, ignoring case", () => {
    expect(filterActivities(items, "CHESS").map(i => i.id)).toEqual(["builtin:chess"]);
    expect(filterActivities(items, "youtube").map(i => i.id)).toEqual(["watch-together"]);
  });
  it("needs every word, in any order", () => {
    expect(filterActivities(items, "board classic").map(i => i.id)).toEqual(["builtin:chess"]);
    expect(filterActivities(items, "chess draw")).toEqual([]);
  });
});

describe("recent ordering", () => {
  beforeEach(() => {
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("puts the newest first without duplicates and caps the list", () => {
    expect(pushRecent(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
    const many = Array.from({ length: MAX_RECENT }, (_, i) => `x${i}`);
    expect(pushRecent(many, "new")).toHaveLength(MAX_RECENT);
    expect(pushRecent(many, "new")[0]).toBe("new");
  });
  it("lists only what is still on offer, newest first", () => {
    expect(orderRecent(items, ["builtin:sketch", "gone", "watch-together"]).map(i => i.id)).toEqual(["builtin:sketch", "watch-together"]);
  });
  it("is stored per account and survives a corrupt entry", () => {
    saveRecent("1", ["a", "b"]);
    expect(loadRecent("1")).toEqual(["a", "b"]);
    expect(loadRecent("2")).toEqual([]);
    localStorage.setItem(recentKey("1"), "{not json");
    expect(loadRecent("1")).toEqual([]);
    localStorage.setItem(recentKey("1"), JSON.stringify(["a", 3, null]));
    expect(loadRecent("1")).toEqual(["a"]);
  });
});
