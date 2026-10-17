import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { BottomSheet, usePhone } from "./BottomSheet";
import { useLayer, useOutsideClose } from "./layers";
import { menuTop, placeAtPoint } from "./position";

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
      /** Muted second line under the label that wraps (the current device on a device row). */
      sub?: string;
      /** Draw the icon before the label instead of after it. */
      iconStart?: boolean;
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
  /** Phone sheet header: the name of the row the menu was opened on. */
  title: string;
  show(x: number, y: number, items: MenuItem[], title?: string): void;
  hide(): void;
}

const useMenuStore = create<MenuState>()(set => ({
  open: false,
  x: 0,
  y: 0,
  items: [],
  title: "",
  show: (x, y, items, title = "") => set({ open: true, x, y, items, title }),
  hide: () => set({ open: false }),
}));

/** The name on the DM or channel row a menu opened on (a phone sheet's header); "" elsewhere. */
function rowTitle(target: EventTarget | null | undefined): string {
  if (!(target instanceof Element)) return "";
  const dm = target.closest(".dm-row")?.querySelector(".dm-name")?.textContent;
  if (dm) return dm;
  const row = target.closest(".channel-row");
  const name = row?.querySelector(".channel-name")?.textContent;
  return name ? (row?.classList.contains("voice") ? name : `# ${name}`) : "";
}

/** `open(event, items)` shows the menu at the pointer (or the element's corner for keyboard events). */
export function useContextMenu(): { open: (event: ReactMouseEvent | MouseEvent | { clientX: number; clientY: number; preventDefault?: () => void }, items: MenuItem[]) => void; close: () => void } {
  const show = useMenuStore(s => s.show);
  const hide = useMenuStore(s => s.hide);
  const open = useCallback(
    (event: { clientX: number; clientY: number; preventDefault?: () => void }, items: MenuItem[]) => {
      if (items.length === 0) return;
      event.preventDefault?.();
      show(event.clientX, event.clientY, items, rowTitle((event as { target?: EventTarget | null }).target));
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
      setPos({ left, top: Math.max(menuTop(), top) });
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
              {item.icon && item.iconStart && <span className="context-menu-icon">{item.icon}</span>}
              {item.sub ? (
                <span className="context-menu-text">
                  <span className="context-menu-label">{item.label}</span>
                  <span className="context-menu-sub">{item.sub}</span>
                </span>
              ) : (
                <span className="context-menu-label">{item.label}</span>
              )}
              {item.hint && <span className="context-menu-hint">{item.hint}</span>}
              {item.icon && !item.iconStart && <span className="context-menu-icon">{item.icon}</span>}
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

/** Phone widths: the menu as a bottom sheet of grouped rows (separators start a new group); a row with children drills down in place. */
function MenuSheet({ items, title, onClose }: { items: MenuItem[]; title: string; onClose: () => void }) {
  const [trail, setTrail] = useState<{ label: string; items: MenuItem[] }[]>([]);
  const here = trail.length > 0 ? trail[trail.length - 1]! : null;
  const groups: Exclude<MenuItem, { type: "separator" }>[][] = [[]];
  for (const item of here?.items ?? items) {
    if ("type" in item) groups.push([]);
    else groups[groups.length - 1]!.push(item);
  }
  return (
    <BottomSheet open onClose={onClose} label={here?.label ?? (title || "Menu")} className="sheet-menu">
      {!here && title && <h2 className="sheet-title">{title}</h2>}
      {here && (
        <button type="button" className="sheet-back" onClick={() => setTrail(t => t.slice(0, -1))}>
          <ChevronLeft size={20} aria-hidden="true" /> {here.label}
        </button>
      )}
      {groups
        .filter(g => g.length > 0)
        .map((group, g) => (
          <div key={g} className="sheet-group" role="menu">
            {group.map(item => {
              if (item.render) {
                return (
                  <div key={item.id} className="sheet-row sheet-row-custom" role="none">
                    {item.render()}
                  </div>
                );
              }
              const drill = !!item.children?.length;
              return (
                <button
                  key={item.id}
                  type="button"
                  role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                  aria-checked={item.checked}
                  disabled={item.disabled}
                  title={item.tooltip}
                  className={`sheet-row${item.danger ? " danger" : ""}${item.icon ? "" : " no-icon"}`}
                  onClick={() => {
                    if (drill) {
                      setTrail(t => [...t, { label: item.label, items: item.children ?? [] }]);
                      return;
                    }
                    onClose();
                    item.onSelect?.();
                  }}
                >
                  {item.icon && <span className="sheet-row-icon">{item.icon}</span>}
                  <span className="sheet-row-label">
                    {item.label}
                    {item.sub && <span className="sheet-row-sub">{item.sub}</span>}
                  </span>
                  {item.hint && <span className="sheet-row-trailing">{item.hint}</span>}
                  {item.checked !== undefined && (
                    <span className="sheet-row-trailing">
                      <span className={`context-menu-check${item.checked ? " on" : ""}`}>{item.checked && <Check size={14} strokeWidth={3} />}</span>
                    </span>
                  )}
                  {drill && (
                    <span className="sheet-row-trailing">
                      <ChevronRight size={18} aria-hidden="true" />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
    </BottomSheet>
  );
}

const LONG_PRESS_MS = 550;
const LONG_PRESS_SLOP = 10;
/** Where a held finger does not become a context menu: text entry, and message rows (they have their own press, see chat/MessageItem.tsx). */
const NO_LONG_PRESS = "input, textarea, [contenteditable], .chat-msg, .sheet";

/** Mount once near the app root. */
export function ContextMenuHost() {
  const { open, x, y, items, title, hide } = useMenuStore();
  const phone = usePhone();
  const layer = useLayer(open && !phone, hide);
  useEffect(() => {
    // Touch has no right click (iOS Safari fires no contextmenu event at all): a held finger ~550 ms on something that handles
    // `contextmenu` opens its menu, as a long press does on a phone. Android Chrome sends its own contextmenu event at about the
    // same time; that one cancels this timer so a handler runs once.
    let timer = 0;
    let at = { x: 0, y: 0 };
    let swallowClickUntil = 0;
    const stop = () => window.clearTimeout(timer);
    const onDown = (event: PointerEvent) => {
      stop();
      if (event.pointerType !== "touch" || !(event.target instanceof Element) || event.target.closest(NO_LONG_PRESS)) return;
      at = { x: event.clientX, y: event.clientY };
      const target = event.target;
      timer = window.setTimeout(() => {
        const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y });
        if (!target.dispatchEvent(menu)) swallowClickUntil = Date.now() + 700;
      }, LONG_PRESS_MS);
    };
    const onMove = (event: PointerEvent) => {
      if (Math.hypot(event.clientX - at.x, event.clientY - at.y) > LONG_PRESS_SLOP) stop();
    };
    const onNative = (event: Event) => {
      if (event.isTrusted) stop();
    };
    const onClick = (event: MouseEvent) => {
      if (Date.now() > swallowClickUntil) return;
      swallowClickUntil = 0;
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerup", stop, true);
    document.addEventListener("pointercancel", stop, true);
    document.addEventListener("contextmenu", onNative, true);
    document.addEventListener("click", onClick, true);
    return () => {
      stop();
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerup", stop, true);
      document.removeEventListener("pointercancel", stop, true);
      document.removeEventListener("contextmenu", onNative, true);
      document.removeEventListener("click", onClick, true);
    };
  }, []);
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
  useOutsideClose(open && !phone, () => [...document.querySelectorAll(".context-menu")], hide, layer.isTop);
  useEffect(() => {
    if (!open || phone) return;
    const close = () => hide();
    // A long menu scrolls inside itself (.context-menu max-height); only a scroll elsewhere moves its anchor.
    const onScroll = (event: Event) => {
      if (!(event.target instanceof Element && event.target.closest(".context-menu"))) hide();
    };
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [open, hide, phone]);
  if (!open) return null;
  if (phone) return <MenuSheet key={`${x}:${y}`} items={items} title={title} onClose={hide} />;
  return createPortal(
    <div className="context-menu-layer" onContextMenu={e => e.preventDefault()}>
      <MenuList key={`${x}:${y}`} items={items} onClose={hide} x={x} y={y} />
    </div>,
    document.body,
  );
}
