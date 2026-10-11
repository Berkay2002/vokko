// Members page state → POST /guilds/{id}/members-search body, plus the pagination and time helpers the table uses.
import { MemberSearchSort, type MemberSearchRequest, type Snowflake } from "../api/types";
import { Perm, hasBit } from "../api/permissions";

/** Discord's member-safety access check: any of these opens the Members page. */
export const MEMBERS_PAGE_PERMISSIONS = [Perm.ADMINISTRATOR, Perm.MANAGE_GUILD, Perm.KICK_MEMBERS, Perm.BAN_MEMBERS, Perm.MODERATE_MEMBERS, Perm.MANAGE_ROLES, Perm.MANAGE_NICKNAMES];

export const canSeeMembersPage = (bits: bigint): boolean => MEMBERS_PAGE_PERMISSIONS.some(p => hasBit(bits, p));

/** The route segment in `/channels/:guildId/member-safety`. */
export const MEMBERS_ROUTE = "member-safety";

export const PAGE_SIZES = [12, 25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

export const SORT_OPTIONS: { value: MemberSearchSort; label: string }[] = [
  { value: MemberSearchSort.MemberSinceNewestFirst, label: "Member since (newest first)" },
  { value: MemberSearchSort.MemberSinceOldestFirst, label: "Member since (oldest first)" },
  { value: MemberSearchSort.JoinedVokkoNewestFirst, label: "Joined Vokko (newest first)" },
  { value: MemberSearchSort.JoinedVokkoOldestFirst, label: "Joined Vokko (oldest first)" },
];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type TimePreset = "all" | "1h" | "24h" | "7d" | "14d" | "28d" | "90d";
export const TIME_PRESETS: { value: TimePreset; label: string; ms: number }[] = [
  { value: "all", label: "All", ms: 0 },
  { value: "1h", label: "Last hour", ms: HOUR },
  { value: "24h", label: "Last 24 hours", ms: DAY },
  { value: "7d", label: "Last 7 days", ms: 7 * DAY },
  { value: "14d", label: "Last 2 weeks", ms: 14 * DAY },
  { value: "28d", label: "Last 4 weeks", ms: 28 * DAY },
  { value: "90d", label: "Last 3 months", ms: 90 * DAY },
];

/** A time filter: a preset window ending now, or a custom from/to date pair (`YYYY-MM-DD`, local days, both inclusive). */
export type TimeFilter = { kind: "preset"; preset: TimePreset } | { kind: "custom"; from: string; to: string };
export const ALL_TIME: TimeFilter = { kind: "preset", preset: "all" };

export interface MemberFilters {
  search: string;
  memberSince: TimeFilter;
  joinedVokko: TimeFilter;
  inviteCodes: string[];
  roleIds: Snowflake[];
}
export const NO_FILTERS: MemberFilters = { search: "", memberSince: ALL_TIME, joinedVokko: ALL_TIME, inviteCodes: [], roleIds: [] };

export const isActive = (filter: TimeFilter): boolean => !(filter.kind === "preset" && filter.preset === "all");

/** `{gte?, lte?}` in unix ms, or null for "All" / an empty custom range. */
export function timeRange(filter: TimeFilter, now = Date.now()): { gte?: number; lte?: number } | null {
  if (filter.kind === "preset") {
    const preset = TIME_PRESETS.find(p => p.value === filter.preset);
    return preset && preset.ms > 0 ? { gte: now - preset.ms } : null;
  }
  const range: { gte?: number; lte?: number } = {};
  const from = parseDay(filter.from);
  const to = parseDay(filter.to);
  if (from !== null) range.gte = from;
  if (to !== null) range.lte = to + DAY - 1;
  return range.gte === undefined && range.lte === undefined ? null : range;
}

function parseDay(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

/** The request for one page. Empty filters are left out so the server sees no constraint. */
export function buildSearchRequest(filters: MemberFilters, sort: MemberSearchSort, page: number, pageSize: number, now = Date.now()): MemberSearchRequest {
  const and_query: MemberSearchRequest["and_query"] = {};
  const search = filters.search.trim().slice(0, 100);
  if (search) and_query.usernames = { or_query: [search] };
  const joined = timeRange(filters.memberSince, now);
  if (joined) and_query.guild_joined_at = { range: joined };
  const created = timeRange(filters.joinedVokko, now);
  if (created) and_query.user_created_at = { range: created };
  if (filters.inviteCodes.length > 0) and_query.source_invite_code = { or_query: [...filters.inviteCodes] };
  if (filters.roleIds.length > 0) and_query.role_ids = { or_query: [...filters.roleIds] };
  return { limit: pageSize, offset: Math.max(0, page - 1) * pageSize, sort, and_query };
}

export const pageCount = (total: number, pageSize: number): number => Math.max(1, Math.ceil(total / pageSize));

/** Page buttons: every page up to 7, else first, last and the current page's neighbours, with "…" for the gaps. */
export function pageItems(current: number, total: number): (number | "…")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = new Set([1, total, current - 1, current, current + 1]);
  if (current <= 4) [2, 3, 4, 5].forEach(p => pages.add(p));
  if (current >= total - 3) [total - 4, total - 3, total - 2, total - 1].forEach(p => pages.add(p));
  const sorted = [...pages].filter(p => p >= 1 && p <= total).sort((a, b) => a - b);
  const out: (number | "…")[] = [];
  sorted.forEach((p, i) => {
    const prev = sorted[i - 1];
    if (prev !== undefined && p - prev > 1) out.push("…");
    out.push(p);
  });
  return out;
}

const relative = new Intl.RelativeTimeFormat("en", { numeric: "always" });

/** "21 days ago", "3 months ago", "2 years ago". */
export function relativeTime(ms: number, now = Date.now()): string {
  const seconds = Math.round((ms - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return relative.format(seconds, "second");
  if (abs < 3600) return relative.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return relative.format(Math.round(seconds / 3600), "hour");
  if (abs < 30 * 86_400) return relative.format(Math.round(seconds / 86_400), "day");
  if (abs < 365 * 86_400) return relative.format(Math.round(seconds / (30 * 86_400)), "month");
  return relative.format(Math.round(seconds / (365 * 86_400)), "year");
}

/** Accounts younger than this get the "New account" signal. */
export const NEW_ACCOUNT_MS = 7 * DAY;

/** Page and sort live in the URL (`?page=2&sort=3`); anything invalid falls back to the defaults. */
export function readUrlState(search: string): { page: number; sort: MemberSearchSort } {
  const params = new URLSearchParams(search);
  const page = Number(params.get("page"));
  const sort = Number(params.get("sort"));
  return {
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    sort: SORT_OPTIONS.some(o => o.value === sort) ? (sort as MemberSearchSort) : MemberSearchSort.MemberSinceNewestFirst,
  };
}

export function writeUrlState(page: number, sort: MemberSearchSort): string {
  const params = new URLSearchParams();
  if (page > 1) params.set("page", String(page));
  if (sort !== MemberSearchSort.MemberSinceNewestFirst) params.set("sort", String(sort));
  const text = params.toString();
  return text ? `?${text}` : "";
}
