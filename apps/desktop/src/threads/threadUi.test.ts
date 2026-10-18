import { beforeEach, describe, expect, it, vi } from "vitest";

const goMock = vi.hoisted(() => vi.fn());
vi.mock("../shell/nav", async orig => ({ ...(await orig<typeof import("../shell/nav")>()), go: goMock }));

import { appStore } from "../api/store";
import { ChannelType, type Channel } from "../api/types";
import { useNavDrawer } from "../shell/navDrawer";
import { goToThread, useThreadUi } from "./threadUi";

const thread = { id: "t", type: ChannelType.PublicThread, guild_id: "g", parent_id: "p", name: "t" } as Channel;

describe("goToThread", () => {
  beforeEach(() => {
    goMock.mockReset();
    useThreadUi.setState({ openId: null });
    useNavDrawer.setState({ open: true, details: true });
  });

  it("routes to the parent, opens the panel and leaves the phone list and details pages", () => {
    appStore.setState({ channels: { p: { id: "p", guild_id: "g" } as Channel }, threads: {} });
    expect(goToThread(thread)).toBe(true);
    expect(goMock).toHaveBeenCalledWith("/channels/g/p");
    expect(useThreadUi.getState().openId).toBe("t");
    expect(useNavDrawer.getState()).toMatchObject({ open: false, details: false });
  });

  it("does nothing when the parent channel is not one we hold", () => {
    appStore.setState({ channels: {}, threads: {} });
    expect(goToThread(thread)).toBe(false);
    expect(goMock).not.toHaveBeenCalled();
    expect(useThreadUi.getState().openId).toBeNull();
    expect(useNavDrawer.getState().open).toBe(true);
  });
});
