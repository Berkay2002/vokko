// Engine ↔ gateway ↔ transport: the reconnect loop, own-session adoption, mute-before-publish and the channel status call.
// The gateway, REST and sounds are faked; transports come from setTransportFactory.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayEvents, VoiceState, VoiceStateUpdateCommand } from "../api/types";
import type { TransportCallbacks, TransportOptions, VoiceTransport } from "./transport";

const gw = vi.hoisted(() => ({
  handlers: new Map<string, ((d: unknown) => void)[]>(),
  sent: [] as VoiceStateUpdateCommand[],
  requests: [] as { method: string; path: string; body: unknown }[],
}));

vi.mock("../api/gateway", () => ({
  gateway: {
    on: (t: string, fn: (d: unknown) => void) => {
      gw.handlers.set(t, [...(gw.handlers.get(t) ?? []), fn]);
      return () => undefined;
    },
    onStatus: () => () => undefined,
    sendVoiceStateUpdate: (command: VoiceStateUpdateCommand) => void gw.sent.push(command),
  },
}));
vi.mock("../api/rest", () => ({
  request: async (method: string, path: string, body: unknown) => {
    gw.requests.push({ method, path, body });
  },
}));
vi.mock("../api/store", () => ({ appStore: { getState: () => ({ guilds: {}, members: {}, me: null }) } }));
vi.mock("../notify/sounds", () => ({ playSound: () => undefined }));
vi.mock("../desktop", () => ({
  isDesktop: () => false,
  registerShortcut: async () => undefined,
  unregisterShortcut: async () => undefined,
  onShortcut: async () => () => undefined,
}));

type Engine = typeof import("./engine");
type Store = typeof import("./store");

const ME = "100";
const GUILD = "10";
const GENERAL = "20";

function emit<K extends keyof GatewayEvents>(t: K, d: GatewayEvents[K]): void {
  for (const fn of gw.handlers.get(t) ?? []) fn(d);
}

function ownState(sessionId: string, channelId: string | null = GENERAL): VoiceState {
  return {
    guild_id: GUILD,
    channel_id: channelId,
    user_id: ME,
    session_id: sessionId,
    deaf: false,
    mute: false,
    self_deaf: false,
    self_mute: false,
    self_video: false,
    self_stream: false,
    suppress: false,
    request_to_speak_timestamp: null,
    connected_at: "2026-10-11T10:00:00.000Z",
  };
}

const serverUpdate = (token: string, sessionId: string, endpoint = "wss://sfu.example") =>
  emit("VOICE_SERVER_UPDATE", { guild_id: GUILD, channel_id: GENERAL, endpoint, token, session_id: sessionId });

/** A transport whose connect only finishes when the test says so (a slow ICE / DTLS handshake). */
class SlowTransport implements VoiceTransport {
  connects: { token: string; options: TransportOptions }[] = [];
  disconnects = 0;
  constructor(readonly cb: TransportCallbacks) {}
  async connect(_endpoint: string, token: string, options: TransportOptions): Promise<void> {
    this.connects.push({ token, options });
    this.cb.status("rtc_connecting");
  }
  connected(): void {
    this.cb.status("connected");
  }
  failed(): void {
    this.cb.closed({ final: false });
  }
  async disconnect(): Promise<void> {
    this.disconnects += 1;
  }
  async dispose(): Promise<void> {
    await this.disconnect();
  }
  setSelfMute(): void {}
  setSelfDeaf(): void {}
  setUserVolume(): void {}
  applySettings(): void {}
  setPttPressed(): void {}
  async refreshDevices(): Promise<void> {}
}

let engine: Engine;
let store: Store;
let slow: SlowTransport | null;

const op4s = () => gw.sent.filter(c => c.channel_id !== null);
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

async function startCall(sessionId = "s1", token = "t1"): Promise<void> {
  store.getVoice().dispatch({ type: "join", guildId: GUILD, channelId: GENERAL });
  serverUpdate(token, sessionId);
  emit("VOICE_STATE_UPDATE", ownState(sessionId));
  await flush();
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  gw.handlers.clear();
  gw.sent.length = 0;
  gw.requests.length = 0;
  slow = null;
  store = await import("./store");
  engine = await import("./engine");
  engine.setTransportFactory((_kind, cb) => (slow = new SlowTransport(cb)));
  engine.wireVoice();
  emit("READY", { v: 1, user: { id: ME }, session_id: "gw-1", guilds: [], private_channels: [], media: { voice_enabled: true } } as unknown as GatewayEvents["READY"]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("voice engine: media reconnect", () => {
  it("never re-sends op 4 while a connect is in progress, however long it takes", async () => {
    await startCall();
    expect(slow?.connects.map(c => c.token)).toEqual(["t1"]);
    // Slow first connect: 30 s in rtc_connecting, no op 4 and no teardown.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(op4s()).toHaveLength(0);
    expect(slow?.disconnects).toBe(0);
    slow!.connected();
    expect(store.getVoice().status).toBe("connected");

    // The connection drops: one op 4 after the 1 s backoff, not before.
    slow!.failed();
    await vi.advanceTimersByTimeAsync(999);
    expect(op4s()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(op4s()).toHaveLength(1);

    // Its token starts a connect that takes longer than 5 s: nothing else is sent and nothing is torn down meanwhile.
    serverUpdate("t2", "s1");
    await flush();
    expect(slow?.connects.map(c => c.token)).toEqual(["t1", "t2"]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(op4s()).toHaveLength(1);
    expect(slow?.connects).toHaveLength(2);
    expect(slow?.disconnects).toBe(0);
    slow!.connected();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(op4s()).toHaveLength(1);
    expect(store.getVoice()).toMatchObject({ status: "connected", channelId: GENERAL, sessionId: "s1" });
  });

  it("backs off 1 s → 2 s → 4 s → 5 s between failed attempts and gives up after two minutes", async () => {
    await startCall();
    slow!.connected();
    const sentAt: number[] = [];
    const start = Date.now();
    slow!.failed();
    for (let i = 0; i < 1400 && store.getVoice().channelId !== null; i += 1) {
      const before = op4s().length;
      await vi.advanceTimersByTimeAsync(100);
      if (op4s().length > before) {
        sentAt.push(Date.now() - start);
        serverUpdate(`t-${i}`, "s1");
        await flush();
        slow!.failed(); // this attempt fails right away
      }
    }
    const gaps = sentAt.map((t, i) => t - (i === 0 ? 0 : sentAt[i - 1]!));
    expect(gaps.slice(0, 5)).toEqual([1000, 2000, 4000, 5000, 5000]);
    expect(store.getVoice()).toMatchObject({ channelId: null, error: { reason: "connection_lost" } });
    expect(Date.now() - start).toBeLessThanOrEqual(2 * 60_000 + 100);
    expect(gw.sent.at(-1)).toMatchObject({ channel_id: null });
  });

  it("a new token (re-identify after a server restart) hands the watched streams and their quality back to the transport", async () => {
    await startCall();
    slow!.connected();
    const watches: [string, boolean][] = [];
    const qualities: string[] = [];
    Object.assign(slow!, {
      watchStream: (id: string, on: boolean) => void watches.push([id, on]),
      setViewerQuality: (id: string, source: string, q: string) => void qualities.push(`${id}:${source}:${q}`),
    });
    engine.watchStream("200", true);
    engine.setViewerQuality("200", "screen", "720p");
    watches.length = 0;
    qualities.length = 0;
    serverUpdate("t2", "s1");
    await flush();
    expect(slow?.connects.map(c => c.token)).toEqual(["t1", "t2"]);
    expect(watches).toEqual([["200", true]]);
    expect(qualities).toEqual(["200:screen:720p"]);
  });

  const reidentify = () =>
    emit("READY", { v: 1, user: { id: ME }, session_id: "gw-2", guilds: [], private_channels: [], media: { voice_enabled: true } } as unknown as GatewayEvents["READY"]);

  it("a gateway reconnect with the same voice session keeps the Room: the server re-binds us without a token", async () => {
    await startCall();
    slow!.connected();
    reidentify();
    expect(op4s()).toHaveLength(1);
    // The server's answer: our state, same voice session, no VOICE_SERVER_UPDATE.
    emit("VOICE_STATE_UPDATE", ownState("s1"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(slow?.connects).toHaveLength(1);
    expect(slow?.disconnects).toBe(0);
    expect(op4s()).toHaveLength(1);
    expect(store.getVoice()).toMatchObject({ status: "connected", channelId: GENERAL, sessionId: "s1", pendingJoin: false });
  });

  it("a gateway reconnect while media is down asks for a token on the new session at once, and the reconnect resumes the call", async () => {
    await startCall();
    slow!.connected();
    slow!.failed();
    reidentify();
    // One op 4 re-binds, the next (now on the bound session) asks for a token; no wait for the backoff.
    expect(op4s()).toHaveLength(2);
    serverUpdate("t2", "s1");
    await flush();
    expect(slow?.connects.map(c => [c.token, c.options.resume])).toEqual([
      ["t1", false],
      ["t2", true],
    ]);
  });

  it("an unanswered op 4 is re-sent only after the token wait", async () => {
    await startCall();
    slow!.connected();
    slow!.failed();
    await vi.advanceTimersByTimeAsync(1000);
    expect(op4s()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(engine.TOKEN_WAIT_MS - 1);
    expect(op4s()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(op4s()).toHaveLength(2);
  });

  it("final closes (moved / kicked) leave without any op 4", async () => {
    await startCall();
    slow!.connected();
    slow!.cb.closed({ final: true, reason: "moved" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(gw.sent).toHaveLength(0);
    expect(store.getVoice()).toMatchObject({ channelId: null, error: { reason: "moved" } });
  });

  it("while retrying, another device's session for us = moved: disconnect and stop retrying", async () => {
    await startCall();
    slow!.connected();
    slow!.failed();
    await vi.advanceTimersByTimeAsync(1000);
    expect(op4s()).toHaveLength(1);
    // Device B took over before our op 4 was answered.
    emit("VOICE_STATE_UPDATE", ownState("device-b"));
    await flush();
    expect(store.getVoice()).toMatchObject({ channelId: null, sessionId: null, error: { reason: "moved" } });
    expect(slow?.disconnects).toBe(1);
    // A late answer to our op 4 does not reconnect, and no further op 4 goes out.
    serverUpdate("t-late", "s-a-2");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(op4s()).toHaveLength(1);
    expect(slow?.connects).toHaveLength(1);
  });
});

describe("voice engine: never live on join", () => {
  it("a self-mute set before joining applies before anything is published, and survives a device switch", async () => {
    const { FakeTransport } = await import("./fakeTransport");
    let fake: InstanceType<typeof FakeTransport> | null = null;
    engine.setTransportFactory((_kind, cb) => (fake = new FakeTransport(cb)));
    engine.setSelfMute(true);
    await startCall("s1", "mock-token");
    await vi.advanceTimersByTimeAsync(500);
    const t = fake as unknown as InstanceType<typeof FakeTransport>;
    expect(store.getVoice().status).toBe("connected");
    expect(t.mic).toBeNull(); // muted: nothing published
    expect(t.micLog).toEqual([]);

    engine.setSelfMute(false);
    expect(t.micLog).toEqual([{ event: "publish", deviceId: "default", muted: false }]);
    engine.setSelfMute(true);
    store.getVoice().dispatch({ type: "settings", settings: { inputDeviceId: "fake-mic" } });
    expect(t.micLog.at(-1)).toEqual({ event: "switch", deviceId: "fake-mic", muted: true });
    expect(t.mic).toEqual({ deviceId: "fake-mic", muted: true });
  });

  it("a device picked in the user panel menus: the input pick switches the transport's mic, the output pick reaches the voice settings", async () => {
    const { FakeTransport } = await import("./fakeTransport");
    const { setPref } = await import("../ui");
    let fake: InstanceType<typeof FakeTransport> | null = null;
    engine.setTransportFactory((_kind, cb) => (fake = new FakeTransport(cb)));
    await startCall("s1", "mock-token");
    await vi.advanceTimersByTimeAsync(500);
    engine.setSelfMute(false);
    try {
      setPref("inputDevice", "fake-mic");
      expect(store.getVoice().settings).toMatchObject({ inputDeviceId: "fake-mic" });
      expect((fake as unknown as InstanceType<typeof FakeTransport>).micLog.at(-1)).toEqual({ event: "switch", deviceId: "fake-mic", muted: false });
      setPref("outputDevice", "speakers");
      expect(store.getVoice().settings).toMatchObject({ outputDeviceId: "speakers" });
    } finally {
      setPref("inputDevice", "default");
      setPref("outputDevice", "default");
    }
  });

  it("passes the persisted mute to the transport at connect time", async () => {
    vi.resetModules();
    const saved = new Map<string, string>([["vokko.voice", JSON.stringify({ selfMute: true, selfDeaf: true })]]);
    vi.stubGlobal("localStorage", { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v) });
    try {
      gw.handlers.clear();
      store = await import("./store");
      engine = await import("./engine");
      engine.setTransportFactory((_kind, cb) => (slow = new SlowTransport(cb)));
      engine.wireVoice();
      expect(store.getVoice()).toMatchObject({ selfMute: true, selfDeaf: true });
      await startCall();
      expect(slow?.connects[0]?.options).toMatchObject({ selfMute: true, selfDeaf: true });
      engine.setSelfDeaf(false);
      expect(JSON.parse(saved.get("vokko.voice") ?? "{}")).toMatchObject({ selfMute: false, selfDeaf: false });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("voice engine: channel status", () => {
  it("setVoiceChannelStatus PUTs the trimmed status, empty clears", async () => {
    await engine.setVoiceChannelStatus(GENERAL, "  Raid night ");
    await engine.setVoiceChannelStatus(GENERAL, "   ");
    await engine.setVoiceChannelStatus(GENERAL, null);
    expect(gw.requests).toEqual([
      { method: "PUT", path: `/channels/${GENERAL}/voice-status`, body: { status: "Raid night" } },
      { method: "PUT", path: `/channels/${GENERAL}/voice-status`, body: { status: null } },
      { method: "PUT", path: `/channels/${GENERAL}/voice-status`, body: { status: null } },
    ]);
  });

  it("VOICE_CHANNEL_STATUS_UPDATE and CHANNEL_UPDATE reach the store", () => {
    emit("VOICE_CHANNEL_STATUS_UPDATE", { id: GENERAL, guild_id: GUILD, status: "Chill" });
    expect(store.getVoice().channelStatus).toEqual({ [GENERAL]: "Chill" });
    emit("CHANNEL_UPDATE", { id: GENERAL, type: 2, guild_id: GUILD, name: "General", status: null } as GatewayEvents["CHANNEL_UPDATE"]);
    expect(store.getVoice().channelStatus).toEqual({});
  });
});

describe("voice engine: camera and screen share together", () => {
  const choice = { resolution: "720p", fps: 30, audio: false } as const;

  async function connectFake() {
    const { FakeTransport } = await import("./fakeTransport");
    let fake: InstanceType<typeof FakeTransport> | null = null;
    engine.setTransportFactory((_kind, cb) => (fake = new FakeTransport(cb)));
    store.getVoice().dispatch({ type: "join", guildId: GUILD, channelId: GENERAL });
    serverUpdate("mock-token", "s1", "mock://sfu");
    emit("VOICE_STATE_UPDATE", ownState("s1"));
    await vi.advanceTimersByTimeAsync(500);
    expect(store.getVoice().status).toBe("connected");
    return { t: fake as unknown as InstanceType<typeof FakeTransport>, media: await import("./mediaStore") };
  }

  /** The server echoes our flags back as a voice state, which makes the transport re-sync every video. */
  const echo = (self_video: boolean, self_stream: boolean) => emit("VOICE_STATE_UPDATE", { ...ownState("s1"), self_video, self_stream });

  it("camera first, then a screen share: both stay on, published and attached; stopping one keeps the other", async () => {
    const { t, media } = await connectFake();
    expect(await engine.startCamera()).toBe(true);
    expect(await engine.startScreenShare(choice)).toBe(true);
    echo(true, true);
    expect(media.getMedia()).toMatchObject({ cameraOn: true, screenOn: true });
    expect(t.camera).not.toBeNull();
    expect(t.screen).toEqual(choice);
    expect(Object.keys(media.getMedia().videos).sort()).toEqual([`${ME}:camera`, `${ME}:screen`]);
    expect(gw.sent.at(-1)).toMatchObject({ self_video: true, self_stream: true });

    await engine.stopScreenShare();
    expect(media.getMedia()).toMatchObject({ cameraOn: true, screenOn: false });
    expect(Object.keys(media.getMedia().videos)).toEqual([`${ME}:camera`]);
    expect(t.camera).not.toBeNull();
    expect(gw.sent.at(-1)).toMatchObject({ self_video: true, self_stream: false });
  });

  it("screen share first, then the camera: both stay on, published and attached; stopping one keeps the other", async () => {
    const { t, media } = await connectFake();
    expect(await engine.startScreenShare(choice)).toBe(true);
    expect(await engine.startCamera()).toBe(true);
    echo(true, true);
    expect(media.getMedia()).toMatchObject({ cameraOn: true, screenOn: true });
    expect(t.camera).not.toBeNull();
    expect(t.screen).toEqual(choice);
    expect(Object.keys(media.getMedia().videos).sort()).toEqual([`${ME}:camera`, `${ME}:screen`]);
    expect(gw.sent.at(-1)).toMatchObject({ self_video: true, self_stream: true });

    await engine.stopCamera();
    expect(media.getMedia()).toMatchObject({ cameraOn: false, screenOn: true });
    expect(Object.keys(media.getMedia().videos)).toEqual([`${ME}:screen`]);
    expect(t.screen).toEqual(choice);
    expect(gw.sent.at(-1)).toMatchObject({ self_video: false, self_stream: true });
  });
});
