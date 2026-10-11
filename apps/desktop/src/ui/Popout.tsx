import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useLayer, useOutsideClose } from "./layers";
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
  children: ReactNode;
}

function resolve(anchor: PopoutProps["anchor"]): HTMLElement | null {
  if (!anchor) return null;
  return anchor instanceof HTMLElement ? anchor : anchor.current;
}

/** Floating panel anchored to an element: closes on Escape and on outside clicks (the anchor itself is "inside"). */
export function Popout({ anchor, open, onClose, side = "bottom", align = "center", gap = 8, className, style, children }: PopoutProps) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const layer = useLayer(open, onClose);
  useOutsideClose(open, () => [box.current, resolve(anchor)], onClose, layer.isTop);

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
    <div ref={box} className={`popout ${className ?? ""}`} style={{ ...style, left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? "visible" : "hidden" }}>
      {children}
    </div>,
    document.body,
  );
}
