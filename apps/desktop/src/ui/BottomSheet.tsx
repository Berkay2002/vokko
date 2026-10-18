import { useEffect, useRef, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useBackClose } from "./backHistory";
import { useFocusTrap, useLayer, useOutsideClose } from "./layers";
import "./sheet.css";

/** Same breakpoint as the phone layout in styles/responsive.css. */
export const PHONE_QUERY = "(max-width: 767px)";

/** True at phone widths: menus and pickers that are popovers on desktop render as a BottomSheet there. */
export function usePhone(): boolean {
  return useSyncExternalStore(
    notify => {
      const list = window.matchMedia(PHONE_QUERY);
      list.addEventListener("change", notify);
      return () => list.removeEventListener("change", notify);
    },
    () => window.matchMedia(PHONE_QUERY).matches,
    () => false,
  );
}

export interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name of the dialog. */
  label: string;
  className?: string;
  /** Docked under the composer instead of over a dimmed page: the chat shifts up so the composer stays visible (emoji/GIF/sticker pickers). Taps outside close it, except on `anchor`. */
  dock?: boolean;
  anchor?: HTMLElement | null | RefObject<HTMLElement | null>;
  children: ReactNode;
}

const resolve = (anchor: BottomSheetProps["anchor"]): HTMLElement | null => (!anchor ? null : anchor instanceof HTMLElement ? anchor : anchor.current);

/** A touch frees the finger after a long press: the mouse events that follow must not hit the backdrop of the sheet that press opened. */
const GUARD_MS = 350;

/** The one bottom sheet: rounded top corners, grabber (drag or tap down to close), backdrop, safe-area padding, 90dvh max with scrolling. */
export function BottomSheet({ open, onClose, label, className, dock, anchor, children }: BottomSheetProps) {
  const box = useRef<HTMLDivElement>(null);
  const openedAt = useRef(0);
  const startY = useRef<number | null>(null);
  const layer = useLayer(open, onClose);
  useBackClose(open, onClose);
  useFocusTrap(open && !dock, () => box.current);
  useOutsideClose(open && !!dock, () => [box.current, resolve(anchor)], onClose, layer.isTop);

  useEffect(() => {
    if (!open) return;
    openedAt.current = Date.now();
    if (!dock) return;
    document.documentElement.classList.add("sheet-docked");
    return () => document.documentElement.classList.remove("sheet-docked");
  }, [open, dock]);

  if (!open) return null;
  const closeFromBackdrop = () => {
    if (Date.now() - openedAt.current > GUARD_MS && layer.isTop()) onClose();
  };
  return createPortal(
    <div className={`sheet-layer${dock ? " dock" : ""}`}>
      {!dock && <div className="sheet-backdrop" onMouseDown={closeFromBackdrop} />}
      <div ref={box} className={`sheet ${className ?? ""}`} role="dialog" aria-modal={dock ? undefined : true} aria-label={label} tabIndex={-1}>
        <div
          className="sheet-grabber"
          onClick={onClose}
          onTouchStart={e => { startY.current = e.touches[0]?.clientY ?? null; }}
          onTouchMove={e => {
            const y = e.touches[0]?.clientY;
            if (startY.current !== null && y !== undefined && y - startY.current > 48) {
              startY.current = null;
              onClose();
            }
          }}
          aria-hidden="true"
        >
          <span />
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
