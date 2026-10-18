import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => false) }));
vi.mock("@tauri-apps/api/core", () => core);

import { RELOAD_GUARD_MS, decideChunkError } from "./staleChunks";

describe("decideChunkError", () => {
  const now = 1_000_000;
  it("reloads when idle and no reload happened recently", () => {
    expect(decideChunkError({ busy: false, lastReloadAt: null, now })).toBe("reload");
    expect(decideChunkError({ busy: false, lastReloadAt: now - RELOAD_GUARD_MS, now })).toBe("reload");
  });
  it("shows the banner instead of reloading twice within a minute", () => {
    expect(decideChunkError({ busy: false, lastReloadAt: now - RELOAD_GUARD_MS + 1, now })).toBe("banner");
  });
  it("never reloads over an unsent draft or a call", () => {
    expect(decideChunkError({ busy: true, lastReloadAt: null, now })).toBe("banner");
  });
});

describe("installStaleChunkReload", () => {
  const reload = vi.fn();
  beforeEach(() => {
    vi.resetModules();
    reload.mockReset();
    const store = new Map<string, string>();
    vi.stubGlobal("window", new EventTarget()); // the test environment is node: no DOM
    vi.stubGlobal("sessionStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
    vi.stubGlobal("location", { reload });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reloads once on the first preload error in the browser and records when", async () => {
    core.isTauri.mockReturnValue(false);
    const { installStaleChunkReload } = await import("./staleChunks");
    installStaleChunkReload();
    window.dispatchEvent(new Event("vite:preloadError"));
    window.dispatchEvent(new Event("vite:preloadError"));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(Number(sessionStorage.getItem("vokko.chunkReloadAt"))).toBeGreaterThan(0);
  });

  it("reloads with typed text in a draft: it is saved and comes back", async () => {
    core.isTauri.mockReturnValue(false);
    const drafts = await import("../chat/draftStore");
    const { installStaleChunkReload } = await import("./staleChunks");
    drafts.setDraftText("1", "half a sentence");
    installStaleChunkReload();
    window.dispatchEvent(new Event("vite:preloadError"));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does nothing in the desktop app", async () => {
    core.isTauri.mockReturnValue(true);
    const { installStaleChunkReload } = await import("./staleChunks");
    installStaleChunkReload();
    window.dispatchEvent(new Event("vite:preloadError"));
    expect(reload).not.toHaveBeenCalled();
  });
});
