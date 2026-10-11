// Server admin routes of docs/api.md: audit log, prune, role member counts, AutoMod keyword rules, and the send checks
// (verification level + AutoMod) that the message routes call. Registered by import side effect from routes.ts.

import { findKeyword } from "../automod";
import { Perm, hasBit, outranks } from "../permissions";
import { snowflakeToTimestamp } from "../snowflake";
import {
  AuditLogEvent,
  AutoModerationActionType,
  AutoModerationEventType,
  AutoModerationTriggerType,
  VerificationLevel,
  isThreadType,
  type AuditEntryInfo,
  type AuditLogChange,
  type AuditLogEntry,
  type AutoModerationRule,
  type User,
} from "../types";
import { guildPermsOf } from "./access";
import { db, nextId, sortedMessages, userOf, type MockChannel, type MockGuild } from "./db";
import { MISSING_PERMISSIONS, fail, requireGuildMember } from "./ops";
import { ID, currentAuditReason, route, str } from "./router";
import { emit } from "./socket";

const DAY_MS = 86_400_000;
const forbidden = (): never => fail(403, 50013, MISSING_PERMISSIONS);
const invalid = (field: string, message: string): never => fail(400, 50035, "Invalid Form Body", { [field]: { code: "INVALID", message } });

const auditLog = new Map<string, AuditLogEntry[]>();
const automodRules = new Map<string, AutoModerationRule[]>();

/** Tests: forget every audit entry and AutoMod rule. */
export function resetAdmin(): void {
  auditLog.clear();
  automodRules.clear();
}

const membersWith = (guild: MockGuild, bit: bigint): string[] => [...guild.members.keys()].filter(id => hasBit(guildPermsOf(guild.guild.id, id), bit));

/** A change record when the values differ (`null` / `undefined` = not set). */
export function change(key: string, oldValue: unknown, newValue: unknown): AuditLogChange | null {
  const norm = (v: unknown) => (v === undefined ? null : v);
  if (JSON.stringify(norm(oldValue)) === JSON.stringify(norm(newValue))) return null;
  return { key, ...(norm(oldValue) !== null ? { old_value: oldValue } : {}), ...(norm(newValue) !== null ? { new_value: newValue } : {}) };
}

/** Records an entry (reason = the request's X-Audit-Log-Reason) and sends GUILD_AUDIT_LOG_ENTRY_CREATE to VIEW_AUDIT_LOG holders. */
export function recordAudit(
  guildId: string,
  userId: string | null,
  action: AuditLogEvent,
  targetId: string | null,
  extra: { changes?: (AuditLogChange | null)[]; options?: AuditEntryInfo; reason?: string | null; skipIfUnchanged?: boolean } = {},
): AuditLogEntry | null {
  const guild = db.guilds.get(guildId);
  if (!guild) return null;
  const changes = (extra.changes ?? []).filter((c): c is AuditLogChange => c !== null);
  if (extra.skipIfUnchanged && changes.length === 0) return null;
  const entry: AuditLogEntry = {
    id: nextId(),
    guild_id: guildId,
    user_id: userId,
    target_id: targetId,
    action_type: action,
    ...(changes.length > 0 ? { changes } : {}),
    ...(extra.options ? { options: extra.options } : {}),
    reason: extra.reason !== undefined ? extra.reason : currentAuditReason(),
  };
  let list = auditLog.get(guildId);
  if (!list) auditLog.set(guildId, (list = []));
  list.push(entry);
  emit(membersWith(guild, Perm.VIEW_AUDIT_LOG), "GUILD_AUDIT_LOG_ENTRY_CREATE", entry);
  return entry;
}

const USER_TARGETS = new Set([
  AuditLogEvent.MemberKick,
  AuditLogEvent.MemberBanAdd,
  AuditLogEvent.MemberBanRemove,
  AuditLogEvent.MemberUpdate,
  AuditLogEvent.MemberRoleUpdate,
  AuditLogEvent.MessageDelete,
  AuditLogEvent.MessagePin,
  AuditLogEvent.MessageUnpin,
  AuditLogEvent.AutoModerationBlockMessage,
]);

route("GET", `/guilds/${ID}/audit-logs`, ({ viewer, params, query }) => {
  const guildId = params[0] ?? "";
  requireGuildMember(guildId, viewer.user.id);
  if (!hasBit(guildPermsOf(guildId, viewer.user.id), Perm.VIEW_AUDIT_LOG)) forbidden();
  const limit = Number(query.get("limit") ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid("limit", "Must be between 1 and 100.");
  const userId = query.get("user_id");
  const action = query.get("action_type");
  const before = query.get("before");
  const after = query.get("after");
  const entries = [...(auditLog.get(guildId) ?? [])]
    .reverse()
    .filter(e => (!userId || e.user_id === userId) && (!action || e.action_type === Number(action)))
    .filter(e => (!before || BigInt(e.id) < BigInt(before)) && (!after || BigInt(e.id) > BigInt(after)))
    .slice(0, limit);
  const ids = new Set<string>();
  for (const e of entries) {
    if (e.user_id) ids.add(e.user_id);
    if (e.target_id && USER_TARGETS.has(e.action_type)) ids.add(e.target_id);
  }
  const users: User[] = [...ids].filter(id => db.accounts.has(id)).map(id => userOf(id));
  return { audit_log_entries: entries, users };
});

// ---- role member counts ----

route("GET", `/guilds/${ID}/roles/member-counts`, ({ viewer, params }) => {
  const guild = requireGuildMember(params[0] ?? "", viewer.user.id);
  const counts: Record<string, number> = {};
  for (const role of guild.guild.roles) if (role.id !== guild.guild.id) counts[role.id] = 0;
  for (const record of guild.members.values()) for (const id of record.roles) if (id in counts) counts[id] = (counts[id] ?? 0) + 1;
  return counts;
});

// ---- prune ----

function pruneParams(guild: MockGuild, viewerId: string, daysRaw: unknown, includeRaw: string[]): { days: number; include: string[] } {
  const bits = guildPermsOf(guild.guild.id, viewerId);
  if (!hasBit(bits, Perm.KICK_MEMBERS) || !hasBit(bits, Perm.MANAGE_GUILD)) forbidden();
  const days = daysRaw === undefined || daysRaw === null || daysRaw === "" ? 7 : Number(daysRaw);
  if (!Number.isInteger(days) || days < 1 || days > 30) invalid("days", "Must be between 1 and 30.");
  const actor = { id: viewerId, roles: guild.members.get(viewerId)?.roles ?? [] };
  for (const id of includeRaw) {
    const role = guild.guild.roles.find(r => r.id === id && r.id !== guild.guild.id);
    if (!role) invalid("include_roles", "Unknown role.");
    if (viewerId !== guild.guild.owner_id && !outranks(guild.guild, actor, { id: "", roles: [id] })) forbidden();
  }
  return { days, include: includeRaw };
}

/** Joined more than `days` ago, no message of their own in the guild since, only included roles, not the owner or the caller. */
export function prunable(guild: MockGuild, viewerId: string, days: number, include: string[]): string[] {
  const cutoff = Date.now() - days * DAY_MS;
  const recent = new Set<string>();
  for (const channel of db.channels.values()) {
    if (channel.guild_id !== guild.guild.id) continue;
    for (const m of sortedMessages(channel.id)) if ((m.type === 0 || m.type === 19) && Date.parse(m.timestamp) > cutoff) recent.add(m.author_id);
  }
  return [...guild.members.entries()]
    .filter(([id, record]) => id !== guild.guild.owner_id && id !== viewerId && Date.parse(record.joined_at) < cutoff && !recent.has(id))
    .filter(([, record]) => record.roles.every(role => include.includes(role)))
    .map(([id]) => id);
}

const listParam = (raw: string | null): string[] => (raw ?? "").split(",").map(s => s.trim()).filter(Boolean);

route("GET", `/guilds/${ID}/prune`, ({ viewer, params, query }) => {
  const guild = requireGuildMember(params[0] ?? "", viewer.user.id);
  const { days, include } = pruneParams(guild, viewer.user.id, query.get("days"), listParam(query.get("include_roles")));
  return { pruned: prunable(guild, viewer.user.id, days, include).length };
});

route("POST", `/guilds/${ID}/prune`, ({ viewer, params, body }) => {
  const guild = requireGuildMember(params[0] ?? "", viewer.user.id);
  const include = Array.isArray(body.include_roles) ? body.include_roles.filter((v): v is string => typeof v === "string") : [];
  const { days, include: roles } = pruneParams(guild, viewer.user.id, body.days, include);
  const doomed = prunable(guild, viewer.user.id, days, roles);
  for (const id of doomed) {
    guild.members.delete(id);
    emit(guild.members.keys(), "GUILD_MEMBER_REMOVE", { guild_id: guild.guild.id, user: userOf(id) });
    emit([id], "GUILD_DELETE", { id: guild.guild.id });
  }
  recordAudit(guild.guild.id, viewer.user.id, AuditLogEvent.MemberPrune, null, { options: { delete_member_days: String(days), members_removed: String(doomed.length) } });
  return { pruned: body.compute_prune_count === false ? null : doomed.length };
});

// ---- AutoMod ----

function rulesOf(guildId: string): AutoModerationRule[] {
  let list = automodRules.get(guildId);
  if (!list) automodRules.set(guildId, (list = []));
  return list;
}

function requireManager(guildId: string, viewerId: string): MockGuild {
  const guild = requireGuildMember(guildId, viewerId);
  if (!hasBit(guildPermsOf(guildId, viewerId), Perm.MANAGE_GUILD)) forbidden();
  return guild;
}

function cleanList(raw: unknown, max: number, field: string): string[] {
  const list = Array.isArray(raw) ? raw : [];
  if (list.length > max || list.some(v => typeof v !== "string")) invalid(field, `Must have at most ${max} entries.`);
  const out: string[] = [];
  for (const value of list as string[]) {
    const v = value.trim();
    if (v.length === 0 || v.length > 60 || v.replace(/\*/g, "") === "") invalid(field, "Each entry must be 1-60 characters.");
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

function applyRuleBody(guild: MockGuild, rule: AutoModerationRule, body: Record<string, unknown>): void {
  if ("name" in body) {
    const name = (str(body.name) ?? "").trim();
    if (name.length < 1 || name.length > 100) invalid("name", "Must be between 1 and 100 in length.");
    rule.name = name;
  }
  if (body.trigger_metadata && typeof body.trigger_metadata === "object") {
    const meta = body.trigger_metadata as { keyword_filter?: unknown; allow_list?: unknown };
    rule.trigger_metadata = { keyword_filter: cleanList(meta.keyword_filter, 1000, "trigger_metadata.keyword_filter"), allow_list: cleanList(meta.allow_list, 100, "trigger_metadata.allow_list") };
  }
  if ("actions" in body) {
    const actions = body.actions as { type?: unknown; metadata?: { custom_message?: unknown } }[] | undefined;
    if (!Array.isArray(actions) || actions.length !== 1 || actions[0]?.type !== AutoModerationActionType.BlockMessage) invalid("actions", "Exactly one BLOCK_MESSAGE action is supported.");
    const message = str(actions?.[0]?.metadata?.custom_message)?.trim();
    if (message && message.length > 150) invalid("actions", "The custom message must be 150 or fewer in length.");
    rule.actions = [{ type: AutoModerationActionType.BlockMessage, ...(message ? { metadata: { custom_message: message } } : {}) }];
  }
  if ("enabled" in body) rule.enabled = body.enabled === true;
  if ("exempt_roles" in body) {
    const ids = Array.isArray(body.exempt_roles) ? [...new Set(body.exempt_roles.filter((v): v is string => typeof v === "string"))] : [];
    if (ids.length > 20 || ids.some(id => !guild.guild.roles.some(r => r.id === id))) invalid("exempt_roles", "Unknown role.");
    rule.exempt_roles = ids;
  }
  if ("exempt_channels" in body) {
    const ids = Array.isArray(body.exempt_channels) ? [...new Set(body.exempt_channels.filter((v): v is string => typeof v === "string"))] : [];
    if (ids.length > 50 || ids.some(id => db.channels.get(id)?.guild_id !== guild.guild.id)) invalid("exempt_channels", "Unknown channel.");
    rule.exempt_channels = ids;
  }
}

function ruleChanges(before: AutoModerationRule | null, after: AutoModerationRule | null): (AuditLogChange | null)[] {
  const keys = ["name", "enabled", "trigger_metadata", "actions", "exempt_roles", "exempt_channels"] as const;
  return keys.map(key => change(key, before?.[key] ?? null, after?.[key] ?? null));
}

const emitRule = (guild: MockGuild, t: "AUTO_MODERATION_RULE_CREATE" | "AUTO_MODERATION_RULE_UPDATE" | "AUTO_MODERATION_RULE_DELETE", rule: AutoModerationRule) =>
  emit(membersWith(guild, Perm.MANAGE_GUILD), t, structuredClone(rule));

route("GET", `/guilds/${ID}/auto-moderation/rules`, ({ viewer, params }) => {
  requireManager(params[0] ?? "", viewer.user.id);
  return rulesOf(params[0] ?? "");
});

route("GET", `/guilds/${ID}/auto-moderation/rules/${ID}`, ({ viewer, params }) => {
  requireManager(params[0] ?? "", viewer.user.id);
  return rulesOf(params[0] ?? "").find(r => r.id === params[1]) ?? fail(404, 10066, "Unknown auto moderation rule");
});

route("POST", `/guilds/${ID}/auto-moderation/rules`, ({ viewer, params, body }) => {
  const guildId = params[0] ?? "";
  const guild = requireManager(guildId, viewer.user.id);
  if (body.event_type !== AutoModerationEventType.MessageSend) invalid("event_type", "Only MESSAGE_SEND is supported.");
  if (body.trigger_type !== AutoModerationTriggerType.Keyword) invalid("trigger_type", "Only KEYWORD rules are supported.");
  if (!("actions" in body)) invalid("actions", "Required.");
  if (!("name" in body)) invalid("name", "Required.");
  const list = rulesOf(guildId);
  if (list.length >= 6) fail(400, 30035, "Maximum number of keyword rules reached (6)");
  const rule: AutoModerationRule = {
    id: nextId(),
    guild_id: guildId,
    name: "",
    creator_id: viewer.user.id,
    event_type: AutoModerationEventType.MessageSend,
    trigger_type: AutoModerationTriggerType.Keyword,
    trigger_metadata: { keyword_filter: [], allow_list: [] },
    actions: [{ type: AutoModerationActionType.BlockMessage }],
    enabled: true,
    exempt_roles: [],
    exempt_channels: [],
  };
  applyRuleBody(guild, rule, body);
  list.push(rule);
  emitRule(guild, "AUTO_MODERATION_RULE_CREATE", rule);
  recordAudit(guildId, viewer.user.id, AuditLogEvent.AutoModerationRuleCreate, rule.id, { changes: ruleChanges(null, rule) });
  return rule;
});

route("PATCH", `/guilds/${ID}/auto-moderation/rules/${ID}`, ({ viewer, params, body }) => {
  const guildId = params[0] ?? "";
  const guild = requireManager(guildId, viewer.user.id);
  const rule = rulesOf(guildId).find(r => r.id === params[1]) ?? fail(404, 10066, "Unknown auto moderation rule");
  if ("trigger_type" in body && body.trigger_type !== AutoModerationTriggerType.Keyword) invalid("trigger_type", "The trigger type cannot change.");
  const before = structuredClone(rule);
  const draft = structuredClone(rule);
  applyRuleBody(guild, draft, body);
  Object.assign(rule, draft);
  emitRule(guild, "AUTO_MODERATION_RULE_UPDATE", rule);
  recordAudit(guildId, viewer.user.id, AuditLogEvent.AutoModerationRuleUpdate, rule.id, { changes: ruleChanges(before, rule), skipIfUnchanged: true });
  return rule;
});

route("DELETE", `/guilds/${ID}/auto-moderation/rules/${ID}`, ({ viewer, params }) => {
  const guildId = params[0] ?? "";
  const guild = requireManager(guildId, viewer.user.id);
  const list = rulesOf(guildId);
  const rule = list.find(r => r.id === params[1]) ?? fail(404, 10066, "Unknown auto moderation rule");
  list.splice(list.indexOf(rule), 1);
  emitRule(guild, "AUTO_MODERATION_RULE_DELETE", rule);
  recordAudit(guildId, viewer.user.id, AuditLogEvent.AutoModerationRuleDelete, rule.id, { changes: ruleChanges(rule, null) });
  return undefined;
});

// ---- send checks ----

/** Verification level (new messages only) and AutoMod for a guild channel; DMs pass. */
export function checkSend(channel: MockChannel, userId: string, content: string): void {
  if (!channel.guild_id) return;
  const guild = db.guilds.get(channel.guild_id);
  const record = guild?.members.get(userId);
  if (!guild || !record) return;
  const level = guild.guild.verification_level ?? VerificationLevel.None;
  const admin = hasBit(guildPermsOf(guild.guild.id, userId), Perm.ADMINISTRATOR);
  if (level >= VerificationLevel.Medium && guild.guild.owner_id !== userId && record.roles.length === 0 && !admin) {
    const now = Date.now();
    const accountOk = now - snowflakeToTimestamp(userId) >= 5 * 60_000;
    const memberOk = now - Date.parse(record.joined_at) >= 10 * 60_000;
    if (!accountOk || (level >= VerificationLevel.High && !memberOk)) fail(403, 50009, "Channel verification level is too high for you to gain access");
  }
  checkAutomod(channel, userId, content);
}

/** 400 200000 when an enabled keyword rule matches and the author is not exempt; records audit entry 143. */
export function checkAutomod(channel: MockChannel, userId: string, content: string): void {
  if (!channel.guild_id || !content.trim()) return;
  const guild = db.guilds.get(channel.guild_id);
  const record = guild?.members.get(userId);
  if (!guild || !record || guild.guild.owner_id === userId) return;
  const bits = guildPermsOf(guild.guild.id, userId);
  if (hasBit(bits, Perm.MANAGE_GUILD) || hasBit(bits, Perm.ADMINISTRATOR)) return;
  const channels = [channel.id, isThreadType(channel.type) ? channel.parent_id : null].filter((id): id is string => !!id);
  for (const rule of rulesOf(guild.guild.id)) {
    if (!rule.enabled) continue;
    if (rule.exempt_roles.some(id => record.roles.includes(id)) || channels.some(id => rule.exempt_channels.includes(id))) continue;
    if (!findKeyword(content, rule.trigger_metadata.keyword_filter, rule.trigger_metadata.allow_list)) continue;
    recordAudit(guild.guild.id, userId, AuditLogEvent.AutoModerationBlockMessage, userId, {
      options: { channel_id: channel.id, auto_moderation_rule_name: rule.name, auto_moderation_rule_trigger_type: String(AutoModerationTriggerType.Keyword) },
      reason: null,
    });
    const custom = rule.actions[0]?.metadata?.custom_message;
    fail(400, 200000, "Message was blocked by automatic moderation", custom ? { content: { _errors: [{ code: "AUTOMOD_BLOCKED", message: custom }] } } : undefined);
  }
}
