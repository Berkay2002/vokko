// The pop-out window's label (src-tauri/src/popout.rs POPOUT_WINDOW) and what the pop-out page asks Rust for.

import { call } from "../desktop/tauri";

export const POPOUT_WINDOW = "popout";

export const setPinned = (on: boolean): Promise<void> => call("desktop_popout_pin", { on }, undefined);
/** Close button: only the pop-out goes; main plays the movie itself again. */
export const closeWindow = (): Promise<void> => call("desktop_popout_close", undefined, undefined);
/** Back to call: the main window comes forward and the pop-out closes (Rust); main navigates to the call on the `back` action. */
export const backToCall = (): Promise<void> => call("desktop_popout_back", undefined, undefined);
