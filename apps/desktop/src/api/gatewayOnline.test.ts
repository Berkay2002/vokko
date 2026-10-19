import { afterEach, describe, expect, it, vi } from "vitest";

// The gateway registers its "online" listener at construction, so a window must exist before the module loads.
vi.hoisted(() => {
  (globalThis as { window?: EventTarget }).window = new EventTarget();
});
vi.mock("./config", async importOriginal => ({ ...(await importOriginal<typeof import("./config")>()), MOCK: false, GATEWAY_URL: "ws://gateway.test/gateway" }));

import { gateway } from "./gateway";

class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readyState = 1;
  constructor() {
    FakeSocket.all.push(this);
  }
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
}

describe("gateway 'online' event during reconnect backoff", () => {
  afterEach(() => {
    gateway.disconnect();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("opens one socket, not a second one when the backoff timer fires", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
    gateway.connect("token");
    FakeSocket.all[0]?.onclose?.({ code: 1006 });
    window.dispatchEvent(new Event("online"));
    expect(FakeSocket.all).toHaveLength(2);
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.all).toHaveLength(2);
  });
});
