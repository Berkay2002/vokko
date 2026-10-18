// Discord-style auto-hide for the call stage while a Stremio picture plays: after IDLE_HIDE_MS without the pointer moving, the stage
// gets `data-idle` and the CSS fades the Stremio title / bar and the call bar out. bindIdleHide is the DOM-free part (the tests drive
// it with a plain EventTarget); useIdleHide wires it to a stage element.

import { useEffect, type RefObject } from "react";
import type { Snowflake } from "../api/types";
import { hasOpenLayer, usePhone } from "../ui";
import { useVoice } from "./store";

export const IDLE_HIDE_MS = 3000;

/** The bars: the pointer over one, or keyboard focus inside one, keeps everything shown. */
const BARS = ".stremio-bar, .stremio-notice, .voice-bar, .dm-call-bar";
const inBars = (suffix: string) => BARS.split(", ").map(b => b + suffix).join(", ");
const OPEN_IN_BARS = inBars(' [aria-expanded="true"]');
/** A pointer that was already resting on a bar when the picture started playing never moved, so it is asked for. */
const HOVERED_BARS = inBars(":hover");

interface IdleHideOptions {
  /** True for a target inside a bar. */
  isBar(target: EventTarget | null): boolean;
  /** True while a menu, popover, picker or focused bar control should keep the stage shown. */
  held(): boolean;
  set(idle: boolean): void;
  ms?: number;
}

type Pointer = Event & { clientX?: number; clientY?: number };

/** Listens on `stage`; returns the dispose function (which also shows everything again). */
export function bindIdleHide(stage: EventTarget, { isBar, held, set, ms = IDLE_HIDE_MS }: IdleHideOptions): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let overBar = false;
  let at = "";
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => (overBar || held() ? arm() : set(true)), ms);
  };
  const wake = () => {
    set(false);
    arm();
  };
  const move = (e: Event) => {
    const p = e as Pointer;
    // Chrome repeats the last pointer position when the layout under a resting mouse changes: that is not movement.
    const now = `${p.clientX},${p.clientY}`;
    if (e.type === "pointermove" && now === at) return;
    at = now;
    overBar = isBar(e.target);
    wake();
  };
  const leave = () => {
    overBar = false;
    clearTimeout(timer);
    if (held()) arm();
    else set(true);
  };
  stage.addEventListener("pointermove", move);
  stage.addEventListener("pointerdown", move);
  stage.addEventListener("pointerenter", move);
  stage.addEventListener("pointerleave", leave);
  stage.addEventListener("keydown", wake);
  stage.addEventListener("focusin", wake);
  arm();
  return () => {
    clearTimeout(timer);
    stage.removeEventListener("pointermove", move);
    stage.removeEventListener("pointerdown", move);
    stage.removeEventListener("pointerenter", move);
    stage.removeEventListener("pointerleave", leave);
    stage.removeEventListener("keydown", wake);
    stage.removeEventListener("focusin", wake);
    set(false);
  };
}

/** Keyboard focus (not a mouse click's leftover focus) on a bar control. */
function focusInBar(stage: Element): boolean {
  const active = document.activeElement;
  if (!active || !stage.contains(active) || !active.closest(BARS)) return false;
  try {
    return active.matches(":focus-visible");
  } catch {
    return true;
  }
}

/** Hides the bars of `stage` (via `data-idle`) while the channel's Stremio picture plays; never on a phone. */
export function useIdleHide(stage: RefObject<HTMLElement | null>, channelId: Snowflake): void {
  const playing = useVoice(s => s.stremio[channelId]?.status === "playing" && s.stremio[channelId]?.playing === true);
  const phone = usePhone();
  const active = playing && !phone;
  useEffect(() => {
    const el = stage.current;
    if (!el || !active) return;
    return bindIdleHide(el, {
      isBar: t => t instanceof Element && !!t.closest(BARS),
      held: () => hasOpenLayer() || !!el.querySelector(HOVERED_BARS) || !!el.querySelector(`.stremio-queue, [role="menu"], ${OPEN_IN_BARS}`) || !!document.querySelector('[role="dialog"], [role="menu"]') || focusInBar(el),
      set: idle => el.toggleAttribute("data-idle", idle),
    });
  }, [stage, active]);
}
