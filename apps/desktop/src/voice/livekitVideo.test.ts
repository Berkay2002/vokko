// LiveKitVideo: the TrackInfo layer mapping, and WebView2's sharing bar being hidden before the screen picker opens rather
// than after the publish (a late call left the bar on screen for the length of the publish).

import { describe, expect, it, vi } from "vitest";
import type { Room } from "livekit-client";
import type { TransportCallbacks } from "./transport";
import { DEFAULT_SCREEN_SHARE } from "./video/options";

const calls = vi.hoisted(() => [] as string[]);

vi.mock("../desktop/window", () => ({ hideShareBar: async () => void calls.push("hideShareBar") }));

const { LiveKitVideo, layersOf } = await import("./livekitVideo");

describe("layersOf", () => {
  it("maps the TrackInfo layers and drops OFF / empty ones", () => {
    const trackInfo = {
      layers: [
        { quality: 0, width: 640, height: 360 },
        { quality: 1, width: 1280, height: 720 },
        { quality: 2, width: 1920, height: 1080 },
        { quality: 3, width: 1920, height: 1080 },
        { quality: 2, width: 0, height: 0 },
      ],
    };
    expect(layersOf({ trackInfo } as unknown as Parameters<typeof layersOf>[0])).toEqual([
      { width: 640, height: 360, quality: "low" },
      { width: 1280, height: 720, quality: "medium" },
      { width: 1920, height: 1080, quality: "high" },
    ]);
    expect(layersOf({ trackInfo: undefined })).toEqual([]);
  });
});

describe("LiveKitVideo screen share", () => {
  it("arms the share-bar hider before the picker opens", async () => {
    const room = {
      localParticipant: {
        setScreenShareEnabled: async () => {
          calls.push("picker");
          return null;
        },
      },
    } as unknown as Room;
    const video = new LiveKitVideo({} as TransportCallbacks, () => room, () => true, () => "100");
    await video.setScreenShare(true, DEFAULT_SCREEN_SHARE);
    expect(calls).toEqual(["hideShareBar", "picker"]);
  });
});
