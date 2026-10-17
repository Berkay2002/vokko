// LiveKitVideo: WebView2's sharing bar is hidden before the screen picker opens rather than after the publish (a late call
// left the bar on screen for the length of the publish).

import { describe, expect, it, vi } from "vitest";
import type { Room } from "livekit-client";
import type { TransportCallbacks } from "./transport";
import { DEFAULT_SCREEN_SHARE } from "./video/options";

const calls = vi.hoisted(() => [] as string[]);

vi.mock("../desktop/window", () => ({ hideShareBar: async () => void calls.push("hideShareBar") }));

const { LiveKitVideo } = await import("./livekitVideo");

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
