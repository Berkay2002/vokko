import { describe, expect, it } from "vitest";
import type { ThreadMember } from "../api/types";
import type { NotifyLocalState } from "../notify/decide";
import { isThreadMuted } from "./mute";

const NOW = Date.parse("2026-10-12T10:00:00Z");
const none: NotifyLocalState = { mutedUntil: {}, notify: {}, suppressEveryone: {}, suppressRoles: {} };
const thread = { id: "t1", parent_id: "forum" };
const member = (over: Partial<ThreadMember> = {}): ThreadMember => ({ id: "t1", user_id: "me", join_timestamp: "", flags: 0, muted: false, mute_config: null, ...over }) as ThreadMember;
const muted = (member_: ThreadMember | undefined, local = none) => isThreadMuted(thread, member_, "cat", local, NOW);

describe("isThreadMuted", () => {
  it("is false with nothing muted", () => expect(muted(member())).toBe(false));
  it("follows the member's mute, forever or timed", () => {
    expect(muted(member({ muted: true, mute_config: { end_time: null } }))).toBe(true);
    expect(muted(member({ muted: true, mute_config: { end_time: "2026-10-12T11:00:00Z" } }))).toBe(true);
  });
  it("lets a timed member mute lapse", () => expect(muted(member({ muted: true, mute_config: { end_time: "2026-10-12T09:00:00Z" } }))).toBe(false));
  it("is muted by its forum or its category", () => {
    expect(muted(member(), { ...none, mutedUntil: { forum: -1 } })).toBe(true);
    expect(muted(undefined, { ...none, mutedUntil: { cat: NOW + 1000 } })).toBe(true);
  });
  it("ignores a stale local mute of the thread when the member is not muted", () => expect(muted(member(), { ...none, mutedUntil: { t1: -1 } })).toBe(false));
});
