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

  it("clears with null and rejects unknown ids, bad colours and long pronouns", () => {
    call("member", "PATCH", "/users/@me", { avatar_decoration: "halo", pronouns: "she/her" });
    const cleared = call("member", "PATCH", "/users/@me", { avatar_decoration: null, pronouns: "" }) as User;
    expect(cleared.avatar_decoration).toBeNull();
    expect(cleared.pronouns).toBeNull();
    expect(errorOf(() => call("member", "PATCH", "/users/@me", { avatar_decoration: "nitro-gold" })).status).toBe(400);
    expect(errorOf(() => call("member", "PATCH", "/users/@me", { profile_effect: "nope" })).status).toBe(400);
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
