// Full screen of the call page and the media query the Stremio "cinema" layout depends on. The page goes full screen as the whole
// document (not as its own element) so the portalled tooltips, menus and popouts, which live in <body>, stay visible; the cinema CSS
// makes the call page cover the app. The document's `fullscreenchange` is the one source of truth (the button, Escape and the
// browser's own exit all end up there), like the game tile's (../games/fullscreen.ts).

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Snowflake } from "../api/types";
import { setWindowFullscreen } from "../desktop/windowControls";
import { STREMIO_TILE_ID } from "../stremio";
import { focusForFullscreen, inPageFullscreen } from "./fullscreenFocus";
import { useVoice } from "./store";
import { useVoiceUi } from "./uiStore";

/** A phone on its side. The width breakpoint of usePhone does not match a phone at 844x390, so the landscape layout has its own query. */
export const LANDSCAPE_QUERY = "(orientation: landscape) and (max-height: 500px)";

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    notify => {
      const list = window.matchMedia(query);
      list.addEventListener("change", notify);
      return () => list.removeEventListener("change", notify);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Full screen of the call page (and the native window in the desktop app). Entering focuses the channel's Stremio tile when there is a session. */
export function useVoiceFullscreen(channelId: Snowflake): { fullscreen: boolean; toggle(): void } {
  const [fullscreen, setFullscreen] = useState(false);
  const was = useRef(false);
  const restore = useRef<(() => void) | null>(null);
  const hasStremio = useVoice(s => !!s.stremio[channelId]);
  const available = useRef(hasStremio);
  available.current = hasStremio;

  const giveBack = useCallback(() => {
    restore.current?.();
    restore.current = null;
  }, []);

  useEffect(() => {
    const sync = () => {
      const on = inPageFullscreen();
      if (on === was.current) return;
      was.current = on;
      setFullscreen(on);
      void setWindowFullscreen(on);
      if (!on) giveBack();
      // The button that was clicked must not keep the keys (Space would click it again): the picture and its keys take over.
      else (document.activeElement as HTMLElement | null)?.blur?.();
    };
    document.addEventListener("fullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      // The page left while full screen (the call ended): give the window and the focus back.
      if (was.current) {
        was.current = false;
        void setWindowFullscreen(false);
        giveBack();
        if (inPageFullscreen()) void document.exitFullscreen().catch(() => undefined);
      }
    };
  }, [giveBack]);

  const toggle = useCallback(() => {
    if (inPageFullscreen()) return void document.exitFullscreen().catch(() => undefined);
    restore.current = focusForFullscreen(() => useVoiceUi.getState(), STREMIO_TILE_ID, available.current);
    // The window first: a maximized window keeps its webview at the work-area size otherwise (see setWindowFullscreen).
    void setWindowFullscreen(true)
      .then(() => document.documentElement.requestFullscreen())
      .catch(() => {
        void setWindowFullscreen(false);
        giveBack();
      });
  }, [giveBack]);

  return { fullscreen, toggle };
}
