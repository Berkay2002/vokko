// A browser tab left open across a redeploy asks for chunk names the server no longer has. Vite reports every failed dynamic
// import in a build as `vite:preloadError`; the first one reloads the page, or, when that would lose something (an unsent draft,
// a call), shows a "Vokko was updated" banner instead. The desktop app bundles its assets, so it never needs this.
import { useSyncExternalStore } from "react";
import { hasUnsentDraft } from "../chat/draftStore";
import { isDesktop } from "../desktop/tauri";
import { getVoice } from "../voice/store";

const RELOADED_AT = "vokko.chunkReloadAt";
/** One automatic reload per minute: a chunk that is still missing after a reload shows the banner instead of looping. */
export const RELOAD_GUARD_MS = 60_000;

export type ChunkErrorAction = "reload" | "banner";

export function decideChunkError(o: { busy: boolean; lastReloadAt: number | null; now: number }): ChunkErrorAction {
  if (o.busy) return "banner";
  if (o.lastReloadAt !== null && o.now - o.lastReloadAt < RELOAD_GUARD_MS) return "banner";
  return "reload";
}

let handled = false;
let bannerShown = false;
const listeners = new Set<() => void>();

function lastReloadAt(): number | null {
  try {
    const n = Number(sessionStorage.getItem(RELOADED_AT));
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** React to the first stale-chunk error of this page load (later ones would only repeat the same decision). */
export function onChunkError(): void {
  if (handled) return;
  handled = true;
  const busy = hasUnsentDraft() || getVoice().channelId !== null || navigator.onLine === false; // offline: a reload would only show the browser's error page
  const now = Date.now();
  if (decideChunkError({ busy, lastReloadAt: lastReloadAt(), now }) === "reload") {
    try {
      sessionStorage.setItem(RELOADED_AT, String(now));
    } catch {
      // without sessionStorage the guard can't hold, so don't risk a reload loop
      showBanner();
      return;
    }
    location.reload();
  } else showBanner();
}

function showBanner(): void {
  bannerShown = true;
  listeners.forEach(l => l());
}

export function useStaleChunkBanner(): boolean {
  return useSyncExternalStore(
    l => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => bannerShown,
  );
}

/** The notice bar under the title bar when a reload was held back. */
export function StaleChunkBanner() {
  if (!useStaleChunkBanner()) return null;
  return (
    <div className="app-notice" role="status">
      <span>Vokko was updated.</span>
      <button type="button" className="app-notice-button" onClick={() => location.reload()}>
        Reload
      </button>
    </div>
  );
}

export function installStaleChunkReload(): void {
  if (isDesktop()) return;
  // Not preventDefault: the import still rejects, so the screen's own retry / error boundary runs as before.
  window.addEventListener("vite:preloadError", onChunkError);
}
