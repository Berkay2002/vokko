import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunningProcess } from "../desktop/games";

// The real gateway client, the real store connection state and the real presence sender, over a fake WebSocket, so the
// presence sync is driven by the same READY / RESUMED / drop sequence the app sees on the wire.

const mocks = vi.hoisted(() => ({ processes: [] as RunningProcess[] }));

vi.mock("../api/config", async importOriginal => ({ ...(await importOriginal<typeof import("../api/config")>()), MOCK: false, GATEWAY_URL: "ws://gateway.test/gateway" }));
vi.mock("../desktop", () => ({ isDesktop: () => true }));
vi.mock("../desktop/games", async importOriginal => ({ ...(await importOriginal<typeof import("../desktop/games")>()), listProcesses: async () => mocks.processes }));

import { gateway } from "../api/gateway";
import { appStore } from "../api/store";
import { GatewayOp } from "../api/types";
import { startGameDetection, useActivity } from "./index";
import { setOwnActivities } from "./own";

interface Frame {
  op: number;
  d: unknown;
}

class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readyState = 1;
  sent: Frame[] = [];
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Frame);
  }
  close(): void {
    this.readyState = 3;
  }
  /** The server (or the network) ends the connection. */
  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  receive(op: number, d: unknown, t: string | null = null, s: number | null = null): void {
    this.onmessage?.({ data: JSON.stringify({ op, d, t, s }) });
  }
  presence(): Frame[] {
    return this.sent.filter(frame => frame.op === GatewayOp.PresenceUpdate);
  }
}
const sockets = () => FakeSocket.all;
const latest = () => FakeSocket.all[FakeSocket.all.length - 1] as FakeSocket;

const proc = (name: string, startedAt = 42_000): RunningProcess => ({ name, startedAt, system: false });
const game = (name: string, start = 42_000) => ({ name, type: 0, timestamps: { start } });
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms + 50);

/** Hello, then READY (a fresh session) or RESUMED, as the server answers an Identify or a Resume. */
function handshake(socket: FakeSocket, answer: "READY" | "RESUMED", seq: number): void {
  socket.receive(GatewayOp.Hello, { heartbeat_interval: 45_000 });
  socket.receive(GatewayOp.Dispatch, answer === "READY" ? { session_id: "session-1" } : {}, answer, seq);
}

let unsubscribe: (() => void) | null = null;
let stop: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  FakeSocket.all = [];
  mocks.processes = [];
  useActivity.setState({ share: true, registered: [], running: null, detected: null });
  unsubscribe = gateway.onStatus(connection => appStore.setState({ connection }));
});

afterEach(() => {
  stop?.();
  stop = null;
  gateway.disconnect();
  unsubscribe?.();
  setOwnActivities([]);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("presence sync over a real gateway connection", () => {
  it("identifies, reports the game, and reports it again after a drop and resume", async () => {
    gateway.connect("token");
    handshake(latest(), "READY", 1);
    expect(appStore.getState().connection).toBe("ready");
    expect(latest().sent.map(frame => frame.op)).toContain(GatewayOp.Identify);

    mocks.processes = [proc("factorio.exe")];
    stop = startGameDetection();
    await tick(0);
    await tick(15_000);
    expect(sockets()).toHaveLength(1);
    expect(sockets()[0]?.presence()).toHaveLength(1);
    expect(sockets()[0]?.presence()[0]?.d).toMatchObject({ activities: [game("Factorio")] });

    // The connection drops: the server forgets this session's activity. The client resumes and must report it again.
    sockets()[0]?.drop();
    expect(appStore.getState().connection).toBe("reconnecting");
    await tick(2_000);
    expect(sockets()).toHaveLength(2);
    expect(latest().presence()).toHaveLength(0);
    handshake(latest(), "RESUMED", 2);
    expect(latest().sent.map(frame => frame.op)).toContain(GatewayOp.Resume);
    expect(appStore.getState().connection).toBe("ready");

    await tick(12_000);
    expect(latest().presence()).toHaveLength(1);
    expect(latest().presence()[0]?.d).toMatchObject({ status: "online", activities: [game("Factorio")] });
  });

  it("reports the game again after a reconnect that needed a fresh READY", async () => {
    gateway.connect("token");
    handshake(latest(), "READY", 1);
    mocks.processes = [proc("terraria.exe", 7_000)];
    stop = startGameDetection();
    await tick(0);
    await tick(15_000);
    expect(sockets()[0]?.presence()).toHaveLength(1);

    sockets()[0]?.drop();
    await tick(2_000);
    // the server no longer knows the session: Invalid Session, then Identify and a new READY
    latest().receive(GatewayOp.Hello, { heartbeat_interval: 45_000 });
    latest().receive(GatewayOp.InvalidSession, false);
    await tick(1_000);
    expect(latest().sent.filter(frame => frame.op === GatewayOp.Identify)).toHaveLength(1);
    expect(appStore.getState().connection).toBe("reconnecting");
    latest().receive(GatewayOp.Dispatch, { session_id: "session-2" }, "READY", 1);
    expect(appStore.getState().connection).toBe("ready");

    await tick(12_000);
    expect(latest().presence()).toHaveLength(1);
    expect(latest().presence()[0]?.d).toMatchObject({ activities: [game("Terraria", 7_000)] });
  });

  it("does not claim a game that closed while the connection was down", async () => {
    gateway.connect("token");
    handshake(latest(), "READY", 1);
    mocks.processes = [proc("factorio.exe")];
    stop = startGameDetection();
    await tick(0);
    await tick(15_000);
    expect(sockets()[0]?.presence()).toHaveLength(1);

    sockets()[0]?.drop();
    mocks.processes = [];
    await tick(15_000);
    handshake(latest(), "RESUMED", 2);
    await tick(15_000);
    // the server already cleared the session's activity on the drop, so there is nothing to send
    expect(latest().presence()).toHaveLength(0);
    expect(sockets().flatMap(socket => socket.presence().filter(frame => (frame.d as { activities: unknown[] }).activities.length > 0))).toHaveLength(1);
  });
});
