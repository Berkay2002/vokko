import { afterEach, describe, expect, it, vi } from "vitest";

// The gateway registers its "online" listener at construction, so a window must exist before the module loads.
vi.hoisted(() => {
  (globalThis as { window?: EventTarget }).window = new EventTarget();
});
vi.mock("./config", async importOriginal => ({ ...(await importOriginal<typeof import("./config")>()), MOCK: false, GATEWAY_URL: "ws://gateway.test/gateway" }));

import { gateway } from "./gateway";
import { GatewayOp } from "./types";

class FakeSocket {
  static all: FakeSocket[] = [];
  sent: { op: number }[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readyState = 1;
  constructor() {
    FakeSocket.all.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as { op: number });
  }
  close(): void {
    this.readyState = 3;
  }
  receive(payload: object): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

const hello = { op: GatewayOp.Hello, d: { heartbeat_interval: 3_600_000 } };

describe("gateway resume window", () => {
  afterEach(() => {
    gateway.disconnect();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("identifies instead of resuming when the last heartbeat ACK is older than the window", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
    gateway.connect("token");
    const first = FakeSocket.all[0]!;
    first.receive(hello);
    first.receive({ op: GatewayOp.Dispatch, s: 1, t: "READY", d: { session_id: "s" } });
    vi.setSystemTime(Date.now() + 10 * 60_000);
    first.onclose?.({ code: 1006 });
    vi.advanceTimersToNextTimer();
    const second = FakeSocket.all.at(-1)!;
    second.receive(hello);
    expect(second.sent.map(frame => frame.op)).toContain(GatewayOp.Identify);
    expect(second.sent.map(frame => frame.op)).not.toContain(GatewayOp.Resume);
  });
});
