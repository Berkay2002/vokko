// Full screen of a game tile: element fullscreen of the tile (header strip and game box, never the call controls), and in the
// desktop app the native window goes borderless too (covers the taskbar) and gets its old state back on exit. The document's
// `fullscreenchange` is the one source of truth, so the button, a double click on the header, Escape and the game's own
// full screen request all end up in the same place.

import { useCallback, useEffect, useRef, useState } from "react";
import { setWindowFullscreen } from "../desktop/windowControls";

const GAME_FRAME = "iframe.game-frame";
const GAME_TILE = "[data-game-tile]";

/**
 * Whether a game owns the keyboard: its frame has focus, or its tile is full screen. The app's own shortcuts (and the call
 * stage's Escape) must not take keys then; the game gets them first and Escape leaves full screen by itself.
 */
export function gameOwnsKeys(active: Element | null = globalThis.document?.activeElement ?? null, full: Element | null = globalThis.document?.fullscreenElement ?? null): boolean {
  return !!active?.matches(GAME_FRAME) || !!full?.matches(GAME_TILE);
}

/** Puts keyboard focus in the game's frame (a click on a frame does it too; this is for the first key after load or a button). */
export function focusGame(tile: Element | null): void {
  tile?.querySelector<HTMLElement>(GAME_FRAME)?.focus();
}

export function useGameFullscreen() {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  const was = useRef(false);

  useEffect(() => {
    const sync = () => {
      const on = !!ref.current && document.fullscreenElement === ref.current;
      if (on === was.current) return;
      was.current = on;
      setActive(on);
      void setWindowFullscreen(on);
      if (on) focusGame(ref.current);
    };
    document.addEventListener("fullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      // The tile left the page while full screen (the browser leaves element fullscreen by itself): give the window back.
      if (was.current) void setWindowFullscreen(false);
    };
  }, []);

  const toggle = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (document.fullscreenElement === el) return void document.exitFullscreen().catch(() => undefined);
    // The window first: the desktop shell already makes it full screen for an element that goes full screen, but a maximized
    // window then keeps its webview at the work-area size, so setWindowFullscreen restores it before the element asks.
    void setWindowFullscreen(true)
      .then(() => el.requestFullscreen())
      .catch(() => setWindowFullscreen(false));
  }, []);

  return { ref, active, toggle };
}
