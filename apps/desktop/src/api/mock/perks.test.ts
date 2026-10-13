import { beforeEach, describe, expect, it, vi } from "vitest";

const events: { users: string[]; t: string; d: unknown }[] = [];
vi.mock("./socket", () => ({
  emit: (users: Iterable<string>, t: string, d: unknown) => {
    events.push({ users: [...users], t, d });
  },
}));

import { ApiRequestError } from "../errors";
import type { Guild, GuildMember, User, UserProfile } from "../types";
import { db } from "./db";
import { createAccount, createGuildRecord } from "./ops";
import { handleRoute } from "./routes";

const ids: Record<string, string> = {};
let guildId = "";

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
const eventsOf = (t: string) => events.filter(e => e.t === t);
const TAG = { tag: "VKK", badge: "sword", color_primary: 0x5865f2, color_secondary: 0xffffff };

beforeEach(() => {
  events.length = 0;
  for (const map of [db.accounts, db.channels, db.messages, db.guilds, db.invites, db.bans, db.pending] as Map<string, unknown>[]) map.clear();
  for (const name of ["owner", "member", "outsider"]) ids[name] = createAccount({ username: name }).user.id;
  guildId = createGuildRecord(ids.owner!, "Perk guild");
  db.guilds.get(guildId)!.members.set(ids.member!, { nick: null, roles: [], joined_at: new Date().toISOString() });
  events.length = 0;
});

describe("user profile perks", () => {
  it("stores pronouns, theme colours, decoration and effect and broadcasts USER_UPDATE", () => {
    const user = call("member", "PATCH", "/users/@me", {
      pronouns: "  they/them ",
      theme_colors: [0x1f5a38, 0x57d28f],
      avatar_decoration: "halo",
      profile_effect: "snowfall",
    }) as User;
    expect(user.pronouns).toBe("they/them");
    expect(user.theme_colors).toEqual([0x1f5a38, 0x57d28f]);
    expect(user.avatar_decoration).toBe("halo");
    expect(user.profile_effect).toBe("snowfall");
    const update = eventsOf("USER_UPDATE").find(e => (e.d as User).id === ids.member);
    expect(update?.users).toContain(ids.owner);
  });

  it("clears with null and rejects malformed ids, bad colours and long pronouns", () => {
    call("member", "PATCH", "/users/@me", { avatar_decoration: "halo", pronouns: "she/her" });
    const cleared = call("member", "PATCH", "/users/@me", { avatar_decoration: null, pronouns: "" }) as User;
    expect(cleared.avatar_decoration).toBeNull();
    expect(cleared.pronouns).toBeNull();
    // unknown but well-formed ids are stored, as on the server (the client ignores ids it does not ship)
    expect((call("member", "PATCH", "/users/@me", { avatar_decoration: "nitro-gold" }) as User).avatar_decoration).toBe("nitro-gold");
    expect(errorOf(() => call("member", "PATCH", "/users/@me", { avatar_decoration: "Nitro Gold" })).status).toBe(400);
    expect(errorOf(() => call("member", "PATCH", "/users/@me", { profile_effect: "NOPE!" })).status).toBe(400);
    expect(errorOf(() => call("member", "PATCH", "/users/@me", { theme_colors: [1, 0x1000000] })).status).toBe(400);
    expect(errorOf(() => call("member", "PATCH", "/users/@me", { pronouns: "x".repeat(41) })).status).toBe(400);
  });
});

describe("server tags", () => {
  it("needs MANAGE_GUILD to set, then members adopt it and wear it until it is removed", () => {
    expect(errorOf(() => call("member", "PATCH", `/guilds/${guildId}`, { tag: TAG })).code).toBe(50013);
    const guild = call("owner", "PATCH", `/guilds/${guildId}`, { tag: TAG }) as Guild;
    expect(guild.tag).toEqual(TAG);

    const adopted = call("member", "PATCH", "/users/@me", { primary_guild_id: guildId }) as User;
    expect(adopted.primary_guild).toEqual({ guild_id: guildId, ...TAG });

    events.length = 0;
    call("owner", "PATCH", `/guilds/${guildId}`, { tag: { ...TAG, tag: "NEW" } });
    expect(db.accounts.get(ids.member!)!.user.primary_guild?.tag).toBe("NEW");
    expect(eventsOf("USER_UPDATE").length).toBeGreaterThan(0);

    call("owner", "PATCH", `/guilds/${guildId}`, { tag: null });
    expect(db.accounts.get(ids.member!)!.user.primary_guild).toBeNull();
  });

  it("rejects adopting a tag of a guild you are not in or that has none, and validates the tag", () => {
    expect(errorOf(() => call("member", "PATCH", "/users/@me", { primary_guild_id: guildId })).status).toBe(400);
    call("owner", "PATCH", `/guilds/${guildId}`, { tag: TAG });
    expect(errorOf(() => call("outsider", "PATCH", "/users/@me", { primary_guild_id: guildId })).status).toBe(400);
    expect(errorOf(() => call("owner", "PATCH", `/guilds/${guildId}`, { tag: { ...TAG, tag: "TOOLONG" } })).status).toBe(400);
    expect(errorOf(() => call("owner", "PATCH", `/guilds/${guildId}`, { tag: { ...TAG, badge: "discord-nitro" } })).status).toBe(400);
  });

  it("leaving the server takes the tag off", () => {
    call("owner", "PATCH", `/guilds/${guildId}`, { tag: TAG });
    call("member", "PATCH", "/users/@me", { primary_guild_id: guildId });
    call("member", "DELETE", `/users/@me/guilds/${guildId}`);
    expect(db.accounts.get(ids.member!)!.user.primary_guild).toBeNull();
  });
});

describe("per-server profiles", () => {
  it("overrides the profile inside the guild only and sends GUILD_MEMBER_UPDATE", () => {
    call("member", "PATCH", "/users/@me", { pronouns: "he/him", bio: "global bio" });
    events.length = 0;
    const member = call("member", "PATCH", `/guilds/${guildId}/members/@me`, { pronouns: "they/them", bio: "server bio", theme_colors: [0x14507a, 0x74b7f5] }) as GuildMember;
    expect(member.pronouns).toBe("they/them");
    expect(member.bio).toBe("server bio");
    expect(member.theme_colors).toEqual([0x14507a, 0x74b7f5]);
    expect(eventsOf("GUILD_MEMBER_UPDATE")).toHaveLength(1);

    const inGuild = call("owner", "GET", `/users/${ids.member}/profile?guild_id=${guildId}`) as UserProfile;
    expect(inGuild.guild_member?.pronouns).toBe("they/them");
    expect(inGuild.user.pronouns).toBe("he/him");

    const cleared = call("member", "PATCH", `/guilds/${guildId}/members/@me`, { pronouns: null, bio: null }) as GuildMember;
    expect(cleared.pronouns).toBeUndefined();
    expect(cleared.bio).toBeUndefined();
  });

  it("requires membership", () => {
    expect(errorOf(() => call("outsider", "PATCH", `/guilds/${guildId}/members/@me`, { pronouns: "x" })).status).toBe(403);
  });
});

describe("nameplate and display name styles", () => {
  it("stores well-formed ids (known or not, like the server) and rejects malformed ones", () => {
    const style = { font_id: "serif", effect_id: "gradient", colors: [0xff0000, 0x0000ff] };
    const me = call("owner", "PATCH", "/users/@me", { nameplate: "aurora", display_name_styles: style }) as User;
    expect(me.nameplate).toBe("aurora");
    expect(me.display_name_styles).toEqual(style);
    expect((call("owner", "PATCH", "/users/@me", { nameplate: "nope" }) as User).nameplate).toBe("nope");
    expect((call("owner", "PATCH", "/users/@me", { display_name_styles: { font_id: "comic", effect_id: "solid", colors: [1] } }) as User).display_name_styles?.font_id).toBe("comic");
    expect(errorOf(() => call("owner", "PATCH", "/users/@me", { nameplate: "Bad Id" })).code).toBe(50035);
    for (const bad of [
      { font_id: "", effect_id: "solid", colors: [1] },
      { font_id: "serif", effect_id: "NOPE!", colors: [1] },
      { font_id: "serif", colors: [1] },
      { font_id: "serif", effect_id: "solid", colors: [] },
      { font_id: "serif", effect_id: "solid", colors: [1, 2, 3] },
      { font_id: "serif", effect_id: "solid", colors: [0x1000000] },
    ]) {
      expect(errorOf(() => call("owner", "PATCH", "/users/@me", { display_name_styles: bad })).code).toBe(50035);
    }
    const cleared = call("owner", "PATCH", "/users/@me", { nameplate: null, display_name_styles: null }) as User;
    expect(cleared.nameplate).toBeNull();
    expect(cleared.display_name_styles).toBeNull();
  });
});

describe("profile frame", () => {
  it("stores a well-formed id, rejects malformed ones without changing anything, and clears", () => {
    expect((call("owner", "PATCH", "/users/@me", { profile_frame: "gold-filigree" }) as User).profile_frame).toBe("gold-filigree");
    for (const bad of ["Bad Id", "f".repeat(65), "frame!"]) expect(errorOf(() => call("owner", "PATCH", "/users/@me", { profile_frame: bad })).code).toBe(50035);
    expect((call("owner", "PATCH", "/users/@me", { bio: "hi" }) as User).profile_frame).toBe("gold-filigree");
    expect((call("owner", "PATCH", "/users/@me", { profile_frame: null }) as User).profile_frame).toBeNull();
  });
});

describe("super reactions", () => {
  const channelOf = () => [...db.channels.values()].find(c => c.guild_id === guildId && c.name === "general")!.id;

  it("counts bursts apart from normal reactions and announces the type", () => {
    const channel = channelOf();
    const message = call("owner", "POST", `/channels/${channel}/messages`, { content: "react" }) as { id: string };
    const base = `/channels/${channel}/messages/${message.id}/reactions/${encodeURIComponent("🔥")}`;
    call("owner", "PUT", `${base}/@me?type=1`);
    call("member", "PUT", `${base}/@me?type=1`);
    call("member", "PUT", `${base}/@me`);
    const add = eventsOf("MESSAGE_REACTION_ADD").map(e => e.d as { type: number; burst: boolean });
    expect(add.map(e => [e.type, e.burst])).toEqual([[1, true], [1, true], [0, false]]);

    const [seen] = call("owner", "GET", `/channels/${channel}/messages`) as { reactions: { count: number; count_details: unknown; me: boolean; me_burst: boolean; burst_colors: unknown }[] }[];
    expect(seen!.reactions).toEqual([{ emoji: { id: null, name: "🔥" }, count: 3, count_details: { normal: 1, burst: 2 }, burst_colors: [], me: false, me_burst: true }]);
    expect((call("owner", "GET", `${base}?type=1`) as User[]).length).toBe(2);
    expect((call("owner", "GET", base) as User[]).map(u => u.id)).toEqual([ids.member]);
    expect(errorOf(() => call("owner", "GET", `${base}?type=3`)).code).toBe(50035);

    call("owner", "DELETE", `${base}/@me?type=1`);
    expect((eventsOf("MESSAGE_REACTION_REMOVE")[0]!.d as { type: number }).type).toBe(1);
    const [after] = call("owner", "GET", `/channels/${channel}/messages`) as { reactions: { count_details: unknown; me_burst: boolean }[] }[];
    expect(after!.reactions[0]).toMatchObject({ count_details: { normal: 1, burst: 1 }, me_burst: false });
  });
});

describe("mutual friends", () => {
  const befriend = (a: string, b: string) => {
    call(a, "PUT", `/users/@me/relationships/${ids[b]}`, {});
    call(b, "PUT", `/users/@me/relationships/${ids[a]}`, {});
  };
  const block = (a: string, b: string) => call(a, "PUT", `/users/@me/relationships/${ids[b]}`, { type: 2 });
  const mutuals = (who: string, other: string) => (call(who, "GET", `/users/${ids[other]}/relationships`) as User[]).map(u => u.id);
  const countOf = (who: string, other: string) => (call(who, "GET", `/users/${ids[other]}/profile`) as UserProfile).mutual_friends_count;

  beforeEach(() => {
    ids.pal = createAccount({ username: "pal" }).user.id;
    befriend("owner", "pal");
    befriend("member", "pal");
  });

  it("lists shared friends and matches the profile count", () => {
    expect(mutuals("owner", "member")).toEqual([ids.pal]);
    expect(countOf("owner", "member")).toBe(1);
  });

  it("is empty for yourself", () => {
    expect(mutuals("owner", "owner")).toEqual([]);
    expect(countOf("owner", "owner")).toBe(0);
  });

  it("is empty when either side blocked the other", () => {
    block("owner", "member");
    expect(mutuals("owner", "member")).toEqual([]);
    expect(mutuals("member", "owner")).toEqual([]);
    expect(countOf("member", "owner")).toBe(0);
  });

  it("is empty without a shared context", () => {
    befriend("outsider", "pal");
    expect(mutuals("owner", "outsider")).toEqual([]);
    expect(countOf("owner", "outsider")).toBe(0);
  });

  it("leaves out mutual friends that are blocked", () => {
    block("owner", "pal");
    expect(mutuals("owner", "member")).toEqual([]);
    expect(countOf("owner", "member")).toBe(0);
  });

  it("404s for an unknown user", () => {
    expect(errorOf(() => call("owner", "GET", "/users/999999999/relationships"))).toEqual({ status: 404, code: 10013 });
  });
});
