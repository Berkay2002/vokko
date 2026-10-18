import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VideoHandle } from "../voice/mediaStore";
import { createViewer, FakeViewer, type ViewerStatus } from "./viewer";

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

function watch() {
  const log: { status: ViewerStatus[]; video: (VideoHandle | null)[]; blocked: boolean[] } = { status: [], video: [], blocked: [] };
  return { log, cb: { status: (s: ViewerStatus) => log.status.push(s), video: (h: VideoHandle | null) => log.video.push(h), audioBlocked: (b: boolean) => log.blocked.push(b), playoutDelay: () => undefined } };
}

describe("viewer Room", () => {
  it("picks the stand-in for a mock:// url and connects with a picture", async () => {
    const { log, cb } = watch();
    const viewer = createViewer("mock://stremio", cb);
    expect(viewer).toBeInstanceOf(FakeViewer);
    await viewer.connect("mock://stremio", "t", "bot:stremio:1");
    expect(log.status).toEqual(["connecting"]);
    vi.advanceTimersByTime(150);
    expect(log.status).toEqual(["connecting", "connected"]);
    expect(log.video.at(-1)).not.toBeNull();
  });

  it("keeps the volume it was given and drops the picture on disconnect", async () => {
    const { log, cb } = watch();
    const viewer = new FakeViewer(cb);
    viewer.setVolume(0.3);
    await viewer.connect();
    vi.advanceTimersByTime(150);
    viewer.setVolume(0);
    expect(viewer.volume).toBe(0);
    viewer.disconnect();
    expect(viewer.connected).toBe(false);
    expect(log.video.at(-1)).toBeNull();
  });

  it("does not connect when it is disconnected first", async () => {
    const { log, cb } = watch();
    const viewer = new FakeViewer(cb);
    await viewer.connect();
    viewer.disconnect();
    vi.advanceTimersByTime(500);
    expect(log.status).toEqual(["connecting"]);
  });
});
