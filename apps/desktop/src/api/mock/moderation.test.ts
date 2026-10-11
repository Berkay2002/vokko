import { beforeEach, describe, expect, it, vi } from "vitest";

const events: { users: string[]; t: string; d: unknown }[] = [];
vi.mock("./socket", () => ({
  emit: (users: Iterable<string>, t: string, d: unknown) => {
    events.push({ users: [...users], t, d });
  },
}));

import { ApiRequestError } from "../errors";
import { DEFAULT_EVERYONE, Perm } from "../permissions";
import { ChannelType, OverwriteType, type Ban, type Channel, type GuildMember, type Message, type Role } from "../types";
import { db } from "./db";
import { addChannel, addMessage, createAccount, createGuildRecord } from "./ops";
import { handleRoute } from "./routes";

const ids: Record<string, string> = {};
let guildId = "";
let generalId = "";

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
const bits = (...p: bigint[]) => p.reduce((a, b) => a | b, 0n).toString();

function roleOf(name: string): Role {
  const role = db.guilds.get(guildId)?.guild.roles.find(r => r.name === name);
  if (!role) throw new Error(`no role ${name}`);
  return role;
}

beforeEach(() => {
  events.length = 0;
  for (const map of [db.accounts, db.channels, db.messages, db.guilds, db.invites, db.bans, db.pending] as Map<string, unknown>[]) map.clear();
  for (const name of ["owner", "admin", "mod", "helper", "plain", "other", "outsider"]) ids[name] = createAccount({ username: name }).user.id;
  guildId = createGuildRecord(ids.owner!, "Test guild");
  const guild = db.guilds.get(guildId)!;
  guild.guild.roles.push(
    { id: "9001", name: "admin", color: 0, hoist: false, position: 3, permissions: Perm.ADMINISTRATOR.toString(), mentionable: false },
    { id: "9002", name: "mod", color: 0, hoist: false, position: 2, permissions: bits(Perm.KICK_MEMBERS, Perm.BAN_MEMBERS, Perm.MODERATE_MEMBERS, Perm.MANAGE_ROLES, Perm.MANAGE_NICKNAMES, Perm.MANAGE_MESSAGES, Perm.MANAGE_CHANNELS), mentionable: false },
    { id: "9003", name: "helper", color: 0, hoist: false, position: 1, permissions: bits(Perm.MANAGE_MESSAGES), mentionable: false },
  );
  const joined = new Date().toISOString();
  guild.members.set(ids.admin!, { nick: null, roles: ["9001"], joined_at: joined });
  guild.members.set(ids.mod!, { nick: null, roles: ["9002"], joined_at: joined });
  guild.members.set(ids.helper!, { nick: null, roles: ["9003"], joined_at: joined });
  guild.members.set(ids.plain!, { nick: null, roles: [], joined_at: joined });
  guild.members.set(ids.other!, { nick: null, roles: [], joined_at: joined });
  generalId = [...db.channels.values()].find(c => c.guild_id === guildId && c.name === "general")!.id;
  events.length = 0;
});

describe("permission gates", () => {
  it("everyone has the default set; guild edits need MANAGE_GUILD", () => {
    expect(roleOf("@everyone").permissions).toBe(DEFAULT_EVERYONE.toString());
    expect(errorOf(() => call("plain", "PATCH", `/guilds/${guildId}`, { name: "Nope" })).code).toBe(50013);
    expect((call("owner", "PATCH", `/guilds/${guildId}`, { name: "Renamed" }) as { name: string }).name).toBe("Renamed");
    expect(errorOf(() => call("admin", "DELETE", `/guilds/${guildId}`)).code).toBe(50013);
  });

  it("channel creation needs MANAGE_CHANNELS and a private channel is hidden", () => {
    expect(errorOf(() => call("plain", "POST", `/guilds/${guildId}/channels`, { name: "x", type: ChannelType.GuildText })).code).toBe(50013);
    const channel = call("mod", "POST", `/guilds/${guildId}/channels`, {
      name: "secret",
      type: ChannelType.GuildText,
      permission_overwrites: [{ id: guildId, type: OverwriteType.Role, allow: "0", deny: Perm.VIEW_CHANNEL.toString() }],
    }) as Channel;
    expect(channel.permission_overwrites).toHaveLength(1);
    const visible = (who: string) => (call(who, "GET", `/guilds/${guildId}/channels`) as Channel[]).some(c => c.id === channel.id);
    expect(visible("plain")).toBe(false);
    expect(visible("owner")).toBe(true);
    expect(visible("admin")).toBe(true);
    expect(visible("mod")).toBe(false); // MANAGE_CHANNELS does not bypass the overwrite
    expect(errorOf(() => call("plain", "GET", `/channels/${channel.id}/messages`)).code).toBe(50001);
    expect(eventsOf("CHANNEL_CREATE").flatMap(e => e.users).sort()).toEqual([ids.admin, ids.owner].sort());
  });

  it("deleting another author's message needs MANAGE_MESSAGES", () => {
    const channel = db.channels.get(generalId)!;
    const message = addMessage({ channel, author_id: ids.plain!, content: "hi", silent: true });
    expect(errorOf(() => call("other", "DELETE", `/channels/${generalId}/messages/${message.id}`)).code).toBe(50013);
    call("helper", "DELETE", `/channels/${generalId}/messages/${message.id}`);
    expect(db.messages.get(generalId)).toHaveLength(0);
  });
});

describe("kick", () => {
  it("needs KICK_MEMBERS and hierarchy, and tells the kicked user", () => {
    expect(errorOf(() => call("plain", "DELETE", `/guilds/${guildId}/members/${ids.other}`)).code).toBe(50013);
    expect(errorOf(() => call("mod", "DELETE", `/guilds/${guildId}/members/${ids.admin}`)).code).toBe(50013);
    expect(errorOf(() => call("admin", "DELETE", `/guilds/${guildId}/members/${ids.owner}`)).code).toBe(50013);
    expect(errorOf(() => call("mod", "DELETE", `/guilds/${guildId}/members/${ids.mod}`)).code).toBe(50013);
    call("mod", "DELETE", `/guilds/${guildId}/members/${ids.plain}`);
    expect(db.guilds.get(guildId)!.members.has(ids.plain!)).toBe(false);
    expect(eventsOf("GUILD_DELETE").some(e => e.users.includes(ids.plain!))).toBe(true);
    expect(eventsOf("GUILD_MEMBER_REMOVE")).toHaveLength(1);
  });
});

describe("bans", () => {
  it("bans a member, removes recent messages, blocks the invite and unbans", () => {
    const channel = db.channels.get(generalId)!;
    addMessage({ channel, author_id: ids.plain!, content: "spam", silent: true });
    addMessage({ channel, author_id: ids.other!, content: "fine", silent: true });
    expect(errorOf(() => call("helper", "PUT", `/guilds/${guildId}/bans/${ids.plain}`, {})).code).toBe(50013);
    expect(errorOf(() => call("mod", "PUT", `/guilds/${guildId}/bans/${ids.plain}`, { delete_message_seconds: 999_999_999 })).status).toBe(400);
    call("mod", "PUT", `/guilds/${guildId}/bans/${ids.plain}`, { delete_message_seconds: 3600, reason: "spam" });
    expect(db.guilds.get(guildId)!.members.has(ids.plain!)).toBe(false);
    expect(eventsOf("GUILD_BAN_ADD")).toHaveLength(1);
    expect(eventsOf("GUILD_MEMBER_REMOVE")).toHaveLength(1);
    expect(eventsOf("GUILD_DELETE").some(e => e.users.includes(ids.plain!))).toBe(true);
    expect(db.messages.get(generalId)!.map(m => m.content)).toEqual(["fine"]);
    const bans = call("mod", "GET", `/guilds/${guildId}/bans`) as Ban[];
    expect(bans).toEqual([{ user: expect.objectContaining({ id: ids.plain }), reason: "spam" }]);

    const invite = call("owner", "POST", `/channels/${generalId}/invites`, {}) as { code: string };
    expect(errorOf(() => call("plain", "POST", `/invites/${invite.code}`)).code).toBe(40007);

    call("mod", "DELETE", `/guilds/${guildId}/bans/${ids.plain}`);
    expect(eventsOf("GUILD_BAN_REMOVE")).toHaveLength(1);
    expect(errorOf(() => call("mod", "DELETE", `/guilds/${guildId}/bans/${ids.plain}`)).code).toBe(10026);
    call("plain", "POST", `/invites/${invite.code}`);
    expect(db.guilds.get(guildId)!.members.has(ids.plain!)).toBe(true);
  });

  it("bans non-members, but never the owner or someone above you", () => {
    call("mod", "PUT", `/guilds/${guildId}/bans/${ids.outsider}`, {});
    expect(db.bans.get(guildId)?.has(ids.outsider!)).toBe(true);
    expect(errorOf(() => call("mod", "PUT", `/guilds/${guildId}/bans/${ids.owner}`, {})).code).toBe(50013);
    expect(errorOf(() => call("mod", "PUT", `/guilds/${guildId}/bans/${ids.admin}`, {})).code).toBe(50013);
  });
});

describe("roles", () => {
  it("creates just above @everyone and shifts the rest up", () => {
    const role = call("mod", "POST", `/guilds/${guildId}/roles`, { name: "Newbie", permissions: Perm.MANAGE_MESSAGES.toString() }) as Role;
    expect(role.position).toBe(1);
    expect(roleOf("helper").position).toBe(2);
    expect(roleOf("admin").position).toBe(4);
    expect(eventsOf("GUILD_ROLE_CREATE")).toHaveLength(1);
    expect(eventsOf("GUILD_ROLE_UPDATE").length).toBeGreaterThanOrEqual(3);
  });

  it("refuses to grant bits you lack, and ADMINISTRATOR unless you are an admin", () => {
    expect(errorOf(() => call("mod", "POST", `/guilds/${guildId}/roles`, { permissions: Perm.MANAGE_GUILD.toString() })).code).toBe(50013);
    expect(errorOf(() => call("mod", "POST", `/guilds/${guildId}/roles`, { permissions: Perm.ADMINISTRATOR.toString() })).code).toBe(50013);
    const created = call("admin", "POST", `/guilds/${guildId}/roles`, { name: "Boss", permissions: Perm.ADMINISTRATOR.toString() }) as Role;
    expect(created.name).toBe("Boss");
    expect(errorOf(() => call("plain", "POST", `/guilds/${guildId}/roles`, {})).code).toBe(50013);
  });

  it("reorders only roles below your highest and keeps @everyone at 0", () => {
    expect(errorOf(() => call("mod", "PATCH", `/guilds/${guildId}/roles`, [{ id: "9001", position: 1 }])).code).toBe(50013);
    expect(errorOf(() => call("owner", "PATCH", `/guilds/${guildId}/roles`, [{ id: guildId, position: 2 }])).status).toBe(400);
    const roles = call("owner", "PATCH", `/guilds/${guildId}/roles`, [{ id: "9003", position: 3 }]) as Role[];
    expect(roles.map(r => r.name)).toEqual(["helper", "admin", "mod", "@everyone"]);
    expect(roleOf("@everyone").position).toBe(0);
    expect(roleOf("helper").position).toBe(3);
    expect(roleOf("mod").position).toBe(1);
  });

  it("edits @everyone permissions only and deletes roles from members", () => {
    call("owner", "PATCH", `/guilds/${guildId}/roles/${guildId}`, { name: "ignored", permissions: Perm.VIEW_CHANNEL.toString() });
    expect(roleOf("@everyone").name).toBe("@everyone");
    expect(roleOf("@everyone").permissions).toBe(Perm.VIEW_CHANNEL.toString());
    expect(errorOf(() => call("owner", "DELETE", `/guilds/${guildId}/roles/${guildId}`)).code).toBe(50013);
    expect(errorOf(() => call("mod", "DELETE", `/guilds/${guildId}/roles/9002`)).code).toBe(50013); // not below mod
    call("mod", "DELETE", `/guilds/${guildId}/roles/9003`);
    expect(db.guilds.get(guildId)!.members.get(ids.helper!)!.roles).toEqual([]);
    expect(eventsOf("GUILD_ROLE_DELETE")).toHaveLength(1);
  });
});

describe("member edit", () => {
  const member = (who: string) => call("owner", "GET", `/guilds/${guildId}/members`) as GuildMember[];
  const find = (who: string) => member(who).find(m => m.user.id === ids[who])!;

  it("nicknames: MANAGE_NICKNAMES on others, CHANGE_NICKNAME on yourself", () => {
    expect(errorOf(() => call("plain", "PATCH", `/guilds/${guildId}/members/${ids.other}`, { nick: "x" })).code).toBe(50013);
    call("mod", "PATCH", `/guilds/${guildId}/members/${ids.other}`, { nick: "Renamed" });
    expect(find("other").nick).toBe("Renamed");
    call("plain", "PATCH", `/guilds/${guildId}/members/@me`, { nick: "Me" });
    expect(find("plain").nick).toBe("Me");
    expect(errorOf(() => call("mod", "PATCH", `/guilds/${guildId}/members/${ids.owner}`, { nick: "x" })).code).toBe(50013);
    expect(eventsOf("GUILD_MEMBER_UPDATE").length).toBe(2);
  });

  it("roles: full replacement, only roles below your highest", () => {
    call("mod", "PATCH", `/guilds/${guildId}/members/${ids.other}`, { roles: ["9003"] });
    expect(find("other").roles).toEqual(["9003"]);
    expect(errorOf(() => call("mod", "PATCH", `/guilds/${guildId}/members/${ids.other}`, { roles: ["9003", "9001"] })).code).toBe(50013);
    expect(errorOf(() => call("mod", "PATCH", `/guilds/${guildId}/members/${ids.other}`, { roles: [guildId] })).status).toBe(400);
    call("mod", "PATCH", `/guilds/${guildId}/members/${ids.other}`, { roles: [] });
    expect(find("other").roles).toEqual([]);
  });

  it("timeout: MODERATE_MEMBERS, not admins or the owner, max 28 days, null clears, blocks sending", () => {
    const hours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
    expect(errorOf(() => call("helper", "PATCH", `/guilds/${guildId}/members/${ids.other}`, { communication_disabled_until: hours(1) })).code).toBe(50013);
    expect(errorOf(() => call("mod", "PATCH", `/guilds/${guildId}/members/${ids.admin}`, { communication_disabled_until: hours(1) })).code).toBe(50013);
    expect(errorOf(() => call("admin", "PATCH", `/guilds/${guildId}/members/${ids.owner}`, { communication_disabled_until: hours(1) })).code).toBe(50013);
    expect(errorOf(() => call("mod", "PATCH", `/guilds/${guildId}/members/${ids.other}`, { communication_disabled_until: hours(24 * 29) })).status).toBe(400);
    const until = hours(2);
    const edited = call("mod", "PATCH", `/guilds/${guildId}/members/${ids.other}`, { communication_disabled_until: until }) as GuildMember;
    expect(edited.communication_disabled_until).toBe(until);
    expect(find("other").communication_disabled_until).toBe(until);
    expect(errorOf(() => call("other", "POST", `/channels/${generalId}/messages`, { content: "hello" })).code).toBe(50013);
    expect((call("other", "GET", `/channels/${generalId}/messages`) as Message[]).length).toBe(0);
    call("mod", "PATCH", `/guilds/${guildId}/members/${ids.other}`, { communication_disabled_until: null });
    expect(find("other").communication_disabled_until).toBeUndefined();
    expect((call("other", "POST", `/channels/${generalId}/messages`, { content: "hello" }) as Message).content).toBe("hello");
  });
});

describe("channel overwrites and visibility", () => {
  it("PUT/DELETE overwrites move CHANNEL_CREATE/DELETE/UPDATE to the right members", () => {
    const channel = db.channels.get(generalId)!;
    expect(errorOf(() => call("plain", "PUT", `/channels/${generalId}/permissions/${guildId}`, { type: OverwriteType.Role, allow: "0", deny: Perm.VIEW_CHANNEL.toString() })).code).toBe(50013);

    // Hide the channel from @everyone but let helpers see it.
    call("owner", "PUT", `/channels/${generalId}/permissions/${guildId}`, { type: OverwriteType.Role, allow: "0", deny: Perm.VIEW_CHANNEL.toString() });
    const deleted = eventsOf("CHANNEL_DELETE").flatMap(e => e.users);
    expect(deleted).toContain(ids.plain);
    expect(deleted).toContain(ids.other);
    expect(deleted).toContain(ids.mod); // mod has no VIEW bypass
    expect(deleted).toContain(ids.helper);
    expect(deleted).not.toContain(ids.admin);
    events.length = 0;
    call("owner", "PUT", `/channels/${generalId}/permissions/9003`, { type: OverwriteType.Role, allow: Perm.VIEW_CHANNEL.toString(), deny: "0" });
    expect(eventsOf("CHANNEL_CREATE").flatMap(e => e.users)).toEqual([ids.helper]);
    expect(channel.permission_overwrites).toHaveLength(2);

    const listed = (who: string) => (call(who, "GET", `/guilds/${guildId}/channels`) as Channel[]).some(c => c.id === generalId);
    expect(listed("plain")).toBe(false);
    expect(listed("helper")).toBe(true);
    expect(errorOf(() => call("plain", "POST", `/channels/${generalId}/messages`, { content: "x" })).code).toBe(50001);

    // Messages only reach members who can see the channel.
    events.length = 0;
    addMessage({ channel, author_id: ids.owner!, content: "staff only" });
    const recipients = eventsOf("MESSAGE_CREATE").flatMap(e => e.users);
    expect(recipients).toContain(ids.helper);
    expect(recipients).not.toContain(ids.plain);

    // Giving a member an allow overwrite shows the channel to them: CHANNEL_CREATE.
    events.length = 0;
    call("owner", "PUT", `/channels/${generalId}/permissions/${ids.plain}`, { type: OverwriteType.Member, allow: Perm.VIEW_CHANNEL.toString(), deny: "0" });
    expect(eventsOf("CHANNEL_CREATE").flatMap(e => e.users)).toEqual([ids.plain]);
    expect(eventsOf("CHANNEL_UPDATE").flatMap(e => e.users)).toContain(ids.helper);

    // Removing the @everyone overwrite restores access for the rest.
    events.length = 0;
    call("owner", "DELETE", `/channels/${generalId}/permissions/${guildId}`);
    expect(eventsOf("CHANNEL_CREATE").flatMap(e => e.users)).toContain(ids.other);
    expect(listed("other")).toBe(true);
  });

  it("a member cannot grant or deny bits they lack on the channel", () => {
    // helper gets MANAGE_ROLES only through a channel overwrite, so cannot set ATTACH_FILES-denied bits they do not hold
    call("owner", "PUT", `/channels/${generalId}/permissions/${ids.helper}`, { type: OverwriteType.Member, allow: Perm.MANAGE_ROLES.toString(), deny: Perm.ATTACH_FILES.toString() });
    call("helper", "PUT", `/channels/${generalId}/permissions/${ids.plain}`, { type: OverwriteType.Member, allow: Perm.SEND_MESSAGES.toString(), deny: "0" });
    expect(errorOf(() => call("helper", "PUT", `/channels/${generalId}/permissions/${ids.plain}`, { type: OverwriteType.Member, allow: Perm.KICK_MEMBERS.toString(), deny: "0" })).code).toBe(50013);
    expect(errorOf(() => call("helper", "PUT", `/channels/${generalId}/permissions/${ids.plain}`, { type: OverwriteType.Member, allow: "0", deny: Perm.ATTACH_FILES.toString() })).code).toBe(50013);
  });

  it("addChannel stores overwrites handed to it", () => {
    const channel = addChannel(guildId, { name: "x", type: ChannelType.GuildText, permission_overwrites: [{ id: guildId, type: OverwriteType.Role, allow: "0", deny: "1024" }] });
    expect(channel.permission_overwrites).toHaveLength(1);
  });
});

describe("category sync", () => {
  const deny = { type: OverwriteType.Role, allow: "0", deny: Perm.VIEW_CHANNEL.toString() };
  const ow = (channelId: string) => db.channels.get(channelId)!.permission_overwrites ?? [];
  const makeCategory = () => call("owner", "POST", `/guilds/${guildId}/channels`, { name: "cat", type: ChannelType.GuildCategory }) as Channel;

  it("a channel created under a category copies its overwrites unless it gives its own", () => {
    const cat = makeCategory();
    call("owner", "PUT", `/channels/${cat.id}/permissions/${ids.helper}`, { type: OverwriteType.Member, allow: Perm.VIEW_CHANNEL.toString(), deny: "0" });
    const copied = call("owner", "POST", `/guilds/${guildId}/channels`, { name: "a", type: ChannelType.GuildText, parent_id: cat.id }) as Channel;
    expect(ow(copied.id)).toEqual(ow(cat.id));
    expect(ow(copied.id)).toHaveLength(1);
    const own = call("owner", "POST", `/guilds/${guildId}/channels`, { name: "b", type: ChannelType.GuildText, parent_id: cat.id, permission_overwrites: [] }) as Channel;
    expect(ow(own.id)).toEqual([]);
  });

  it("PATCH with parent_id copies the new parent's overwrites only with lock_permissions", () => {
    const cat = makeCategory();
    call("owner", "PUT", `/channels/${cat.id}/permissions/${guildId}`, { ...deny });
    const kept = call("owner", "POST", `/guilds/${guildId}/channels`, { name: "k", type: ChannelType.GuildText }) as Channel;
    const locked = call("owner", "POST", `/guilds/${guildId}/channels`, { name: "l", type: ChannelType.GuildText }) as Channel;
    call("owner", "PATCH", `/channels/${kept.id}`, { parent_id: cat.id });
    expect(ow(kept.id)).toEqual([]);
    events.length = 0;
    call("owner", "PATCH", `/channels/${locked.id}`, { parent_id: cat.id, lock_permissions: true });
    expect(ow(locked.id)).toEqual(ow(cat.id));
    expect(eventsOf("CHANNEL_DELETE").flatMap(e => e.users)).toContain(ids.plain);
    expect(eventsOf("CHANNEL_UPDATE").flatMap(e => e.users)).toContain(ids.owner);
  });

  it("PUT/DELETE on a category follow only synced children and emit CHANNEL_UPDATE per child", () => {
    const cat = makeCategory();
    call("owner", "PUT", `/channels/${cat.id}/permissions/${ids.helper}`, { type: OverwriteType.Member, allow: Perm.VIEW_CHANNEL.toString(), deny: "0" });
    const synced = call("owner", "POST", `/guilds/${guildId}/channels`, { name: "s", type: ChannelType.GuildText, parent_id: cat.id }) as Channel;
    const custom = call("owner", "POST", `/guilds/${guildId}/channels`, { name: "c", type: ChannelType.GuildText, parent_id: cat.id }) as Channel;
    call("owner", "PUT", `/channels/${custom.id}/permissions/${ids.plain}`, { type: OverwriteType.Member, allow: "0", deny: Perm.SEND_MESSAGES.toString() });
    events.length = 0;
    call("owner", "PUT", `/channels/${cat.id}/permissions/${guildId}`, { ...deny });
    expect(ow(synced.id)).toEqual(ow(cat.id));
    expect(ow(custom.id)).toHaveLength(2);
    const updated = eventsOf("CHANNEL_UPDATE").filter(e => e.users.includes(ids.owner)).map(e => (e.d as Channel).id);
    expect(updated).toContain(synced.id);
    expect(updated).not.toContain(custom.id);
    expect(eventsOf("CHANNEL_DELETE").flatMap(e => e.users)).toContain(ids.plain);
    call("owner", "DELETE", `/channels/${cat.id}/permissions/${guildId}`);
    expect(ow(synced.id).some(o => o.id === guildId)).toBe(false);
  });

  it("ignores ADMINISTRATOR in an overwrite", () => {
    call("owner", "PUT", `/channels/${generalId}/permissions/${ids.plain}`, { type: OverwriteType.Member, allow: bits(Perm.ADMINISTRATOR, Perm.SEND_MESSAGES), deny: Perm.ADMINISTRATOR.toString() });
    expect(ow(generalId).find(o => o.id === ids.plain)).toMatchObject({ allow: Perm.SEND_MESSAGES.toString(), deny: "0" });
  });
});

describe("seed", () => {
  it("has a private #staff channel, a banned account and reduced rights for the Moderator", async () => {
    const { seed } = await import("./seed");
    for (const map of [db.accounts, db.channels, db.messages, db.guilds, db.invites, db.bans, db.pending] as Map<string, unknown>[]) map.clear();
    seed();
    const user = (name: string) => [...db.accounts.values()].find(a => a.user.username === name)!.user.id;
    const guild = [...db.guilds.values()][0]!;
    expect(guild.guild.owner_id).toBe(user("sam"));
    const names = (who: string) => (handleRoute("GET", `/guilds/${guild.guild.id}/channels`, null, user(who)) as Channel[]).map(c => c.name);
    expect(names("sam")).toContain("staff");
    expect(names("alice")).toContain("staff");
    expect(names("bob")).not.toContain("staff");
    expect(db.bans.get(guild.guild.id)?.size).toBe(1);
    expect(() => handleRoute("PATCH", `/guilds/${guild.guild.id}`, { name: "x" }, user("alice"))).toThrow();
    expect(handleRoute("GET", `/guilds/${guild.guild.id}/bans`, null, user("alice"))).toHaveLength(1);
  });
});
