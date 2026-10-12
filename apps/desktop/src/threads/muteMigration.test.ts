import { beforeEach, describe, expect, it, vi } from "vitest";

const updateThreadMember = vi.hoisted(() => vi.fn());
const chatToast = vi.hoisted(() => vi.fn());
vi.mock("../api/rest", () => ({ request: vi.fn(), resolveUrl: (url: string) => url, updateThreadMember }));
vi.mock("../chat/toast", () => ({ chatToast }));
vi.mock("../api/gateway", () => ({ gateway: { on: () => () => undefined, onStatus: () => () => undefined } }));

import { appStore } from "../api/store";
import { ChannelType, type Channel, type ThreadMember, type UpdateThreadMemberRequest } from "../api/types";
import { useLocalState } from "../shell/localState";
import { applyMemberPatch } from "./memberSettings";
import { localThreadMutePatch, migrateLocalThreadMute, resetThreadMuteMigration, startThreadMuteMigration } from "./muteMigration";

const NOW = Date.parse("2026-10-12T10:00:00.000Z");
const member = (id: string, extra: Partial<ThreadMember> = {}): ThreadMember => ({ id, user_id: "10", join_timestamp: "2026-01-01T00:00:00.000Z", flags: 0, muted: false, mute_config: null, ...extra });
const thread = (id: string, m?: ThreadMember): Channel => ({
  id,
  type: ChannelType.PublicThread,
  guild_id: "100",
  name: "t",
  topic: null,
  position: 0,
  parent_id: "200",
  last_message_id: null,
  ...(m ? { member: m } : {}),
});
const mine = (id: string) => appStore.getState().threads[id]?.member;
const local = () => useLocalState.getState().mutedUntil;

beforeEach(() => {
  resetThreadMuteMigration();
  updateThreadMember.mockReset();
  // The server answers with what the optimistic patch predicted.
  updateThreadMember.mockImplementation(async (id: string, patch: UpdateThreadMemberRequest) => applyMemberPatch(member(id), patch));
  chatToast.mockReset();
  useLocalState.setState({ mutedUntil: {} });
});

describe("localThreadMutePatch", () => {
  it("turns forever into a mute without an end", () => expect(localThreadMutePatch(-1, NOW)).toEqual({ muted: true, mute_config: null }));
  it("keeps the end time of an active timed mute", () => {
    expect(localThreadMutePatch(NOW + 60_000, NOW)).toEqual({ muted: true, mute_config: { end_time: "2026-10-12T10:01:00.000Z" } });
  });
  it("is null for an expired entry or none", () => {
    expect(localThreadMutePatch(NOW, NOW)).toBeNull();
    expect(localThreadMutePatch(NOW - 1, NOW)).toBeNull();
    expect(localThreadMutePatch(undefined, NOW)).toBeNull();
  });
});

describe("migrateLocalThreadMute", () => {
  it("moves a forever local mute onto the thread member and drops the local entry", async () => {
    appStore.getState().upsertThread(thread("t1", member("t1")));
    useLocalState.setState({ mutedUntil: { t1: -1, other: -1 } });
    await migrateLocalThreadMute("t1", NOW);
    expect(updateThreadMember).toHaveBeenCalledWith("t1", { muted: true, mute_config: null });
    expect(mine("t1")).toMatchObject({ muted: true, mute_config: { end_time: null } });
    expect(local()).toEqual({ other: -1 });
  });

  it("moves an active timed mute with the same end time", async () => {
    appStore.getState().upsertThread(thread("t2", member("t2")));
    useLocalState.setState({ mutedUntil: { t2: NOW + 3_600_000 } });
    await migrateLocalThreadMute("t2", NOW);
    expect(updateThreadMember).toHaveBeenCalledWith("t2", { muted: true, mute_config: { end_time: "2026-10-12T11:00:00.000Z" } });
    expect(local()).toEqual({});
  });

  it("just drops an expired entry", async () => {
    appStore.getState().upsertThread(thread("t3", member("t3")));
    useLocalState.setState({ mutedUntil: { t3: NOW - 1 } });
    await migrateLocalThreadMute("t3", NOW);
    expect(updateThreadMember).not.toHaveBeenCalled();
    expect(local()).toEqual({});
  });

  it("leaves a member that is already muted alone and drops the local entry", async () => {
    appStore.getState().upsertThread(thread("t4", member("t4", { muted: true, mute_config: { end_time: null } })));
    useLocalState.setState({ mutedUntil: { t4: NOW + 60_000 } });
    await migrateLocalThreadMute("t4", NOW);
    expect(updateThreadMember).not.toHaveBeenCalled();
    expect(local()).toEqual({});
  });

  it("waits until the thread member is known", async () => {
    appStore.getState().upsertThread(thread("t5"));
    useLocalState.setState({ mutedUntil: { t5: -1 } });
    await migrateLocalThreadMute("t5", NOW);
    expect(updateThreadMember).not.toHaveBeenCalled();
    expect(local()).toEqual({ t5: -1 });
    appStore.getState().upsertThread(thread("t5", member("t5")));
    await migrateLocalThreadMute("t5", NOW);
    expect(updateThreadMember).toHaveBeenCalledTimes(1);
    expect(local()).toEqual({});
  });

  it("runs once per thread and keeps the local entry when the PATCH fails", async () => {
    updateThreadMember.mockRejectedValue(new Error("nope"));
    appStore.getState().upsertThread(thread("t6", member("t6")));
    useLocalState.setState({ mutedUntil: { t6: -1 } });
    await migrateLocalThreadMute("t6", NOW);
    expect(mine("t6")?.muted).toBe(false);
    expect(local()).toEqual({ t6: -1 });
    await migrateLocalThreadMute("t6", NOW);
    expect(updateThreadMember).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: a second run (or a later session) with nothing local does nothing", async () => {
    appStore.getState().upsertThread(thread("t7", member("t7")));
    useLocalState.setState({ mutedUntil: { t7: -1 } });
    await migrateLocalThreadMute("t7", NOW);
    resetThreadMuteMigration();
    await migrateLocalThreadMute("t7", NOW);
    expect(updateThreadMember).toHaveBeenCalledTimes(1);
  });
});

describe("startThreadMuteMigration", () => {
  it("migrates as threads with members arrive, without looping on its own store updates", async () => {
    useLocalState.setState({ mutedUntil: { t8: -1, guild: -1 } });
    const off = startThreadMuteMigration();
    appStore.getState().upsertThread(thread("t8", member("t8")));
    await vi.waitFor(() => expect(local()).toEqual({ guild: -1 }));
    appStore.getState().upsertThread(thread("t8", member("t8", { flags: 2 })));
    await Promise.resolve();
    expect(updateThreadMember).toHaveBeenCalledTimes(1);
    off();
  });
});
