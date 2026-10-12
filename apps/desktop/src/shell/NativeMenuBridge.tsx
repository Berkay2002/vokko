import { useEffect } from "react";
import { onNativeMenu, type NativeMenuId } from "../desktop/menu";
import { runShortcut, type ShortcutId } from "../keyboard";
import { openModal, type ModalSpec } from "./modalStore";

/** Menu items that are also key bindings: they run the binding's handler, so the menu and the keys share one path. */
const MENU_SHORTCUT: Partial<Record<NativeMenuId, ShortcutId>> = { "quick-switcher": "quickSwitcher", inbox: "inbox", shortcuts: "shortcuts" };

/** The modal a macOS menu item opens: the same ones the title bar, the sidebar and the shortcuts open. */
export function menuModal(id: NativeMenuId): ModalSpec {
  switch (id) {
    case "settings":
      return { type: "userSettings" };
    case "quick-switcher":
      return { type: "quickSwitcher" };
    case "inbox":
      return { type: "inbox" };
    case "help":
      return { type: "userSettings", section: "keybinds" };
    case "shortcuts":
      return { type: "shortcuts" };
  }
}

/** Mounted inside the signed-in shell, so menu clicks while logged out do nothing. */
export function NativeMenuBridge() {
  useEffect(() => {
    const unlisten = onNativeMenu(id => {
      const shortcut = MENU_SHORTCUT[id];
      // Help has no key binding (Settings has Mod+,); a binding with no handler mounted falls back to opening its modal.
      if (!shortcut || !runShortcut(shortcut)) openModal(menuModal(id));
    });
    return () => void unlisten.then(stop => stop());
  }, []);
  return null;
}
