import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap, useLayer, useOutsideClose } from "./layers";
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
  /** Move focus in and keep Tab inside; for a popout opened over a dialog, whose own focus trap would otherwise keep the keyboard out. */
  trapFocus?: boolean;
  children: ReactNode;
}

function resolve(anchor: PopoutProps["anchor"]): HTMLElement | null {
  if (!anchor) return null;
  return anchor instanceof HTMLElement ? anchor : anchor.current;
}

/** Floating panel anchored to an element: closes on Escape and on outside clicks (the anchor itself is "inside"). */
export function Popout({ anchor, open, onClose, side = "bottom", align = "center", gap = 8, className, style, role, label, trapFocus, children }: PopoutProps) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const layer = useLayer(open, onClose);
  useOutsideClose(open, () => [box.current, resolve(anchor)], onClose, layer.isTop);
  // Only once placed: the box is visibility:hidden until then and cannot take focus.
  useFocusTrap(open && !!trapFocus && pos !== null, () => box.current);

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
    return () => window.removeEventListener("resize", place);
  }, [open, anchor, side, align, gap, children]);

  if (!open) return null;
  return createPortal(
    <div ref={box} role={role} aria-label={label} className={`popout ${className ?? ""}`} style={{ ...style, left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? "visible" : "hidden" }}>
      {children}
    </div>,
    document.body,
  );
}
