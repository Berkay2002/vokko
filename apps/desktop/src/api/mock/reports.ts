// Mock of docs/api.md "Reports (MOD-009)": POST .../report for messages and guild members, with the server's status and error codes,
// one open report per reporter and target, and the per-reporter limit (5 new reports, then 1 per minute). The moderator queue
// (GET/PATCH /guilds/{id}/reports) is not mocked: the client has no UI for it yet.

import { RateLimitedError } from "../errors";
import { MessageType, REPORT_DETAILS_MAX, type CreateReportRequest, type Report, type ReportReason } from "../types";
import { db, nextId, userOf } from "./db";
import { fail, requireChannel, requireGuildMember, requireMessage } from "./ops";
import { ID, route, str } from "./router";

const REASONS: readonly ReportReason[] = ["spam", "harassment", "hate", "sexual", "violence", "self_harm", "impersonation", "other"];
/** Message types a person wrote; everything else is a system message and cannot be reported. */
const USER_MESSAGE_TYPES = new Set<MessageType>([MessageType.Default, MessageType.Reply, MessageType.ChatInputCommand, MessageType.ContextMenuCommand]);

const reports: Report[] = [];
const created = new Map<string, number[]>();

/** Clears the mock's reports and limiter (tests). */
export function resetReports(): void {
  reports.length = 0;
  created.clear();
}

const invalid = (field: string, code: string, message: string): never => fail(400, 50035, "Invalid Form Body", { [field]: { code, message } });

function parseBody(body: Record<string, unknown>): CreateReportRequest {
  const reason = REASONS.find(r => r === str(body.reason));
  if (!reason) invalid("reason", "ENUM_TYPE_COERCE", "Must be one of: " + REASONS.join(", "));
  const raw = body.details === undefined || body.details === null ? "" : str(body.details);
  if (raw === undefined) invalid("details", "BASE_TYPE_BAD_STRING", "Must be a string.");
  const details = (raw ?? "").trim();
  if (Array.from(details).length > REPORT_DETAILS_MAX) invalid("details", "BASE_TYPE_MAX_LENGTH", `Must be ${REPORT_DETAILS_MAX} or fewer in length.`);
  return { reason: reason!, details: details === "" ? null : details };
}

/** 5 new reports, then 1 per minute (429 with retry_after). */
function takeSlot(reporterId: string): void {
  const now = Date.now();
  const times = created.get(reporterId) ?? [];
  const last = times[times.length - 1];
  if (times.length >= 5 && last !== undefined && now - last < 60_000) throw new RateLimitedError(Math.ceil((60_000 - (now - last)) / 1000), false);
  times.push(now);
  created.set(reporterId, times);
}

function file(reporterId: string, base: Pick<Report, "guild_id" | "target_type" | "channel_id" | "message_id" | "message_content">, targetUserId: string, input: CreateReportRequest): Report {
  const open = reports.find(r => r.status === "open" && r.reporter.id === reporterId && r.target_type === base.target_type && r.message_id === base.message_id && r.guild_id === base.guild_id && r.target_user.id === targetUserId);
  if (open) return open;
  takeSlot(reporterId);
  const report: Report = { id: nextId(), ...base, reporter: userOf(reporterId), target_user: userOf(targetUserId), reason: input.reason, details: input.details ?? null, status: "open", created_at: new Date().toISOString(), closed_by: null, closed_at: null };
  reports.push(report);
  return report;
}

route("POST", `/channels/${ID}/messages/${ID}/report`, ({ viewer, params, body }) => {
  const channel = requireChannel(params[0]!, viewer.user.id);
  const message = requireMessage(channel.id, params[1]!);
  const input = parseBody(body);
  if (message.author_id === viewer.user.id || !USER_MESSAGE_TYPES.has(message.type)) invalid("message_id", "REPORT_TARGET_INVALID", "This message cannot be reported.");
  return file(viewer.user.id, { guild_id: channel.guild_id ?? null, target_type: "message", channel_id: channel.id, message_id: message.id, message_content: message.content }, message.author_id, input);
});

route("POST", `/guilds/${ID}/members/${ID}/report`, ({ viewer, params, body }) => {
  const guild = requireGuildMember(params[0]!, viewer.user.id);
  const input = parseBody(body);
  const targetId = params[1]!;
  if (targetId === viewer.user.id) invalid("user_id", "REPORT_TARGET_INVALID", "You cannot report yourself.");
  if (!guild.members.has(targetId) || !db.accounts.has(targetId)) fail(404, 10007, "Unknown Member");
  return file(viewer.user.id, { guild_id: params[0]!, target_type: "user", channel_id: null, message_id: null, message_content: null }, targetId, input);
});
