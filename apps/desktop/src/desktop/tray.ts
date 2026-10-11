import { call, isDesktop } from "./tauri";

let lastUnread: boolean | null = null;

/** Shows (true) or clears (false) the unread dot on the tray icon. Safe to call on every unread-count change. */
export async function setTrayUnread(unread: boolean): Promise<void> {
  if (!isDesktop() || lastUnread === unread) return;
  lastUnread = unread;
  await call<void>("desktop_set_unread", { unread }, undefined);
}

/** Test hook: forget the last value sent. */
export function resetTrayUnread(): void {
  lastUnread = null;
}
