// LiveKitVideo across a reconnect into the same call: our camera and screen share leave the old room unstopped and are
// published again in the new one; a capture that ended meanwhile is reopened (camera, same device and background) or turned off.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TransportCallbacks } from "./transport";
import type { CameraSession } from "./video/cameraSession";

const opened = vi.hoisted(() => ({ calls: [] as { deviceId?: string; resolution: string }[], next: null as unknown }));

vi.mock("livekit-client", () => ({
  Track: { Kind: { Audio: "audio", Video: "video" }, Source: { Microphone: "microphone", Camera: "camera", ScreenShare: "screen_share", ScreenShareAudio: "screen_share_audio" } },
  TrackEvent: { Ended: "ended" },
  VideoPreset: class {
    constructor(readonly options: unknown) {}
  },
  VideoQuality: { HIGH: 2 },
}));
vi.mock("../desktop/window", () => ({ hideShareBar: async () => undefined }));
vi.mock("./video/cameraSession", () => ({
  openCamera: async (options: { deviceId?: string; resolution: string }) => {
    opened.calls.push(options);
    return opened.next;
  },
}));

class FakeTrack {
  mediaStreamTrack = { readyState: "live" };
  constructor(readonly label: string) {}
  once() {}
  attach() {}
  detach() {}
  stop() {
    this.mediaStreamTrack.readyState = "ended";
  }
}

function fakeSession(label: string, background: unknown = { kind: "none" }) {
  const track = new FakeTrack(label);
  const session = {
    track,
    deviceId: `${label}-device`,
    stopped: false,
    backgrounds: [] as unknown[],
    attach() {},
    detach() {},
    async setBackground(choice: unknown) {
      session.backgrounds.push(choice);
    },
    background: () => background,
    async stop() {
      session.stopped = true;
      track.stop();
    },
  };
  return session;
}

class FakeRoom {
  published: { label: string; source: string }[] = [];
  unpublished: { label: string; stop: boolean | undefined }[] = [];
  private publications = new Map<string, { track: FakeTrack }>();
  screen = new FakeTrack("screen");
  screenAudio = new FakeTrack("screen-audio");
  localParticipant = {
    identity: "100",
    publishTrack: async (track: FakeTrack, options: { source: string }) => {
      this.published.push({ label: track.label, source: options.source });
      const pub = { track };
      this.publications.set(options.source, pub);
      return pub;
    },
    unpublishTrack: async (track: FakeTrack, stop?: boolean) => {
      this.unpublished.push({ label: track.label, stop });
      if (stop !== false) track.stop();
    },
    setScreenShareEnabled: async (enabled: boolean) => {
      if (!enabled) return undefined;
      this.publications.set("screen_share_audio", { track: this.screenAudio });
      const pub = { track: this.screen };
      this.publications.set("screen_share", pub);
      return pub;
    },
    getTrackPublication: (source: string) => this.publications.get(source),
  };
  remoteParticipants = new Map();
}

type Video = import("./livekitVideo").LiveKitVideo;

let room: FakeRoom | null;
let video: Video;
const events: string[] = [];

beforeEach(async () => {
  events.length = 0;
  opened.calls.length = 0;
  room = new FakeRoom();
  const cb = {
    video: (userId: string, source: string, handle: unknown) => userId === "100" && events.push(`${source}:${handle ? "on" : "off"}`),
    localVideoEnded: (source: string) => events.push(`${source}:ended`),
    videoFailed: (source: string, reason: string) => events.push(`${source}:failed:${reason}`),
  } as unknown as TransportCallbacks;
  const { LiveKitVideo } = await import("./livekitVideo");
  video = new LiveKitVideo(cb, () => room as never, () => room !== null, () => "100");
});

const choice = { resolution: "1080p", fps: 30, audio: true, content: "detail" } as const;

async function publishBoth(session = fakeSession("camera")) {
  await video.setCamera(true, { resolution: "720p", session: session as unknown as CameraSession });
  await video.setScreenShare(true, choice);
  events.length = 0;
  return session;
}

describe("LiveKitVideo: reconnect into the same call", () => {
  it("carries a live camera and screen share into the next room without stopping them, and publishes them there", async () => {
    const session = await publishBoth();
    const old = room!;
    await video.reset(true);
    expect(old.unpublished).toEqual([
      { label: "camera", stop: false },
      { label: "screen", stop: false },
      { label: "screen-audio", stop: false },
    ]);
    expect(session.stopped).toBe(false);
    expect(events).toEqual([]); // the buttons stay on
    room = new FakeRoom();
    await video.resume();
    expect(room.published).toEqual([
      { label: "camera", source: "camera" },
      { label: "screen", source: "screen_share" },
      { label: "screen-audio", source: "screen_share_audio" },
    ]);
    expect(events).toEqual(["camera:on", "screen:on"]);
    expect(opened.calls).toEqual([]);
  });

  it("a lost room's ended captures: the camera reopens on the same device with its background, the screen share turns off", async () => {
    const blur = { kind: "blur", strength: "light" };
    const session = await publishBoth(fakeSession("camera", blur));
    const old = room!;
    // LiveKit stopped every local track when it lost the room.
    session.track.stop();
    old.screen.stop();
    old.screenAudio.stop();
    await video.reset(true);
    expect(old.unpublished).toEqual([]);
    room = new FakeRoom();
    const reopened = fakeSession("camera-2");
    opened.next = reopened;
    await video.resume();
    expect(opened.calls).toEqual([{ deviceId: "camera-device", resolution: "720p" }]);
    expect(reopened.backgrounds).toEqual([blur]);
    expect(room.published).toEqual([{ label: "camera-2", source: "camera" }]);
    expect(events).toEqual(["camera:on", "screen:off", "screen:ended"]);
  });

  it("a background that cannot be applied again keeps the camera off", async () => {
    const session = await publishBoth(fakeSession("camera", { kind: "blur", strength: "light" }));
    session.track.stop();
    await video.reset(true);
    room = new FakeRoom();
    const reopened = fakeSession("camera-2");
    reopened.setBackground = async () => {
      throw new Error("no segmenter");
    };
    opened.next = reopened;
    await video.resume();
    expect(reopened.stopped).toBe(true);
    expect(room.published.filter(p => p.source === "camera")).toEqual([]);
    expect(events).toContain("camera:failed:failed");
  });

  it("leaving instead (or a connect into another call) stops what was carried", async () => {
    const session = await publishBoth();
    const old = room!;
    await video.reset(true);
    room = null;
    await video.reset(false);
    expect(session.stopped).toBe(true);
    expect(old.screen.mediaStreamTrack.readyState).toBe("ended");
    expect(old.screenAudio.mediaStreamTrack.readyState).toBe("ended");
    expect(events).toEqual(["camera:off", "camera:ended", "screen:off", "screen:ended"]);
  });

  it("turning the camera off between rooms drops it for good", async () => {
    const session = await publishBoth();
    await video.reset(true);
    await video.setCamera(false);
    expect(session.stopped).toBe(true);
    room = new FakeRoom();
    await video.resume();
    expect(room.published.map(p => p.source)).toEqual(["screen_share", "screen_share_audio"]);
  });
});
