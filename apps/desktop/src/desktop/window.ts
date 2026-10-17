import { call, isDesktop } from "./tauri";

/**
 * Makes the native window match the theme: its background colour (what shows while the webview resizes or loads) and its
 * light/dark chrome. `background` is the resolved `--app-frame-background` of the active theme. `scheme` null hands the
 * chrome back to the OS ("Sync with computer"); a forced "dark"/"light" would stop the webview following OS changes.
 * A no-op outside Tauri, and failures are swallowed (an older shell without the permissions keeps working).
 */
export async function syncWindowTheme(background: string, scheme: "dark" | "light" | null): Promise<void> {
  if (!isDesktop()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    if (/^#[0-9a-f]{6}$/i.test(background)) await win.setBackgroundColor(background);
    await win.setTheme(scheme);
  } catch (error) {
    console.warn("[desktop] cannot sync the window theme", error);
  }
}

/** The installed app version (from the Tauri config), or null in the browser. */
export async function getAppVersion(): Promise<string | null> {
  if (!isDesktop()) return null;
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    return null;
  }
}

/** Hides WebView2's own "is sharing your screen" bar (Windows; a no-op elsewhere). Call just before opening the screen picker. */
export async function hideShareBar(): Promise<void> {
  await call<void>("desktop_hide_share_bar", undefined, undefined);
}
