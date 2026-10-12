import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./socket", () => ({ emit: () => undefined }));

import { ApiRequestError, RateLimitedError } from "../errors";
import type { Message, Report } from "../types";
import { db } from "./db";
import { createAccount, createGuildRecord } from "./ops";
import { handleRoute } from "./routes";
import { resetReports } from "./reports";

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
const reportMember = (who: string, uid: string, body: unknown = { reason: "harassment" }) => call(who, "POST", `/guilds/${guildId}/members/${uid}/report`, body) as Report;

beforeEach(() => {
  resetReports();
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
});
