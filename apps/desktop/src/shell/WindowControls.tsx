import { useEffect, useState } from "react";
import { create } from "zustand";
import { closeWindow, minimizeWindow, toggleMaximizeWindow, useWindowChrome, watchMaximized } from "../desktop/windowControls";

/** Minimize, maximize / restore and close, drawn by the page when the shell removed the OS frame (Windows, Linux). */
export function WindowControls() {
  const chrome = useWindowChrome();
  const [maximized, setMaximized] = useState(false);
  const active = chrome?.customControls === true;
  useEffect(() => {
    if (!active) return;
    let stop: (() => void) | null = null;
    let live = true;
    void watchMaximized(setMaximized).then(unlisten => {
      if (live) stop = unlisten;
      else unlisten();
    });
    return () => {
      live = false;
      stop?.();
    };
  }, [active]);
  if (!active) return null;
  return (
    <div className="window-controls" role="group" aria-label="Window controls" data-testid="window-controls">
      <button type="button" className="window-control" aria-label="Minimize" onClick={() => void minimizeWindow()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5.5h10" stroke="currentColor" strokeWidth="1" fill="none" />
        </svg>
      </button>
      <button type="button" className="window-control" aria-label={maximized ? "Restore" : "Maximize"} onClick={() => void toggleMaximizeWindow()}>
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2.5 2.5v-2h7v7h-2M0.5 2.5h7v7h-7z" stroke="currentColor" strokeWidth="1" fill="none" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1" fill="none" />
          </svg>
        )}
      </button>
      <button type="button" className="window-control window-control-close" aria-label="Close" onClick={() => void closeWindow()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" fill="none" />
        </svg>
      </button>
    </div>
  );
}

/** How many title bars are mounted: the shell's own bar carries the controls, other screens get `WindowFrame`. */
const useTitleBars = create<{ count: number }>(() => ({ count: 0 }));

export function useRegisterTitleBar(): void {
  useEffect(() => {
    useTitleBars.setState(s => ({ count: s.count + 1 }));
    return () => useTitleBars.setState(s => ({ count: s.count - 1 }));
  }, []);
}

/** A drag strip with the window buttons for screens without the shell title bar (sign-in, splash, invite page). */
export function WindowFrame() {
  const bars = useTitleBars(s => s.count);
  const chrome = useWindowChrome();
  if (bars > 0 || chrome?.customControls !== true) return null;
  return (
    <div className="window-frame" data-tauri-drag-region="deep">
      <WindowControls />
    </div>
  );
}
