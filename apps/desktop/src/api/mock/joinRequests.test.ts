import { beforeEach, describe, expect, it, vi } from "vitest";

const events: { users: string[]; t: string; d: unknown }[] = [];
vi.mock("./socket", () => ({
  emit: (users: Iterable<string>, t: string, d: unknown) => {
    events.push({ users: [...users], t, d });
  },
}));

import { ApiRequestError } from "../errors";
import type { Guild, GuildJoinRequest, GuildJoinRequestList, Invite, MemberVerificationForm } from "../types";
import { db } from "./db";
import { resetJoinRequests } from "./joinRequests";
import { createAccount, createGuildRecord } from "./ops";
import { handleRoute } from "./routes";

const ids: Record<string, string> = {};
let guildId = "";
let code = "";

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
const FORM: MemberVerificationForm = {
  description: "Tell us about you",
  form_fields: [
    { field_type: "TERMS", label: "Server Rules", required: true, values: ["Be kind"] },
    { field_type: "TEXT_INPUT", label: "Why join?", required: true },
    { field_type: "MULTIPLE_CHOICE", label: "Pick", required: false, values: ["a", "b"] },
  ],
};
const answers = (why = "because"): unknown[] => [{ field_type: "TERMS", response: true }, { field_type: "TEXT_INPUT", response: why }, { field_type: "MULTIPLE_CHOICE", response: 1 }];
const apply = (who: string, fields: unknown = answers()) => call(who, "PUT", `/guilds/${guildId}/requests/@me`, { invite_code: code, form_fields: fields }) as GuildJoinRequest;
const list = (who: string, status = "SUBMITTED") => call(who, "GET", `/guilds/${guildId}/requests?status=${status}`) as GuildJoinRequestList;
const act = (who: string, id: string, body: unknown) => call(who, "PATCH", `/guilds/${guildId}/requests/${id}`, body) as GuildJoinRequest;

beforeEach(() => {
  events.length = 0;
  resetJoinRequests();
  for (const map of [db.accounts, db.channels, db.messages, db.guilds, db.invites, db.bans, db.pending] as Map<string, unknown>[]) map.clear();
  for (const name of ["owner", "applicant", "other"]) ids[name] = createAccount({ username: name }).user.id;
  guildId = createGuildRecord(ids.owner!, "Apply guild");
  const channel = [...db.channels.values()].find(c => c.guild_id === guildId && c.name === "general")!;
  code = (call("owner", "POST", `/channels/${channel.id}/invites`, {}) as Invite).code;
  call("owner", "PUT", `/guilds/${guildId}/member-verification`, FORM);
  call("owner", "PATCH", `/guilds/${guildId}`, { join_mode: 1 });
});

describe("mock apply to join", () => {
  it("gates invite accept for non-members and shows join_mode in the preview", () => {
    expect((call("applicant", "GET", `/invites/${code}`) as Invite).guild.join_mode).toBe(1);
    expect(errorOf(() => call("applicant", "POST", `/invites/${code}`))).toEqual({ status: 403, code: 150009 });
    expect(db.guilds.get(guildId)!.members.has(ids.applicant!)).toBe(false);
    expect((call("owner", "POST", `/invites/${code}`) as Guild).id).toBe(guildId);
    expect(errorOf(() => call("owner", "PATCH", `/guilds/${guildId}`, { join_mode: 2 }))).toMatchObject({ status: 400, code: 50035 });
  });

  it("serves the form to members and to non-members with a live invite only", () => {
    expect(call("applicant", "GET", `/guilds/${guildId}/member-verification?invite_code=${code}`)).toMatchObject({ description: "Tell us about you" });
    expect(errorOf(() => call("applicant", "GET", `/guilds/${guildId}/member-verification`))).toEqual({ status: 404, code: 10004 });
    expect(errorOf(() => call("applicant", "PUT", `/guilds/${guildId}/member-verification`, FORM))).toMatchObject({ status: 403 });
  });

  it("validates the form limits", () => {
    const put = (form: unknown) => errorOf(() => call("owner", "PUT", `/guilds/${guildId}/member-verification`, form));
    const q = { field_type: "TEXT_INPUT", label: "q", required: false };
    expect(put({ description: null, form_fields: Array(6).fill(q) })).toMatchObject({ code: 50035 });
    expect(put({ description: null, form_fields: [{ field_type: "TERMS", label: "r", required: true, values: [] }] })).toMatchObject({ code: 50035 });
    expect(put({ description: null, form_fields: [{ field_type: "MULTIPLE_CHOICE", label: "m", required: true, values: Array(9).fill("x") }] })).toMatchObject({ code: 50035 });
    expect(put({ description: null, form_fields: [{ ...q, label: "" }] })).toMatchObject({ code: 50035 });
  });

  it("validates answers, then approving adds the member and notifies both sides", () => {
    expect(errorOf(() => apply("applicant", [{ field_type: "TERMS", response: true }]))).toMatchObject({ status: 400, code: 50035 });
    expect(errorOf(() => apply("applicant", answers("  ")))).toMatchObject({ status: 400, code: 50035 });
    expect(errorOf(() => apply("applicant", answers("x".repeat(151))))).toMatchObject({ status: 400, code: 50035 });
    expect(errorOf(() => apply("applicant", answers("a\u0000b")))).toMatchObject({ status: 400, code: 50035 });
    const request = apply("applicant");
    expect(request).toMatchObject({ application_status: "SUBMITTED", user_id: ids.applicant });
    expect(request.form_responses[1]?.response).toBe("because");
    expect(events.filter(e => e.t === "GUILD_JOIN_REQUEST_CREATE").flatMap(e => e.users)).toEqual(expect.arrayContaining([ids.applicant, ids.owner]));
    expect(list("owner").total).toBe(1);
    expect(errorOf(() => list("other"))).toMatchObject({ status: 403 });
    expect(request.actioned_by_user).toBeNull();
    events.length = 0;
    const done = act("owner", request.id, { action: "APPROVED" });
    expect(done).toMatchObject({ application_status: "APPROVED", actioned_by_user: { id: ids.owner } });
    expect(db.guilds.get(guildId)!.members.has(ids.applicant!)).toBe(true);
    expect(events.map(e => e.t)).toEqual(expect.arrayContaining(["GUILD_CREATE", "GUILD_JOIN_REQUEST_UPDATE"]));
    const updates = events.filter(e => e.t === "GUILD_JOIN_REQUEST_UPDATE");
    const seen = (user: string) => (updates.find(e => e.users.includes(user))?.d as { request: GuildJoinRequest }).request.actioned_by_user;
    expect(seen(ids.applicant!)).toBeNull();
    expect(seen(ids.owner!)).toMatchObject({ id: ids.owner });
    expect((call("applicant", "GET", `/guilds/${guildId}/requests/@me`) as GuildJoinRequest).actioned_by_user).toBeNull();
    expect(list("owner").total).toBe(0);
    expect(list("owner", "APPROVED").guild_join_requests).toHaveLength(1);
    expect(errorOf(() => act("owner", request.id, { action: "REJECTED" }))).toMatchObject({ status: 400 });
    const handled = (): unknown => {
      try {
        act("owner", request.id, { action: "REJECTED" });
      } catch (e) {
        return (e as ApiRequestError).api.errors;
      }
    };
    expect(handled()).toHaveProperty("action");
    expect(errorOf(() => apply("applicant"))).toMatchObject({ status: 400 });
  });

  it("rejects with a reason and lets the applicant apply again", () => {
    const first = apply("applicant");
    expect(errorOf(() => act("owner", first.id, { action: "REJECTED", rejection_reason: "x".repeat(161) }))).toMatchObject({ status: 400 });
    expect(act("owner", first.id, { action: "REJECTED", rejection_reason: "not now" })).toMatchObject({ application_status: "REJECTED", rejection_reason: "not now" });
    expect((call("applicant", "GET", `/guilds/${guildId}/requests/@me`) as GuildJoinRequest).application_status).toBe("REJECTED");
    expect(errorOf(() => call("applicant", "DELETE", `/guilds/${guildId}/requests/@me`))).toEqual({ status: 404, code: 10070 });
    const second = apply("applicant");
    expect(second.id).not.toBe(first.id);
    expect(list("owner", "REJECTED").total).toBe(0);
    expect(list("owner").total).toBe(1);
  });

  it("withdraws a pending request", () => {
    const request = apply("applicant");
    events.length = 0;
    expect(call("applicant", "DELETE", `/guilds/${guildId}/requests/@me`)).toBeUndefined();
    expect(events.find(e => e.t === "GUILD_JOIN_REQUEST_DELETE")?.d).toEqual({ guild_id: guildId, id: request.id, user_id: ids.applicant });
    expect(errorOf(() => call("applicant", "GET", `/guilds/${guildId}/requests/@me`))).toEqual({ status: 404, code: 10070 });
    expect(list("owner").total).toBe(0);
  });

  it("needs apply mode, a live invite and no ban; a ban deletes the request", () => {
    const request = apply("applicant");
    expect(errorOf(() => call("applicant", "PUT", `/guilds/${guildId}/requests/@me`, { invite_code: "nope", form_fields: answers() }))).toEqual({ status: 404, code: 10006 });
    call("owner", "PUT", `/guilds/${guildId}/bans/${ids.applicant}`, {});
    expect(list("owner").total).toBe(0);
    expect(errorOf(() => call("applicant", "GET", `/guilds/${guildId}/requests/@me`))).toMatchObject({ status: 404 });
    expect(errorOf(() => apply("applicant"))).toEqual({ status: 403, code: 40007 });
    expect(request.id).toBeTruthy();
    call("owner", "PATCH", `/guilds/${guildId}`, { join_mode: 0 });
    expect(errorOf(() => apply("other"))).toMatchObject({ status: 400, code: 50035 });
  });

  it("validates the answers before the mode, and refuses text fields with values and control characters in the form", () => {
    call("owner", "PATCH", `/guilds/${guildId}`, { join_mode: 0 });
    expect(errorOf(() => apply("other", []))).toMatchObject({ status: 400 });
    const put = (fields: unknown[]) => errorOf(() => call("owner", "PUT", `/guilds/${guildId}/member-verification`, { form_fields: fields }));
    expect(put([{ field_type: "TEXT_INPUT", label: "Q", values: ["a"] }])).toMatchObject({ status: 400, code: 50035 });
    expect(put([{ field_type: "TEXT_INPUT", label: "a\u0000b" }])).toMatchObject({ status: 400, code: 50035 });
    const stored = call("owner", "PUT", `/guilds/${guildId}/member-verification`, { form_fields: [{ field_type: "TEXT_INPUT", label: "Q", response: "x" }] }) as MemberVerificationForm;
    expect(stored.form_fields[0]?.response).toBeNull();
  });

  it("keeps the stored inviter when the invite was deleted before approval", () => {
    const request = apply("applicant");
    call("owner", "DELETE", `/invites/${code}`);
    act("owner", request.id, { action: "APPROVED" });
    expect(db.guilds.get(guildId)!.members.get(ids.applicant!)).toMatchObject({ source_invite_code: code, inviter_id: ids.owner });
  });

  it("re-checks bans on approval", () => {
    const request = apply("applicant");
    db.bans.set(guildId, new Map([[ids.applicant!, null]]));
    expect(errorOf(() => act("owner", request.id, { action: "APPROVED" }))).toEqual({ status: 403, code: 40007 });
    expect(list("owner").total).toBe(1);
  });

  it("pages the reviewer queue newest first with before/limit and the full total", () => {
    const names = ["u1", "u2", "u3"];
    const made = names.map(n => {
      ids[n] = createAccount({ username: n }).user.id;
      return apply(n).id;
    });
    const page = (q: string) => call("owner", "GET", `/guilds/${guildId}/requests?${q}`) as GuildJoinRequestList;
    const first = page("limit=2");
    const second = page(`limit=2&before=${first.guild_join_requests[1]!.id}`);
    expect(first.guild_join_requests.map(r => r.id)).toEqual([made[2], made[1]]);
    expect(second.guild_join_requests.map(r => r.id)).toEqual([made[0]]);
    expect([first.total, second.total]).toEqual([3, 3]);
  });
});
