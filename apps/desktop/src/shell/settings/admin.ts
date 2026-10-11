// Server admin data helpers: audit log wording and diffs, member table signals and sorting, ban history windows.
// Pure functions (unit-tested) plus thin REST wrappers for the admin pages.

import { request } from "../../api/rest";
import { snowflakeToTimestamp } from "../../api/snowflake";
import {
  AuditLogEvent,
  type AuditLog,
  type AuditLogChange,
  type AuditLogEntry,
  type AuditLogQuery,
  type AutoModerationRule,
  type AutoModerationRuleRequest,
  type Channel,
  type GuildMember,
  type PruneResponse,
  type Role,
  type Snowflake,
  type User,
} from "../../api/types";

// ---- REST ----

const query = (params: Record<string, string | number | undefined>): string => {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") q.set(key, String(value));
  const text = q.toString();
  return text ? `?${text}` : "";
};

export const fetchAuditLog = (guildId: Snowflake, params: AuditLogQuery = {}): Promise<AuditLog> =>
  request("GET", `/guilds/${guildId}/audit-logs${query({ user_id: params.user_id, action_type: params.action_type, before: params.before, after: params.after, limit: params.limit })}`);
export const fetchRoleMemberCounts = (guildId: Snowflake): Promise<Record<Snowflake, number>> => request("GET", `/guilds/${guildId}/roles/member-counts`);
export const fetchPruneCount = (guildId: Snowflake, days: number, includeRoles: Snowflake[]): Promise<PruneResponse> =>
  request("GET", `/guilds/${guildId}/prune${query({ days, include_roles: includeRoles.join(",") })}`);
export const prune = (guildId: Snowflake, days: number, includeRoles: Snowflake[], reason?: string): Promise<PruneResponse> =>
  request("POST", `/guilds/${guildId}/prune`, { days, include_roles: includeRoles }, { reason });
export const listAutomodRules = (guildId: Snowflake): Promise<AutoModerationRule[]> => request("GET", `/guilds/${guildId}/auto-moderation/rules`);
export const createAutomodRule = (guildId: Snowflake, body: AutoModerationRuleRequest): Promise<AutoModerationRule> => request("POST", `/guilds/${guildId}/auto-moderation/rules`, body);
export const updateAutomodRule = (guildId: Snowflake, ruleId: Snowflake, body: AutoModerationRuleRequest): Promise<AutoModerationRule> =>
  request("PATCH", `/guilds/${guildId}/auto-moderation/rules/${ruleId}`, body);
export const deleteAutomodRule = (guildId: Snowflake, ruleId: Snowflake): Promise<void> => request("DELETE", `/guilds/${guildId}/auto-moderation/rules/${ruleId}`);

// ---- ban history ----

/** Discord's "Delete message history" choices, in seconds. */
export const BAN_HISTORY_OPTIONS: { value: string; label: string }[] = [
  { value: "0", label: "Don't delete any" },
  { value: "3600", label: "Previous hour" },
  { value: "21600", label: "Previous 6 hours" },
  { value: "43200", label: "Previous 12 hours" },
  { value: "86400", label: "Previous 24 hours" },
  { value: "259200", label: "Previous 3 days" },
  { value: "604800", label: "Previous 7 days" },
];

// ---- audit log wording ----

export interface AuditLookup {
  users: Map<Snowflake, User>;
  roles: Map<Snowflake, Role>;
  channels: Map<Snowflake, Channel>;
}

/** Action filter choices for the dropdown (the ones Vokko records). */
export const AUDIT_ACTIONS: { value: AuditLogEvent; label: string }[] = [
  { value: AuditLogEvent.GuildUpdate, label: "Update Server" },
  { value: AuditLogEvent.ChannelCreate, label: "Create Channel" },
  { value: AuditLogEvent.ChannelUpdate, label: "Update Channel" },
  { value: AuditLogEvent.ChannelDelete, label: "Delete Channel" },
  { value: AuditLogEvent.ChannelOverwriteCreate, label: "Create Channel Permissions" },
  { value: AuditLogEvent.ChannelOverwriteUpdate, label: "Update Channel Permissions" },
  { value: AuditLogEvent.ChannelOverwriteDelete, label: "Delete Channel Permissions" },
  { value: AuditLogEvent.MemberKick, label: "Kick Member" },
  { value: AuditLogEvent.MemberPrune, label: "Prune Members" },
  { value: AuditLogEvent.MemberBanAdd, label: "Ban Member" },
  { value: AuditLogEvent.MemberBanRemove, label: "Unban Member" },
  { value: AuditLogEvent.MemberUpdate, label: "Update Member" },
  { value: AuditLogEvent.MemberRoleUpdate, label: "Update Member Roles" },
  { value: AuditLogEvent.RoleCreate, label: "Create Role" },
  { value: AuditLogEvent.RoleUpdate, label: "Update Role" },
  { value: AuditLogEvent.RoleDelete, label: "Delete Role" },
  { value: AuditLogEvent.InviteCreate, label: "Create Invite" },
  { value: AuditLogEvent.MessageDelete, label: "Delete Message" },
  { value: AuditLogEvent.MessagePin, label: "Pin Message" },
  { value: AuditLogEvent.MessageUnpin, label: "Unpin Message" },
  { value: AuditLogEvent.AutoModerationRuleCreate, label: "Create AutoMod Rule" },
  { value: AuditLogEvent.AutoModerationRuleUpdate, label: "Update AutoMod Rule" },
  { value: AuditLogEvent.AutoModerationRuleDelete, label: "Delete AutoMod Rule" },
  { value: AuditLogEvent.AutoModerationBlockMessage, label: "AutoMod Blocked Message" },
];

const userName = (lookup: AuditLookup, id: string | null | undefined): string => {
  if (!id) return "Unknown user";
  const user = lookup.users.get(id);
  return user ? (user.global_name ?? user.username) : `Unknown user (${id})`;
};
const channelName = (lookup: AuditLookup, id: string | null | undefined): string => {
  const channel = id ? lookup.channels.get(id) : undefined;
  return channel?.name ? `#${channel.name}` : "a deleted channel";
};
const roleName = (lookup: AuditLookup, id: string | null | undefined, fallback?: unknown): string =>
  (id ? lookup.roles.get(id)?.name : undefined) ?? (typeof fallback === "string" ? fallback : "a deleted role");
const changed = (entry: AuditLogEntry, key: string): AuditLogChange | undefined => entry.changes?.find(c => c.key === key);
const named = (entry: AuditLogEntry, key: string): unknown => changed(entry, "name")?.[key === "old" ? "old_value" : "new_value"];

/** One-line summary like Discord's ("Sam banned Spammer"). */
export function describeAuditEntry(entry: AuditLogEntry, lookup: AuditLookup): string {
  const actor = userName(lookup, entry.user_id);
  const target = entry.target_id;
  const overwriteTarget = () => (entry.options?.type === "1" ? userName(lookup, entry.options.id) : entry.options?.id === entry.guild_id ? "@everyone" : roleName(lookup, entry.options?.id, entry.options?.role_name));
  switch (entry.action_type) {
    case AuditLogEvent.GuildUpdate:
      return `${actor} updated the server`;
    case AuditLogEvent.ChannelCreate:
      return `${actor} created ${typeof named(entry, "new") === "string" ? `#${String(named(entry, "new"))}` : channelName(lookup, target)}`;
    case AuditLogEvent.ChannelUpdate:
      return `${actor} updated ${channelName(lookup, target)}`;
    case AuditLogEvent.ChannelDelete:
      return `${actor} deleted ${typeof named(entry, "old") === "string" ? `#${String(named(entry, "old"))}` : "a channel"}`;
    case AuditLogEvent.ChannelOverwriteCreate:
      return `${actor} created channel permissions for ${overwriteTarget()} in ${channelName(lookup, target)}`;
    case AuditLogEvent.ChannelOverwriteUpdate:
      return `${actor} updated channel permissions for ${overwriteTarget()} in ${channelName(lookup, target)}`;
    case AuditLogEvent.ChannelOverwriteDelete:
      return `${actor} removed channel permissions for ${overwriteTarget()} in ${channelName(lookup, target)}`;
    case AuditLogEvent.MemberKick:
      return `${actor} kicked ${userName(lookup, target)}`;
    case AuditLogEvent.MemberPrune:
      return `${actor} pruned ${entry.options?.members_removed ?? "0"} members inactive for ${entry.options?.delete_member_days ?? "?"} days`;
    case AuditLogEvent.MemberBanAdd:
      return `${actor} banned ${userName(lookup, target)}`;
    case AuditLogEvent.MemberBanRemove:
      return `${actor} unbanned ${userName(lookup, target)}`;
    case AuditLogEvent.MemberUpdate:
      return changed(entry, "communication_disabled_until")
        ? changed(entry, "communication_disabled_until")?.new_value
          ? `${actor} timed out ${userName(lookup, target)}`
          : `${actor} removed the timeout of ${userName(lookup, target)}`
        : `${actor} updated ${userName(lookup, target)}`;
    case AuditLogEvent.MemberRoleUpdate:
      return `${actor} updated roles for ${userName(lookup, target)}`;
    case AuditLogEvent.RoleCreate:
      return `${actor} created the role ${roleName(lookup, target, named(entry, "new"))}`;
    case AuditLogEvent.RoleUpdate:
      return `${actor} updated the role ${roleName(lookup, target, named(entry, "new"))}`;
    case AuditLogEvent.RoleDelete:
      return `${actor} deleted the role ${typeof named(entry, "old") === "string" ? String(named(entry, "old")) : "a role"}`;
    case AuditLogEvent.InviteCreate:
      return `${actor} created the invite ${target ?? ""}`.trim();
    case AuditLogEvent.MessageDelete:
      return `${actor} deleted a message by ${userName(lookup, target)} in ${channelName(lookup, entry.options?.channel_id)}`;
    case AuditLogEvent.MessagePin:
      return `${actor} pinned a message by ${userName(lookup, target)} in ${channelName(lookup, entry.options?.channel_id)}`;
    case AuditLogEvent.MessageUnpin:
      return `${actor} unpinned a message by ${userName(lookup, target)} in ${channelName(lookup, entry.options?.channel_id)}`;
    case AuditLogEvent.AutoModerationRuleCreate:
      return `${actor} created the AutoMod rule ${String(named(entry, "new") ?? "")}`.trim();
    case AuditLogEvent.AutoModerationRuleUpdate:
      return `${actor} updated an AutoMod rule`;
    case AuditLogEvent.AutoModerationRuleDelete:
      return `${actor} deleted the AutoMod rule ${String(named(entry, "old") ?? "")}`.trim();
    case AuditLogEvent.AutoModerationBlockMessage:
      return `AutoMod blocked a message by ${userName(lookup, entry.user_id)} in ${channelName(lookup, entry.options?.channel_id)} (${entry.options?.auto_moderation_rule_name ?? "rule"})`;
    default:
      return `${actor} performed action ${entry.action_type}`;
  }
}

/** A readable value for the before → after diff. */
export function formatAuditValue(key: string, value: unknown, lookup: AuditLookup): string {
  if (value === undefined || value === null) return "none";
  if (key === "$add" || key === "$remove") return Array.isArray(value) ? value.map(r => (r as { name?: string }).name ?? "?").join(", ") : "";
  if (key === "color" && typeof value === "number") return value === 0 ? "default" : `#${value.toString(16).padStart(6, "0")}`;
  if (key === "parent_id" || key === "system_channel_id" || key === "channel_id") return channelName(lookup, String(value));
  if (key === "communication_disabled_until" && typeof value === "string") return new Date(value).toLocaleString();
  if (key === "trigger_metadata" && typeof value === "object") return ((value as { keyword_filter?: string[] }).keyword_filter ?? []).join(", ");
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

const KEY_LABELS: Record<string, string> = {
  $add: "Added roles",
  $remove: "Removed roles",
  communication_disabled_until: "Timeout until",
  system_channel_id: "System channel",
  verification_level: "Verification level",
  explicit_content_filter: "Explicit media filter",
  parent_id: "Category",
  unicode_emoji: "Role icon",
  trigger_metadata: "Keywords",
  exempt_roles: "Exempt roles",
  exempt_channels: "Exempt channels",
  max_age: "Max age",
  max_uses: "Max uses",
  inviter_id: "Inviter",
  channel_id: "Channel",
};

export interface DiffRow {
  label: string;
  before: string | null;
  after: string | null;
}

/** The expandable before → after rows of an entry. */
export function auditDiff(entry: AuditLogEntry, lookup: AuditLookup): DiffRow[] {
  return (entry.changes ?? []).map(c => ({
    label: KEY_LABELS[c.key] ?? c.key.replace(/_/g, " ").replace(/^./, s => s.toUpperCase()),
    before: c.key.startsWith("$") || c.old_value === undefined ? null : formatAuditValue(c.key, c.old_value, lookup),
    after: c.new_value === undefined ? null : formatAuditValue(c.key, c.new_value, lookup),
  }));
}

// ---- member table ----

export type MemberSortKey = "joined" | "created" | "name";
export type SortDirection = "asc" | "desc";

export const accountCreatedAt = (userId: Snowflake): number => snowflakeToTimestamp(userId);

const WEEK_MS = 7 * 86_400_000;

/** Short labels for the "Signals" column (Discord shows flags such as new account, timed out). */
export function memberSignals(member: GuildMember, ownerId: Snowflake, now = Date.now()): string[] {
  const out: string[] = [];
  if (member.user.id === ownerId) out.push("Owner");
  if (member.user.bot) out.push("Bot");
  if (member.communication_disabled_until && Date.parse(member.communication_disabled_until) > now) out.push("Timed out");
  if (now - accountCreatedAt(member.user.id) < WEEK_MS) out.push("New account");
  return out;
}

export function sortMembers(members: GuildMember[], key: MemberSortKey, direction: SortDirection): GuildMember[] {
  const dir = direction === "asc" ? 1 : -1;
  const value = (m: GuildMember): number | string => (key === "joined" ? Date.parse(m.joined_at) : key === "created" ? accountCreatedAt(m.user.id) : (m.nick ?? m.user.global_name ?? m.user.username).toLowerCase());
  return [...members].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    return (x < y ? -1 : x > y ? 1 : 0) * dir || a.user.id.localeCompare(b.user.id);
  });
}

export function filterMembers(members: GuildMember[], needle: string, roleId: Snowflake | null = null): GuildMember[] {
  const q = needle.trim().toLowerCase();
  return members.filter(
    m =>
      (!roleId || m.roles.includes(roleId)) &&
      (!q || m.user.id === q || m.user.username.toLowerCase().includes(q) || (m.user.global_name ?? "").toLowerCase().includes(q) || (m.nick ?? "").toLowerCase().includes(q)),
  );
}

/** Moves `id` one slot up (towards higher rank) or down in a role list sorted by position descending; returns the position updates. */
export function nudgeRole(roles: Role[], id: Snowflake, direction: "up" | "down"): { id: Snowflake; position: number }[] {
  const index = roles.findIndex(r => r.id === id);
  const other = roles[direction === "up" ? index - 1 : index + 1];
  const role = roles[index];
  if (index < 0 || !role || !other) return [];
  return [
    { id: role.id, position: other.position },
    { id: other.id, position: role.position },
  ];
}
