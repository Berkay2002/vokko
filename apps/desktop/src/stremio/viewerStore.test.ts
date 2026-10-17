import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const token = vi.hoisted(() => vi.fn(async () => ({ url: "mock://stremio", token: "t" })));
vi.mock("./api", () => ({ viewerToken: token }));

const { IDLE_SLOT, syncViewer, useViewerStore } = await import("./viewerStore");

const slot = () => useViewerStore.getState().slot;
const target = { channelId: "c1", bot: "bot:stremio:c1" };

beforeEach(() => {
  vi.useFakeTimers();
  token.mockClear();
});
afterEach(() => {
  syncViewer(null);
  vi.useRealTimers();
});

describe("the call's viewer Room", () => {
  it("connects once and keeps the same Room while tiles come and go (Focus, Back to grid)", async () => {
    syncViewer(target);
    await vi.advanceTimersByTimeAsync(200);
    expect(slot().room).toBe("connected");
    const picture = slot().video;
    expect(picture).not.toBeNull();

    // The layout switch unmounts the grid tile and mounts the focused one: each attaches the picture to its own <video>.
    const grid = videoStub();
    const focused = videoStub();
    picture?.attach(grid);
    picture?.detach(grid);
    picture?.attach(focused);
    // The host effect re-running (a re-render with the same call and session) is not a reconnect either.
    syncViewer({ ...target });
    syncViewer({ ...target });
    await vi.advanceTimersByTimeAsync(5000);

    expect(token).toHaveBeenCalledTimes(1);
    expect(slot().video).toBe(picture);
    expect(focused.dataset.fake).toBe("true");
  });

  it("closes with the session or the call and opens a fresh Room for the next one", async () => {
    syncViewer(target);
    await vi.advanceTimersByTimeAsync(200);
    syncViewer(null);
    expect(useViewerStore.getState()).toMatchObject({ channelId: null, slot: IDLE_SLOT });
    syncViewer(target);
    await vi.advanceTimersByTimeAsync(200);
    expect(token).toHaveBeenCalledTimes(2);
    expect(slot().room).toBe("connected");
  });
});

function videoStub(): HTMLVideoElement {
  return { dataset: {}, style: {} } as unknown as HTMLVideoElement;
}
