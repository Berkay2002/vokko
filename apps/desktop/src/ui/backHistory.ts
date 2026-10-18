// Phone overlays (settings, sheets, dialogs, the details and search pages) own a browser history entry while they are open, so the iOS
// swipe-back, Android back and the browser back button close them instead of leaving the app. One stack for all of them: the entries
// are tagged with their depth in history.state (next to react-router's own state, the URL never changes), and a reconcile pass keeps
// the number of tagged entries equal to the number of open overlays. Closing one in the UI pops its entry; a back press closes the
// overlays above the entry it lands on. Wider windows (desktop, Tauri) never push anything.

import { useEffect, useRef } from "react";
import { PHONE_QUERY } from "./BottomSheet";

const KEY = "vokkoOverlay";

interface Entry {
  onBack: () => void;
  /** Its history entry was consumed by a back press; it is closing (or refused to, see `onPop`). */
  popped: boolean;
}

const open: Entry[] = [];
let scheduled = false;
/** A history.go of ours is in flight: its popstate only reconciles, it closes nothing. */
let going = false;
let installed = false;

function depth(): number {
  const state: unknown = window.history.state;
  const value = state && typeof state === "object" ? (state as Record<string, unknown>)[KEY] : undefined;
  return typeof value === "number" ? value : 0;
}

function reconcile(): void {
  scheduled = false;
  if (going) return;
  const want = open.filter(e => !e.popped).length;
  let have = depth();
  if (have > want) {
    going = true;
    window.history.go(want - have);
    return;
  }
  const base: unknown = window.history.state;
  while (have < want) {
    have += 1;
    window.history.pushState({ ...(base && typeof base === "object" ? base : {}), [KEY]: have }, "", window.location.href);
  }
}

/** Overlays open and close in the same commit when one replaces another (a menu sheet opening a dialog): settle once after it. */
function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(reconcile);
}

function onPop(event: PopStateEvent): void {
  // Synthetic popstates (oauth.ts, deeplinks.ts, tests) only tell react-router about a pushState; they are not a back press.
  if (!event.isTrusted) return;
  if (going) {
    going = false;
    schedule();
    return;
  }
  const keep = depth();
  const live = open.filter(e => !e.popped);
  const closing = live.slice(keep).reverse();
  for (const entry of closing) {
    entry.popped = true;
    entry.onBack();
  }
  // ponytail: an overlay that refuses to close (unsaved changes) gets its entry back after its exit animation would have finished.
  if (closing.length) window.setTimeout(() => (closing.forEach(e => (e.popped = false)), schedule()), 400);
  schedule();
}

/** While `active` on a phone-width window, back (gesture, hardware or browser button) calls `onBack` instead of leaving the page. */
export function useBackClose(active: boolean, onBack: () => void): void {
  const handler = useRef(onBack);
  handler.current = onBack;
  useEffect(() => {
    if (!active || !window.matchMedia(PHONE_QUERY).matches) return;
    if (!installed) {
      installed = true;
      window.addEventListener("popstate", onPop);
    }
    const entry: Entry = { onBack: () => handler.current(), popped: false };
    open.push(entry);
    schedule();
    return () => {
      open.splice(open.indexOf(entry), 1);
      schedule();
    };
  }, [active]);
}
