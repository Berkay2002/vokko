import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TransportCallbacks, TransportOptions } from "./transport";
import { DEFAULT_SETTINGS } from "./reducer";

const calls: { name: string; args?: Record<string, unknown> }[] = [];
let failConnect = false;

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class<T> {
    onmessage: (event: T) => void = () => undefined;
  },
  invoke: async (name: string, args?: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === "native_voice_connect" && failConnect) throw new Error("refused");
    if (name === "native_voice_devices") return { input: [{ deviceId: "mic1", label: "USB mic" }], output: [] };
    return undefined;
  },
}));

const { NativeTransport } = await import("./nativeTransport");

function callbacks() {
  return {
    status: vi.fn(),
    speaking: vi.fn(),
    selfSpeaking: vi.fn(),
    quality: vi.fn(),
    closed: vi.fn(),
    devices: vi.fn(),
    micFailed: vi.fn(),
  } satisfies TransportCallbacks;
}

const options = (): TransportOptions => ({
  selfMute: true,
  selfDeaf: false,
  settings: DEFAULT_SETTINGS,
  volumeOf: id => (id === "2" ? 0 : 1),
  participants: () => ["2", "3"],
});

type Sink = { onmessage: (event: unknown) => void };
const channel = (): Sink => calls.find(c => c.name === "native_voice_connect")?.args?.events as Sink;

describe("NativeTransport", () => {
  beforeEach(() => {
    calls.length = 0;
    failConnect = false;
  });

  it("connects with the known volumes and forwards room events until the room closes", async () => {
    const cb = callbacks();
    const t = new NativeTransport(cb);
    await t.connect("wss://lk", "tok", options());
    expect(calls[0].args).toMatchObject({ url: "wss://lk", token: "tok", init: { selfMute: true, volumes: { "2": 0, "3": 1 } } });
    expect(cb.devices).toHaveBeenCalledWith([{ deviceId: "default", label: "Default" }, { deviceId: "mic1", label: "USB mic" }], [{ deviceId: "default", label: "Default" }], true);
    const events = channel();
    events.onmessage({ type: "status", status: "connected" });
    events.onmessage({ type: "speaking", userIds: ["3"] });
    events.onmessage({ type: "ping", ms: 40 });
    events.onmessage({ type: "ping", ms: 60 });
    events.onmessage({ type: "participant", userId: "2" });
    expect(cb.status).toHaveBeenCalledWith("connected");
    expect(cb.speaking).toHaveBeenCalledWith(["3"]);
    expect(cb.quality).toHaveBeenLastCalledWith("unknown", 50);
    expect(calls.at(-1)).toEqual({ name: "native_voice_set_user_volume", args: { userId: "2", volume: 0 } });
    events.onmessage({ type: "closed", final: true, reason: "kicked" });
    events.onmessage({ type: "speaking", userIds: [] });
    expect(cb.closed).toHaveBeenCalledWith({ final: true, reason: "kicked" });
    expect(cb.speaking).toHaveBeenCalledTimes(1);
  });

  it("reports remote videos and drops them when the room closes", async () => {
    vi.stubGlobal("document", { createElement: () => ({}) }); // a canvas without captureStream: warns, never paints
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cb = { ...callbacks(), video: vi.fn(), screenLive: vi.fn() };
    const t = new NativeTransport(cb);
    await t.connect("wss://lk", "tok", options());
    const events = channel();
    events.onmessage({ type: "video", userId: "3", source: "screen", key: "TR_1" });
    events.onmessage({ type: "screenLive", userId: "3", live: true });
    expect(cb.video).toHaveBeenLastCalledWith("3", "screen", expect.objectContaining({ attach: expect.any(Function) }));
    expect(cb.screenLive).toHaveBeenCalledWith("3", true);
    t.watchStream("3", true);
    t.setViewerQuality("3", "screen", "720p");
    expect(calls.slice(-2)).toEqual([
      { name: "native_voice_watch", args: { userId: "3", watch: true } },
      { name: "native_voice_video_quality", args: { userId: "3", source: "screen", quality: "720p" } },
    ]);
    events.onmessage({ type: "closed", final: false });
    expect(cb.video).toHaveBeenLastCalledWith("3", "screen", null);
  });

  it("reports a failed connect as a retryable close, and drops events after a disconnect", async () => {
    const cb = callbacks();
    const t = new NativeTransport(cb);
    failConnect = true;
    await t.connect("wss://lk", "tok", options());
    expect(cb.closed).toHaveBeenCalledWith({ final: false });
    failConnect = false;
    calls.length = 0;
    await t.connect("wss://lk", "tok", options());
    const events = channel();
    await t.disconnect();
    events.onmessage({ type: "status", status: "reconnecting" });
    expect(cb.status).not.toHaveBeenCalled();
    expect(calls.at(-1)?.name).toBe("native_voice_disconnect");
  });
});
