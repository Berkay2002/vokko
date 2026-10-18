// Keyboard of the pop-out: Space plays or pauses, Left and Right jump 10 s, for the session's controller only. The rule (controller, no
// modifiers, no key repeat, not while typing, not on a focused button that clicks on Space) is the call's full-screen one: stremio/keys.ts.

import { stremioKey, type KeyLike } from "../stremio/keys";
import { JUMP_MS, type PopoutAction } from "./protocol";

export type { KeyLike };

/** The action a key means, or null. The caller prevents the default of a key that returns one. The pop-out is always "full screen" and has no menus. */
export function popoutKeyAction(event: KeyLike, controller: boolean, playing: boolean): PopoutAction | null {
  // A held arrow would send a jump per repeat (stremioKey only guards Space).
  if (event.repeat) return null;
  switch (stremioKey(event, { controller, fullscreen: true, blocked: false })) {
    case "toggle":
      return { type: "playing", on: !playing };
    case "back":
      return { type: "jump", deltaMs: -JUMP_MS };
    case "forward":
      return { type: "jump", deltaMs: JUMP_MS };
    default:
      return null;
  }
}
