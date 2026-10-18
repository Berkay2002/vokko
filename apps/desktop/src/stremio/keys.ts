// Full-screen keys of the Stremio tile: Space plays / pauses, Left / Right go back / forward 10 s. Only the session's controller gets them
// (everyone else's keys do nothing), only while the page is full screen, and never while typing or while a menu / dialog owns the keys.
// DOM-free (the tests pass plain objects).

export type StremioKey = "toggle" | "back" | "forward";

export interface KeyLike {
  key: string;
  target: unknown;
  defaultPrevented?: boolean;
  repeat?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

interface Ctx {
  controller: boolean;
  fullscreen: boolean;
  /** A popout, menu or dialog is open. */
  blocked: boolean;
}

const TYPING = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const CLICKS_ON_SPACE = new Set(["BUTTON", "A", "SUMMARY"]);

export function stremioKey(e: KeyLike, { controller, fullscreen, blocked }: Ctx): StremioKey | null {
  if (!controller || !fullscreen || blocked || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return null;
  const target = e.target as { tagName?: string; isContentEditable?: boolean } | null;
  if (target?.isContentEditable || (target?.tagName && TYPING.has(target.tagName))) return null;
  if (e.key === "ArrowLeft") return "back";
  if (e.key === "ArrowRight") return "forward";
  // A focused button already clicks on Space, and a held Space must not flicker the picture.
  if (e.key === " " && !e.repeat && !(target?.tagName && CLICKS_ON_SPACE.has(target.tagName))) return "toggle";
  return null;
}
