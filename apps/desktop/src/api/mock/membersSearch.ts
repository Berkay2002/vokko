// Mock of POST /guilds/{id}/members-search (docs/api.md "Members page (member-safety search)"): same access check, filters, sorts,
// offset paging and error codes as the server. Joining through an invite is recorded by the invite route in routes.ts.

import { JoinSourceType, MemberSearchSort, type GuildMember, type MemberSearchResponse } from "../types";
import { compareIds, snowflakeToTimestamp } from "../snowflake";
import { Perm } from "../permissions";
import { guildPermsOf } from "./access";
import { fail, MISSING_PERMISSIONS, requireGuildMember } from "./ops";
import { ID, route } from "./router";
import { membersOf } from "./views";

const ACCESS = Perm.ADMINISTRATOR | Perm.MANAGE_GUILD | Perm.KICK_MEMBERS | Perm.BAN_MEMBERS | Perm.MODERATE_MEMBERS | Perm.MANAGE_ROLES | Perm.MANAGE_NICKNAMES;
const MAX_LIST = 100;

function invalid(field: string, message: string): never {
  return fail(400, 50035, "Invalid Form Body", { [field]: { code: "BASE_TYPE_BAD_FORMAT", message } });
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A list under `parent[key]`; absent or empty = no filter (null). */
function list(parent: Record<string, unknown>, key: string, field: string, item: (v: unknown) => boolean, max = MAX_LIST): unknown[] | null {
  const raw = parent[key];
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) return invalid(field, "Must be a list.");
  if (raw.length > max) invalid(field, `Must be ${max} or fewer in length.`);
  for (const v of raw) if (!item(v)) invalid(field, "Invalid value.");
  return raw.length === 0 ? null : raw;
}

function group(and: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const raw = and[key];
  if (raw === undefined || raw === null) return null;
  return isObject(raw) ? raw : invalid(key, "Must be an object.");
}

type Range = { gte?: number; lte?: number };

function range(and: Record<string, unknown>, key: string): Range | null {
  const g = group(and, key);
  const r = g?.range;
  if (r === undefined || r === null) return null;
  if (!isObject(r)) return invalid(key, "Must be an object.");
  const out: Range = {};
  for (const bound of ["gte", "lte"] as const) {
    const v = r[bound];
    if (v === undefined || v === null) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) invalid(key, `${bound} must be a number.`);
    out[bound] = v;
  }
  return out;
}

const isId = (v: unknown): boolean => typeof v === "string" && /^\d+$/.test(v);
const inRange = (value: number, r: Range | null): boolean => !r || ((r.gte === undefined || value >= r.gte) && (r.lte === undefined || value <= r.lte));

route("POST", `/guilds/${ID}/members-search`, ({ viewer, params, body }) => {
  const guildId = params[0] ?? "";
  const guild = requireGuildMember(guildId, viewer.user.id);
  if ((guildPermsOf(guildId, viewer.user.id) & ACCESS) === 0n) fail(403, 50013, MISSING_PERMISSIONS);

  const int = (key: string, min: number, max: number, fallback: number): number => {
    const v = body[key];
    if (v === undefined || v === null) return fallback;
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) invalid(key, `Must be between ${min} and ${max}.`);
    return v;
  };
  const limit = int("limit", 1, 1000, 25);
  const offset = int("offset", 0, 100_000, 0);
  const sort = int("sort", 1, 4, MemberSearchSort.MemberSinceNewestFirst);
  const andRaw = body.and_query;
  if (andRaw !== undefined && andRaw !== null && !isObject(andRaw)) invalid("and_query", "Must be an object.");
  const and = isObject(andRaw) ? andRaw : {};

  const nameGroup = group(and, "usernames");
  const terms = nameGroup ? list(nameGroup, "or_query", "usernames", v => typeof v === "string" && v.trim().length >= 1 && v.trim().length <= 100, 10) : null;
  const usernames = terms ? (terms as string[]).map(t => t.trim().toLowerCase()) : null;
  const idGroup = group(and, "user_id");
  const userIds = idGroup ? (list(idGroup, "or_query", "user_id", isId) as string[] | null) : null;
  const roleGroup = group(and, "role_ids");
  const rolesAny = roleGroup ? (list(roleGroup, "or_query", "role_ids", isId) as string[] | null) : null;
  const rolesAll = roleGroup ? (list(roleGroup, "and_query", "role_ids", isId) as string[] | null) : null;
  const joinedRange = range(and, "guild_joined_at");
  const createdRange = range(and, "user_created_at");
  const codeGroup = group(and, "source_invite_code");
  const codes = codeGroup ? (list(codeGroup, "or_query", "source_invite_code", v => typeof v === "string" && v.length > 0 && v.length <= 100) as string[] | null) : null;
  const sourceGroup = group(and, "join_source_type");
  const sources = sourceGroup ? (list(sourceGroup, "or_query", "join_source_type", v => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 7) as number[] | null) : null;

  const rows = membersOf(guildId).flatMap(member => {
    const record = guild.members.get(member.user.id);
    return record ? [{ member: member as GuildMember, record }] : [];
  });
  const matched = rows.filter(({ member, record }) => {
    const id = member.user.id;
    if (usernames) {
      const names = [member.user.username, member.user.global_name, member.nick].filter((n): n is string => typeof n === "string").map(n => n.toLowerCase());
      if (!usernames.some(t => (/^\d+$/.test(t) && id === t) || names.some(n => n.startsWith(t)))) return false;
    }
    if (userIds && !userIds.includes(id)) return false;
    if (rolesAny && !rolesAny.some(r => member.roles.includes(r))) return false;
    if (rolesAll && !rolesAll.every(r => member.roles.includes(r))) return false;
    if (!inRange(Date.parse(member.joined_at), joinedRange)) return false;
    if (!inRange(snowflakeToTimestamp(id), createdRange)) return false;
    if (codes && !(record.source_invite_code && codes.includes(record.source_invite_code))) return false;
    if (sources && !sources.includes(record.join_source_type ?? JoinSourceType.Unspecified)) return false;
    return true;
  });

  const dir = sort === MemberSearchSort.MemberSinceNewestFirst || sort === MemberSearchSort.JoinedVokkoNewestFirst ? -1 : 1;
  const byMemberSince = sort === MemberSearchSort.MemberSinceNewestFirst || sort === MemberSearchSort.MemberSinceOldestFirst;
  matched.sort((a, b) => {
    const primary = byMemberSince ? Date.parse(a.member.joined_at) - Date.parse(b.member.joined_at) : snowflakeToTimestamp(a.member.user.id) - snowflakeToTimestamp(b.member.user.id);
    return dir * (primary || compareIds(a.member.user.id, b.member.user.id));
  });

  const page = matched.slice(offset, offset + limit);
  const out: MemberSearchResponse = {
    guild_id: guildId,
    members: page.map(({ member, record }) => ({
      member,
      source_invite_code: record.source_invite_code ?? null,
      join_source_type: record.join_source_type ?? JoinSourceType.Unspecified,
      inviter_id: record.inviter_id ?? null,
    })),
    page_result_count: page.length,
    total_result_count: matched.length,
  };
  return out;
});
