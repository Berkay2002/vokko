// Mock of docs/api.md "Apply to Join": the member verification form, join requests (applicant side, reviewer queue, approve/reject)
// and the GUILD_JOIN_REQUEST_* events. The gate on invite accept lives in invites.ts; a ban drops the request (moderation.ts).

import { Perm, hasBit } from "../permissions";
import type { GuildJoinRequest, JoinRequestStatus, MemberVerificationField, MemberVerificationForm } from "../types";
import { guildPermsOf } from "./access";
import { db, nextId, userOf } from "./db";
import { joinViaInvite, liveInvite } from "./invites";
import { fail, guildAudience, requireGuildMember, requireGuildPerm } from "./ops";
import { ID, route, str } from "./router";
import { emit } from "./socket";

const forms = new Map<string, MemberVerificationForm>();
type Entry = { request: GuildJoinRequest; invite_code: string; inviter_id: string | null };
/** guild id -> user id -> request (+ the invite it was filed with and that invite's inviter, kept if the invite is deleted). */
const requests = new Map<string, Map<string, Entry>>();

/** Clears the mock's forms and requests (tests). */
export function resetJoinRequests(): void {
  forms.clear();
  requests.clear();
}

const invalid = (field: string, message: string): never => fail(400, 50035, "Invalid Form Body", { [field]: { code: "INVALID", message } });
const len = (v: string) => Array.from(v).length;
const unknownRequest = () => fail(404, 10070, "Unknown Join Request");
const FIELD_TYPES = ["TERMS", "TEXT_INPUT", "PARAGRAPH", "MULTIPLE_CHOICE"] as const;

const reviewerIds = (guildId: string): string[] =>
  guildAudience(guildId).filter(id => {
    const bits = guildPermsOf(guildId, id);
    return hasBit(bits, Perm.KICK_MEMBERS) || hasBit(bits, Perm.MANAGE_GUILD);
  });

function requireReviewer(guildId: string, viewerId: string) {
  const guild = requireGuildMember(guildId, viewerId);
  const bits = guildPermsOf(guildId, viewerId);
  if (!hasBit(bits, Perm.KICK_MEMBERS) && !hasBit(bits, Perm.MANAGE_GUILD)) fail(403, 50013, "Missing Permissions");
  return guild;
}

/** Control characters other than line breaks and tabs are refused (Postgres rejects NUL), like the server. */
const noControl = (text: string, name: string): string => (/[\p{Cc}]/u.test(text.replace(/[\n\r\t]/g, "")) ? invalid(name, "Must not contain control characters.") : text);

function optText(raw: unknown, max: number, name: string): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return invalid(name, "Must be a string.");
  const text = raw.trim();
  if (len(text) > max) invalid(name, `Must be ${max} or fewer in length.`);
  noControl(text, name);
  return text === "" ? null : text;
}

function strings(raw: unknown, min: number, max: number, each: number, name: string): string[] {
  if (!Array.isArray(raw) || raw.length < min || raw.length > max) return invalid(name, `Needs ${min}-${max} entries.`);
  return raw.map(v => {
    const text = typeof v === "string" ? v.trim() : "";
    if (text === "" || len(text) > each) return invalid(name, `Entries are 1-${each} characters.`);
    return noControl(text, name);
  });
}

function cleanForm(body: Record<string, unknown>): MemberVerificationForm {
  const raw = body.form_fields ?? [];
  if (!Array.isArray(raw)) return invalid("form_fields", "Must be a list.");
  const fields = raw.map((entry, i): MemberVerificationField => {
    const f = (entry ?? {}) as Record<string, unknown>;
    const name = `form_fields.${i}`;
    const type = FIELD_TYPES.find(t => t === f.field_type);
    if (!type) return invalid(name, "Unknown field_type.");
    const label = typeof f.label === "string" ? f.label.trim() : "";
    if (label === "" || len(label) > 300) invalid(name, "Label is 1-300 characters.");
    noControl(label, name);
    if ((type === "TEXT_INPUT" || type === "PARAGRAPH") && Array.isArray(f.values) && f.values.length > 0) invalid(`${name}.values`, "Text fields have no values.");
    const values = type === "TERMS" ? strings(f.values, 1, 16, 300, name) : type === "MULTIPLE_CHOICE" ? strings(f.values, 1, 8, 150, name) : null;
    return { field_type: type, label, required: f.required === true, values, description: optText(f.description, 300, name), placeholder: optText(f.placeholder, 100, name), response: null };
  });
  if (fields.filter(f => f.field_type === "TERMS").length > 1) invalid("form_fields", "At most one TERMS field.");
  if (fields.filter(f => f.field_type !== "TERMS").length > 5) invalid("form_fields", "At most 5 questions.");
  return { description: optText(body.description, 300, "description"), form_fields: fields };
}

const formOf = (guildId: string): MemberVerificationForm => forms.get(guildId) ?? { description: null, form_fields: [] };

route("GET", `/guilds/${ID}/member-verification`, ({ viewer, params, query }) => {
  const guildId = params[0] ?? "";
  const guild = db.guilds.get(guildId);
  if (!guild) return fail(404, 10004, "Unknown Guild");
  if (!guild.members.has(viewer.user.id)) {
    const code = query.get("invite_code");
    const invite = code ? db.invites.get(code) : undefined;
    let live = false;
    if (invite?.guild_id === guildId) {
      try {
        live = !!liveInvite(invite.code);
      } catch {
        live = false;
      }
    }
    if (!live) fail(404, 10004, "Unknown Guild");
  }
  return structuredClone(formOf(guildId));
});

route("PUT", `/guilds/${ID}/member-verification`, ({ viewer, params, body }) => {
  const guildId = params[0] ?? "";
  requireGuildPerm(guildId, viewer.user.id, Perm.MANAGE_GUILD);
  const form = cleanForm(body);
  forms.set(guildId, form);
  return structuredClone(form);
});

// ---- applicant ----

const entryOf = (guildId: string, userId: string) => requests.get(guildId)?.get(userId);

function setEntry(guildId: string, userId: string, entry: Entry | null): void {
  let map = requests.get(guildId);
  if (!map) requests.set(guildId, (map = new Map()));
  if (entry) map.set(userId, entry);
  else map.delete(userId);
}

/** What the applicant sees: not which moderator handled the request. */
const forApplicant = (request: GuildJoinRequest): GuildJoinRequest => ({ ...structuredClone(request), actioned_by_user: null });

function notify(guildId: string, userId: string, name: "GUILD_JOIN_REQUEST_CREATE" | "GUILD_JOIN_REQUEST_UPDATE", request: GuildJoinRequest): void {
  emit(reviewerIds(guildId).filter(id => id !== userId), name, { guild_id: guildId, status: request.application_status, request });
  emit([userId], name, { guild_id: guildId, status: request.application_status, request: forApplicant(request) });
}

function notifyDelete(guildId: string, request: GuildJoinRequest): void {
  emit([...new Set([request.user_id, ...reviewerIds(guildId)])], "GUILD_JOIN_REQUEST_DELETE", { guild_id: guildId, id: request.id, user_id: request.user_id });
}

/** A ban (or the guild's deletion) drops the user's request. */
export function dropJoinRequest(guildId: string, userId: string): void {
  const entry = entryOf(guildId, userId);
  if (!entry) return;
  setEntry(guildId, userId, null);
  if (db.guilds.has(guildId)) notifyDelete(guildId, entry.request);
}

export function purgeGuildJoinRequests(guildId: string): void {
  forms.delete(guildId);
  requests.delete(guildId);
}

function answered(form: MemberVerificationField[], raw: unknown): MemberVerificationField[] {
  if (!Array.isArray(raw) || raw.length !== form.length) return invalid("form_fields", "Answers must match the form.");
  return form.map((field, i) => {
    const given = (raw[i] ?? {}) as Record<string, unknown>;
    if (given.field_type !== field.field_type) invalid("form_fields", "Answers must match the form.");
    const r = given.response;
    let response: MemberVerificationField["response"] = null;
    if (field.field_type === "TERMS") {
      if (r === true) response = true;
      else if (field.required) invalid(`form_fields.${i}`, "The rules must be accepted.");
    } else if (field.field_type === "MULTIPLE_CHOICE") {
      if (r !== undefined && r !== null) {
        if (typeof r !== "number" || !Number.isInteger(r) || r < 0 || r >= (field.values?.length ?? 0)) invalid(`form_fields.${i}`, "Pick one of the choices.");
        response = r as number;
      } else if (field.required) invalid(`form_fields.${i}`, "This question is required.");
    } else {
      const text = typeof r === "string" ? noControl(r.trim(), `form_fields.${i}`) : "";
      if (r !== undefined && r !== null && typeof r !== "string") invalid(`form_fields.${i}`, "Must be a string.");
      if (len(text) > (field.field_type === "TEXT_INPUT" ? 150 : 1000)) invalid(`form_fields.${i}`, "Answer is too long.");
      if (text !== "") response = text;
      else if (field.required) invalid(`form_fields.${i}`, "This question is required.");
    }
    return { ...field, response };
  });
}

route("PUT", `/guilds/${ID}/requests/@me`, ({ viewer, params, body }) => {
  const guildId = params[0] ?? "";
  const userId = viewer.user.id;
  const invite = liveInvite(str(body.invite_code) ?? "");
  if (invite.guild_id !== guildId) fail(404, 10006, "Unknown Invite");
  const guild = db.guilds.get(guildId);
  if (!guild) return fail(404, 10006, "Unknown Invite");
  const responses = answered(formOf(guildId).form_fields, body.form_fields);
  if (db.bans.get(guildId)?.has(userId)) fail(403, 40007, "The user is banned from this guild");
  if (guild.members.has(userId)) invalid("guild_id", "You are already a member of this server.");
  if (guild.guild.join_mode !== 1) invalid("join_mode", "This server does not take applications.");
  const old = entryOf(guildId, userId);
  const request: GuildJoinRequest = { id: nextId(), guild_id: guildId, user_id: userId, user: userOf(userId), created_at: new Date().toISOString(), application_status: "SUBMITTED", form_responses: responses, rejection_reason: null, actioned_at: null, actioned_by_user: null };
  setEntry(guildId, userId, { request, invite_code: invite.code, inviter_id: invite.inviter_id ?? null });
  if (old) notifyDelete(guildId, old.request);
  notify(guildId, userId, "GUILD_JOIN_REQUEST_CREATE", request);
  return forApplicant(request);
});

route("GET", `/guilds/${ID}/requests/@me`, ({ viewer, params }) => {
  const entry = entryOf(params[0] ?? "", viewer.user.id);
  return entry ? forApplicant(entry.request) : unknownRequest();
});

route("DELETE", `/guilds/${ID}/requests/@me`, ({ viewer, params }) => {
  const guildId = params[0] ?? "";
  const entry = entryOf(guildId, viewer.user.id);
  if (!entry || entry.request.application_status !== "SUBMITTED") return unknownRequest();
  setEntry(guildId, viewer.user.id, null);
  notifyDelete(guildId, entry.request);
  return undefined;
});

// ---- reviewers ----

const STATUSES: readonly JoinRequestStatus[] = ["SUBMITTED", "APPROVED", "REJECTED"];

route("GET", `/guilds/${ID}/requests`, ({ viewer, params, query }) => {
  const guildId = params[0] ?? "";
  requireReviewer(guildId, viewer.user.id);
  const status = STATUSES.find(s => s === (query.get("status") ?? "SUBMITTED"));
  if (!status) return invalid("status", "Must be one of: SUBMITTED, APPROVED, REJECTED.");
  const limit = Number(query.get("limit") ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid("limit", "Must be between 1 and 100.");
  const before = query.get("before");
  const all = [...(requests.get(guildId)?.values() ?? [])].map(e => e.request).filter(r => r.application_status === status).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1));
  const page = all.filter(r => !before || BigInt(r.id) < BigInt(before)).slice(0, limit);
  return { guild_join_requests: structuredClone(page), total: all.length };
});

route("PATCH", `/guilds/${ID}/requests/${ID}`, ({ viewer, params, body }) => {
  const guildId = params[0] ?? "";
  const guild = requireReviewer(guildId, viewer.user.id);
  const entry = [...(requests.get(guildId)?.values() ?? [])].find(e => e.request.id === params[1]);
  if (!entry) return unknownRequest();
  const { request } = entry;
  const action = body.action;
  if (action !== "APPROVED" && action !== "REJECTED") invalid("action", "Must be APPROVED or REJECTED.");
  if (request.application_status !== "SUBMITTED") invalid("action", "This request was already handled.");
  const reason = optText(body.rejection_reason, 160, "rejection_reason");
  if (action === "APPROVED") {
    if (db.bans.get(guildId)?.has(request.user_id)) fail(403, 40007, "The user is banned from this guild");
    if (!guild.members.has(request.user_id)) {
      const invite = db.invites.get(entry.invite_code);
      joinViaInvite(guild, request.user_id, invite, false);
      // The invite may be gone: the member keeps the code and inviter stored on the request, not the owner fallback.
      const member = guild.members.get(request.user_id);
      if (member && !invite) Object.assign(member, { source_invite_code: entry.invite_code, inviter_id: entry.inviter_id });
    }
  }
  request.application_status = action as JoinRequestStatus;
  request.rejection_reason = action === "REJECTED" ? reason : null;
  request.actioned_at = new Date().toISOString();
  request.actioned_by_user = userOf(viewer.user.id);
  notify(guildId, request.user_id, "GUILD_JOIN_REQUEST_UPDATE", request);
  return structuredClone(request);
});
