import { beforeEach, describe, expect, it, vi } from "vitest";

const events: { users: string[]; t: string; d: unknown }[] = [];
vi.mock("./socket", () => ({
  emit: (users: Iterable<string>, t: string, d: unknown) => {
    events.push({ users: [...users], t, d });
  },
}));

import { ApiRequestError } from "../errors";
import type { Attachment, User } from "../types";
import { db } from "./db";
import { createAccount } from "./ops";
import { handleRoute } from "./routes";

const ids: Record<string, string> = {};

const call = (who: string, method: string, path: string, body?: unknown): unknown => handleRoute(method, path, body ?? null, ids[who] ?? null);
const patch = (who: string, widgets: unknown, extra: Record<string, unknown> = {}): User => call(who, "PATCH", "/users/@me", { widgets, ...extra }) as User;
const errorOf = (fn: () => unknown): { status: number; code: number; fields: string[] } => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApiRequestError) return { status: e.status, code: e.code, fields: Object.keys(e.api.errors ?? {}) };
    throw e;
  }
  throw new Error("expected the call to fail");
};

function upload(who: string, id: string, contentType = "image/png"): Attachment {
  const attachment: Attachment = { id, filename: `${id}.png`, content_type: contentType, size: 10, url: `http://mock.local/attachments/${id}.png`, width: 4, height: 4 };
  db.pending.set(id, { attachment, owner: ids[who] ?? "" });
  return attachment;
}

beforeEach(() => {
  events.length = 0;
  for (const map of [db.accounts, db.channels, db.messages, db.guilds, db.invites, db.bans, db.pending] as Map<string, unknown>[]) map.clear();
  for (const name of ["owner", "other"]) ids[name] = createAccount({ username: name }).user.id;
});

describe("profile widgets", () => {
  it("stores, normalises, echoes images back, replaces as a whole and clears", () => {
    const cover = upload("owner", "9001");
    const tile = upload("owner", "9002");
    const user = patch("owner", {
      favorite_game: { name: " Hades ", image_attachment_id: cover.id, reason: " fast ", tags: [" roguelike ", "action"] },
      games_i_like: [{ name: "Celeste", image_attachment_id: tile.id }, { name: "Hollow Knight" }],
    });
    expect(user.widgets?.favorite_game).toEqual({ name: "Hades", image: cover.url, image_attachment_id: cover.id, reason: "fast", tags: ["roguelike", "action"] });
    expect(user.widgets?.games_i_like?.[1]).toEqual({ name: "Hollow Knight", image: null, image_attachment_id: null });
    expect(events.at(-1)?.t).toBe("USER_UPDATE");

    // another user reads the same value; unrelated edits leave it
    expect((call("other", "GET", `/users/${ids.owner}`) as User).widgets).toEqual(user.widgets);
    const bio = call("owner", "PATCH", "/users/@me", { bio: "hi" }) as User;
    expect(bio.widgets).toEqual(user.widgets);

    // echoing the shown value back keeps the images even once the pending upload is gone
    db.pending.clear();
    const echoed = patch("owner", { favorite_game: user.widgets?.favorite_game, games_i_like: user.widgets?.games_i_like });
    expect(echoed.widgets).toEqual(user.widgets);

    // the value is replaced as a whole
    expect(patch("owner", { games_i_like: [{ name: "Tunic" }] }).widgets).toEqual({ games_i_like: [{ name: "Tunic", image: null, image_attachment_id: null }] });
    expect(patch("owner", null).widgets).toBeNull();
    expect(patch("owner", {}).widgets).toBeNull();
  });

  it("accepts exactly the limits and rejects one over, changing nothing", () => {
    const edge = {
      favorite_game: { name: "n".repeat(64), reason: "r".repeat(190), tags: ["a", "b", "c", "d", "t".repeat(20)] },
      games_i_like: Array.from({ length: 20 }, (_, n) => ({ name: `Game ${n}` })),
    };
    expect(patch("owner", edge).widgets?.games_i_like).toHaveLength(20);
    const other = upload("other", "9100");
    const text = upload("owner", "9101", "text/plain");
    const bad: [unknown, string][] = [
      [{ favorite_game: { name: "Hades", reason: "r".repeat(191) } }, "widgets.favorite_game.reason"],
      [{ favorite_game: { name: "Hades", tags: ["a", "b", "c", "d", "e", "f"] } }, "widgets.favorite_game.tags"],
      [{ favorite_game: { name: "Hades", tags: [""] } }, "widgets.favorite_game.tags"],
      [{ favorite_game: { name: "Hades", tags: ["a", "A"] } }, "widgets.favorite_game.tags"],
      [{ favorite_game: { name: "Hades", tags: ["t".repeat(21)] } }, "widgets.favorite_game.tags"],
      [{ favorite_game: { name: "   " } }, "widgets.favorite_game.name"],
      [{ favorite_game: { name: "n".repeat(65) } }, "widgets.favorite_game.name"],
      [{ games_i_like: Array.from({ length: 21 }, (_, n) => ({ name: `Game ${n}` })) }, "widgets.games_i_like"],
      [{ games_i_like: [{ name: "" }] }, "widgets.games_i_like.0.name"],
      [{ games_i_like: [{ name: "Celeste", image_attachment_id: other.id }] }, "widgets.games_i_like.0.image_attachment_id"],
      [{ games_i_like: [{ name: "Celeste", image_attachment_id: text.id }] }, "widgets.games_i_like.0.image_attachment_id"],
      [{ games_i_like: [{ name: "Celeste", image_attachment_id: "424242" }] }, "widgets.games_i_like.0.image_attachment_id"],
      [{ wishlist: [] }, "widgets"],
    ];
    for (const [widgets, field] of bad) {
      const failure = errorOf(() => patch("owner", widgets, { bio: "changed" }));
      expect({ status: failure.status, code: failure.code }).toEqual({ status: 400, code: 50035 });
      expect(failure.fields, JSON.stringify(widgets)).toEqual([field]);
    }
    const me = call("owner", "GET", "/users/@me") as User;
    expect(me.bio).toBeNull();
    expect(me.widgets?.games_i_like).toHaveLength(20);
  });
});
