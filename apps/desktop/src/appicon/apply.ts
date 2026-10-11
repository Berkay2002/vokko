import { callStrict } from "../desktop/tauri";
import { getPrefs, usePrefs } from "../ui/prefs";
import { DEFAULT_APP_ICON } from "./variants";

/**
 * Window, tray and Dock follow the `appIcon` pref. Rust starts on the default icon, so only a different choice is sent.
 * `sent` moves only after the shell accepted it, so a failed apply is retried on the next pref change. One call at a
 * time keeps quick picks in order. No-op outside Tauri.
 */
let sent: string = DEFAULT_APP_ICON;
let wanted: string = DEFAULT_APP_ICON;
let busy = false;

async function flush(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    while (sent !== wanted) {
      const id = wanted;
      try {
        await callStrict<void>("desktop_set_app_icon", { id }, undefined);
      } catch (error) {
        console.warn("[desktop] cannot apply the app icon", error);
        return;
      }
      sent = id;
    }
  } finally {
    busy = false;
  }
}

function apply(id: string): void {
  wanted = id;
  void flush();
}

apply(getPrefs().appIcon);
usePrefs.subscribe(prefs => apply(prefs.appIcon));
