import { call, callStrict } from "./tauri";

/** Whether Vokko is registered to start with the OS ("Open Vokko" in Discord's Windows settings). False outside Tauri. */
export function getAutostart(): Promise<boolean> {
  return call<boolean>("desktop_autostart_status", undefined, false);
}

/** Turns run-on-startup on or off and resolves to the resulting state. Rejects with the OS error if registration fails. */
export function setAutostart(enabled: boolean): Promise<boolean> {
  return callStrict<boolean>("desktop_autostart_set", { enabled }, false);
}
