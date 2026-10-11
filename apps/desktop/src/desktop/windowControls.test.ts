import { beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => false) }));
const win = vi.hoisted(() => ({ minimize: vi.fn(async () => undefined), toggleMaximize: vi.fn(async () => undefined), close: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/core", () => core);
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));

import { closeWindow, getWindowChrome, minimizeWindow, resetWindowChrome, toggleMaximizeWindow, watchMaximized } from "./windowControls";

beforeEach(() => {
  core.invoke.mockReset();
  core.isTauri.mockReset();
  win.minimize.mockClear();
  win.toggleMaximize.mockClear();
  win.close.mockClear();
  resetWindowChrome();
});

describe("window controls", () => {
  it("are native and inert in the browser", async () => {
    core.isTauri.mockReturnValue(false);
    expect((await getWindowChrome()).customControls).toBe(false);
    await minimizeWindow();
    await toggleMaximizeWindow();
    await closeWindow();
    expect(await watchMaximized(() => undefined)).toBeTypeOf("function");
    expect(core.invoke).not.toHaveBeenCalled();
    expect(win.close).not.toHaveBeenCalled();
  });

  it("ask the shell whether to draw them, and drive the window", async () => {
    core.isTauri.mockReturnValue(true);
    core.invoke.mockResolvedValue({ customControls: true, platform: "windows" });
    expect(await getWindowChrome()).toEqual({ customControls: true, platform: "windows" });
    expect(core.invoke).toHaveBeenCalledWith("desktop_window_chrome", undefined);
    await minimizeWindow();
    await toggleMaximizeWindow();
    await closeWindow();
    expect(win.minimize).toHaveBeenCalledTimes(1);
    expect(win.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(win.close).toHaveBeenCalledTimes(1);
  });

  it("keep macOS traffic lights native", async () => {
    core.isTauri.mockReturnValue(true);
    core.invoke.mockResolvedValue({ customControls: false, platform: "macos" });
    expect((await getWindowChrome()).customControls).toBe(false);
  });

  it("never throw when the window API fails", async () => {
    core.isTauri.mockReturnValue(true);
    win.close.mockRejectedValueOnce(new Error("no permission"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(closeWindow()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
