import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./socket", () => ({ emit: () => undefined }));

import { syncedKeys, wireKey } from "../../ui/settingsSync";
import { ApiRequestError } from "../errors";
import { db } from "./db";
import { createAccount } from "./ops";
import { handleRoute } from "./routes";
import { SETTINGS_KEYS } from "./settings";

let me = "";
const patch = (settings: Record<string, unknown>, version = 0): unknown => handleRoute("PATCH", "/users/@me/settings", { version, settings }, me);
const statusOf = (fn: () => unknown): number => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApiRequestError) return e.status;
    throw e;
  }
  return 200;
};

beforeEach(() => {
  for (const map of [db.accounts, db.channels, db.messages, db.guilds] as Map<string, unknown>[]) map.clear();
  me = createAccount({ username: "settings" }).user.id;
});

describe("mock /users/@me/settings validation", () => {
  it("allows exactly the keys the client syncs", () => {
    expect([...SETTINGS_KEYS.keys()].sort()).toEqual(syncedKeys().map(wireKey).sort());
  });

  it("rejects what the real server rejects", () => {
    expect(statusOf(() => patch({ message_group_gap: 99 }))).toBe(400);
    expect(statusOf(() => patch({ theme: "x".repeat(33) }))).toBe(400);
    expect(statusOf(() => patch({ time_format: "25" }))).toBe(400);
    expect(statusOf(() => patch({ message_spacing: "x" }))).toBe(400);
    expect(statusOf(() => patch({ locale: "x".repeat(17) }))).toBe(400);
    expect(statusOf(() => patch({ disabled_sounds: ["mute", "mute"] }))).toBe(400);
    expect(statusOf(() => patch({ disabled_sounds: Array.from({ length: 33 }, (_, i) => `s${i}`) }))).toBe(400);
    expect(statusOf(() => patch({ keybinds: [{ action: "a", keys: "Ctrl+A", extra: 1 }] }))).toBe(400);
    expect(statusOf(() => patch({ keybinds: Array.from({ length: 513 }, () => ({ action: "a", keys: "b" })) }))).toBe(400);
    expect(statusOf(() => patch({ unknown_key: true }))).toBe(400);
  });

  it("accepts valid values", () => {
    expect(patch({ message_group_gap: 16, disabled_sounds: ["mute", "message"], keybinds: [{ action: "a", keys: "Ctrl+A", global: true }] })).toMatchObject({ version: 1 });
  });
});
