import { call, callStrict, onDesktopEvent } from "./tauri";

/**
 * Global (system-wide) shortcuts, e.g. push-to-talk. Nothing is registered by default.
 * Accelerators look like "Ctrl+Shift+K", "Alt+F13", "F13". A binding needs a non-modifier key; mouse buttons can't be bound.
 */
export interface ShortcutBinding {
  id: string;
  accelerator: string;
}

export interface ShortcutEvent {
  id: string;
  /** `pressed` on key down, `released` on key up (push-to-talk needs both). */
  state: "pressed" | "released";
}

/** Binds `accelerator` to `id` (replacing the id's earlier binding). Rejects if the accelerator is invalid or taken by another app. */
export function registerShortcut(id: string, accelerator: string): Promise<void> {
  return callStrict<void>("desktop_shortcut_register", { id, accelerator }, undefined);
}

export function unregisterShortcut(id: string): Promise<void> {
  return callStrict<void>("desktop_shortcut_unregister", { id }, undefined);
}

export function listShortcuts(): Promise<ShortcutBinding[]> {
  return call<ShortcutBinding[]>("desktop_shortcut_list", undefined, []);
}

/** Listens for press/release of any registered shortcut. Resolves to an unsubscribe function. */
export function onShortcut(handler: (event: ShortcutEvent) => void): Promise<() => void> {
  return onDesktopEvent<ShortcutEvent>("desktop-shortcut", handler);
}
