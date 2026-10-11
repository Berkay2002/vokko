import { call } from "./tauri";
import { getPrefs, setPref, usePrefs } from "../ui/prefs";

/** True while OBS or other streaming software runs (desktop only; false in the browser). */
export function streamingSoftwareRunning(): Promise<boolean> {
  return call<boolean>("desktop_streaming_software_running", undefined, false);
}

/** Keeps the window out of screen captures (content protection). No-op in the browser. */
export function setCaptureHidden(hidden: boolean): Promise<void> {
  return call<void>("desktop_set_capture_hidden", { hidden }, undefined);
}

/** Restarts the desktop app (hardware acceleration changes). */
export function restartApp(): Promise<void> {
  return call<void>("desktop_restart", undefined, undefined);
}

const POLL_MS = 15_000;

/**
 * Streamer mode on the desktop: "automatically enable/disable" follows streaming software (only flips when the detection result
 * changes, so a manual toggle sticks until OBS starts or stops), and "hide window from screen capture" follows the mode.
 */
export function initStreamerMode(): () => void {
  let lastDetected: boolean | null = null;
  const poll = async () => {
    if (!getPrefs().streamerAutoEnable) {
      lastDetected = null;
      return;
    }
    const detected = await streamingSoftwareRunning();
    if (detected !== lastDetected) {
      lastDetected = detected;
      if (getPrefs().streamerMode !== detected) setPref("streamerMode", detected);
    }
  };
  const timer = setInterval(() => void poll(), POLL_MS);
  void poll();

  let hidden: boolean | null = null;
  const applyCapture = () => {
    const prefs = getPrefs();
    const next = prefs.streamerMode && prefs.streamerHideWindow;
    if (next === hidden) return;
    hidden = next;
    void setCaptureHidden(next);
  };
  applyCapture();
  const stop = usePrefs.subscribe((prefs, previous) => {
    applyCapture();
    if (prefs.streamerAutoEnable && !previous.streamerAutoEnable) void poll();
  });
  return () => {
    clearInterval(timer);
    stop();
  };
}
