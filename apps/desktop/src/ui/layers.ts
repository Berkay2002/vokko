// Stack of open overlays (modals, popouts, context menus). Escape and outside clicks only reach the top layer.

import { useEffect, useRef } from "react";

interface Layer {
  id: number;
  onEscape: () => void;
}

const stack: Layer[] = [];
let counter = 0;
let installed = false;

function install(): void {
  if (installed) return;
  installed = true;
  document.addEventListener(
    "keydown",
    event => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const top = stack[stack.length - 1];
      if (!top) return;
      event.preventDefault();
      event.stopPropagation();
      top.onEscape();
    },
    true,
  );
}

/** True while any overlay (modal, popout, context menu) is open: page-level Escape handlers should leave Escape to it. */
export function hasOpenLayer(): boolean {
  return stack.length > 0;
}

/** Register an overlay while `active`. Returns nothing; `onEscape` is called when this layer is on top. */
export function useLayer(active: boolean, onEscape: () => void): { isTop: () => boolean } {
  const handler = useRef(onEscape);
  handler.current = onEscape;
  const idRef = useRef(0);
  useEffect(() => {
    if (!active) return;
    install();
    const layer: Layer = { id: (counter += 1), onEscape: () => handler.current() };
    idRef.current = layer.id;
    stack.push(layer);
    return () => {
      const index = stack.indexOf(layer);
      if (index >= 0) stack.splice(index, 1);
    };
  }, [active]);
  return { isTop: () => stack[stack.length - 1]?.id === idRef.current };
}

/** Close when a pointer goes down outside every element in `inside`. */
export function useOutsideClose(active: boolean, inside: () => (Element | null | undefined)[], onClose: () => void, isTop: () => boolean): void {
  const insideRef = useRef(inside);
  insideRef.current = inside;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const topRef = useRef(isTop);
  topRef.current = isTop;
  useEffect(() => {
    if (!active) return;
    const handler = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (insideRef.current().some(el => el?.contains(target))) return;
      if (!topRef.current()) return;
      closeRef.current();
    };
    document.addEventListener("mousedown", handler, true);
    return () => document.removeEventListener("mousedown", handler, true);
  }, [active]);
}

export const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Menu-like rows that Up/Down/Home/End move between (`rovingKey`). */
export const ROVING_ITEMS = ["menuitem", "menuitemcheckbox", "menuitemradio", "option"].map(r => `[role="${r}"]:not(:disabled):not([aria-disabled="true"])`).join(", ");

/**
 * Up/Down/Home/End move DOM focus through `items` (wrapping), the way Discord's menus and popouts do. Returns true when it handled the key.
 * Keys typed into a text field are left alone, so a search box keeps its caret.
 */
export function rovingKey(event: { key: string; target: EventTarget | null; preventDefault(): void }, items: HTMLElement[]): boolean {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return false;
  if (event.target instanceof HTMLElement && event.target.matches("input, textarea, select, [contenteditable]")) return false;
  if (items.length === 0) return false;
  event.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowDown" ? (at + 1) % items.length : at <= 0 ? items.length - 1 : at - 1;
  items[next]?.focus();
  return true;
}

/** Active focus traps, oldest first: with a modal stacked over another (the profile editor over settings) only the newest handles Tab. */
const traps: object[] = [];

/**
 * Where a trap that closed in this commit sent focus back to: a trap opened in the same commit by one of its items (Server Settings from
 * the server menu) returns there instead of to the item, which is gone by then.
 */
let handoff: HTMLElement | null = null;

/** The focused element as an overlay opens (its opener), or null for <body>. Read it while rendering, before any autofocus inside runs. */
export function takeOpener(): HTMLElement | null {
  const el = document.activeElement;
  return el instanceof HTMLElement && el !== document.body ? el : null;
}

/** Give focus back to `opener` as an overlay (`root`) closes, but only when focus would otherwise be lost: a click elsewhere keeps what it focused. */
export function restoreFocus(opener: HTMLElement | null, root: HTMLElement | null): void {
  const target = opener?.isConnected ? opener : handoff;
  const now = document.activeElement;
  if (!target?.isConnected || (now && now !== document.body && !root?.contains(now))) return;
  target.focus({ preventScroll: true });
  handoff = target;
  queueMicrotask(() => (handoff = null));
}

/**
 * Keep Tab focus inside `container`, focus the first control on mount and restore focus to the opener on unmount. `ready` delays the
 * first focus (a popout is invisible until placed) without moving the moment the opener is taken; `initial` picks what to focus first.
 */
export function useFocusTrap(active: boolean, container: () => HTMLElement | null, ready = true, initial?: string): void {
  const containerRef = useRef(container);
  containerRef.current = container;
  // Taken while rendering: by the time an effect runs, an `autoFocus` input inside has already moved focus.
  const opener = useRef<HTMLElement | null>(null);
  const was = useRef(false);
  if (active && !was.current) opener.current = takeOpener();
  was.current = active;
  const on = active && ready;
  useEffect(() => {
    if (!on) return;
    const token = {};
    traps.push(token);
    const previous = opener.current?.isConnected ? opener.current : handoff;
    const root = containerRef.current();
    // An input with `autoFocus` has already taken focus by the time this effect runs: keep it.
    if (root && !root.contains(document.activeElement)) {
      const first = root.querySelector<HTMLElement>("[data-autofocus]") ?? (initial ? root.querySelector<HTMLElement>(initial) : null) ?? root.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? root).focus({ preventScroll: true });
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || traps[traps.length - 1] !== token) return;
      const el = containerRef.current();
      if (!el) return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(node => node.offsetParent !== null || node === document.activeElement);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0] as HTMLElement;
      const last = items[items.length - 1] as HTMLElement;
      const current = document.activeElement;
      // A popout opened over this dialog (profile card from a mention) traps Tab itself.
      if (current instanceof Element && !el.contains(current) && current.closest(".popout")) return;
      if (event.shiftKey && (current === first || !el.contains(current))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || !el.contains(current))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const index = traps.indexOf(token);
      if (index >= 0) traps.splice(index, 1);
      restoreFocus(previous, root);
    };
  }, [on]);
}

/** Overlays open over the app; the app body behind them is `inert` (out of the a11y tree and Tab order) while any is open. The title bar
 * stays live: its window controls must keep working. */
let inertCount = 0;

/** Make the app frame's `.app-body` inert while `active`. Call it before `useFocusTrap`, so the frame is live again when focus is restored. */
export function useInertApp(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    inertCount += 1;
    document.querySelector(".app-frame > .app-body")?.setAttribute("inert", "");
    return () => {
      inertCount -= 1;
      if (inertCount === 0) document.querySelector(".app-frame > .app-body")?.removeAttribute("inert");
    };
  }, [active]);
}
