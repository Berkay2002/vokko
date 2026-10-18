import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  let state = { channelId: null as string | null, selfMute: false };
  const listeners = new Set<(next: typeof state, prev: typeof state) => void>();
  return {
    store: {
      getState: () => state,
      subscribe: (l: (next: typeof state, prev: typeof state) => void) => (listeners.add(l), () => listeners.delete(l)),
      set(patch: Partial<typeof state>) {
        const prev = state;
        state = { ...state, ...patch };
        listeners.forEach(l => l(state, prev));
      },
    },
  };
});

vi.mock("./store", () => ({ voiceStore: fake.store }));
vi.mock("./engine", () => ({ toggleSelfMute: vi.fn(), leaveVoice: vi.fn() }));
vi.mock("./videoControls", () => ({ toggleCamera: vi.fn() }));
vi.mock("../ui/BottomSheet", () => ({ PHONE_QUERY: "(max-width: 767px)" }));
vi.mock("../api/store", () => ({ appStore: { getState: () => ({ channels: {}, guilds: {} }) }, dmName: () => "dm" }));

class Sentinel {
  released = false;
  private listeners: (() => void)[] = [];
  addEventListener(_: "release", l: () => void) {
    this.listeners.push(l);
  }
  release() {
    this.released = true;
    return Promise.resolve();
  }
  /** What the browser does when the page is hidden. */
  drop() {
    this.released = true;
    this.listeners.forEach(l => l());
  }
}

const sentinels: Sentinel[] = [];
const handlers: Record<string, unknown> = {};
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

beforeAll(async () => {
  // The suite runs in node: a bare EventTarget stands in for the document.
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.stubGlobal("navigator", {
    wakeLock: { request: () => Promise.resolve(sentinels[sentinels.push(new Sentinel()) - 1]) },
    mediaSession: { setActionHandler: (a: string, h: unknown) => void (handlers[a] = h) },
  });
  vi.stubGlobal("MediaMetadata", class {});
  const { wireCallSession } = await import("./callSession");
  wireCallSession();
});

beforeEach(() => {
  fake.store.set({ channelId: null });
  sentinels.length = 0;
  Object.keys(handlers).forEach(k => delete handlers[k]);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: phone, media: query }));
});

let phone = true;

describe("call session (wake lock, lock-screen controls)", () => {
  it("takes the wake lock again after the browser released it (page hidden, then visible)", async () => {
    phone = true;
    fake.store.set({ channelId: "c1" });
    await flush();
    expect(sentinels).toHaveLength(1);
    sentinels[0]!.drop();
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(sentinels).toHaveLength(2);
    fake.store.set({ channelId: null });
    expect(sentinels[1]!.released).toBe(true);
  });

  it("does neither on a desktop", async () => {
    phone = false;
    fake.store.set({ channelId: "c1" });
    await flush();
    expect(sentinels).toHaveLength(0);
    expect(handlers["hangup"]).toBeUndefined();
  });

  it("sets the call handlers on a phone and removes them on leave", async () => {
    phone = true;
    fake.store.set({ channelId: "c1" });
    expect(handlers["hangup"]).toBeTypeOf("function");
    fake.store.set({ channelId: null });
    expect(handlers["hangup"]).toBeNull();
  });
});
