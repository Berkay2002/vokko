// Moderation routes of docs/api.md: kick, member edit, bans, roles and channel permission overwrites.
// Registered by import side effect (routes.ts imports `parseOverwrites` from here).

import { ALL_PERMISSIONS, Perm, basePermissions, canEditRole, hasBit, highestPosition, outranks, parseBits } from "../permissions";
import { AuditLogEvent, ChannelType, OverwriteType, type AuditLogChange, type Ban, type Guild, type GuildMember, type PermissionOverwrite, type Role, type User } from "../types";
import { guildPermsOf, channelPermsOf } from "./access";
import { db, nextId, sortedMessages, userOf, type MockGuild } from "./db";
import { MISSING_PERMISSIONS, pendingAttachment, channelAudience, emitVisibilityChanges, fail, requireChannel, requireChannelPerm, requireGuildMember, syncCategoryChildren, visibilityOf } from "./ops";
import { forgetOnboardingRoles } from "./memberFlags";
import { applyOwnMemberPerks, dropTagOnLeave, memberProfileFields } from "./perks";
import { ID, currentAuditReason, route, str } from "./router";
import { dropIntegration, isManagedRole } from "./apps";
import { emit } from "./socket";
import { memberVoiceEdit } from "./voice";
import { change, recordAudit } from "./admin";
import { dropJoinRequest } from "./joinRequests";

const DAY_MS = 86_400_000;
const MAX_TIMEOUT_MS = 28 * DAY_MS;
const MAX_DELETE_SECONDS = 604_800;

const forbidden = (): never => fail(403, 50013, MISSING_PERMISSIONS);
const invalid = (field: string, code: string, message: string): never => fail(400, 50035, "Invalid Form Body", { [field]: { code, message } });

type MemberRecord = MockGuild["members"] extends Map<string, infer V> ? V : never;

const like = (id: string, record: MemberRecord) => ({ id, roles: record.roles, communication_disabled_until: record.communication_disabled_until });

function memberRecord(guild: MockGuild, userId: string): MemberRecord {
  return guild.members.get(userId) ?? fail(404, 10007, "Unknown Member");
}

function memberJson(guild: MockGuild, userId: string): GuildMember {
  const record = memberRecord(guild, userId);
  return {
    user: userOf(userId),
    nick: record.nick,
    roles: [...record.roles],
    joined_at: record.joined_at,
    ...(record.communication_disabled_until ? { communication_disabled_until: record.communication_disabled_until } : {}),
    ...memberProfileFields(record),
    ...(record.mute ? { mute: true } : {}),
    ...(record.deaf ? { deaf: true } : {}),
  };
}

/** Remove a member and tell everyone: GUILD_MEMBER_REMOVE to the rest of the guild, GUILD_DELETE to the user. */
function removeMember(guild: MockGuild, userId: string): void {
  if (!guild.members.delete(userId)) return;
  dropIntegration(guild.guild.id, userId);
  dropTagOnLeave(guild, userId);
  emit(guild.members.keys(), "GUILD_MEMBER_REMOVE", { guild_id: guild.guild.id, user: userOf(userId) });
  emit([userId], "GUILD_DELETE", { id: guild.guild.id });
}

const sortedRoles = (guild: Guild): Role[] => [...guild.roles].sort((a, b) => b.position - a.position);
const emitRole = (guild: MockGuild, type: "GUILD_ROLE_CREATE" | "GUILD_ROLE_UPDATE", role: Role) =>
  emit(guild.members.keys(), type, { guild_id: guild.guild.id, role: { ...role } });

function bitsOf(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return invalid(field, "NUMBER_TYPE_COERCE", `${field} must be a decimal string`);
  return BigInt(value) & ALL_PERMISSIONS;
}

// ---- kick ----

route("DELETE", `/guilds/${ID}/members/${ID}`, ({ viewer, params }) => {
  const guildId = params[0] ?? "";
  const targetId = params[1] ?? "";
  const guild = requireGuildMember(guildId, viewer.user.id);
  if (!hasBit(guildPermsOf(guildId, viewer.user.id), Perm.KICK_MEMBERS)) forbidden();
  const target = memberRecord(guild, targetId);
  if (targetId === viewer.user.id || targetId === guild.guild.owner_id) forbidden();
  if (!outranks(guild.guild, like(viewer.user.id, memberRecord(guild, viewer.user.id)), like(targetId, target))) forbidden();
  removeMember(guild, targetId);
  recordAudit(guildId, viewer.user.id, AuditLogEvent.MemberKick, targetId);
  return undefined;
});

// ---- member edit ----

function editMember(guildId: string, viewerId: string, targetId: string, body: Record<string, unknown>): GuildMember {
  const guild = requireGuildMember(guildId, viewerId);
  const g = guild.guild;
  const record = memberRecord(guild, targetId);
  const actor = like(viewerId, memberRecord(guild, viewerId));
  const target = like(targetId, record);
  const self = targetId === viewerId;
  const actorBits = guildPermsOf(guildId, viewerId);
  const next: { nick?: string | null; roles?: string[]; until?: string | null } = {};

  if ("nick" in body) {
    const raw = body.nick;
    if (raw !== null && typeof raw !== "string") invalid("nick", "BASE_TYPE_STRING", "Not a string.");
    const nick = typeof raw === "string" ? raw.trim() : "";
    if (nick.length > 32) invalid("nick", "BASE_TYPE_MAX_LENGTH", "Must be 32 or fewer in length.");
    if (self) {
      if (!hasBit(actorBits, Perm.CHANGE_NICKNAME) && !hasBit(actorBits, Perm.MANAGE_NICKNAMES)) forbidden();
    } else if (!hasBit(actorBits, Perm.MANAGE_NICKNAMES) || !outranks(g, actor, target)) forbidden();
    next.nick = nick === "" ? null : nick;
  }

  if ("roles" in body) {
    if (!Array.isArray(body.roles) || body.roles.some(r => typeof r !== "string")) invalid("roles", "BASE_TYPE_LIST", "Not a list of ids.");
    const wanted = [...new Set(body.roles as string[])];
    for (const id of wanted) if (id === g.id || !g.roles.some(r => r.id === id)) invalid("roles", "INVALID_ROLE", `Unknown role ${id}`);
    if (!hasBit(actorBits, Perm.MANAGE_ROLES)) forbidden();
    if (!self && !outranks(g, actor, target)) forbidden();
    const changed = [...wanted.filter(id => !record.roles.includes(id)), ...record.roles.filter(id => !wanted.includes(id))];
    for (const id of changed) {
      if (isManagedRole(guildId, id)) invalid("roles", "INVALID_ROLE", "A bot's role cannot be assigned or removed.");
      const role = g.roles.find(r => r.id === id);
      if (role && !canEditRole(g, actor, role)) forbidden();
    }
    next.roles = wanted;
  }

  if ("communication_disabled_until" in body) {
    const raw = body.communication_disabled_until;
    if (self || !hasBit(actorBits, Perm.MODERATE_MEMBERS)) forbidden();
    if (!outranks(g, actor, target)) forbidden();
    if (raw === null) {
      next.until = null;
    } else {
      const time = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
      if (Number.isNaN(time)) invalid("communication_disabled_until", "DATE_TYPE_PARSE", "Not a valid ISO8601 date.");
      if (hasBit(basePermissions(g, target), Perm.ADMINISTRATOR)) forbidden();
      if (time - Date.now() > MAX_TIMEOUT_MS) invalid("communication_disabled_until", "TIMEOUT_TOO_LONG", "Timeout can be at most 28 days.");
      next.until = time <= Date.now() ? null : new Date(time).toISOString();
    }
  }

  // Server mute / deafen / move / disconnect (validated here, applied after the rest).
  const voice = memberVoiceEdit(guildId, viewerId, targetId, body);

  const before = visibilityOf(guildId);
  const memberChanges = [
    next.nick !== undefined ? change("nick", record.nick, next.nick) : null,
    next.until !== undefined ? change("communication_disabled_until", record.communication_disabled_until ?? null, next.until) : null,
  ];
  const roleChanges: AuditLogChange[] = [];
  if (next.roles) {
    const named = (ids: string[]) => ids.map(id => ({ id, name: g.roles.find(r => r.id === id)?.name ?? "" }));
    const added = named(next.roles.filter(id => !record.roles.includes(id)));
    const removed = named(record.roles.filter(id => !next.roles?.includes(id)));
    if (added.length > 0) roleChanges.push({ key: "$add", new_value: added });
    if (removed.length > 0) roleChanges.push({ key: "$remove", new_value: removed });
  }
  if (next.nick !== undefined) record.nick = next.nick;
  if (next.roles) {
    const wanted = next.roles;
    forgetOnboardingRoles(guildId, targetId, [...record.roles.filter(id => !wanted.includes(id)), ...wanted.filter(id => !record.roles.includes(id))]);
    record.roles = wanted;
  }
  if (next.until !== undefined) {
    if (next.until === null) delete record.communication_disabled_until;
    else record.communication_disabled_until = next.until;
  }
  voice.store(record);
  const json = memberJson(guild, targetId);
  emit(guild.members.keys(), "GUILD_MEMBER_UPDATE", { guild_id: guildId, ...json });
  emitVisibilityChanges(guildId, before);
  voice.apply(next.roles !== undefined || next.until !== undefined);
  recordAudit(guildId, viewerId, AuditLogEvent.MemberUpdate, targetId, { changes: memberChanges, skipIfUnchanged: true });
  recordAudit(guildId, viewerId, AuditLogEvent.MemberRoleUpdate, targetId, { changes: roleChanges, skipIfUnchanged: true });
  return json;
}

route("PATCH", `/guilds/${ID}/members/${ID}`, ({ viewer, params, body }) => editMember(params[0] ?? "", viewer.user.id, params[1] ?? "", body));

route("PATCH", `/guilds/${ID}/members/@me`, ({ viewer, params, body }) => {
  const only: Record<string, unknown> = {};
  if ("nick" in body) only.nick = body.nick;
  const guildId = params[0] ?? "";
  const guild = requireGuildMember(guildId, viewer.user.id);
  const touched = applyOwnMemberPerks(memberRecord(guild, viewer.user.id), body, id => pendingAttachment(id, viewer.user.id));
  if (Object.keys(only).length > 0) return editMember(guildId, viewer.user.id, viewer.user.id, only);
  const json = memberJson(guild, viewer.user.id);
  if (touched) emit(guild.members.keys(), "GUILD_MEMBER_UPDATE", { guild_id: guildId, ...json });
  return json;
});

// ---- bans ----

function bansOf(guildId: string): Map<string, string | null> {
  let map = db.bans.get(guildId);
  if (!map) db.bans.set(guildId, (map = new Map()));
  return map;
}

function requireBanPerm(guildId: string, viewerId: string): MockGuild {
  const guild = requireGuildMember(guildId, viewerId);
  if (!hasBit(guildPermsOf(guildId, viewerId), Perm.BAN_MEMBERS)) forbidden();
  return guild;
}

route("GET", `/guilds/${ID}/bans`, ({ viewer, params }) => {
  const guildId = params[0] ?? "";
  requireBanPerm(guildId, viewer.user.id);
  return [...bansOf(guildId)].map(([id, reason]): Ban => ({ user: userOf(id), reason }));
});

route("PUT", `/guilds/${ID}/bans/${ID}`, ({ viewer, params, body }) => {
  const guildId = params[0] ?? "";
  const targetId = params[1] ?? "";
  const guild = requireBanPerm(guildId, viewer.user.id);
  if (!db.accounts.has(targetId)) fail(404, 10013, "Unknown User");
  if (targetId === viewer.user.id || targetId === guild.guild.owner_id) forbidden();
  const rawSeconds = body.delete_message_seconds ?? 0;
  const seconds = typeof rawSeconds === "number" ? rawSeconds : -1;
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > MAX_DELETE_SECONDS) {
    invalid("delete_message_seconds", "BASE_TYPE_BAD_RANGE", "Must be between 0 and 604800.");
  }
  const reasonRaw = str(body.reason)?.trim() || currentAuditReason();
  const targetRecord = guild.members.get(targetId);
  if (targetRecord && !outranks(guild.guild, like(viewer.user.id, memberRecord(guild, viewer.user.id)), like(targetId, targetRecord))) forbidden();

  const bans = bansOf(guildId);
  const wasBanned = bans.has(targetId);
  bans.set(targetId, reasonRaw ? reasonRaw : null);
  const user: User = userOf(targetId);
  if (!wasBanned) {
    const moderators = [...guild.members.keys()].filter(id => hasBit(guildPermsOf(guildId, id), Perm.BAN_MEMBERS));
    emit(moderators, "GUILD_BAN_ADD", { guild_id: guildId, user });
  }
  removeMember(guild, targetId);
  dropJoinRequest(guildId, targetId);
  recordAudit(guildId, viewer.user.id, AuditLogEvent.MemberBanAdd, targetId, { reason: reasonRaw ? reasonRaw : null });

  if (seconds > 0) {
    const cutoff = Date.now() - seconds * 1000;
    for (const channel of db.channels.values()) {
      if (channel.guild_id !== guildId) continue;
      const list = sortedMessages(channel.id);
      const doomed = list.filter(m => m.author_id === targetId && Date.parse(m.timestamp) >= cutoff);
      if (doomed.length === 0) continue;
      db.messages.set(channel.id, list.filter(m => !doomed.includes(m)));
      channel.last_message_id = sortedMessages(channel.id).at(-1)?.id ?? null;
      const audience = channelAudience(channel);
      emit(audience, "MESSAGE_DELETE_BULK", { ids: doomed.map(m => m.id), channel_id: channel.id, guild_id: guildId });
    }
  }
  return undefined;
});

route("DELETE", `/guilds/${ID}/bans/${ID}`, ({ viewer, params }) => {
  const guildId = params[0] ?? "";
  const targetId = params[1] ?? "";
  const guild = requireBanPerm(guildId, viewer.user.id);
  if (!bansOf(guildId).delete(targetId)) fail(404, 10026, "Unknown Ban");
  const moderators = [...guild.members.keys()].filter(id => hasBit(guildPermsOf(guildId, id), Perm.BAN_MEMBERS));
  emit(moderators, "GUILD_BAN_REMOVE", { guild_id: guildId, user: userOf(targetId) });
  recordAudit(guildId, viewer.user.id, AuditLogEvent.MemberBanRemove, targetId);
  return undefined;
});

// ---- roles ----

function requireRoleManager(guildId: string, viewerId: string): { guild: MockGuild; bits: bigint; actor: ReturnType<typeof like> } {
  const guild = requireGuildMember(guildId, viewerId);
  const bits = guildPermsOf(guildId, viewerId);
  if (!hasBit(bits, Perm.MANAGE_ROLES)) forbidden();
  return { guild, bits, actor: like(viewerId, memberRecord(guild, viewerId)) };
}

type RoleFields = Partial<Pick<Role, "name" | "color" | "hoist" | "mentionable" | "unicode_emoji">>;

const ROLE_AUDIT_KEYS = ["name", "color", "hoist", "mentionable", "permissions", "unicode_emoji"] as const;
const roleChanges = (before: Role | null, after: Role | null) => ROLE_AUDIT_KEYS.map(key => change(key, before?.[key] ?? null, after?.[key] ?? null));

function readRoleFields(body: Record<string, unknown>): RoleFields {
  const out: RoleFields = {};
  if ("unicode_emoji" in body) {
    const raw = body.unicode_emoji;
    if (raw !== null && typeof raw !== "string") invalid("unicode_emoji", "BASE_TYPE_STRING", "Not a string.");
    const emoji = typeof raw === "string" ? raw.trim() : "";
    if ([...emoji].length > 32 || /\s/.test(emoji)) invalid("unicode_emoji", "BASE_TYPE_BAD_LENGTH", "Must be an emoji of at most 32 characters.");
    out.unicode_emoji = emoji === "" ? null : emoji;
  }
  if ("name" in body) {
    const name = (str(body.name) ?? "").trim();
    if (name.length < 1 || name.length > 100) invalid("name", "BASE_TYPE_BAD_LENGTH", "Must be between 1 and 100 in length.");
    out.name = name;
  }
  if ("color" in body) {
    if (typeof body.color !== "number" || !Number.isInteger(body.color) || body.color < 0 || body.color > 0xffffff) invalid("color", "COLOR_TYPE_CONVERT", "Not a valid color.");
    out.color = body.color as number;
  }
  if ("hoist" in body) {
    if (typeof body.hoist !== "boolean") invalid("hoist", "BASE_TYPE_BOOLEAN", "Not a boolean.");
    out.hoist = body.hoist as boolean;
  }
  if ("mentionable" in body) {
    if (typeof body.mentionable !== "boolean") invalid("mentionable", "BASE_TYPE_BOOLEAN", "Not a boolean.");
    out.mentionable = body.mentionable as boolean;
  }
  return out;
}

route("POST", `/guilds/${ID}/roles`, ({ viewer, params, body }) => {
  const guildId = params[0] ?? "";
  const { guild, bits } = requireRoleManager(guildId, viewer.user.id);
  const fields = readRoleFields(body);
  const everyone = guild.guild.roles.find(r => r.id === guildId);
  const permissions = "permissions" in body ? bitsOf(body.permissions, "permissions") : parseBits(everyone?.permissions);
  if ((permissions & ~bits) !== 0n) forbidden(); // cannot grant bits you lack (ADMINISTRATOR only by an admin)
  // Just above @everyone: everything else moves up one.
  for (const role of guild.guild.roles) {
    if (role.id === guildId) continue;
    role.position += 1;
  }
  const role: Role = {
    id: nextId(),
    name: fields.name ?? "new role",
    color: fields.color ?? 0,
    hoist: fields.hoist ?? false,
    position: 1,
    permissions: permissions.toString(),
    mentionable: fields.mentionable ?? false,
    unicode_emoji: fields.unicode_emoji ?? null,
  };
  guild.guild.roles.push(role);
  emitRole(guild, "GUILD_ROLE_CREATE", role);
  for (const other of guild.guild.roles) if (other.id !== guildId && other.id !== role.id) emitRole(guild, "GUILD_ROLE_UPDATE", other);
  recordAudit(guildId, viewer.user.id, AuditLogEvent.RoleCreate, role.id, { changes: roleChanges(null, role) });
  return { ...role };
});

route("PATCH", `/guilds/${ID}/roles`, ({ viewer, params, body }) => {
  const guildId = params[0] ?? "";
  const { guild, actor } = requireRoleManager(guildId, viewer.user.id);
  const g = guild.guild;
  const list: unknown = body;
  if (!Array.isArray(list)) return invalid("body", "BASE_TYPE_LIST", "Expected a list of {id, position}.");
  const updates = list.map((entry: { id?: unknown; position?: unknown }) => {
    const id = typeof entry?.id === "string" ? entry.id : "";
    const position = entry?.position;
    const role = g.roles.find(r => r.id === id);
    if (!role) return invalid("id", "UNKNOWN_ROLE", `Unknown role ${id}`);
    if (id === g.id) return invalid("id", "EVERYONE_FIXED", "@everyone stays at position 0.");
    if (typeof position !== "number" || !Number.isInteger(position) || position < 1) return invalid("position", "BASE_TYPE_BAD_RANGE", "Position must be 1 or more.");
    return { role, position };
  });
  const top = highestPosition(g, actor.roles);
  if (actor.id !== g.owner_id) {
    for (const u of updates) if (u.role.position >= top || u.position >= top) forbidden();
  }
  const before = new Map(g.roles.map(r => [r.id, r.position]));
  const order = g.roles.filter(r => r.id !== g.id).sort((a, b) => a.position - b.position);
  for (const u of [...updates].sort((a, b) => a.position - b.position)) {
    order.splice(order.indexOf(u.role), 1);
    order.splice(Math.min(u.position - 1, order.length), 0, u.role);
  }
  order.forEach((role, i) => {
    role.position = i + 1;
  });
  for (const role of order) if (before.get(role.id) !== role.position) emitRole(guild, "GUILD_ROLE_UPDATE", role);
  return sortedRoles(g).map(r => ({ ...r }));
});

route("PATCH", `/guilds/${ID}/roles/${ID}`, ({ viewer, params, body }) => {
  const guildId = params[0] ?? "";
  const { guild, bits, actor } = requireRoleManager(guildId, viewer.user.id);
  const g = guild.guild;
  const role = g.roles.find(r => r.id === params[1]);
  if (!role) fail(404, 10011, "Unknown Role");
  if (isManagedRole(guildId, role.id)) invalid("role", "INVALID_ROLE", "A bot's role cannot be edited. Change the bot's permissions by adding it again.");
  if (!canEditRole(g, actor, role)) forbidden();
  const isEveryone = role.id === g.id;
  const fields = isEveryone ? {} : readRoleFields(body);
  let permissions: bigint | undefined;
  if ("permissions" in body) {
    permissions = bitsOf(body.permissions, "permissions");
    const added = permissions & ~parseBits(role.permissions);
    if ((added & ~bits) !== 0n) forbidden();
  }
  const before = visibilityOf(guildId);
  const snapshot = { ...role };
  Object.assign(role, fields);
  if (permissions !== undefined) role.permissions = permissions.toString();
  emitRole(guild, "GUILD_ROLE_UPDATE", role);
  emitVisibilityChanges(guildId, before);
  recordAudit(guildId, viewer.user.id, AuditLogEvent.RoleUpdate, role.id, { changes: roleChanges(snapshot, role), skipIfUnchanged: true });
  return { ...role };
});

route("DELETE", `/guilds/${ID}/roles/${ID}`, ({ viewer, params }) => {
  const guildId = params[0] ?? "";
  const { guild, actor } = requireRoleManager(guildId, viewer.user.id);
  const g = guild.guild;
  const role = g.roles.find(r => r.id === params[1]);
  if (!role) fail(404, 10011, "Unknown Role");
  if (role.id === g.id) fail(400, 50028, "Invalid role");
  if (isManagedRole(guildId, role.id)) invalid("role", "INVALID_ROLE", "A bot's role cannot be deleted. Remove the bot from Integrations instead.");
  if (!canEditRole(g, actor, role)) forbidden();
  const before = visibilityOf(guildId);
  g.roles =g.roles.filter(r => r.id !== role.id);
  for (const record of guild.members.values()) record.roles = record.roles.filter(id => id !== role.id);
  const touched: string[] = [];
  for (const channel of db.channels.values()) {
    if (channel.guild_id !== guildId || !channel.permission_overwrites) continue;
    const kept = channel.permission_overwrites.filter(o => !(o.type === OverwriteType.Role && o.id === role.id));
    if (kept.length !== channel.permission_overwrites.length) {
      channel.permission_overwrites = kept;
      touched.push(channel.id);
    }
  }
  emit(guild.members.keys(), "GUILD_ROLE_DELETE", { guild_id: guildId, role_id: role.id });
  emitVisibilityChanges(guildId, before, touched);
  recordAudit(guildId, viewer.user.id, AuditLogEvent.RoleDelete, role.id, { changes: roleChanges(role, null) });
  return undefined;
});

// ---- channel permission overwrites ----

function overwriteFrom(guild: MockGuild, entry: unknown, actorBits: bigint): PermissionOverwrite {
  const e = (entry ?? {}) as { id?: unknown; type?: unknown; allow?: unknown; deny?: unknown };
  const id = typeof e.id === "string" ? e.id : "";
  if (e.type !== OverwriteType.Role && e.type !== OverwriteType.Member) return invalid("type", "BASE_TYPE_CHOICES", "Value must be one of (0, 1).");
  if (e.type === OverwriteType.Role) {
    if (!guild.guild.roles.some(r => r.id === id)) fail(404, 10011, "Unknown Role");
  } else if (!guild.members.has(id)) {
    fail(404, 10007, "Unknown Member");
  }
  // ADMINISTRATOR in an overwrite is ignored.
  const allow = bitsOf(e.allow ?? "0", "allow") & ~Perm.ADMINISTRATOR;
  const deny = bitsOf(e.deny ?? "0", "deny") & ~Perm.ADMINISTRATOR;
  if (((allow | deny) & ~actorBits) !== 0n) forbidden();
  return { id, type: e.type, allow: allow.toString(), deny: deny.toString() };
}

/** Overwrite create (13) / update (14) / delete (15) entries, options naming the target like Discord. */
function auditOverwrite(guildId: string, actorId: string, channelId: string, before: PermissionOverwrite | null, after: PermissionOverwrite | null): void {
  const target = after ?? before;
  if (!target) return;
  const same = before && after && before.allow === after.allow && before.deny === after.deny;
  if (same) return;
  const action = !before ? AuditLogEvent.ChannelOverwriteCreate : after ? AuditLogEvent.ChannelOverwriteUpdate : AuditLogEvent.ChannelOverwriteDelete;
  const roleName = target.type === OverwriteType.Role ? db.guilds.get(guildId)?.guild.roles.find(r => r.id === target.id)?.name : undefined;
  recordAudit(guildId, actorId, action, channelId, {
    options: { id: target.id, type: String(target.type), ...(roleName ? { role_name: roleName } : {}) },
    changes: [
      change("id", before?.id ?? null, after?.id ?? null),
      change("type", before?.type ?? null, after?.type ?? null),
      change("allow", before?.allow ?? null, after?.allow ?? null),
      change("deny", before?.deny ?? null, after?.deny ?? null),
    ],
  });
}

/** Validate `permission_overwrites` of a channel create body (creator needs every bit they set). */
export function parseOverwrites(guildId: string, viewerId: string, raw: unknown): PermissionOverwrite[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return invalid("permission_overwrites", "BASE_TYPE_LIST", "Not a list.");
  const guild = requireGuildMember(guildId, viewerId);
  const bits = guildPermsOf(guildId, viewerId);
  const out = new Map<string, PermissionOverwrite>();
  for (const entry of raw) {
    const o = overwriteFrom(guild, entry, bits);
    out.set(`${o.type}:${o.id}`, o);
  }
  return [...out.values()];
}

route("PUT", `/channels/${ID}/permissions/${ID}`, ({ viewer, params, body }) => {
  const channel = requireChannel(params[0] ?? "", viewer.user.id);
  if (!channel.guild_id) fail(400, 50003, "Cannot execute action on a DM channel");
  requireChannelPerm(channel, viewer.user.id, Perm.MANAGE_ROLES);
  const guild = requireGuildMember(channel.guild_id, viewer.user.id);
  const overwrite = overwriteFrom(guild, { ...body, id: params[1] }, channelPermsOf(channel, viewer.user.id));
  const before = visibilityOf(channel.guild_id);
  const previous = (channel.permission_overwrites ?? []).map(o => ({ ...o }));
  const list = (channel.permission_overwrites ??= []);
  const index = list.findIndex(o => o.id === overwrite.id && o.type === overwrite.type);
  if (index >= 0) list[index] = overwrite;
  else list.push(overwrite);
  const synced = channel.type === ChannelType.GuildCategory ? syncCategoryChildren(channel, previous) : [];
  emitVisibilityChanges(channel.guild_id, before, [channel.id, ...synced]);
  auditOverwrite(channel.guild_id, viewer.user.id, channel.id, previous.find(o => o.id === overwrite.id) ?? null, overwrite);
  return undefined;
});

route("DELETE", `/channels/${ID}/permissions/${ID}`, ({ viewer, params }) => {
  const channel = requireChannel(params[0] ?? "", viewer.user.id);
  if (!channel.guild_id) fail(400, 50003, "Cannot execute action on a DM channel");
  requireChannelPerm(channel, viewer.user.id, Perm.MANAGE_ROLES);
  const before = visibilityOf(channel.guild_id);
  const previous = (channel.permission_overwrites ?? []).map(o => ({ ...o }));
  channel.permission_overwrites = previous.filter(o => o.id !== params[1]);
  const synced = channel.type === ChannelType.GuildCategory ? syncCategoryChildren(channel, previous) : [];
  emitVisibilityChanges(channel.guild_id, before, [channel.id, ...synced]);
  auditOverwrite(channel.guild_id, viewer.user.id, channel.id, previous.find(o => o.id === params[1]) ?? null, null);
  return undefined;
});
