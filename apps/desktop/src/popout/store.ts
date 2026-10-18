// Which call's tile is popped out right now. Desktop: a separate window (`usePopoutStore`, set by openPopout and Rust's closed event).
// Web: a Document Picture-in-Picture window showing a second copy of the tile (`useWebPipStore`, webPip.tsx). The tiles that must go
// quiet while the other copy plays (WatchTile) ask `useQuiet`.

import { createContext, useContext } from "react";
import { create } from "zustand";
import type { Snowflake } from "../api/types";
import { call, callStrict } from "../desktop/tauri";
import type { PopoutKind } from "./protocol";

interface PopoutOpen {
  channelId: Snowflake | null;
  kind: PopoutKind | null;
}

const NONE: PopoutOpen = { channelId: null, kind: null };

/** The desktop pop-out window. */
export const usePopoutStore = create<PopoutOpen>()(() => NONE);

/** The web Document PiP window (the page's own copy of the tile lives in it). */
export const useWebPipStore = create<PopoutOpen & { win: Window | null }>()(() => ({ ...NONE, win: null }));

/** True inside the tile copy that lives in the PiP window. */
export const PipSurface = createContext(false);

/** True while another copy of `channelId`'s tile plays (the pop-out window, or the PiP copy when this is the page's own), so this one must not. */
export function useQuiet(channelId: Snowflake, kind: PopoutKind): boolean {
  const inPip = useContext(PipSurface);
  const popped = usePopoutStore(s => s.kind === kind && s.channelId === channelId);
  const pip = useWebPipStore(s => s.kind === kind && s.channelId === channelId);
  return popped || (pip && !inPip);
}

/** Opens the pop-out window for the call's tile (or brings it forward). Main starts relaying as soon as the store is set. */
export async function openPopout(channelId: Snowflake, kind: PopoutKind): Promise<void> {
  usePopoutStore.setState({ channelId, kind });
  try {
    await callStrict("desktop_popout_open", undefined, undefined);
  } catch (error) {
    console.warn("[popout] cannot open the window", error);
    usePopoutStore.setState(NONE);
  }
}

/** Closes the window; Rust's closed event (and this) put main back to playing the movie itself. */
export function closePopout(): void {
  usePopoutStore.setState(NONE);
  void call("desktop_popout_close", undefined, undefined);
}
