import { useEffect } from "react";
import { onNativeMenu, type NativeMenuId } from "../desktop/menu";
import { closeModal, openModal, useModals, type ModalSpec } from "./modalStore";

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
      const modal = menuModal(id);
      // Same toggle as Cmd+K, so the menu item and the key behave alike.
      if (modal.type === "quickSwitcher" && useModals.getState().modal?.type === "quickSwitcher") closeModal();
      else openModal(modal);
    });
    return () => void unlisten.then(stop => stop());
  }, []);
  return null;
}
