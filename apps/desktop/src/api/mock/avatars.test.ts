import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./socket", () => ({ emit: () => undefined }));

import { ApiRequestError } from "../errors";
import type { Attachment, RecentAvatar, User } from "../types";
import { db, nextId } from "./db";
import { mockGif } from "./gifs";
import { createAccount, createGuildRecord } from "./ops";
import { handleRoute } from "./routes";

const ids: Record<string, string> = {};
let channelId = "";

const call = (who: string, method: string, path: string, body?: unknown): unknown => handleRoute(method, path, body ?? null, ids[who] ?? null);
const errorOf = (fn: () => unknown): { status: number; code: number } => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApiRequestError) return { status: e.status, code: e.code };
    throw e;
  }
  throw new Error("expected the call to fail");
};

function upload(who: string): Attachment {
  const id = nextId();
  const attachment: Attachment = { id, filename: "a.png", content_type: "image/png", size: 100, url: `blob:${id}`, width: 8, height: 8 };
  db.pending.set(id, { attachment, owner: ids[who] ?? "" });
  return attachment;
}

beforeEach(() => {
  for (const map of [db.accounts, db.channels, db.messages, db.guilds, db.pending, db.recentAvatars] as Map<string, unknown>[]) map.clear();
  db.gifProvider = "klipy";
  for (const name of ["sam", "alice"]) ids[name] = createAccount({ username: name }).user.id;
  const guild = createGuildRecord(ids.sam!, "Avatars");
  channelId = [...db.channels.values()].find(c => c.guild_id === guild && c.name === "general")!.id;
});

describe("recent avatars", () => {
  it("lists the last six avatars the user set, newest first, and moves a re-set one to the top", () => {
    expect(call("sam", "GET", "/users/@me/avatars")).toEqual([]);
    const sets = Array.from({ length: 8 }, () => upload("sam"));
    for (const a of sets) call("sam", "PATCH", "/users/@me", { avatar_attachment_id: a.id });
    const list = call("sam", "GET", "/users/@me/avatars") as RecentAvatar[];
    expect(list.map(a => a.id)).toEqual(sets.slice(2).reverse().map(a => a.id));
    expect(list[0]?.url).toBe(sets[7]!.url);

    const user = call("sam", "PATCH", "/users/@me", { avatar_attachment_id: sets[4]!.id }) as User;
    expect(user.avatar).toBe(sets[4]!.url);
    expect((call("sam", "GET", "/users/@me/avatars") as RecentAvatar[])[0]?.id).toBe(sets[4]!.id);
    expect(call("alice", "GET", "/users/@me/avatars")).toEqual([]);
    // clearing the avatar keeps the list
    call("sam", "PATCH", "/users/@me", { avatar_attachment_id: null });
    expect(call("sam", "GET", "/users/@me/avatars")).toHaveLength(6);
  });
});

describe("avatar from a picked GIF", () => {
  it("turns a GIF of the provider into a pending upload that PATCH /users/@me can claim", () => {
    const gif = mockGif("party", 1);
    const attachment = call("sam", "POST", "/users/@me/avatars/gif", { channel_id: channelId, url: gif.url }) as Attachment;
    expect(attachment).toMatchObject({ filename: "avatar.gif", content_type: "image/gif" });
    const user = call("sam", "PATCH", "/users/@me", { avatar_attachment_id: attachment.id }) as User;
    expect(user.avatar).toBe(attachment.url);
    expect((call("sam", "GET", "/users/@me/avatars") as RecentAvatar[]).map(a => a.id)).toEqual([attachment.id]);
  });

  it("refuses other hosts, a server without a GIF provider and unknown channels", () => {
    const gif = mockGif("party", 1);
    expect(errorOf(() => call("sam", "POST", "/users/@me/avatars/gif", { channel_id: channelId, url: "https://evil.example/a.gif" }))).toEqual({ status: 400, code: 50035 });
    expect(errorOf(() => call("sam", "POST", "/users/@me/avatars/gif", { channel_id: "999", url: gif.url }))).toMatchObject({ status: 404 });
    db.gifProvider = "none";
    expect(errorOf(() => call("sam", "POST", "/users/@me/avatars/gif", { channel_id: channelId, url: gif.url }))).toEqual({ status: 400, code: 50035 });
  });
});
