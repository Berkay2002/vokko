import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { Check, ChevronRight } from "lucide-react";
import { useLayer, useOutsideClose } from "./layers";
import { placeAtPoint } from "./position";

export type MenuItem =
  | {
      id: string;
      label: string;
      icon?: ReactNode;
      danger?: boolean;
      disabled?: boolean;
      /** Checkbox state (shows a check mark when true, an empty box when false). */
      checked?: boolean;
      /** Right-aligned hint text (e.g. a shortcut). */
      hint?: string;
      /** Native tooltip, used for disabled rows ("Not available yet"). */
      tooltip?: string;
      onSelect?: () => void;
      children?: MenuItem[];
      /** Custom row content (e.g. a volume slider) instead of the label; not keyboard-selectable, clicks stay inside. */
      render?: () => ReactNode;
    }
  | { type: "separator" };

interface MenuState {
  open: boolean;
  x: number;
  y: number;
  items: MenuItem[];
  show(x: number, y: number, items: MenuItem[]): void;
  hide(): void;
}

const useMenuStore = create<MenuState>()(set => ({
  open: false,
  x: 0,
  y: 0,
  items: [],
  show: (x, y, items) => set({ open: true, x, y, items }),
  hide: () => set({ open: false }),
}));

/** `open(event, items)` shows the menu at the pointer (or the element's corner for keyboard events). */
export function useContextMenu(): { open: (event: ReactMouseEvent | MouseEvent | { clientX: number; clientY: number; preventDefault?: () => void }, items: MenuItem[]) => void; close: () => void } {
  const show = useMenuStore(s => s.show);
  const hide = useMenuStore(s => s.hide);
  const open = useCallback(
    (event: { clientX: number; clientY: number; preventDefault?: () => void }, items: MenuItem[]) => {
      if (items.length === 0) return;
      event.preventDefault?.();
      show(event.clientX, event.clientY, items);
    },
    [show],
  );
  return useMemo(() => ({ open, close: hide }), [open, hide]);
}

const isSelectable = (item: MenuItem): item is Exclude<MenuItem, { type: "separator" }> => !("type" in item) && !item.disabled && !item.render;

function MenuList({ items, onClose, level = 0, x, y, anchorRect }: { items: MenuItem[]; onClose: () => void; level?: number; x?: number; y?: number; anchorRect?: DOMRect }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [active, setActive] = useState<number>(-1);
  const [sub, setSub] = useState<{ index: number; rect: DOMRect } | null>(null);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    if (anchorRect) {
      // Submenu: right of the parent row, flipped left when it would overflow.
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      let left = anchorRect.right + 2;
      if (left + width + 8 > window.innerWidth) left = Math.max(8, anchorRect.left - width - 2);
      const top = Math.min(anchorRect.top - 8, window.innerHeight - height - 8);
      setPos({ left, top: Math.max(8, top) });
    } else {
      setPos(placeAtPoint(x ?? 0, y ?? 0, el.offsetWidth, el.offsetHeight));
    }
  }, [x, y, anchorRect]);

  const move = (delta: number) => {
    const count = items.length;
    let next = active;
    for (let i = 0; i < count; i += 1) {
      next = (next + delta + count) % count;
      const item = items[next];
      if (item && isSelectable(item)) {
        setActive(next);
        return;
      }
    }
  };

  const activate = (index: number, row?: HTMLElement | null) => {
    const item = items[index];
    if (!item || !isSelectable(item)) return;
    if (item.children?.length) {
      const rect = (row ?? box.current?.querySelectorAll<HTMLElement>("[data-menu-row]")[index])?.getBoundingClientRect();
      if (rect) setSub({ index, rect });
      return;
    }
    onClose();
    item.onSelect?.();
  };

  useEffect(() => {
    if (level > 0) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        move(1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        move(-1);
      } else if (event.key === "Enter" || event.key === " " || event.key === "ArrowRight") {
        if (active >= 0) {
          event.preventDefault();
          activate(active);
        }
      } else if (event.key === "ArrowLeft") {
        setSub(null);
      } else if (event.key === "Tab") {
        // The menu has no focusable rows: let Tab move on and close the menu behind it (ARIA menu pattern).
        // A custom row (a volume slider) does hold focus; Tab there moves within the menu.
        if (!document.activeElement?.closest(".context-menu")) onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  return (
    <>
      <div ref={box} className="context-menu" role="menu" style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? "visible" : "hidden" }} onContextMenu={e => e.preventDefault()}>
        {items.map((item, index) => {
          if ("type" in item) return <div key={`sep-${index}`} className="context-menu-separator" role="separator" />;
          if (item.render) {
            return (
              <div key={item.id} data-menu-row className="context-menu-custom" role="none" onMouseEnter={() => (setActive(-1), setSub(null))}>
                {item.render()}
              </div>
            );
          }
          const submenu = !!item.children?.length;
          return (
            <div
              key={item.id}
              data-menu-row
              role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
              aria-checked={item.checked}
              aria-disabled={item.disabled || undefined}
              title={item.tooltip}
              className={`context-menu-item${item.danger ? " danger" : ""}${item.disabled ? " disabled" : ""}${active === index || sub?.index === index ? " focused" : ""}`}
              onMouseEnter={e => {
                setActive(index);
                if (submenu && !item.disabled) setSub({ index, rect: e.currentTarget.getBoundingClientRect() });
                else setSub(null);
              }}
              onClick={e => activate(index, e.currentTarget)}
            >
              <span className="context-menu-label">{item.label}</span>
              {item.hint && <span className="context-menu-hint">{item.hint}</span>}
              {item.icon && <span className="context-menu-icon">{item.icon}</span>}
              {item.checked !== undefined && <span className={`context-menu-check${item.checked ? " on" : ""}`}>{item.checked && <Check size={14} strokeWidth={3} />}</span>}
              {submenu && <ChevronRight size={16} className="context-menu-chevron" />}
            </div>
          );
        })}
      </div>
      {sub && items[sub.index] && "children" in (items[sub.index] as object) && <MenuList items={((items[sub.index] as { children?: MenuItem[] }).children) ?? []} onClose={onClose} level={level + 1} anchorRect={sub.rect} />}
    </>
  );
}

/** Mount once near the app root. */
export function ContextMenuHost() {
  const { open, x, y, items, hide } = useMenuStore();
  const layer = useLayer(open, hide);
  useEffect(() => {
    // Shift+F10 and the Menu key: Chromium on Windows/Linux may turn them into a native `contextmenu` event (Windows: on keyup),
    // macOS and Tauri's WKWebView do not. Dispatch one ourselves at the focused element so every onContextMenu handler works from
    // the keyboard, and swallow a trusted native one that follows on the same target so the menu does not open twice.
    // The swallow lasts until the key is released (Windows sends its native event on keyup, however long the key was held).
    let swallow: Element | null = null;
    const isMenuKey = (event: KeyboardEvent) => event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
    const onKey = (event: KeyboardEvent) => {
      if (!isMenuKey(event) || event.repeat || event.isComposing) return;
      const target = document.activeElement;
      if (!(target instanceof HTMLElement) || target === document.body) return;
      const rect = target.getBoundingClientRect();
      const x = Math.min(Math.max(rect.left, 0), window.innerWidth - 1);
      const y = Math.min(Math.max(rect.bottom, 0), window.innerHeight - 1);
      // Same outcome as a right click on that element: a handler took it (menu opened) or nobody did and the native menu stays.
      if (!target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }))) {
        event.preventDefault();
        swallow = target;
      }
    };
    const onNative = (event: Event) => {
      if (!swallow || !event.isTrusted || event.target !== swallow) return;
      swallow = null;
      event.preventDefault();
      event.stopPropagation();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!swallow || !isMenuKey(event)) return;
      event.preventDefault();
      // The native event follows this keyup in the same input task; drop the swallow after it.
      setTimeout(() => (swallow = null));
    };
    // A keyup that never arrives (focus left the window) must not eat a later right click on the same element.
    const reset = () => (swallow = null);
    document.addEventListener("keydown", onKey);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("contextmenu", onNative, true);
    document.addEventListener("pointerdown", reset, true);
    window.addEventListener("blur", reset);
    return () => {
      document.removeEventListener("pointerdown", reset, true);
      window.removeEventListener("blur", reset);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("contextmenu", onNative, true);
    };
  }, []);
  useOutsideClose(open, () => [...document.querySelectorAll(".context-menu")], hide, layer.isTop);
  useEffect(() => {
    if (!open) return;
    const close = () => hide();
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    document.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      document.removeEventListener("scroll", close, true);
    };
  }, [open, hide]);
  if (!open) return null;
  return createPortal(
    <div className="context-menu-layer" onContextMenu={e => e.preventDefault()}>
      <MenuList key={`${x}:${y}`} items={items} onClose={hide} x={x} y={y} />
    </div>,
    document.body,
  );
}
