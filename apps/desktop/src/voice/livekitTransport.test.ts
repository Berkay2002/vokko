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
    switches: [] as { kind: string; deviceId: string; mutedAfter: boolean | null }[],
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
    async publishTrack(track: FakeLocalAudioTrack) {
      state.published.push({ deviceId: track.deviceId, muted: track.isMuted });
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
  Track: { Kind: { Audio: "audio" }, Source: { Microphone: "microphone" } },
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
    setKey() {}
    configure() {}
    async destroy() {}
  },
}));

const { LiveKitTransport } = await import("./livekitTransport");

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
  lk.state.published.length = 0;
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
    t.applySettings({ ...DEFAULT_SETTINGS, inputDeviceId: "id-usb" });
    await settle();
    expect(lk.state.switches.at(-1)).toMatchObject({ kind: "audioinput", deviceId: "id-usb" });
    const pub = lk.state.rooms[0]!.localParticipant.publication!;
    expect(pub.isMuted).toBe(true);
    // A processing-constraint change restarts the track: still muted afterwards.
    t.applySettings({ ...DEFAULT_SETTINGS, inputDeviceId: "id-usb", noiseSuppression: false });
    await settle();
    expect(pub.audioTrack.restarts).toHaveLength(1);
    expect(pub.isMuted).toBe(true);
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

describe("LiveKitTransport: dispose", () => {
  it("removes its devicechange listener", async () => {
    const t = new LiveKitTransport(callbacks());
    expect(mediaDevices.added).toBe(1);
    await t.dispose();
    expect(mediaDevices.removed).toBe(1);
  });
});
