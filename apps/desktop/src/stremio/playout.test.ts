import { describe, expect, it, vi } from "vitest";

type Handler = (...args: unknown[]) => void;
const room = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }));

// A Room whose events the test fires by hand; the real classes stay for `instanceof` and the enums.
vi.mock("livekit-client", async importOriginal => {
  const actual = await importOriginal<typeof import("livekit-client")>();
  class FakeRoom {
    state = "connected";
    canPlaybackAudio = true;
    on(event: string, handler: Handler) {
      room.handlers.set(event, handler);
      return this;
    }
    async connect() {}
    async disconnect() {}
  }
  return { ...actual, Room: FakeRoom };
});

const { RemoteAudioTrack, RoomEvent, Track } = await import("livekit-client");
const { PLAYOUT_BUFFER_MS, applyPlayoutBuffer } = await import("./playout");
const { createViewer } = await import("./viewer");

describe("applyPlayoutBuffer", () => {
  it("sets the target where the receiver supports it and says how much", () => {
    const receiver = { jitterBufferTarget: null as number | null };
    expect(applyPlayoutBuffer(receiver)).toBe(PLAYOUT_BUFFER_MS);
    expect(receiver.jitterBufferTarget).toBe(PLAYOUT_BUFFER_MS);
  });

  it("does nothing without support or without a receiver", () => {
    const old = {};
    expect(applyPlayoutBuffer(old)).toBe(0);
    expect("jitterBufferTarget" in old).toBe(false);
    expect(applyPlayoutBuffer(undefined)).toBe(0);
  });

  it("gives up quietly when the browser rejects the value", () => {
    const strict = {
      set jitterBufferTarget(_: number | null) {
        throw new RangeError("out of range");
      },
    };
    expect(applyPlayoutBuffer(strict)).toBe(0);
  });
});

describe("viewer Room", () => {
  const bot = "bot:stremio:c1";
  const audio = (receiver: object) => Object.assign(Object.create(RemoteAudioTrack.prototype), { kind: Track.Kind.Audio, receiver, setVolume() {}, attach: () => ({ remove() {} }), detach() {} });
  const video = (receiver: object) => ({ kind: Track.Kind.Video, receiver, attach() {}, detach() {} });
  const subscribe = (track: unknown, source: unknown, identity = bot) => room.handlers.get(RoomEvent.TrackSubscribed)?.(track, { source }, { identity });

  async function open(buffered = true) {
    vi.stubGlobal("document", { body: { append() {} } });
    const delays: number[] = [];
    const viewer = createViewer("wss://media.example", { status() {}, video() {}, audioBlocked() {}, playoutDelay: ms => delays.push(ms) }, buffered);
    await viewer.connect("wss://media.example", "t", bot);
    return { viewer, delays };
  }

  it("buffers the movie's picture and sound alike, and again after a resubscribe", async () => {
    const { viewer, delays } = await open();
    const pic = { jitterBufferTarget: null as number | null };
    const snd = { jitterBufferTarget: null as number | null };
    subscribe(video(pic), Track.Source.ScreenShare);
    subscribe(audio(snd), Track.Source.ScreenShareAudio);
    expect([pic.jitterBufferTarget, snd.jitterBufferTarget]).toEqual([PLAYOUT_BUFFER_MS, PLAYOUT_BUFFER_MS]);
    expect(delays).toEqual([PLAYOUT_BUFFER_MS]);

    const again = { jitterBufferTarget: null as number | null };
    subscribe(video(again), Track.Source.ScreenShare);
    expect(again.jitterBufferTarget).toBe(PLAYOUT_BUFFER_MS);
    viewer.disconnect();
    expect(delays.at(-1)).toBe(0);
  });

  it("keeps a music Room at low latency", async () => {
    const { delays } = await open(false);
    const pic = { jitterBufferTarget: null as number | null };
    const snd = { jitterBufferTarget: null as number | null };
    subscribe(video(pic), Track.Source.ScreenShare);
    subscribe(audio(snd), Track.Source.ScreenShareAudio);
    expect([pic.jitterBufferTarget, snd.jitterBufferTarget, delays]).toEqual([null, null, [0]]);
  });

  it("reports no delay where the receiver cannot buffer", async () => {
    const { delays } = await open();
    subscribe(video({}), Track.Source.ScreenShare);
    expect(delays).toEqual([0]);
  });

  it("leaves everything that is not the bot's screen share alone (the call's voice Room is a different Room)", async () => {
    await open();
    const untouched = () => ({ jitterBufferTarget: null as number | null });
    const other = [untouched(), untouched(), untouched()];
    subscribe(video(other[0]), Track.Source.ScreenShare, "someone-else");
    subscribe(audio(other[1]), Track.Source.Microphone);
    subscribe(video(other[2]), Track.Source.Camera);
    expect(other.map(r => r.jitterBufferTarget)).toEqual([null, null, null]);
  });
});
