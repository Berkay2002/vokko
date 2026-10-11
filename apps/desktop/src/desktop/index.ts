// Desktop-shell adapters (Tauri). Every export is a no-op outside the Tauri webview, so the browser build can import freely.
import { initDeepLinks, type DeepLink } from "./deeplinks";
import { initUpdater } from "./updater";

export { isDesktop } from "./tauri";
export { DEFAULT_DESKTOP_PREFS, getDesktopPrefs, setDesktopPrefs, type DesktopPrefs } from "./prefs";
export { getAutostart, setAutostart } from "./autostart";
export { setTrayUnread } from "./tray";
export { initDeepLinks, invitePath, routeDeepLink, type DeepLink } from "./deeplinks";
export { checkForUpdate, downloadUpdate, initUpdater, restartToUpdate, useDesktopUpdate, type UpdateStatus } from "./updater";
export { listShortcuts, onShortcut, registerShortcut, unregisterShortcut, type ShortcutBinding, type ShortcutEvent } from "./shortcuts";

/** One-call startup: deep-link delivery plus update status/checks. Call once from the app entry; returns a teardown. */
export async function initDesktop(options: { onDeepLink?: (link: DeepLink) => void } = {}): Promise<() => void> {
  const stops = await Promise.all([initDeepLinks(options.onDeepLink), initUpdater()]);
  return () => stops.forEach(stop => stop());
}
