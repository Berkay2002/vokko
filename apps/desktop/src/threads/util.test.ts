import { describe, expect, it } from "vitest";
import { timestampToSnowflake } from "../api/snowflake";
import { ChannelType, type Channel } from "../api/types";
import { applyReactionEvent, clampPanelWidth, groupActiveThreads, isThreadUnread, PANEL_MIN, panelMax, sortThreads, topReaction } from "./util";

const T0 = Date.parse("2026-10-01T12:00:00Z");
const MIN = 60_000;

/** A thread created `createdMin` after T0 whose last message is `lastMin` after T0. */
function thread(name: string, createdMin: number, lastMin: number | null, joined = false): Channel {
  return {
    id: timestampToSnowflake(T0 + createdMin * MIN),
    type: ChannelType.PublicThread,
    guild_id: "1",
    position: 0,
    name,
    parent_id: "2",
    last_message_id: lastMin === null ? null : timestampToSnowflake(T0 + lastMin * MIN, 1),
    thread_metadata: { archived: false, auto_archive_duration: 1440, archive_timestamp: new Date(T0).toISOString(), locked: false, create_timestamp: new Date(T0 + createdMin * MIN).toISOString() },
    ...(joined ? { member: { id: "t", user_id: "me", join_timestamp: new Date(T0).toISOString(), flags: 0 } } : {}),
  } as Channel;
}

const old = thread("old but busy", 0, 50);
const fresh = thread("fresh and quiet", 30, null, true);
const mid = thread("middle", 10, 20, true);

describe("sortThreads", () => {
  it("orders by last activity, falling back to creation for threads without messages", () => {
    expect(sortThreads([fresh, mid, old], "activity").map(t => t.name)).toEqual(["old but busy", "fresh and quiet", "middle"]);
  });
  it("orders by creation time", () => {
    expect(sortThreads([old, mid, fresh], "created").map(t => t.name)).toEqual(["fresh and quiet", "middle", "old but busy"]);
  });
});

describe("groupActiveThreads", () => {
  it("splits joined from other threads, each sorted", () => {
    const { joined, other } = groupActiveThreads([old, mid, fresh], "", "activity");
    expect(joined.map(t => t.name)).toEqual(["fresh and quiet", "middle"]);
    expect(other.map(t => t.name)).toEqual(["old but busy"]);
  });
  it("filters by name, case-insensitive", () => {
    const { joined, other } = groupActiveThreads([old, mid, fresh], "  QUIET ", "activity");
    expect(joined.map(t => t.name)).toEqual(["fresh and quiet"]);
    expect(other).toEqual([]);
  });
});

describe("isThreadUnread", () => {
  it("is unread when the read state is behind the last message, or never read", () => {
    expect(isThreadUnread(old, { channel_id: old.id, last_message_id: mid.last_message_id ?? null, mention_count: 0 })).toBe(true);
    expect(isThreadUnread(old, { channel_id: old.id, last_message_id: null, mention_count: 0 })).toBe(true);
  });
  it("is read when caught up, without messages, or without a read state", () => {
    expect(isThreadUnread(old, { channel_id: old.id, last_message_id: old.last_message_id ?? null, mention_count: 0 })).toBe(false);
    expect(isThreadUnread(fresh, { channel_id: fresh.id, last_message_id: null, mention_count: 0 })).toBe(false);
    expect(isThreadUnread(old, undefined)).toBe(false);
  });
});

describe("topReaction", () => {
  it("picks the highest count, the first one on a tie", () => {
    const a = { emoji: { id: null, name: "👍" }, count: 2, me: false };
    const b = { emoji: { id: null, name: "🎉" }, count: 3, me: true };
    const c = { emoji: { id: null, name: "❤️" }, count: 3, me: false };
    expect(topReaction([a, b, c])).toBe(b);
    expect(topReaction([])).toBeUndefined();
    expect(topReaction(undefined)).toBeUndefined();
  });
});

describe("clampPanelWidth", () => {
  it("keeps the panel at least PANEL_MIN wide and leaves 440 px for the channel", () => {
    expect(clampPanelWidth(100, 1600)).toBe(PANEL_MIN);
    expect(clampPanelWidth(500.4, 1600)).toBe(500);
    expect(clampPanelWidth(1400, 1600)).toBe(1160);
    expect(clampPanelWidth(600, 700)).toBe(PANEL_MIN);
    expect(panelMax(1200.6)).toBe(760);
    expect(panelMax(500)).toBe(PANEL_MIN);
  });
});

describe("applyReactionEvent", () => {
  const up = { id: null, name: "👍" };
  const tada = { id: null, name: "🎉" };
  it("adds a new reaction, counts up and down, and drops it at zero", () => {
    const one = applyReactionEvent([], up, 1, false);
    expect(one).toEqual([{ emoji: up, count: 1, me: false }]);
    const two = applyReactionEvent(one, up, 1, true);
    expect(two).toEqual([{ emoji: up, count: 2, me: true }]);
    expect(applyReactionEvent(two, up, -1, true)).toEqual([{ emoji: up, count: 1, me: false }]);
    expect(applyReactionEvent(two, up, -1, false)).toEqual([{ emoji: up, count: 1, me: true }]);
    expect(applyReactionEvent(one, up, -1, false)).toEqual([]);
  });
  it("leaves other reactions alone and ignores removing an unknown one", () => {
    const list = [{ emoji: tada, count: 3, me: false }];
    expect(applyReactionEvent(list, up, -1, false)).toEqual(list);
    expect(applyReactionEvent(list, up, 1, false)).toHaveLength(2);
    expect(applyReactionEvent([{ emoji: { id: "5", name: "blob" }, count: 1, me: false }], { id: "5", name: "renamed" }, 1, false)[0]?.count).toBe(2);
  });
});
