// LiveKitTransport against a fake livekit-client: mute before publish, device switches keep the mute, label → id with
// default fallback, and the devicechange listener is removed on dispose.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type VoiceSettings } from "./reducer";
import type { TransportCallbacks, TransportOptions } from "./transport";

const lk = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;

  class FakeLocalAudioTrack {
    isMuted = false;
    stopped = false;
    processor: unknown = null;
    restarts: unknown[] = [];
    constructor(readonly deviceId: string) {}
    async mute() {
      this.isMuted = true;
    }
    async unmute() {
      this.isMuted = false;
    }
    async setProcessor(p: unknown) {
      this.processor = p;
    }
    async restartTrack(opts: unknown) {
      this.restarts.push(opts);
      state.order.push("restart");
      // Like a real restart: the new capture track comes back enabled.
      this.isMuted = false;
    }
    stop() {
      this.stopped = true;
    }
  }

  class FakePublication {
    constructor(readonly audioTrack: FakeLocalAudioTrack) {}
    get track() {
      return this.audioTrack;
    }
    get isMuted() {
      return this.audioTrack.isMuted;
    }
    mute() {
      return this.audioTrack.mute();
    }
    unmute() {
      return this.audioTrack.unmute();
    }
  }

  const state = {
    rooms: [] as FakeRoom[],
    devices: { audioinput: [] as { deviceId: string; label: string; kind: string }[], audiooutput: [] as { deviceId: string; label: string; kind: string }[] },
    /** Device ids getUserMedia refuses (OverconstrainedError). */
    broken: new Set<string>(),
    /** Every publishTrack with the track's mute state at that moment. */
    published: [] as { deviceId: string; muted: boolean }[],
    /** The options of every publishTrack, same order. */
    publishOptions: [] as unknown[],
    switches: [] as { kind: string; deviceId: string; mutedAfter: boolean | null }[],
    /** Gate and capture calls in order: the gate's muted-speech clone must be released before the mic is re-captured. */
    order: [] as string[],
    /** Remote participants already in the room when a new Room connects. */
    remotes: [] as { identity: string }[],
  };

  class FakeLocalParticipant {
    identity = "100";
    publication: FakePublication | null = null;
    constructor(readonly room: FakeRoom) {}
    getTrackPublication() {
      return this.publication ?? undefined;
    }
    async createTracks(opts: { audio: { deviceId?: string } }) {
      const id = opts.audio.deviceId ?? "default";
      if (state.broken.has(id)) throw Object.assign(new Error("over"), { name: "OverconstrainedError" });
      return [new FakeLocalAudioTrack(id)];
    }
    async publishTrack(track: FakeLocalAudioTrack, opts?: unknown) {
      state.published.push({ deviceId: track.deviceId, muted: track.isMuted });
      state.publishOptions.push(opts);
      this.publication = new FakePublication(track);
      return this.publication;
    }
  }

  class FakeRoom {
    static async getLocalDevices(kind: "audioinput" | "audiooutput") {
      return state.devices[kind];
    }
    listeners = new Map<string, Listener[]>();
    remoteParticipants = new Map();
    localParticipant = new FakeLocalParticipant(this);
    engine = undefined;
    connected = false;
    connectGate: Promise<void> = Promise.resolve();
    constructor(readonly options: unknown) {
      state.rooms.push(this);
      for (const participant of state.remotes) this.remoteParticipants.set(participant.identity, participant);
    }
    on(event: string, fn: Listener) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
      return this;
    }
    removeAllListeners() {
      this.listeners.clear();
    }
    async connect() {
      await this.connectGate;
      this.connected = true;
    }
    async disconnect() {
      this.connected = false;
    }
    async startAudio() {}
    async switchActiveDevice(kind: string, deviceId: string) {
      if (state.broken.has(deviceId)) return false;
      const track = this.localParticipant.publication?.audioTrack;
      // LiveKit restarts the capture track on a switch: it comes back unmuted.
      if (kind === "audioinput" && track) track.isMuted = false;
      state.order.push(`switch:${kind}`);
      state.switches.push({ kind, deviceId, mutedAfter: track ? track.isMuted : null });
      return true;
    }
  }

  return { state, FakeRoom, FakeLocalAudioTrack };
});

vi.mock("livekit-client", () => ({
  Room: lk.FakeRoom,
  RoomEvent: new Proxy({}, { get: (_t, key) => String(key) }),
  ConnectionQuality: { Excellent: "excellent", Good: "good", Poor: "poor", Lost: "lost" },
  DisconnectReason: { DUPLICATE_IDENTITY: 2, PARTICIPANT_REMOVED: 4 },
  RemoteAudioTrack: class {},
  Track: { Kind: { Audio: "audio", Video: "video" }, Source: { Microphone: "microphone", Camera: "camera", ScreenShare: "screen_share", ScreenShareAudio: "screen_share_audio" } },
  supportsAudioOutputSelection: () => true,
}));
vi.mock("./gate", () => ({
  GateProcessor: class {
    muted: boolean;
    constructor(_settings: unknown, muted: boolean) {
      this.muted = muted;
    }
    setMuted(m: boolean) {
      this.muted = m;
    }
    pauseTap() {
      lk.state.order.push("pauseTap");
    }
    setKey() {}
    configure() {}
    async destroy() {}
  },
}));

const { LiveKitTransport } = await import("./livekitTransport");
type RoomEmit = { listeners: Map<string, ((...args: unknown[]) => void)[]> };
const emit = (room: unknown, event: string, ...args: unknown[]) => void ((room as RoomEmit).listeners.get(event) ?? []).forEach(fn => fn(...args));

const callbacks = (): TransportCallbacks & { closedCalls: unknown[]; micFailures: unknown[] } => {
  const closedCalls: unknown[] = [];
  const micFailures: unknown[] = [];
  return {
    closedCalls,
    micFailures,
    status: () => undefined,
    speaking: () => undefined,
    selfSpeaking: () => undefined,
    quality: () => undefined,
    closed: info => void closedCalls.push(info),
    devices: () => undefined,
    micFailed: reason => void micFailures.push(reason),
  };
};

const options = (selfMute: boolean, settings: Partial<VoiceSettings> = {}): TransportOptions => ({
  selfMute,
  selfDeaf: false,
  settings: { ...DEFAULT_SETTINGS, ...settings },
  volumeOf: () => 1,
  participants: () => [],
});

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

let mediaDevices: EventTarget & { added: number; removed: number };

beforeEach(() => {
  lk.state.rooms.length = 0;
  lk.state.remotes.length = 0;
  lk.state.published.length = 0;
  lk.state.publishOptions.length = 0;
  lk.state.switches.length = 0;
  lk.state.broken.clear();
  lk.state.devices.audioinput = [
    { deviceId: "default", label: "Default", kind: "audioinput" },
    { deviceId: "id-usb", label: "USB Mic", kind: "audioinput" },
    { deviceId: "id-builtin", label: "Built-in Mic", kind: "audioinput" },
  ];
  lk.state.devices.audiooutput = [{ deviceId: "default", label: "Default", kind: "audiooutput" }];
  const target = new EventTarget();
  mediaDevices = Object.assign(target, { added: 0, removed: 0 });
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  mediaDevices.addEventListener = (...args: Parameters<EventTarget["addEventListener"]>) => {
    if (args[0] === "devicechange") mediaDevices.added += 1;
    add(...args);
  };
  mediaDevices.removeEventListener = (...args: Parameters<EventTarget["removeEventListener"]>) => {
    if (args[0] === "devicechange") mediaDevices.removed += 1;
    remove(...args);
  };
  vi.stubGlobal("navigator", { mediaDevices });
  const el = () => ({ hidden: false, dataset: {} as Record<string, string>, remove() {}, append() {} });
  vi.stubGlobal("document", { createElement: el, body: { append() {} } });
});

afterEach(() => vi.unstubAllGlobals());

describe("LiveKitTransport: never live on join", () => {
  it("publishes nothing while self-muted; the first unmute publishes an open mic", async () => {
    const t = new LiveKitTransport(callbacks());
    await t.connect("wss://sfu", "tok", options(true));
    await settle();
    expect(lk.state.published).toEqual([]);
    t.setSelfMute(false);
    await settle();
    expect(lk.state.published).toEqual([{ deviceId: "default", muted: false }]);
    await t.dispose();
  });

  it("a mute that lands while the microphone is being captured is applied before publishTrack", async () => {
    const t = new LiveKitTransport(callbacks());
    await t.connect("wss://sfu", "tok", options(true));
    t.setSelfMute(false); // starts the capture
    t.setSelfMute(true); // muted again before it is published
    await settle();
    expect(lk.state.published).toEqual([{ deviceId: "default", muted: true }]);
    await t.dispose();
  });

  it("an input device switch while muted keeps the published mic muted", async () => {
    const t = new LiveKitTransport(callbacks());
    await t.connect("wss://sfu", "tok", options(false));
    await settle();
    t.setSelfMute(true);
    await settle();
    const from = lk.state.order.length;
    t.applySettings({ ...DEFAULT_SETTINGS, inputDeviceId: "id-usb" });
    await settle();
    expect(lk.state.switches.at(-1)).toMatchObject({ kind: "audioinput", deviceId: "id-usb" });
    expect(lk.state.order.slice(from)).toEqual(["pauseTap", "switch:audioinput"]); // the clone is released before the re-capture
    const pub = lk.state.rooms[0]!.localParticipant.publication!;
    expect(pub.isMuted).toBe(true);
    // A processing-constraint change restarts the track: still muted afterwards.
    t.applySettings({ ...DEFAULT_SETTINGS, inputDeviceId: "id-usb", noiseSuppression: false });
    await settle();
    expect(lk.state.order.slice(from + 2)).toEqual(["pauseTap", "restart"]);
    expect(pub.audioTrack.restarts).toHaveLength(1);
    expect(pub.isMuted).toBe(true);
    await t.dispose();
  });
});

describe("LiveKitTransport: channel bitrate", () => {
  it("publishes the microphone with the voice channel's bitrate as its max; a DM call keeps the default preset", async () => {
    const t = new LiveKitTransport(callbacks());
    await t.connect("wss://sfu", "tok", { ...options(false), audioBitrate: 96_000 });
    await settle();
    expect(lk.state.publishOptions.at(-1)).toEqual({ source: "microphone", audioPreset: { maxBitrate: 96_000 } });
    await t.connect("wss://sfu", "tok2", options(false));
    await settle();
    expect(lk.state.publishOptions.at(-1)).toEqual({ source: "microphone" });
    await t.dispose();
  });
});

describe("LiveKitTransport: device choice", () => {
  it("maps an old label pref to the device id when publishing", async () => {
    const t = new LiveKitTransport(callbacks());
    await t.connect("wss://sfu", "tok", options(false, { inputDeviceId: "USB Mic" }));
    await settle();
    expect(lk.state.published).toEqual([{ deviceId: "id-usb", muted: false }]);
    await t.dispose();
  });

  it("falls back to the default device when the stored one is gone or fails", async () => {
    const cb = callbacks();
    const t = new LiveKitTransport(cb);
    lk.state.broken.add("id-usb");
    await t.connect("wss://sfu", "tok", options(false, { inputDeviceId: "id-usb" }));
    await settle();
    expect(lk.state.published).toEqual([{ deviceId: "default", muted: false }]);
    expect(cb.micFailures).toEqual([]);
    await t.connect("wss://sfu", "tok2", options(false, { inputDeviceId: "Unplugged Mic" }));
    await settle();
    expect(lk.state.published.at(-1)).toEqual({ deviceId: "default", muted: false });
    // A switch to a failing device ends on the default one.
    t.applySettings({ ...DEFAULT_SETTINGS, inputDeviceId: "id-usb" });
    await settle();
    expect(lk.state.switches.at(-1)).toMatchObject({ kind: "audioinput", deviceId: "default" });
    await t.dispose();
  });
});

describe("LiveKitTransport: remote screen shares", () => {
  const screen = (muted = false) => ({ source: "screen_share", kind: "video", isMuted: muted, isSubscribed: false, setSubscribed() {} });
  const remote = (identity: string, pubs: ReturnType<typeof screen>[] = []) => ({ identity, trackPublications: new Map(pubs.map((pub, i) => [String(i), pub])) });

  it("reports a screen share from the room's own publications, whether or not the webhook ever arrives", async () => {
    const reports: [string, boolean][] = [];
    const t = new LiveKitTransport({ ...callbacks(), screenLive: (id, live) => void reports.push([id, live]) });
    const alice = remote("200", [screen()]);
    const bob = remote("300");
    lk.state.remotes.push(alice, bob);
    await t.connect("wss://x", "token", options(true));
    const room = lk.state.rooms.at(-1)!;
    expect(reports).toEqual([["200", true], ["300", false]]);

    // Bob starts sharing.
    bob.trackPublications.set("0", screen());
    emit(room, "TrackPublished", bob.trackPublications.get("0"), bob);
    // The server's guild cap mutes Alice's share: not live any more; unmuted: live again.
    const aliceShare = alice.trackPublications.get("0")!;
    aliceShare.isMuted = true;
    emit(room, "TrackMuted", aliceShare, alice);
    aliceShare.isMuted = false;
    emit(room, "TrackUnmuted", aliceShare, alice);
    // Bob stops, Alice leaves.
    bob.trackPublications.clear();
    emit(room, "TrackUnpublished", {}, bob);
    emit(room, "ParticipantDisconnected", alice);
    expect(reports.slice(2)).toEqual([["300", true], ["200", false], ["200", true], ["300", false], ["200", false]]);
  });

  it("a reconnect clears every video handle of the old room (no black tiles from dead tracks)", async () => {
    const videos: [string, string, boolean][] = [];
    const t = new LiveKitTransport({ ...callbacks(), video: (id, source, handle) => void videos.push([id, source, !!handle]) });
    lk.state.remotes.push(remote("200", [screen()]));
    await t.connect("wss://x", "t1", options(true));
    videos.length = 0;
    await t.connect("wss://x", "t2", options(true));
    expect(videos).toEqual([["200", "camera", false], ["200", "screen", false]]);
  });

  it("ignores events for participants that are not in the room (the local participant)", async () => {
    const reports: [string, boolean][] = [];
    const t = new LiveKitTransport({ ...callbacks(), screenLive: (id, live) => void reports.push([id, live]) });
    await t.connect("wss://x", "token", options(true));
    emit(lk.state.rooms.at(-1), "TrackMuted", {}, { identity: "100", trackPublications: new Map() });
    expect(reports).toEqual([]);
  });
});

describe("LiveKitTransport: dispose", () => {
  it("removes its devicechange listener", async () => {
    const t = new LiveKitTransport(callbacks());
    expect(mediaDevices.added).toBe(1);
    await t.dispose();
    expect(mediaDevices.removed).toBe(1);
  });
});
