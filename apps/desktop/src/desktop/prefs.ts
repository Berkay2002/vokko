import { call, callStrict } from "./tauri";

/** Desktop-shell preferences, stored by the Rust side (they apply before the webview loads). */
export interface DesktopPrefs {
  /** Closing the window hides Vokko to the tray instead of quitting. Default true, like Discord. */
  closeToTray: boolean;
  /** When started by the "run on startup" entry, stay in the tray instead of opening the window. Default false. */
  startMinimized: boolean;
}

export const DEFAULT_DESKTOP_PREFS: DesktopPrefs = { closeToTray: true, startMinimized: false };

export function getDesktopPrefs(): Promise<DesktopPrefs> {
  return call<DesktopPrefs>("desktop_get_prefs", undefined, DEFAULT_DESKTOP_PREFS);
}

/** Applies a partial update and resolves to the stored result. Outside Tauri nothing is stored and the defaults come back. */
export function setDesktopPrefs(patch: Partial<DesktopPrefs>): Promise<DesktopPrefs> {
  return callStrict<DesktopPrefs>("desktop_set_prefs", { patch }, DEFAULT_DESKTOP_PREFS);
}
