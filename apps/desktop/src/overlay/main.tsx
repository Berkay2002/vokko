// Entry of the in-game overlay window (overlay.html, created by src-tauri/src/overlay.rs). A small page of its own: no gateway, no
// stores, no app shell; it draws what the main window sends (src/overlay/bridge.ts) and sends its button presses back.
// Outside Tauri (Playwright, `vite` in a browser) `window.__overlay` drives it and actions land in `window.__overlayActions`.

import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import "@fontsource/noto-sans/latin-400.css";
import "@fontsource/noto-sans/latin-600.css";
import { Overlay } from "./Overlay";
import { ACTION_EVENT, INTERACTIVE_EVENT, READY_EVENT, STATE_EVENT, type OverlayAction, type OverlayState } from "./protocol";
import "./overlay.css";

interface Harness {
  setState(state: OverlayState): void;
  setInteractive(on: boolean): void;
}

declare global {
  interface Window {
    __overlay?: Harness;
    __overlayActions?: OverlayAction[];
  }
}

const TAURI = isTauri();

function setInteractiveMode(on: boolean): void {
  if (TAURI) void invoke("desktop_overlay_set_interactive", { on }).catch(() => undefined);
}

function App() {
  const [state, setState] = useState<OverlayState | null>(null);
  const [interactive, setInteractive] = useState(false);

  useEffect(() => {
    if (!TAURI) {
      window.__overlayActions = [];
      window.__overlay = { setState, setInteractive };
      return;
    }
    const stops = [listen<OverlayState>(STATE_EVENT, e => setState(e.payload)), listen<boolean>(INTERACTIVE_EVENT, e => setInteractive(e.payload))];
    void Promise.all(stops).then(() => emit(READY_EVENT, null));
    return () => stops.forEach(stop => void stop.then(fn => fn()));
  }, []);

  useEffect(() => {
    if (!interactive) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (TAURI) setInteractiveMode(false);
      else setInteractive(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [interactive]);

  const onAction = (action: OverlayAction) => {
    if (!TAURI) {
      window.__overlayActions?.push(action);
      return;
    }
    void emit(ACTION_EVENT, action);
    // Opening a message brings Vokko forward (and leaves interactive mode); Rust does it, the main page navigates.
    if (action.type === "open") void invoke("desktop_overlay_open_main").catch(() => undefined);
  };

  return <Overlay state={state} interactive={interactive} onAction={onAction} onExit={() => (TAURI ? setInteractiveMode(false) : setInteractive(false))} />;
}

const root = document.getElementById("root");
if (root) ReactDOM.createRoot(root).render(<App />);
