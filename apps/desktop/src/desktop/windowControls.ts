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
