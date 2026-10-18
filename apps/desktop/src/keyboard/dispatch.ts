import { useEffect, useRef } from "react";
import { useModals } from "../shell/modalStore";
import { BINDINGS, IS_MAC, matches, type Binding, type ShortcutId } from "./bindings";
import { keysFor } from "./overrides";

/** Return false when the shortcut does not apply right now: the next handler (or the browser default) gets the key. */
export type ShortcutHandler = (index: number, event?: KeyboardEvent) => boolean | void;

const handlers = new Map<ShortcutId, ShortcutHandler[]>();
let installed = false;

/** Runs the newest handler registered for `id` that accepts. Also the entry point for menus that trigger shortcuts. */
export function runShortcut(id: ShortcutId, index = 0, event?: KeyboardEvent): boolean {
  const list = handlers.get(id) ?? [];
  for (let i = list.length - 1; i >= 0; i--) if (list[i]!(index, event) !== false) return true;
  return false;
}

const isEditable = (t: EventTarget | null): t is HTMLElement =>
  typeof HTMLElement !== "undefined" &&
  t instanceof HTMLElement && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");

/** Chats and the panels around them: a key from inside one belongs to that chat's handler, never to a shell fallback. */
const CHAT_PANEL = ".chat-view, .thread-panel, .voice-chat";

export function inChatPanel(target: EventTarget | null | undefined): boolean {
  return !!(target as Element | null | undefined)?.closest?.(CHAT_PANEL);
}

const modalOpen = () => useModals.getState().modal !== null || document.querySelector('[aria-modal="true"]') !== null;

export interface DispatchEnv {
  mac: boolean;
  modalOpen(): boolean;
}

export function handleKeyDown(e: KeyboardEvent, env: DispatchEnv = { mac: IS_MAC, modalOpen }): void {
  // Handled already (a popout's Escape, the composer's autocomplete) or mid IME composition.
  if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
  for (const b of BINDINGS as readonly Binding[]) {
    const index = keysFor(b).find(k => matches(k.spec, e, env.mac))?.index ?? -1;
    if (index < 0) continue;
    const id = b.id as ShortcutId;
    if (isEditable(e.target) && (b.text === "none" || (b.text === "composer" && !e.target.closest(".chat-composer, .chat-composer-picker")))) return;
    if (!b.modal && env.modalOpen()) return;
    if (e.repeat && !b.repeat) {
      // A held Ctrl+P must not fall through to the print dialog on the second event.
      if (handlers.get(id)?.length) e.preventDefault();
      return;
    }
    if (runShortcut(id, index, e)) e.preventDefault();
    return;
  }
}

/** Registers `handler` for `id`; returns the unregister function. */
export function registerShortcut(id: ShortcutId, handler: ShortcutHandler): () => void {
  if (!installed && typeof window !== "undefined") {
    installed = true;
    // Bubble phase on window: React handlers (composer, menus) and the overlay stack's Escape run first.
    window.addEventListener("keydown", e => handleKeyDown(e));
  }
  const list = handlers.get(id) ?? [];
  list.push(handler);
  handlers.set(id, list);
  return () => {
    const i = list.indexOf(handler);
    if (i >= 0) list.splice(i, 1);
  };
}

/** Call-site hook: what `id` does while this component is mounted (and `enabled`). The latest handler closure is used. */
export function useShortcut(id: ShortcutId, handler: ShortcutHandler, enabled = true): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => (enabled ? registerShortcut(id, (i, e) => ref.current(i, e)) : undefined), [id, enabled]);
}
