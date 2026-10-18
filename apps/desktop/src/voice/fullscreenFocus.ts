// What full screen does to the call stage's focus: with a Stremio session running, full screen focuses its tile first and the old
// focus comes back when full screen ends (unless the viewer picked another tile meanwhile). DOM-free, so the tests drive it with a fake.

export interface FocusUi {
  focusedTile: string | null;
  setFocusedTile(id: string | null): void;
}

/** True while the call page's full screen (not a game's or a video's) is on: the page goes full screen as the whole document. */
export const inPageFullscreen = (): boolean => !!document.fullscreenElement && document.fullscreenElement === document.documentElement;

/** Focuses `tileId` when `available`; returns the function that gives the old focus back, or null when nothing changed. */
export function focusForFullscreen(ui: () => FocusUi, tileId: string, available: boolean): (() => void) | null {
  const now = ui();
  if (!available || now.focusedTile === tileId) return null;
  const previous = now.focusedTile;
  now.setFocusedTile(tileId);
  return () => {
    const current = ui();
    if (current.focusedTile === tileId) current.setFocusedTile(previous);
  };
}
