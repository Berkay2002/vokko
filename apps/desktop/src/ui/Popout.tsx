import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ROVING_ITEMS, rovingKey, useFocusTrap, useLayer, useOutsideClose } from "./layers";
import { useBackClose } from "./backHistory";
import { BottomSheet, usePhone } from "./BottomSheet";
import { placeNear, type Align, type Side } from "./position";

export interface PopoutProps {
  /** Element the popout attaches to (state value from a callback ref, or a ref object). */
  anchor: HTMLElement | null | RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  side?: Side;
  align?: Align;
  gap?: number;
  className?: string;
  style?: CSSProperties;
  /** Landmark role and name for popouts that are dialogs rather than plain panels. */
  role?: "dialog";
  label?: string;
  /**
   * Move focus in (a search field first), keep Tab inside and give focus back to the opener on close; on by default, as in Discord.
   * Off for a popout that follows a text field the user keeps typing in (search suggestions).
   */
  trapFocus?: boolean;
  /** Focus the panel itself on open instead of its first control (the first Tab goes in), as Discord's profile card does. */
  focusSelf?: boolean;
  /** At phone widths render as a BottomSheet with this accessible name instead of a floating panel (the placement props are ignored there). */
  sheet?: string;
  children: ReactNode;
}

const SEARCH_FIELD = 'input[type="search"], input[type="text"], input:not([type])';

function resolve(anchor: PopoutProps["anchor"]): HTMLElement | null {
  if (!anchor) return null;
  return anchor instanceof HTMLElement ? anchor : anchor.current;
}

/** Floating panel anchored to an element: closes on Escape and on outside clicks (the anchor itself is "inside"). */
export function Popout({ anchor, open, onClose, side = "bottom", align = "center", gap = 8, className, style, role, label, trapFocus = true, focusSelf, sheet, children }: PopoutProps) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const phone = usePhone();
  const asSheet = !!sheet && phone;
  const layer = useLayer(open && !asSheet, onClose);
  useBackClose(open && !asSheet, onClose);
  useOutsideClose(open && !asSheet, () => [box.current, resolve(anchor)], onClose, layer.isTop);
  // Focus moves in only once placed: the box is visibility:hidden until then and cannot take focus.
  useFocusTrap(open && trapFocus && !asSheet, () => box.current, pos !== null, focusSelf ? null : SEARCH_FIELD);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const target = resolve(anchor);
      const el = box.current;
      if (!target || !el) return;
      const { left, top } = placeNear(target.getBoundingClientRect(), el.offsetWidth, el.offsetHeight, side, gap, align);
      setPos({ left, top });
    };
    place();
    window.addEventListener("resize", place);
    // Content that loads after opening (Inbox previews) changes the height: a popout above its anchor must move up with it.
    const grow = typeof ResizeObserver === "undefined" || !box.current ? null : new ResizeObserver(place);
    if (box.current) grow?.observe(box.current);
    return () => {
      window.removeEventListener("resize", place);
      grow?.disconnect();
    };
  }, [open, anchor, side, align, gap, children]);

  if (!open) return null;
  // the classes go on an inner box: the card keeps its own look (banner, absolutely placed avatar) inside the sheet
  if (asSheet) return <BottomSheet open onClose={onClose} label={sheet}><div className={`popout-sheet ${className ?? ""}`} style={{ ...style, width: undefined }}>{children}</div></BottomSheet>;
  return createPortal(
    <div ref={box} role={role} aria-label={label} tabIndex={focusSelf ? -1 : undefined} className={`popout ${className ?? ""}`} style={{ ...style, left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? "visible" : "hidden" }}
      onKeyDown={e => !e.defaultPrevented && rovingKey(e, [...e.currentTarget.querySelectorAll<HTMLElement>(ROVING_ITEMS)])}>
      {children}
    </div>,
    document.body,
  );
}
