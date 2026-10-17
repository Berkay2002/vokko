import { onDesktopEvent } from "./tauri";

/** Actions the macOS menu bar can ask for; mirrors `ACTIONS` in src-tauri/src/macos.rs. */
export type NativeMenuId = "settings" | "quick-switcher" | "inbox" | "help" | "shortcuts" | "report-problem";

const KNOWN: ReadonlySet<string> = new Set<NativeMenuId>(["settings", "quick-switcher", "inbox", "help", "shortcuts", "report-problem"]);

/** Subscribes to native menu clicks. Never fires outside the macOS desktop app. Returns an unsubscribe function. */
export function onNativeMenu(handler: (id: NativeMenuId) => void): Promise<() => void> {
  return onDesktopEvent<string>("desktop-menu", id => {
    if (KNOWN.has(id)) handler(id as NativeMenuId);
  });
}
