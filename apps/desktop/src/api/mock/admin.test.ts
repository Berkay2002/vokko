import { beforeEach, describe, expect, it, vi } from "vitest";

const events: { users: string[]; t: string; d: unknown }[] = [];
vi.mock("./socket", () => ({
  emit: (users: Iterable<string>, t: string, d: unknown) => {
    events.push({ users: [...users], t, d });
  },
}));

import { ApiRequestError } from "../errors";
import { timestampToSnowflake } from "../snowflake";
import { Perm } from "../permissions";
import { AuditLogEvent, OverwriteType, type AuditLog, type AuditLogEntry, type AutoModerationRule, type Role } from "../types";
import { resetAdmin } from "./admin";
import { db } from "./db";
import { addMessage, createAccount, createGuildRecord } from "./ops";
import { handleRoute } from "./routes";

const ids: Record<string, string> = {};
let guildId = "";
let generalId = "";
const DAY = 86_400_000;

const call = (who: string, method: string, path: string, body?: unknown, reason?: string): unknown => handleRoute(method, path, body ?? null, ids[who] ?? null, reason ?? null);
const errorOf = (fn: () => unknown): { status: number; code: number; errors?: Record<string, unknown> } => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApiRequestError) return { status: e.status, code: e.code, errors: e.api.errors };
    throw e;
  }
  throw new Error("expected the call to fail");
};
const audit = (query = ""): AuditLogEntry[] => (call("owner", "GET", `/guilds/${guildId}/audit-logs${query}`) as AuditLog).audit_log_entries;
const role = (id: string, name: string, position: number, permissions: bigint): Role => ({ id, name, color: 0, hoist: false, position, permissions: permissions.toString(), mentionable: false });

beforeEach(() => {
  events.length = 0;
  resetAdmin();
  for (const map of [db.accounts, db.channels, db.messages, db.guilds, db.invites, db.bans, db.pending] as Map<string, unknown>[]) map.clear();
  // Accounts are a day old so the verification level does not apply unless a test makes them new.
  const created = Date.now() - DAY;
  ["owner", "manager", "auditor", "plain", "idle", "trusted"].forEach((name, i) => {
    ids[name] = createAccount({ id: timestampToSnowflake(created, i), username: name }).user.id;
  });
  guildId = createGuildRecord(ids.owner!, "Admin guild");
  const guild = db.guilds.get(guildId)!;
  guild.guild.roles.push(
    role("9100", "manager", 3, Perm.MANAGE_ROLES | Perm.KICK_MEMBERS | Perm.MANAGE_GUILD),
    role("9101", "high", 5, 0n),
    role("9102", "low", 1, 0n),
    role("9103", "auditors", 2, Perm.VIEW_AUDIT_LOG),
    role("9104", "trusted", 1, 0n),
  );
  const old = new Date(Date.now() - 10 * DAY).toISOString();
  guild.members.set(ids.manager!, { nick: null, roles: ["9100"], joined_at: old });
  guild.members.set(ids.auditor!, { nick: null, roles: ["9103"], joined_at: old });
  guild.members.set(ids.plain!, { nick: null, roles: [], joined_at: old });
  guild.members.set(ids.idle!, { nick: null, roles: ["9102"], joined_at: old });
  guild.members.set(ids.trusted!, { nick: null, roles: ["9104"], joined_at: old });
  generalId = [...db.channels.values()].find(c => c.guild_id === guildId && c.name === "general")!.id;
  events.length = 0;
});

describe("role hierarchy and reorder", () => {
  it("managers cannot move or edit roles at or above their own; the owner can", () => {
    expect(errorOf(() => call("manager", "PATCH", `/guilds/${guildId}/roles`, [{ id: "9101", position: 1 }])).code).toBe(50013);
    expect(errorOf(() => call("manager", "PATCH", `/guilds/${guildId}/roles/9101`, { name: "mine" })).code).toBe(50013);
    expect(errorOf(() => call("manager", "PATCH", `/guilds/${guildId}/members/${ids.plain}`, { roles: ["9101"] })).code).toBe(50013);
    const roles = call("owner", "PATCH", `/guilds/${guildId}/roles`, [{ id: "9102", position: 5 }]) as Role[];
    expect(roles[0]?.id).toBe("9102");
    expect(events.some(e => e.t === "GUILD_ROLE_UPDATE")).toBe(true);
  });

  it("role icons round-trip and are audited with the reason", () => {
    const updated = call("owner", "PATCH", `/guilds/${guildId}/roles/9102`, { unicode_emoji: "🛡️" }, "give it an icon") as Role;
    expect(updated.unicode_emoji).toBe("🛡️");
    const [entry] = audit(`?action_type=${AuditLogEvent.RoleUpdate}`);
    expect(entry?.changes).toEqual([{ key: "unicode_emoji", new_value: "🛡️" }]);
    expect(entry?.reason).toBe("give it an icon");
    expect((call("owner", "GET", `/guilds/${guildId}/roles/member-counts`) as Record<string, number>)["9102"]).toBe(1);
  });
});

describe("audit log", () => {
  it("is visible only with VIEW_AUDIT_LOG and filters by user and action", () => {
    call("owner", "PATCH", `/guilds/${guildId}/members/${ids.plain}`, { nick: "P" });
    call("manager", "DELETE", `/guilds/${guildId}/members/${ids.idle}`);
    expect(errorOf(() => call("plain", "GET", `/guilds/${guildId}/audit-logs`)).code).toBe(50013);
    expect((call("auditor", "GET", `/guilds/${guildId}/audit-logs`) as AuditLog).audit_log_entries).toHaveLength(2);
    const created = events.filter(e => e.t === "GUILD_AUDIT_LOG_ENTRY_CREATE");
    expect(created).toHaveLength(2);
    for (const e of created) {
      expect(e.users).toContain(ids.auditor);
      expect(e.users).not.toContain(ids.plain);
    }
    expect(audit(`?user_id=${ids.manager}`).map(e => e.action_type)).toEqual([AuditLogEvent.MemberKick]);
    expect(audit(`?action_type=${AuditLogEvent.MemberUpdate}`)[0]?.changes).toEqual([{ key: "nick", new_value: "P" }]);
    const all = audit();
    expect(audit(`?before=${all[0]?.id}`).map(e => e.id)).toEqual([all[1]?.id]);
  });

  it("records overwrite create, update and delete with the target", () => {
    const path = `/channels/${generalId}/permissions/9102`;
    call("owner", "PUT", path, { type: OverwriteType.Role, allow: Perm.ATTACH_FILES.toString(), deny: Perm.SEND_MESSAGES.toString() });
    call("owner", "PUT", path, { type: OverwriteType.Role, allow: Perm.SEND_MESSAGES.toString(), deny: "0" });
    call("owner", "DELETE", path);
    const entries = audit().filter(e => e.action_type >= 13 && e.action_type <= 15);
    expect(entries.map(e => e.action_type)).toEqual([15, 14, 13]);
    expect(entries[1]?.options).toEqual({ id: "9102", type: "0", role_name: "low" });
    expect(entries[1]?.changes).toEqual([
      { key: "allow", old_value: Perm.ATTACH_FILES.toString(), new_value: Perm.SEND_MESSAGES.toString() },
      { key: "deny", old_value: Perm.SEND_MESSAGES.toString(), new_value: "0" },
    ]);
  });
});

describe("bans and prune", () => {
  it("ban deletes the message window with one MESSAGE_DELETE_BULK per channel", () => {
    const channel = db.channels.get(generalId)!;
    const old = addMessage({ channel, author_id: ids.plain!, content: "old" });
    old.timestamp = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const fresh = [addMessage({ channel, author_id: ids.plain!, content: "a" }), addMessage({ channel, author_id: ids.plain!, content: "b" })];
    events.length = 0;
    call("owner", "PUT", `/guilds/${guildId}/bans/${ids.plain}`, { delete_message_seconds: 3600 }, "spam");
    const bulk = events.filter(e => e.t === "MESSAGE_DELETE_BULK");
    expect(bulk).toHaveLength(1);
    expect((bulk[0]?.d as { ids: string[] }).ids).toEqual(fresh.map(m => m.id));
    expect(events.some(e => e.t === "MESSAGE_DELETE")).toBe(false);
    expect(db.messages.get(generalId)?.some(m => m.id === old.id)).toBe(true);
    const [entry] = audit(`?action_type=${AuditLogEvent.MemberBanAdd}`);
    expect([entry?.target_id, entry?.reason]).toEqual([ids.plain, "spam"]);
  });

  it("prune counts inactive members, honours include_roles and needs KICK + MANAGE_GUILD", () => {
    addMessage({ channel: db.channels.get(generalId)!, author_id: ids.trusted!, content: "still here" });
    expect(errorOf(() => call("plain", "GET", `/guilds/${guildId}/prune?days=7`)).code).toBe(50013);
    expect(errorOf(() => call("owner", "GET", `/guilds/${guildId}/prune?days=31`)).code).toBe(50035);
    expect(call("owner", "GET", `/guilds/${guildId}/prune?days=7`)).toEqual({ pruned: 1 });
    expect(call("owner", "GET", `/guilds/${guildId}/prune?days=7&include_roles=9102`)).toEqual({ pruned: 2 });
    expect(errorOf(() => call("manager", "GET", `/guilds/${guildId}/prune?include_roles=9101`)).code).toBe(50013);
    expect(call("owner", "POST", `/guilds/${guildId}/prune`, { days: 7, include_roles: ["9102"] })).toEqual({ pruned: 2 });
    const members = db.guilds.get(guildId)!.members;
    expect([members.has(ids.plain!), members.has(ids.idle!), members.has(ids.trusted!)]).toEqual([false, false, true]);
    expect(audit(`?action_type=${AuditLogEvent.MemberPrune}`)[0]?.options).toEqual({ delete_member_days: "7", members_removed: "2" });
  });
});

describe("safety and AutoMod", () => {
  const send = (who: string, content: string) => call(who, "POST", `/channels/${generalId}/messages`, { content });

  it("blocks keywords except for exempt roles, the owner and managers", () => {
    expect(errorOf(() => call("plain", "POST", `/guilds/${guildId}/auto-moderation/rules`, {})).code).toBe(50013);
    const rule = call("owner", "POST", `/guilds/${guildId}/auto-moderation/rules`, {
      name: "Words",
      event_type: 1,
      trigger_type: 1,
      trigger_metadata: { keyword_filter: ["bad*"], allow_list: ["badge"] },
      actions: [{ type: 1, metadata: { custom_message: "Be nice" } }],
      exempt_roles: ["9104"],
    }) as AutoModerationRule;
    expect(events.find(e => e.t === "AUTO_MODERATION_RULE_CREATE")?.users).not.toContain(ids.plain);
    const blocked = errorOf(() => send("plain", "so baaad... no, BADLY"));
    expect([blocked.status, blocked.code]).toEqual([400, 200000]);
    expect(blocked.errors).toEqual({ content: { _errors: [{ code: "AUTOMOD_BLOCKED", message: "Be nice" }] } });
    expect(() => send("plain", "my badge")).not.toThrow();
    expect(() => send("trusted", "bad")).not.toThrow();
    expect(() => send("owner", "bad")).not.toThrow();
    expect(() => send("manager", "bad")).not.toThrow();
    expect(audit(`?action_type=${AuditLogEvent.AutoModerationBlockMessage}`)).toHaveLength(1);
    call("owner", "PATCH", `/guilds/${guildId}/auto-moderation/rules/${rule.id}`, { enabled: false });
    expect(() => send("plain", "bad")).not.toThrow();
  });

  it("verification level holds back brand-new accounts without roles", () => {
    const fresh = createAccount({ username: "fresh" }).user.id;
    ids.fresh = fresh;
    db.guilds.get(guildId)!.members.set(fresh, { nick: null, roles: [], joined_at: new Date().toISOString() });
    call("owner", "PATCH", `/guilds/${guildId}`, { verification_level: 2 });
    expect(errorOf(() => send("fresh", "hi")).code).toBe(50009);
    expect(() => send("plain", "hi")).not.toThrow();
    expect(errorOf(() => call("owner", "PATCH", `/guilds/${guildId}`, { verification_level: 7 })).code).toBe(50035);
    expect(audit(`?action_type=${AuditLogEvent.GuildUpdate}`)[0]?.changes).toEqual([{ key: "verification_level", old_value: 0, new_value: 2 }]);
  });
});
