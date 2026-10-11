// Desktop-shell adapters (Tauri). Every export is a no-op outside the Tauri webview, so the browser build can import freely.
import { initDeepLinks } from "./deeplinks";
import { initUpdater } from "./updater";

export { isDesktop } from "./tauri";
export { DEFAULT_DESKTOP_PREFS, getDesktopPrefs, setDesktopPrefs, type DesktopPrefs } from "./prefs";
export { getAutostart, setAutostart } from "./autostart";
export { setTrayUnread } from "./tray";
export { getAppVersion, syncWindowTheme } from "./window";
export { initDeepLinks, invitePath, onDeepLink, routeDeepLink, type DeepLink, type DeepLinkHandler } from "./deeplinks";
export { checkForUpdate, downloadUpdate, initUpdater, restartToUpdate, useDesktopUpdate, type UpdateStatus } from "./updater";
export { minimizeWindow, toggleMaximizeWindow, closeWindow, getWindowChrome, useWindowChrome, type WindowChrome } from "./windowControls";
export { DETECTABLE_GAMES, listProcesses, matchGame, type DetectedGame, type GameEntry, type RunningProcess } from "./games";
export { listShortcuts, onShortcut, registerShortcut, unregisterShortcut, type ShortcutBinding, type ShortcutEvent } from "./shortcuts";

/** One-call startup: deep-link delivery, update status/checks. Call once from the app entry; returns a teardown. */
export async function initDesktop(): Promise<() => void> {
  const stops = await Promise.all([initDeepLinks(), initUpdater()]);
  return () => stops.forEach(stop => stop());
}
