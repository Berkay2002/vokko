// Keyboard of the pop-out: Space plays or pauses, Left and Right jump 10 s, for the session's controller only (the same rule as the
// call's full screen). Everyone else gets nothing: they cannot change the picture, so a key must not look like it does.

import { JUMP_MS, type PopoutAction } from "./protocol";

export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  defaultPrevented?: boolean;
  /** Where the key went: an element (a DOM event's target) or anything else. */
  target?: object | null;
}

/** Typing into something keeps its keys. A range slider (seek, volume) does not: the pop-out wants its arrows and Space. */
function typing(raw: KeyLike["target"]): boolean {
  const target = raw as { tagName?: string; type?: string; isContentEditable?: boolean } | null | undefined;
  const tag = target?.tagName?.toUpperCase();
  return tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable === true || (tag === "INPUT" && target?.type !== "range");
}

/** True for the keys the pop-out answers: the caller prevents their default (a focused button would otherwise click on Space). */
export function popoutKeyAction(event: KeyLike, controller: boolean, playing: boolean): PopoutAction | null {
  // A held key repeats: Space would flip play and pause at that rate and the arrows would flood the server with seeks.
  if (!controller || event.repeat || event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return null;
  if (typing(event.target)) return null;
  switch (event.key) {
    case " ":
    case "Spacebar":
      return { type: "playing", on: !playing };
    case "ArrowLeft":
      return { type: "jump", deltaMs: -JUMP_MS };
    case "ArrowRight":
      return { type: "jump", deltaMs: JUMP_MS };
    default:
      return null;
  }
}
