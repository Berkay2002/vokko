import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const token = vi.hoisted(() => vi.fn(async () => ({ url: "mock://stremio", token: "t" })));
const listener = vi.hoisted(() => vi.fn(async () => ({ url: "mock://spotify", token: "t" })));
vi.mock("./api", () => ({ viewerToken: token }));
vi.mock("../spotify/api", () => ({ listenerToken: listener }));

const { IDLE_SLOT, botOutput, botVolumeKey, syncViewer, useViewerStore } = await import("./viewerStore");

const slot = () => useViewerStore.getState().slot;
const target = { channelId: "c1", bot: "bot:stremio:c1", kind: "stremio" as const };

beforeEach(() => {
  vi.useFakeTimers();
  token.mockClear();
  listener.mockClear();
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

  it("asks Spotify's listener-token route for a Spotify session, through the same single Room", async () => {
    syncViewer({ channelId: "c1", bot: "bot:spotify:c1", kind: "spotify" });
    await vi.advanceTimersByTimeAsync(200);
    expect(slot().room).toBe("connected");
    expect(listener).toHaveBeenCalledWith("c1");
    expect(token).not.toHaveBeenCalled();
    // The movie replaces the music in the same channel: the Spotify Room closes and the Stremio one opens.
    syncViewer(target);
    await vi.advanceTimersByTimeAsync(200);
    expect(token).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("a bot's User Volume", () => {
  const model = (volumes: Record<string, number>, localMutes: Record<string, true> = {}, selfDeaf = false) => ({ volumes, localMutes, selfDeaf });

  it("scales the tile slider by the bot's own 0-200 % level, kept per kind", () => {
    expect(botVolumeKey("spotify")).toBe("bot:spotify");
    expect(botOutput(model({}), "spotify", 60)).toBeCloseTo(0.6);
    expect(botOutput(model({ "bot:spotify": 200 }), "spotify", 60)).toBeCloseTo(1.2);
    expect(botOutput(model({ "bot:spotify": 50 }), "stremio", 80)).toBeCloseTo(0.8);
    expect(botOutput(model({ "bot:stremio": 0 }), "stremio", 80)).toBe(0);
  });

  it("is silent while the bot is locally muted or we are deafened", () => {
    expect(botOutput(model({ "bot:spotify": 150 }, { "bot:spotify": true }), "spotify", 60)).toBe(0);
    expect(botOutput(model({ "bot:spotify": 150 }, {}, true), "spotify", 60)).toBe(0);
  });
});

function videoStub(): HTMLVideoElement {
  return { dataset: {}, style: {} } as unknown as HTMLVideoElement;
}
