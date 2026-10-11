import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./socket", () => ({ emit: () => undefined }));

import { ApiRequestError } from "../errors";
import { Perm } from "../permissions";
import { timestampToSnowflake } from "../snowflake";
import { JoinSourceType, MemberSearchSort, type MemberSearchQuery, type MemberSearchResponse } from "../types";
import { db } from "./db";
import { createAccount, createGuildRecord } from "./ops";
import { handleRoute } from "./routes";

const ids: Record<string, string> = {};
let guildId = "";
const DAY = 86_400_000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

const call = (who: string, method: string, path: string, body?: unknown): unknown => handleRoute(method, path, body ?? null, ids[who] ?? null);
const search = (who: string, body: { limit?: number; offset?: number; sort?: number; and_query?: MemberSearchQuery }): MemberSearchResponse =>
  call(who, "POST", `/guilds/${guildId}/members-search`, { and_query: {}, ...body }) as MemberSearchResponse;
const names = (r: MemberSearchResponse): string[] => r.members.map(m => m.member.user.username);
const errorOf = (fn: () => unknown): { status: number; code: number } => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApiRequestError) return { status: e.status, code: e.code };
    throw e;
  }
  throw new Error("expected the call to fail");
};

/** Users are named by hand; an account's age comes from its snowflake, so `age` is how many days old the account is. */
function addUser(name: string, age: number, joinedAgo: number, extra: { nick?: string | null; roles?: string[]; code?: string; inviter?: string; source?: JoinSourceType; global?: string } = {}): void {
  const account = createAccount({ id: timestampToSnowflake(Date.now() - age * DAY, Object.keys(ids).length), username: name, global_name: extra.global ?? null });
  ids[name] = account.user.id;
  db.guilds.get(guildId)!.members.set(account.user.id, {
    nick: extra.nick ?? null,
    roles: extra.roles ?? [],
    joined_at: ago(joinedAgo),
    ...(extra.code || extra.source !== undefined ? { source_invite_code: extra.code ?? null, inviter_id: extra.inviter ?? null, join_source_type: extra.source ?? JoinSourceType.Invite } : {}),
  });
}

beforeEach(() => {
  for (const map of [db.accounts, db.channels, db.messages, db.guilds, db.invites, db.bans, db.pending] as Map<string, unknown>[]) map.clear();
  for (const k of Object.keys(ids)) delete ids[k];
  for (const name of ["owner", "outsider"]) ids[name] = createAccount({ username: name }).user.id;
  guildId = createGuildRecord(ids.owner!, "Test guild");
  const guild = db.guilds.get(guildId)!;
  const role = (id: string, name: string, bits: bigint) => guild.guild.roles.push({ id, name, color: 0, hoist: false, position: 1, permissions: bits.toString(), mentionable: false });
  role("9001", "red", 0n);
  role("9002", "green", 0n);
  role("9003", "blue", 0n);
  // One role per access permission, plus one that grants nothing relevant.
  const access: [string, bigint][] = [["admin", Perm.ADMINISTRATOR], ["manageGuild", Perm.MANAGE_GUILD], ["kicker", Perm.KICK_MEMBERS], ["banner", Perm.BAN_MEMBERS], ["timeouter", Perm.MODERATE_MEMBERS], ["roler", Perm.MANAGE_ROLES], ["nicker", Perm.MANAGE_NICKNAMES], ["messager", Perm.MANAGE_MESSAGES]];
  access.forEach(([name, bit], i) => {
    role(`80${i}`, name, bit);
    addUser(name, 400, 100 * DAY, { roles: [`80${i}`] });
  });
  addUser("plain", 400, 100 * DAY);
  // Searchable crowd (all account ages and join times are relative to now)
  addUser("alpha", 300, 10 * DAY, { roles: ["9001"], code: "abc", inviter: ids.owner, global: "Alpha Prime" });
  addUser("alpine", 200, 5 * DAY, { roles: ["9001", "9002"], code: "abc", inviter: ids.owner, nick: "Zed" });
  addUser("beta", 100, 3 * DAY, { roles: ["9002"], code: "xyz", inviter: ids.alpha });
  addUser("gamma", 3, 2 * DAY, { roles: ["9001", "9002", "9003"] });
  addUser("delta", 50, 1 * DAY);
  addUser("bot1", 20, 60_000, { source: JoinSourceType.Bot });
});

describe("POST /guilds/{id}/members-search", () => {
  it("is open to each of the seven permissions and the owner, closed to everyone else", () => {
    for (const who of ["owner", "admin", "manageGuild", "kicker", "banner", "timeouter", "roler", "nicker"]) expect(search(who, {}).guild_id).toBe(guildId);
    expect(errorOf(() => search("plain", {}))).toEqual({ status: 403, code: 50013 });
    expect(errorOf(() => search("messager", {}))).toEqual({ status: 403, code: 50013 });
    expect(errorOf(() => search("outsider", {}))).toEqual({ status: 403, code: 50001 });
    expect(errorOf(() => call("owner", "POST", "/guilds/1/members-search", { and_query: {} })).status).toBe(404);
  });

  it("returns the member view with the join source, null for members without one", () => {
    const hit = search("owner", { and_query: { usernames: { or_query: ["alpine"] } } });
    expect(hit.members).toHaveLength(1);
    const [first] = hit.members;
    expect(first).toMatchObject({ source_invite_code: "abc", join_source_type: JoinSourceType.Invite, inviter_id: ids.owner });
    expect(first?.member).toMatchObject({ nick: "Zed", roles: ["9001", "9002"], user: { id: ids.alpine } });
    expect(first?.member).not.toHaveProperty("source_invite_code");
    const unknown = search("owner", { and_query: { usernames: { or_query: ["plain"] } } }).members[0];
    expect(unknown).toMatchObject({ source_invite_code: null, join_source_type: JoinSourceType.Unspecified, inviter_id: null });
  });

  it("matches usernames by case-insensitive prefix of username, display name or nickname, and all-digit terms by exact id", () => {
    expect(names(search("owner", { and_query: { usernames: { or_query: ["AL"] } } })).sort()).toEqual(["alpha", "alpine"]);
    expect(names(search("owner", { and_query: { usernames: { or_query: ["prime"] } } }))).toEqual([]);
    expect(names(search("owner", { and_query: { usernames: { or_query: ["alpha p"] } } }))).toEqual(["alpha"]);
    expect(names(search("owner", { and_query: { usernames: { or_query: ["zed"] } } }))).toEqual(["alpine"]);
    expect(names(search("owner", { and_query: { usernames: { or_query: [" beta ", "gam"] } } })).sort()).toEqual(["beta", "gamma"]);
    expect(names(search("owner", { and_query: { usernames: { or_query: [ids.delta!] } } }))).toEqual(["delta"]);
    expect(names(search("owner", { and_query: { usernames: { or_query: [ids.delta!.slice(0, 5)] } } }))).toEqual([]);
  });

  it("filters by user id", () => {
    expect(names(search("owner", { and_query: { user_id: { or_query: [ids.beta!, ids.delta!] } } })).sort()).toEqual(["beta", "delta"]);
  });

  it("filters by roles: or_query = any, and_query = all, both together", () => {
    const by = (q: MemberSearchQuery) => names(search("owner", { and_query: q })).sort();
    expect(by({ role_ids: { or_query: ["9001"] } })).toEqual(["alpha", "alpine", "gamma"]);
    expect(by({ role_ids: { or_query: ["9001", "9002"] } })).toEqual(["alpha", "alpine", "beta", "gamma"]);
    expect(by({ role_ids: { and_query: ["9001", "9002"] } })).toEqual(["alpine", "gamma"]);
    expect(by({ role_ids: { and_query: ["9001", "9002"], or_query: ["9003"] } })).toEqual(["gamma"]);
  });

  it("filters by guild_joined_at and user_created_at ranges (inclusive, unix ms)", () => {
    const by = (q: MemberSearchQuery) => names(search("owner", { and_query: q })).sort();
    expect(by({ guild_joined_at: { range: { gte: Date.now() - 4 * DAY } } })).toEqual(["beta", "bot1", "delta", "gamma", "owner"]);
    expect(by({ guild_joined_at: { range: { lte: Date.now() - 4 * DAY, gte: Date.now() - 6 * DAY } } })).toEqual(["alpine"]);
    // account age: gamma is 3 days old, bot1 20, delta 50
    expect(by({ user_created_at: { range: { gte: Date.now() - 7 * DAY } } })).toEqual(["gamma", "owner"]);
    expect(by({ user_created_at: { range: { gte: Date.now() - 60 * DAY, lte: Date.now() - 10 * DAY } } })).toEqual(["bot1", "delta"]);
    expect(by({ user_created_at: { range: { gte: ids.gamma ? Number(BigInt(ids.gamma) >> 22n) + 1420070400000 : 0, lte: Number(BigInt(ids.gamma!) >> 22n) + 1420070400000 } } })).toEqual(["gamma"]);
  });

  it("filters by source_invite_code and join_source_type", () => {
    const by = (q: MemberSearchQuery) => names(search("owner", { and_query: q })).sort();
    expect(by({ source_invite_code: { or_query: ["abc"] } })).toEqual(["alpha", "alpine"]);
    expect(by({ source_invite_code: { or_query: ["abc", "xyz"] } })).toEqual(["alpha", "alpine", "beta"]);
    expect(by({ join_source_type: { or_query: [JoinSourceType.Bot] } })).toEqual(["bot1"]);
    expect(by({ join_source_type: { or_query: [JoinSourceType.Invite] } })).toEqual(["alpha", "alpine", "beta"]);
    expect(by({ join_source_type: { or_query: [JoinSourceType.Unspecified] } })).toContain("owner");
    expect(by({ join_source_type: { or_query: [JoinSourceType.Invite] }, role_ids: { or_query: ["9002"] } })).toEqual(["alpine", "beta"]);
  });

  it("ignores empty filters", () => {
    const all = search("owner", { limit: 1000 }).total_result_count;
    expect(search("owner", { limit: 1000, and_query: { usernames: { or_query: [] }, role_ids: {}, guild_joined_at: { range: {} } } }).total_result_count).toBe(all);
  });

  it("sorts by member since and by account creation, newest first by default, ties by user id", () => {
    const only = { usernames: { or_query: ["alp", "bet", "gam", "del", "bot1"] } };
    expect(names(search("owner", { and_query: only }))).toEqual(["bot1", "delta", "gamma", "beta", "alpine", "alpha"]);
    expect(names(search("owner", { sort: MemberSearchSort.MemberSinceOldestFirst, and_query: only }))).toEqual(["alpha", "alpine", "beta", "gamma", "delta", "bot1"]);
    expect(names(search("owner", { sort: MemberSearchSort.JoinedVokkoNewestFirst, and_query: only }))).toEqual(["gamma", "bot1", "delta", "beta", "alpine", "alpha"]);
    expect(names(search("owner", { sort: MemberSearchSort.JoinedVokkoOldestFirst, and_query: only }))).toEqual(["alpha", "alpine", "beta", "delta", "bot1", "gamma"]);
    // The eight permission accounts joined at the same instant offset (ago() is called per user) but share an age: ties fall back to id.
    const same = search("owner", { sort: MemberSearchSort.JoinedVokkoOldestFirst, and_query: { user_created_at: { range: { gte: Date.now() - 401 * DAY, lte: Date.now() - 399 * DAY } } } });
    const idsInOrder = same.members.map(m => BigInt(m.member.user.id));
    expect(idsInOrder).toEqual([...idsInOrder].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    const sameDesc = search("owner", { sort: MemberSearchSort.JoinedVokkoNewestFirst, and_query: { user_created_at: { range: { gte: Date.now() - 401 * DAY, lte: Date.now() - 399 * DAY } } } });
    expect(sameDesc.members.map(m => m.member.user.id)).toEqual(same.members.map(m => m.member.user.id).reverse());
  });

  it("pages by offset and limit and counts every match before paging", () => {
    const total = search("owner", { limit: 1000 }).total_result_count;
    expect(total).toBe(db.guilds.get(guildId)!.members.size);
    const page1 = search("owner", { limit: 5, offset: 0 });
    const page2 = search("owner", { limit: 5, offset: 5 });
    expect(page1).toMatchObject({ page_result_count: 5, total_result_count: total });
    expect(page2).toMatchObject({ page_result_count: 5, total_result_count: total });
    expect(new Set([...names(page1), ...names(page2)]).size).toBe(10);
    expect(search("owner", { limit: 5, offset: total - 2 })).toMatchObject({ page_result_count: 2, total_result_count: total });
    expect(search("owner", { offset: 100_000 })).toMatchObject({ page_result_count: 0, members: [], total_result_count: total });
    expect(search("owner", {}).page_result_count).toBe(Math.min(25, total));
  });

  it("rejects out-of-range and malformed input with 400 50035", () => {
    const bad = (body: unknown) => errorOf(() => call("owner", "POST", `/guilds/${guildId}/members-search`, body));
    expect(bad({ limit: 0, and_query: {} })).toEqual({ status: 400, code: 50035 });
    expect(bad({ limit: 1001, and_query: {} })).toEqual({ status: 400, code: 50035 });
    expect(bad({ offset: -1, and_query: {} })).toEqual({ status: 400, code: 50035 });
    expect(bad({ offset: 100_001, and_query: {} })).toEqual({ status: 400, code: 50035 });
    expect(bad({ sort: 5, and_query: {} })).toEqual({ status: 400, code: 50035 });
    expect(bad({ and_query: { usernames: { or_query: new Array(11).fill("a") } } })).toEqual({ status: 400, code: 50035 });
    expect(bad({ and_query: { usernames: { or_query: ["x".repeat(101)] } } })).toEqual({ status: 400, code: 50035 });
    expect(bad({ and_query: { user_id: { or_query: new Array(101).fill("1") } } })).toEqual({ status: 400, code: 50035 });
    expect(bad({ and_query: { user_id: { or_query: ["abc"] } } })).toEqual({ status: 400, code: 50035 });
    expect(bad({ and_query: { guild_joined_at: { range: { gte: "yesterday" } } } })).toEqual({ status: 400, code: 50035 });
    expect(bad({ and_query: { join_source_type: { or_query: [99] } } })).toEqual({ status: 400, code: 50035 });
  });
});

describe("join source recorded on invite accept", () => {
  it("stores the code, the inviter and type 5 for a new member and nothing for the others", () => {
    const channel = [...db.channels.values()].find(c => c.guild_id === guildId && c.name === "general")!;
    const invite = call("owner", "POST", `/channels/${channel.id}/invites`, {}) as { code: string };
    expect(db.invites.get(invite.code)?.inviter_id).toBe(ids.owner);
    call("outsider", "POST", `/invites/${invite.code}`);
    const hit = search("owner", { and_query: { source_invite_code: { or_query: [invite.code] } } });
    expect(hit.total_result_count).toBe(1);
    expect(hit.members[0]).toMatchObject({ source_invite_code: invite.code, inviter_id: ids.owner, join_source_type: JoinSourceType.Invite });
    expect(hit.members[0]?.member.user.id).toBe(ids.outsider);
    // the owner stays Unknown
    expect(search("owner", { and_query: { user_id: { or_query: [ids.owner!] } } }).members[0]).toMatchObject({ source_invite_code: null, join_source_type: 0, inviter_id: null });
  });

  it("records the new invite when a member leaves and rejoins through another one", () => {
    const channel = [...db.channels.values()].find(c => c.guild_id === guildId && c.name === "general")!;
    const one = call("owner", "POST", `/channels/${channel.id}/invites`, {}) as { code: string };
    const two = call("admin", "POST", `/channels/${channel.id}/invites`, {}) as { code: string };
    call("outsider", "POST", `/invites/${one.code}`);
    call("outsider", "DELETE", `/users/@me/guilds/${guildId}`);
    call("outsider", "POST", `/invites/${two.code}`);
    expect(search("owner", { and_query: { user_id: { or_query: [ids.outsider!] } } }).members[0]).toMatchObject({ source_invite_code: two.code, inviter_id: ids.admin });
  });
});

describe("seed", () => {
  it("gives the demo guild about 65 members with varied sources, roles and ages; bob has no access, alice has", async () => {
    const { seed } = await import("./seed");
    for (const map of [db.accounts, db.channels, db.messages, db.guilds, db.invites, db.bans, db.pending] as Map<string, unknown>[]) map.clear();
    seed();
    const user = (name: string) => [...db.accounts.values()].find(a => a.user.username === name)!.user.id;
    const guild = [...db.guilds.values()][0]!;
    guildId = guild.guild.id;
    ids.alice = user("alice");
    ids.bob = user("bob");
    ids.sam = user("sam");
    const all = search("sam", { limit: 1000 });
    expect(all.total_result_count).toBe(65);
    expect(search("alice", {}).total_result_count).toBe(65);
    expect(errorOf(() => search("bob", {}))).toEqual({ status: 403, code: 50013 });
    expect(all.members.filter(m => m.source_invite_code).length).toBeGreaterThanOrEqual(25);
    expect(new Set(all.members.map(m => m.source_invite_code).filter(Boolean)).size).toBe(4);
    expect(all.members.filter(m => m.member.user.bot)).toHaveLength(3);
    expect(all.members.filter(m => m.member.roles.length >= 3).length).toBeGreaterThan(0);
    const young = search("sam", { and_query: { user_created_at: { range: { gte: Date.now() - 7 * DAY } } }, limit: 1000 });
    expect(young.total_result_count).toBeGreaterThanOrEqual(2);
    const joined = all.members.map(m => Date.now() - Date.parse(m.member.joined_at));
    expect(Math.min(...joined)).toBeLessThan(60 * 60_000);
    expect(Math.max(...joined)).toBeGreaterThan(300 * DAY);
  });
});
