import { describe, expect, it } from "vitest";
import { formatSize, isHeavy, safeImage, shownPositionMs, statusText } from "./format";

const state = { status: "playing" as const, playing: true, position_ms: 10_000, updated_at_ms: 1_000_000, duration_ms: 60_000 };

describe("Stremio formatting", () => {
  it("only lets https pictures from the poster hosts through", () => {
    expect(safeImage("https://images.metahub.space/poster/small/tt1/img")).toBeDefined();
    expect(safeImage("https://episodes.metahub.space/tt1/1/1/w780.jpg")).toBeDefined();
    expect(safeImage("https://m.media-amazon.com/images/x.jpg")).toBeDefined();
    expect(safeImage("http://images.metahub.space/x")).toBeUndefined();
    expect(safeImage("https://evil.example/x.png")).toBeUndefined();
    expect(safeImage("https://images.metahub.space.evil.example/x")).toBeUndefined();
    expect(safeImage("not a url")).toBeUndefined();
    expect(safeImage(undefined)).toBeUndefined();
  });

  it("advances the position only while the movie plays, and stops at the end", () => {
    expect(shownPositionMs(state, 1_004_500)).toBe(14_500);
    expect(shownPositionMs({ ...state, playing: false, status: "paused" }, 1_004_500)).toBe(10_000);
    expect(shownPositionMs({ ...state, status: "buffering" }, 1_004_500)).toBe(10_000);
    expect(shownPositionMs({ ...state, status: "starting", position_ms: 0 }, 1_004_500)).toBe(0);
    expect(shownPositionMs(state, 2_000_000)).toBe(60_000);
    expect(shownPositionMs(state, 999_000)).toBe(10_000);
  });

  it("formats sizes and spots heavy sources", () => {
    expect(formatSize(22_400_000_000)).toBe("22.4 GB");
    expect(formatSize(850_000_000)).toBe("850 MB");
    expect(isHeavy({ flags: [], resolution: 2160 })).toBe(true);
    expect(isHeavy({ flags: ["REMUX"], resolution: 1080 })).toBe(true);
    expect(isHeavy({ flags: ["hdr"] })).toBe(true);
    expect(isHeavy({ flags: [], resolution: 1080 })).toBe(false);
  });

  it("says what a tile without a picture is waiting for", () => {
    expect(statusText({ status: "starting" }, "connected")).toBe("Starting…");
    expect(statusText({ status: "buffering" }, "connected")).toBe("Buffering…");
    expect(statusText({ status: "error", error: "The file is gone" }, "connected")).toBe("The file is gone");
    expect(statusText({ status: "playing" }, "connecting")).toBe("Connecting to the movie…");
    expect(statusText({ status: "playing" }, "failed")).toContain("Trying again");
    expect(statusText({ status: "paused" }, "connected")).toBe("Paused");
    expect(statusText({ status: "playing" }, "connected")).toBe("");
  });
});
