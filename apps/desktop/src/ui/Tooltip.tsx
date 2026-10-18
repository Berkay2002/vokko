import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { placeNear, type Side } from "./position";

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: Side;
  /** Delay before showing, ms. */
  delay?: number;
  disabled?: boolean;
  /** Extra class on the bubble, e.g. `tooltip-lg` for the 16/20 rail variant. */
  className?: string;
  /** Distance from the trigger, px. */
  gap?: number;
}

// Last input was a key. Chrome marks script focus as :focus-visible too, so a popout opened by a click that moves focus onto a
// tooltip trigger (the profile card's In voice info icon) would otherwise open that tooltip with no hover.
let keyed = false;
if (typeof document !== "undefined") {
  document.addEventListener("keydown", () => (keyed = true), true);
  document.addEventListener("pointerdown", () => (keyed = false), true);
}

/** Keyboard focus only: a click or tap also focuses the trigger, and that must not bring the tooltip back over what it opened. */
function keyboardFocus(target: EventTarget): boolean {
  try {
    return keyed && target instanceof Element && target.matches(":focus-visible");
  } catch {
    return true;
  }
}

/** Hover (mouse only) / keyboard-focus tooltip; a press hides it. Wraps its children in a layout-neutral element (`display: contents`). */
export function Tooltip({ content, children, side = "top", delay = 120, disabled, className, gap = 8 }: TooltipProps) {
  const wrapper = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; side: Side } | null>(null);
  const id = useId();

  const show = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), delay);
  }, [delay]);
  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setOpen(false);
    setPos(null);
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const target = wrapper.current?.firstElementChild;
    const el = bubble.current;
    if (!target || !el) return;
    const rect = target.getBoundingClientRect();
    setPos(placeNear(rect, el.offsetWidth, el.offsetHeight, side, gap));
  }, [open, side, content, gap]);

  const visible = open && !disabled && content !== null && content !== undefined && content !== "";
  return (
    <span
      ref={wrapper}
      style={{ display: "contents" }}
      onPointerEnter={e => e.pointerType === "mouse" && show()}
      onPointerLeave={hide}
      onPointerDown={hide}
      onFocus={e => keyboardFocus(e.target) && show()}
      onBlur={hide}
      aria-describedby={visible ? id : undefined}
    >
      {children}
      {visible &&
        createPortal(
          <div
            ref={bubble}
            id={id}
            role="tooltip"
            className={`tooltip tooltip-${pos?.side ?? side}${className ? ` ${className}` : ""}`}
            style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? "visible" : "hidden" }}
          >
            {content}
            <span className="tooltip-pointer" />
          </div>,
          document.body,
        )}
    </span>
  );
}
