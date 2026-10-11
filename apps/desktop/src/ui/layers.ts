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

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keep Tab focus inside `container`, focus the first control on mount and restore focus on unmount. */
export function useFocusTrap(active: boolean, container: () => HTMLElement | null): void {
  const containerRef = useRef(container);
  containerRef.current = container;
  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = containerRef.current();
    if (root) {
      const first = root.querySelector<HTMLElement>("[data-autofocus]") ?? root.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? root).focus({ preventScroll: true });
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
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
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [active]);
}
