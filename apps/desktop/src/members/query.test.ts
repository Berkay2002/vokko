import { describe, expect, it } from "vitest";
import { MemberSearchSort } from "../api/types";
import { Perm } from "../api/permissions";
import { NO_FILTERS, buildSearchRequest, canSeeMembersPage, pageCount, pageItems, readUrlState, relativeTime, timeRange, writeUrlState } from "./query";

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("pageItems", () => {
  it("lists every page up to seven", () => {
    expect(pageItems(1, 1)).toEqual([1]);
    expect(pageItems(3, 6)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(pageItems(7, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
  it("uses an ellipsis for gaps in long lists", () => {
    expect(pageItems(1, 20)).toEqual([1, 2, 3, 4, 5, "…", 20]);
    expect(pageItems(10, 20)).toEqual([1, "…", 9, 10, 11, "…", 20]);
    expect(pageItems(20, 20)).toEqual([1, "…", 16, 17, 18, 19, 20]);
    expect(pageItems(5, 20)).toEqual([1, "…", 4, 5, 6, "…", 20]);
  });
  it("never repeats or skips the edges", () => {
    for (let total = 1; total <= 30; total++) {
      for (let current = 1; current <= total; current++) {
        const numbers = pageItems(current, total).filter((p): p is number => p !== "…");
        expect(numbers[0]).toBe(1);
        expect(numbers[numbers.length - 1]).toBe(total);
        expect(numbers).toContain(current);
        expect(new Set(numbers).size).toBe(numbers.length);
      }
    }
  });
  it("counts pages", () => {
    expect(pageCount(0, 12)).toBe(1);
    expect(pageCount(65, 12)).toBe(6);
    expect(pageCount(65, 100)).toBe(1);
  });
});

describe("buildSearchRequest", () => {
  it("sends no filters by default and pages by offset", () => {
    expect(buildSearchRequest(NO_FILTERS, MemberSearchSort.MemberSinceNewestFirst, 1, 12, NOW)).toEqual({ limit: 12, offset: 0, sort: 1, and_query: {} });
    expect(buildSearchRequest(NO_FILTERS, MemberSearchSort.JoinedVokkoOldestFirst, 3, 25, NOW)).toEqual({ limit: 25, offset: 50, sort: 4, and_query: {} });
  });
  it("maps every filter", () => {
    const request = buildSearchRequest(
      {
        search: "  sam ",
        memberSince: { kind: "preset", preset: "24h" },
        joinedVokko: { kind: "preset", preset: "7d" },
        inviteCodes: ["vokkodev"],
        roleIds: ["10", "11"],
      },
      MemberSearchSort.MemberSinceOldestFirst,
      2,
      12,
      NOW,
    );
    expect(request).toEqual({
      limit: 12,
      offset: 12,
      sort: 2,
      and_query: {
        usernames: { or_query: ["sam"] },
        guild_joined_at: { range: { gte: NOW - DAY } },
        user_created_at: { range: { gte: NOW - 7 * DAY } },
        source_invite_code: { or_query: ["vokkodev"] },
        role_ids: { or_query: ["10", "11"] },
      },
    });
  });
  it("leaves out blank search and the All preset", () => {
    const request = buildSearchRequest({ ...NO_FILTERS, search: "   ", memberSince: { kind: "preset", preset: "all" } }, MemberSearchSort.MemberSinceNewestFirst, 1, 12, NOW);
    expect(request.and_query).toEqual({});
  });
});

describe("timeRange", () => {
  it("turns presets into a window ending now", () => {
    expect(timeRange({ kind: "preset", preset: "1h" }, NOW)).toEqual({ gte: NOW - HOUR });
    expect(timeRange({ kind: "preset", preset: "90d" }, NOW)).toEqual({ gte: NOW - 90 * DAY });
    expect(timeRange({ kind: "preset", preset: "all" }, NOW)).toBeNull();
  });
  it("makes a custom range cover whole local days", () => {
    const from = new Date(2026, 0, 1).getTime();
    const to = new Date(2026, 0, 31).getTime();
    expect(timeRange({ kind: "custom", from: "2026-01-01", to: "2026-01-31" }, NOW)).toEqual({ gte: from, lte: to + DAY - 1 });
    expect(timeRange({ kind: "custom", from: "2026-01-01", to: "" }, NOW)).toEqual({ gte: from });
    expect(timeRange({ kind: "custom", from: "", to: "nope" }, NOW)).toBeNull();
  });
});

describe("access and url state", () => {
  it("opens for any of Discord's member-safety permissions", () => {
    expect(canSeeMembersPage(0n)).toBe(false);
    expect(canSeeMembersPage(Perm.SEND_MESSAGES | Perm.MANAGE_MESSAGES)).toBe(false);
    for (const perm of [Perm.ADMINISTRATOR, Perm.MANAGE_GUILD, Perm.KICK_MEMBERS, Perm.BAN_MEMBERS, Perm.MODERATE_MEMBERS, Perm.MANAGE_ROLES, Perm.MANAGE_NICKNAMES]) {
      expect(canSeeMembersPage(perm)).toBe(true);
    }
  });
  it("round-trips page and sort through the URL", () => {
    expect(readUrlState("")).toEqual({ page: 1, sort: 1 });
    expect(readUrlState(writeUrlState(3, MemberSearchSort.JoinedVokkoNewestFirst))).toEqual({ page: 3, sort: 3 });
    expect(writeUrlState(1, MemberSearchSort.MemberSinceNewestFirst)).toBe("");
    expect(readUrlState("?page=-2&sort=9")).toEqual({ page: 1, sort: 1 });
  });
  it("formats relative times", () => {
    expect(relativeTime(NOW - 21 * DAY, NOW)).toBe("21 days ago");
    expect(relativeTime(NOW - 3 * HOUR, NOW)).toBe("3 hours ago");
    expect(relativeTime(NOW - 400 * DAY, NOW)).toBe("1 year ago");
  });
});
