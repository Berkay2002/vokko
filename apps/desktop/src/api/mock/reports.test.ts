import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./socket", () => ({ emit: () => undefined }));

import { ApiRequestError, RateLimitedError } from "../errors";
import { Perm } from "../permissions";
import type { AuditLogEntry, Message, Report } from "../types";
import { db } from "./db";
import { createAccount, createGuildRecord } from "./ops";
import { handleRoute } from "./routes";
import { resetReports } from "./reports";
import { resetAdmin } from "./admin";

const ids: Record<string, string> = {};
let guildId = "";
let general = "";

const call = (who: string, method: string, path: string, body?: unknown): unknown => handleRoute(method, path, body ?? null, ids[who] ?? null);
const errorOf = (fn: () => unknown): { status: number; code: number; errors?: Record<string, unknown> } => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApiRequestError) return { status: e.status, code: e.code, errors: e.api.errors as Record<string, unknown> | undefined };
    throw e;
  }
  throw new Error("expected the call to fail");
};
const say = (who: string, content: string): Message => call(who, "POST", `/channels/${general}/messages`, { content }) as Message;
const reportMessage = (who: string, mid: string, body: unknown = { reason: "spam" }) => call(who, "POST", `/channels/${general}/messages/${mid}/report`, body) as Report;
const listReports = (who: string, query = ""): Report[] => call(who, "GET", `/guilds/${guildId}/reports${query}`) as Report[];
const setStatus = (who: string, id: string, status: string): Report => call(who, "PATCH", `/guilds/${guildId}/reports/${id}`, { status }) as Report;
const auditEntries = (): AuditLogEntry[] => (call("owner", "GET", `/guilds/${guildId}/audit-logs?action_type=250`) as { audit_log_entries: AuditLogEntry[] }).audit_log_entries;
const reportMember = (who: string, uid: string, body: unknown = { reason: "harassment" }) => call(who, "POST", `/guilds/${guildId}/members/${uid}/report`, body) as Report;

beforeEach(() => {
  resetReports();
  resetAdmin();
  for (const map of [db.accounts, db.channels, db.messages, db.guilds, db.invites, db.bans, db.pending, db.followers] as Map<string, unknown>[]) map.clear();
  for (const name of ["owner", "alice", "outsider"]) ids[name] = createAccount({ username: name }).user.id;
  guildId = createGuildRecord(ids.owner!, "Test guild");
  db.guilds.get(guildId)!.members.set(ids.alice!, { nick: null, roles: [], joined_at: new Date().toISOString() });
  general = [...db.channels.values()].find(c => c.guild_id === guildId && c.name === "general")!.id;
});

describe("mock reports", () => {
  it("reports another member's message", () => {
    const message = say("alice", "buy cheap stuff");
    const report = reportMessage("owner", message.id, { reason: "spam", details: "  again  " });
    expect(report).toMatchObject({ guild_id: guildId, target_type: "message", channel_id: general, message_id: message.id, message_content: "buy cheap stuff", reason: "spam", details: "again", status: "open", closed_by: null, closed_at: null });
    expect(report.reporter.id).toBe(ids.owner);
    expect(report.target_user.id).toBe(ids.alice);
  });

  it("reports a guild member", () => {
    const report = reportMember("owner", ids.alice!, { reason: "impersonation", details: "  " });
    expect(report).toMatchObject({ guild_id: guildId, target_type: "user", message_id: null, message_content: null, reason: "impersonation", details: null });
    expect(report.target_user.id).toBe(ids.alice);
  });

  it("rejects your own message, yourself, unknown targets and strangers", () => {
    const mine = say("owner", "hello");
    expect(errorOf(() => reportMessage("owner", mine.id))).toMatchObject({ status: 400, code: 50035 });
    expect(errorOf(() => reportMessage("owner", mine.id))).toHaveProperty("errors.message_id");
    expect(errorOf(() => reportMember("owner", ids.owner!))).toMatchObject({ status: 400, code: 50035 });
    expect(errorOf(() => reportMember("owner", ids.owner!))).toHaveProperty("errors.user_id");
    expect(errorOf(() => reportMessage("alice", "999999999999"))).toMatchObject({ status: 404, code: 10008 });
    expect(errorOf(() => reportMember("owner", ids.outsider!))).toMatchObject({ status: 404, code: 10007 });
    expect(errorOf(() => reportMember("outsider", ids.alice!))).toMatchObject({ status: 403, code: 50001 });
  });

  it("rejects system messages", () => {
    const pin = say("alice", "pin me");
    call("owner", "PUT", `/channels/${general}/messages/pins/${pin.id}`);
    const notice = (call("owner", "GET", `/channels/${general}/messages`) as Message[]).find(m => m.type === 6)!;
    expect(errorOf(() => reportMessage("owner", notice.id))).toMatchObject({ status: 400, code: 50035 });
  });

  it("returns the open report again instead of a new one", () => {
    const message = say("alice", "rude");
    const first = reportMessage("owner", message.id);
    expect(reportMessage("owner", message.id, { reason: "hate" }).id).toBe(first.id);
    const member = reportMember("owner", ids.alice!);
    expect(reportMember("owner", ids.alice!).id).toBe(member.id);
    expect(member.id).not.toBe(first.id);
  });

  it("validates reason and details length", () => {
    const message = say("alice", "x");
    expect(errorOf(() => reportMessage("owner", message.id, { reason: "bogus" }))).toMatchObject({ status: 400, code: 50035 });
    expect(errorOf(() => reportMessage("owner", message.id, { reason: "spam", details: "a".repeat(1001) }))).toMatchObject({ status: 400, code: 50035 });
    expect(reportMessage("owner", message.id, { reason: "spam", details: "a".repeat(1000) }).details).toHaveLength(1000);
  });

  it("allows 5 new reports, then 1 per minute", () => {
    for (let i = 0; i < 5; i++) reportMessage("owner", say("alice", `m${i}`).id);
    const extra = say("alice", "one more");
    try {
      reportMessage("owner", extra.id);
      throw new Error("expected 429");
    } catch (e) {
      expect(e).toBeInstanceOf(RateLimitedError);
      expect((e as RateLimitedError).retryAfter).toBeGreaterThan(0);
    }
  });

  describe("moderator queue", () => {
    it("lists reports to moderators only, newest first, without reports about the caller", () => {
      const first = reportMember("alice", ids.owner!);
      const second = reportMessage("owner", say("alice", "rude").id);
      expect(errorOf(() => listReports("alice"))).toMatchObject({ status: 403, code: 50013 });
      expect(errorOf(() => listReports("outsider"))).toMatchObject({ status: 403, code: 50001 });
      // The owner is the target of the first report, so only the second shows up for them.
      expect(listReports("owner").map(r => r.id)).toEqual([second.id]);
      const role = { id: "9100", name: "mods", color: 0, hoist: false, position: 1, permissions: Perm.MANAGE_MESSAGES.toString(), mentionable: false };
      db.guilds.get(guildId)!.guild.roles.push(role);
      ids.mod = createAccount({ username: "mod" }).user.id;
      db.guilds.get(guildId)!.members.set(ids.mod, { nick: null, roles: [role.id], joined_at: new Date().toISOString() });
      expect(listReports("mod").map(r => r.id)).toEqual([second.id, first.id]);
    });

    it("filters by status and pages with before and limit", () => {
      const a = reportMessage("owner", say("alice", "a").id);
      const b = reportMessage("owner", say("alice", "b").id);
      const c = reportMessage("owner", say("alice", "c").id);
      setStatus("owner", b.id, "dismissed");
      setStatus("owner", c.id, "resolved");
      expect(listReports("owner").map(r => r.id)).toEqual([a.id]);
      expect(listReports("owner", "?status=dismissed").map(r => r.id)).toEqual([b.id]);
      expect(listReports("owner", "?status=resolved").map(r => r.id)).toEqual([c.id]);
      expect(listReports("owner", "?status=all").map(r => r.id)).toEqual([c.id, b.id, a.id]);
      expect(listReports("owner", "?status=all&limit=2").map(r => r.id)).toEqual([c.id, b.id]);
      expect(listReports("owner", `?status=all&before=${b.id}`).map(r => r.id)).toEqual([a.id]);
      expect(errorOf(() => listReports("owner", "?status=bogus"))).toMatchObject({ status: 400, code: 50035 });
    });

    it("closes and reopens, and answers 404 for a report about the caller", () => {
      const report = reportMessage("owner", say("alice", "spam").id);
      const closed = setStatus("owner", report.id, "resolved");
      expect(closed).toMatchObject({ status: "resolved", closed_by: ids.owner });
      expect(closed.closed_at).not.toBeNull();
      expect(setStatus("owner", report.id, "open")).toMatchObject({ status: "open", closed_by: null, closed_at: null });
      expect(errorOf(() => setStatus("owner", report.id, "bogus"))).toMatchObject({ status: 400, code: 50035 });
      expect(errorOf(() => setStatus("alice", report.id, "resolved"))).toMatchObject({ status: 403, code: 50013 });
      const aboutOwner = reportMember("alice", ids.owner!);
      expect(errorOf(() => setStatus("owner", aboutOwner.id, "resolved"))).toMatchObject({ status: 404 });
    });

    it("refuses to reopen next to a newer open report from the same reporter", () => {
      const message = say("alice", "rude");
      const old = reportMessage("owner", message.id);
      setStatus("owner", old.id, "dismissed");
      reportMessage("owner", message.id);
      expect(errorOf(() => setStatus("owner", old.id, "open"))).toMatchObject({ status: 400, code: 50035, errors: { status: expect.anything() } });
    });

    it("records audit entry 250 only when the status changes", () => {
      const report = reportMessage("owner", say("alice", "spam").id);
      setStatus("owner", report.id, "open");
      expect(auditEntries()).toHaveLength(0);
      setStatus("owner", report.id, "resolved");
      setStatus("owner", report.id, "resolved");
      setStatus("owner", report.id, "open");
      const entries = auditEntries();
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({ action_type: 250, target_id: report.id, user_id: ids.owner, changes: [{ key: "status", old_value: "resolved", new_value: "open" }] });
      expect(entries[1]).toMatchObject({ changes: [{ key: "status", old_value: "open", new_value: "resolved" }] });
    });
  });
});
