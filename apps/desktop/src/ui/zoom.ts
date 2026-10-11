import { isDesktop } from "../desktop/tauri";
import { DEFAULT_ZOOM, stepZoom } from "./a11y";

/**
 * Interface zoom. In the desktop shell the webview itself is zoomed (like the browser's own zoom: layout, viewport units and
 * popout positions stay consistent). In a plain browser tab there is no such API, so the fallback is CSS `zoom` on <body>,
 * with `--ui-zoom` for the rules in styles/a11y.css that keep the page filling the viewport.
 */

let lastWebviewZoom = 1;

export function applyZoom(percent: number): void {
  const factor = percent / 100;
  const root = document.documentElement;
  if (isDesktop()) {
    document.body.style.removeProperty("zoom");
    root.style.removeProperty("--ui-zoom");
    root.classList.remove("ui-zoomed");
    if (factor === lastWebviewZoom) return;
    lastWebviewZoom = factor;
    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) => getCurrentWebview().setZoom(factor))
      .catch(error => console.warn("[zoom] cannot set the webview zoom", error));
    return;
  }
  root.style.setProperty("--ui-zoom", String(factor));
  root.classList.toggle("ui-zoomed", factor !== 1);
  if (factor === 1) document.body.style.removeProperty("zoom");
  else document.body.style.zoom = String(factor);
}

/** A Ctrl/Cmd + `+`, `-` or `0` key press as a zoom change: the new zoom level, or null when the event is not a zoom shortcut. */
export function zoomFromKey(event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey">, current: number): number | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  const { key, code } = event;
  if (key === "+" || key === "=" || code === "NumpadAdd" || code === "Equal") return stepZoom(current, 1);
  if (key === "-" || key === "_" || code === "NumpadSubtract" || code === "Minus") return stepZoom(current, -1);
  if (key === "0" || code === "Digit0" || code === "Numpad0") return DEFAULT_ZOOM;
  return null;
}

/** Ctrl +/-/0 zoom the interface. Returns the teardown. `get`/`set` read and write the saved zoom level. */
export function installZoomShortcuts(get: () => number, set: (percent: number) => void): () => void {
  const onKey = (event: KeyboardEvent) => {
    const next = zoomFromKey(event, get());
    if (next === null) return;
    event.preventDefault();
    set(next);
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}
