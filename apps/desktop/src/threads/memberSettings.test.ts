import { beforeEach, describe, expect, it, vi } from "vitest";

const updateThreadMember = vi.hoisted(() => vi.fn());
const chatToast = vi.hoisted(() => vi.fn());
vi.mock("../api/rest", () => ({ request: vi.fn(), resolveUrl: (url: string) => url, updateThreadMember }));
vi.mock("../chat/toast", () => ({ chatToast }));
vi.mock("../api/gateway", () => ({ gateway: { on: () => () => undefined, onStatus: () => () => undefined } }));

import { appStore } from "../api/store";
import { ChannelType, ThreadMemberFlags, type Channel, type ThreadMember } from "../api/types";
import { decide, withThreadMember, type NotifyLocalState } from "../notify/decide";
import { threadMuteItem, threadNotificationItem } from "../shell/menus";
import { applyMemberPatch, patchThreadMember } from "./memberSettings";

const member = (extra: Partial<ThreadMember> = {}): ThreadMember => ({ id: "1", user_id: "10", join_timestamp: "2026-01-01T00:00:00.000Z", flags: 0, muted: false, mute_config: null, ...extra });
const thread = (m?: ThreadMember): Channel => ({
  id: "1",
  type: ChannelType.PublicThread,
  guild_id: "100",
  name: "t",
  topic: null,
  position: 0,
  parent_id: "200",
  last_message_id: null,
  ...(m ? { member: m } : {}),
});
const mine = () => appStore.getState().threads["1"]?.member;

beforeEach(() => {
  updateThreadMember.mockReset();
  chatToast.mockReset();
  appStore.getState().upsertThread(thread(member()));
});

describe("applyMemberPatch", () => {
  it("only the notify bits change; HAS_INTERACTED stays", () => {
    const next = applyMemberPatch(member({ flags: ThreadMemberFlags.HasInteracted | ThreadMemberFlags.AllMessages }), { flags: ThreadMemberFlags.NoMessages });
    expect(next.flags).toBe(ThreadMemberFlags.HasInteracted | ThreadMemberFlags.NoMessages);
    expect(applyMemberPatch(member({ flags: 4 }), { flags: 0 }).flags).toBe(0);
  });

  it("mutes forever or until a time, and unmuting clears the config", () => {
    expect(applyMemberPatch(member(), { muted: true, mute_config: null })).toMatchObject({ muted: true, mute_config: { end_time: null } });
    const end = "2999-01-01T00:00:00.000Z";
    expect(applyMemberPatch(member(), { muted: true, mute_config: { end_time: end } })).toMatchObject({ muted: true, mute_config: { end_time: end } });
    expect(applyMemberPatch(member({ muted: true, mute_config: { end_time: end } }), { muted: false })).toMatchObject({ muted: false, mute_config: null });
  });
});

describe("patchThreadMember", () => {
  it("applies optimistically, then keeps the server's member", async () => {
    let resolve: (m: ThreadMember) => void = () => undefined;
    updateThreadMember.mockReturnValue(new Promise<ThreadMember>(r => (resolve = r)));
    const done = patchThreadMember("1", { flags: ThreadMemberFlags.OnlyMentions });
    expect(mine()?.flags).toBe(ThreadMemberFlags.OnlyMentions);
    expect(updateThreadMember).toHaveBeenCalledWith("1", { flags: ThreadMemberFlags.OnlyMentions });
    resolve(member({ flags: 4, muted: true, mute_config: { end_time: null } }));
    await done;
    expect(mine()).toMatchObject({ flags: 4, muted: true });
    expect(chatToast).not.toHaveBeenCalled();
  });

  it("reverts and toasts on failure", async () => {
    updateThreadMember.mockRejectedValue(new Error("nope"));
    await patchThreadMember("1", { muted: true, mute_config: null });
    expect(mine()).toMatchObject({ muted: false, mute_config: null });
    expect(chatToast).toHaveBeenCalledTimes(1);
  });

  it("the gateway's THREAD_MEMBER_UPDATE shape lands on the thread member", () => {
    appStore.getState().upsertThread(thread(member({ flags: 8, muted: true, mute_config: { end_time: null } })));
    expect(mine()).toMatchObject({ flags: 8, muted: true, mute_config: { end_time: null } });
  });
});

describe("thread bell menu builders", () => {
  it("is disabled with a hint until the thread is joined", () => {
    expect(threadMuteItem(undefined, vi.fn())).toMatchObject({ label: "Mute Thread", disabled: true, hint: "Join the thread first" });
    expect(threadNotificationItem(undefined, vi.fn())).toMatchObject({ label: "Notification Settings", disabled: true, hint: "Join the thread first" });
  });

  it("mute durations send an end time, forever sends null", () => {
    const apply = vi.fn();
    const item = threadMuteItem(member(), apply, 1_000_000);
    const children = "children" in item ? (item.children ?? []) : [];
    const pick = (id: string) => (children.find(c => "id" in c && c.id === id) as { onSelect: () => void }).onSelect();
    pick("1h");
    expect(apply).toHaveBeenLastCalledWith({ muted: true, mute_config: { end_time: new Date(1_000_000 + 3_600_000).toISOString() } });
    pick("forever");
    expect(apply).toHaveBeenLastCalledWith({ muted: true, mute_config: { end_time: null } });
  });

  it("offers Unmute Thread while muted", () => {
    const apply = vi.fn();
    const item = threadMuteItem(member({ muted: true, mute_config: { end_time: null } }), apply);
    expect(item).toMatchObject({ id: "unmute", label: "Unmute Thread" });
    (item as { onSelect: () => void }).onSelect();
    expect(apply).toHaveBeenCalledWith({ muted: false });
  });

  it("radios map to the notify bits; no bit checks Use Channel Default", () => {
    const apply = vi.fn();
    const radios = (m: ThreadMember) => {
      const item = threadNotificationItem(m, apply);
      return ("children" in item ? (item.children ?? []) : []) as { id: string; label: string; checked: boolean; onSelect: () => void }[];
    };
    expect(radios(member()).map(r => [r.label, r.checked])).toEqual([["Use Channel Default", true], ["All Messages", false], ["Only @mentions", false], ["Nothing", false]]);
    const set = radios(member({ flags: ThreadMemberFlags.HasInteracted | ThreadMemberFlags.OnlyMentions }));
    expect(set.find(r => r.checked)?.label).toBe("Only @mentions");
    set.find(r => r.id === "none")?.onSelect();
    expect(apply).toHaveBeenLastCalledWith({ flags: ThreadMemberFlags.NoMessages });
    set.find(r => r.id === "default")?.onSelect();
    expect(apply).toHaveBeenLastCalledWith({ flags: 0 });
  });
});

describe("withThreadMember", () => {
  const local = (): NotifyLocalState => ({ mutedUntil: {}, notify: {}, suppressEveryone: {}, suppressRoles: {} });

  it("overlays the member's mute and level on the thread id, and leaves the rest alone", () => {
    const base = { ...local(), notify: { "200": "mentions" as const } };
    expect(withThreadMember(base, "1", undefined)).toBe(base);
    expect(withThreadMember(base, "1", member()).notify).toEqual({ "200": "mentions" });
    expect(withThreadMember(base, "1", member({ flags: ThreadMemberFlags.NoMessages })).notify).toEqual({ "200": "mentions", "1": "none" });
    expect(withThreadMember(base, "1", member({ muted: true, mute_config: { end_time: null } })).mutedUntil).toEqual({ "1": -1 });
    expect(withThreadMember({ ...base, mutedUntil: { "1": -1 } }, "1", member()).mutedUntil).toEqual({});
  });

  it("a muted thread member silences decide()", () => {
    const message = { author: { id: "9" }, mentions: [], mention_everyone: false, content: "hi", type: 0 } as never;
    const run = (l: NotifyLocalState) =>
      decide({ message, meId: "10", myRoleIds: [], dm: null, scopes: ["1", "200", "100"], local: l, prefs: { desktopNotifications: true, notificationSounds: true, soundCurrentChannel: false, streamerMode: false, streamerDisableSounds: true, streamerDisableNotifications: true }, status: "online", focused: false, viewing: false, now: 1 });
    expect(run(withThreadMember(local(), "1", member())).kind).toBe("message");
    expect(run(withThreadMember(local(), "1", member({ muted: true, mute_config: { end_time: null } }))).reason).toBe("muted");
    expect(run(withThreadMember(local(), "1", member({ flags: ThreadMemberFlags.OnlyMentions }))).reason).toBe("level-mentions");
  });
});
