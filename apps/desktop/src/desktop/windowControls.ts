import { useEffect, useState } from "react";
import { call, isDesktop } from "./tauri";

/**
 * Window chrome of the desktop shell. Off macOS the OS title bar is removed at startup and the page draws minimize / maximize /
 * close itself; macOS keeps its traffic lights. Every function is a no-op in the browser.
 */
export interface WindowChrome {
  /** The page draws the window buttons (and must provide a drag region). */
  customControls: boolean;
  platform: "windows" | "macos" | "linux";
}

const BROWSER: WindowChrome = { customControls: false, platform: "windows" };
let cached: Promise<WindowChrome> | null = null;

export function getWindowChrome(): Promise<WindowChrome> {
  if (!isDesktop()) return Promise.resolve(BROWSER);
  cached ??= call<WindowChrome>("desktop_window_chrome", undefined, BROWSER);
  return cached;
}

/** Test hook: forget the cached answer. */
export function resetWindowChrome(): void {
  cached = null;
}

/** The chrome of this window, or null until the shell answered (and always `customControls: false` in the browser). */
export function useWindowChrome(): WindowChrome | null {
  const [chrome, setChrome] = useState<WindowChrome | null>(isDesktop() ? null : BROWSER);
  useEffect(() => {
    let live = true;
    void getWindowChrome().then(value => live && setChrome(value));
    return () => {
      live = false;
    };
  }, []);
  return chrome;
}

async function currentWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

/** Runs a window action; failures are logged, never thrown (the buttons must not break the page). */
async function act(name: string, run: (win: Awaited<ReturnType<typeof currentWindow>>) => Promise<unknown>): Promise<void> {
  if (!isDesktop()) return;
  try {
    await run(await currentWindow());
  } catch (error) {
    console.warn(`[desktop] window ${name} failed`, error);
  }
}

export const minimizeWindow = (): Promise<void> => act("minimize", win => win.minimize());
export const toggleMaximizeWindow = (): Promise<void> => act("toggle maximize", win => win.toggleMaximize());
/** Closes the window through the normal close request, so close-to-tray still applies. */
export const closeWindow = (): Promise<void> => act("close", win => win.close());

let windowFullscreen: Promise<void> = Promise.resolve();
/** What the window was before a game took it full screen; null when it is not ours to give back. */
let before: { maximized: boolean } | null = null;

/**
 * Borderless full screen of the native window (covers the taskbar), for a game's full screen; leaving gives back what the window
 * was (maximized or not). Calls run one after the other so a quick enter and leave cannot cross. No-op in the browser.
 */
export function setWindowFullscreen(on: boolean): Promise<void> {
  windowFullscreen = windowFullscreen.then(() =>
    act("full screen", async win => {
      if (on) {
        if (before || (await win.isFullscreen())) return;
        before = { maximized: await win.isMaximized() };
        // A maximized window that goes full screen keeps its webview at the work-area size (the taskbar strip stays empty), so it is restored first.
        if (before.maximized) await win.unmaximize();
        await win.setFullscreen(true);
      } else if (before) {
        const { maximized } = before;
        before = null;
        await win.setFullscreen(false);
        if (maximized) await win.maximize();
      }
    }),
  );
  return windowFullscreen;
}

/** Calls `handler` with the maximized state now and after every resize. Resolves to an unsubscribe function. */
export async function watchMaximized(handler: (maximized: boolean) => void): Promise<() => void> {
  if (!isDesktop()) return () => undefined;
  try {
    const win = await currentWindow();
    const report = () => void win.isMaximized().then(handler, () => undefined);
    report();
    return await win.onResized(report);
  } catch (error) {
    console.warn("[desktop] cannot watch the window state", error);
    return () => undefined;
  }
}
