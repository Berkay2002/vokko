import { describe, expect, it, vi } from "vitest";

// A stand-in for livekit-client that keeps its one relevant quirk: RemoteAudioTrack builds its gain node in attach() and only
// copies a stored volume that is truthy, so a volume of 0 has to be set after attach to reach the sound.
const lk = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  class RemoteAudioTrack {
    kind = "audio";
    receiver = undefined;
    gain = 1;
    private stored = 0;
    private attached = false;
    setVolume(v: number) {
      this.stored = v;
      if (this.attached) this.gain = v;
    }
    attach() {
      this.attached = true;
      if (this.stored) this.gain = this.stored;
      return { hidden: false, remove() {} };
    }
    detach() {}
  }
  const room = {
    state: "connected",
    canPlaybackAudio: true,
    on(event: string, fn: (...args: unknown[]) => void) {
      handlers.set(event, fn);
      return room;
    },
    connect: async () => undefined,
    disconnect: async () => undefined,
    startAudio: async () => undefined,
  };
  return { handlers, RemoteAudioTrack, room };
});

vi.mock("livekit-client", () => ({
  ConnectionState: { Connected: "connected" },
  RemoteAudioTrack: lk.RemoteAudioTrack,
  Room: function Room() {
    return lk.room;
  },
  RoomEvent: { TrackSubscribed: "sub", TrackUnsubscribed: "unsub", DataReceived: "data", AudioPlaybackStatusChanged: "audio", Disconnected: "disc" },
  Track: { Kind: { Audio: "audio", Video: "video" }, Source: { ScreenShare: "screen", ScreenShareAudio: "screen_audio" } },
}));

vi.stubGlobal("document", { body: { append() {} } });
const { createViewer } = await import("./viewer");

const bot = { identity: "bot:spotify:c1" };
const cb = { status: () => undefined, video: () => undefined, audioBlocked: () => undefined, playoutDelay: () => undefined };

async function subscribe(volume: number) {
  const viewer = createViewer("wss://live.example", cb);
  viewer.setVolume(volume);
  await viewer.connect("wss://live.example", "t", bot.identity);
  const track = new lk.RemoteAudioTrack();
  lk.handlers.get("sub")?.(track, { source: "screen_audio" }, bot);
  return { viewer, track };
}

describe("the bot's sound in the viewer Room", () => {
  it("is silent from the first sample when the bot is locally muted before its track arrives", async () => {
    const { track } = await subscribe(0);
    expect(track.gain).toBe(0);
  });

  it("applies the level it holds to a resubscribed track, and a later change to the live one", async () => {
    const { viewer, track } = await subscribe(0.4);
    expect(track.gain).toBe(0.4);
    viewer.setVolume(0);
    expect(track.gain).toBe(0);
    const again = new lk.RemoteAudioTrack();
    lk.handlers.get("sub")?.(again, { source: "screen_audio" }, bot);
    expect(again.gain).toBe(0);
    viewer.setVolume(1.5);
    expect(again.gain).toBe(1.5);
  });
});
