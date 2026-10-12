import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./socket", () => ({ emit: () => undefined }));

import { syncedKeys, wireKey } from "../../ui/settingsSync";
import { ApiRequestError } from "../errors";
import { RelationshipType } from "../types";
import { db } from "./db";
import { createAccount, createGuildRecord } from "./ops";
import { handleRoute } from "./routes";
import { SETTINGS_KEYS } from "./settings";
import { setRelationship } from "./views";

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

describe("mock per-guild privacy and DM enforcement", () => {
  const as = (who: string, method: string, path: string, body: unknown = {}) => handleRoute(method, path, body, who);
  const code = (fn: () => unknown): number | null => {
    try {
      fn();
    } catch (e) {
      if (e instanceof ApiRequestError) return e.code ?? e.status;
      throw e;
    }
    return null;
  };
  let other = "";
  let g1 = "";
  let g2 = "";
  beforeEach(() => {
    other = createAccount({ username: "stranger" }).user.id;
    g1 = createGuildRecord(me, "One");
    g2 = createGuildRecord(me, "Two");
    for (const g of [g1, g2]) db.guilds.get(g)!.members.set(other, { ...db.guilds.get(g)!.members.get(me)!, roles: [] });
  });
  const openDm = (who: string, target: string) => as(who, "POST", "/users/@me/channels", { recipient_id: target });
  const restrict = (guild: string, on: boolean) => as(me, "PATCH", `/users/@me/guilds/${guild}/privacy`, { direct_messages: !on });

  it("GET defaults to true; PATCH round-trips", () => {
    expect(as(me, "GET", `/users/@me/guilds/${g1}/privacy`)).toEqual({ direct_messages: true });
    expect(restrict(g1, true)).toEqual({ direct_messages: false });
    expect(as(me, "GET", `/users/@me/guilds/${g1}/privacy`)).toEqual({ direct_messages: false });
    expect(as(me, "GET", `/users/@me/guilds/${g2}/privacy`)).toEqual({ direct_messages: true });
  });

  it("validates the body and membership", () => {
    expect(code(() => as(me, "PATCH", `/users/@me/guilds/${g1}/privacy`, {}))).toBe(50035);
    expect(code(() => as(me, "PATCH", `/users/@me/guilds/${g1}/privacy`, { direct_messages: "no" }))).toBe(50035);
    const outsider = createAccount({ username: "outsider" }).user.id;
    expect(code(() => as(outsider, "GET", `/users/@me/guilds/${g1}/privacy`))).toBe(10004);
    expect(code(() => as(outsider, "PATCH", `/users/@me/guilds/${g1}/privacy`, { direct_messages: false }))).toBe(10004);
    expect(code(() => as(outsider, "PATCH", `/users/@me/guilds/${g1}/privacy`, {}))).toBe(50035);
    expect(code(() => as(me, "GET", "/users/@me/guilds/999999999/privacy"))).toBe(10004);
  });

  it("restricting the only shared guild blocks sending; another shared guild allows it", () => {
    const dm = (openDm(other, me) as { id: string }).id;
    const send = () => as(other, "POST", `/channels/${dm}/messages`, { content: "hi" });
    expect(code(send)).toBeNull();
    restrict(g1, true);
    expect(code(send)).toBeNull(); // g2 is still open
    restrict(g2, true);
    expect(code(send)).toBe(50007);
    restrict(g2, false);
    expect(code(send)).toBeNull();
  });

  it("blocks opening a new DM when every shared guild is restricted, unless friends", () => {
    restrict(g1, true);
    restrict(g2, true);
    expect(code(() => openDm(other, me))).toBe(50007);
    setRelationship(me, other, RelationshipType.Friend, RelationshipType.Friend);
    expect(code(() => openDm(other, me))).toBeNull();
  });
});
