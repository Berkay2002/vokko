import { describe, expect, it } from "vitest";
import { focusForFullscreen, type FocusUi } from "./fullscreenFocus";

function fake(focusedTile: string | null) {
  const ui: FocusUi = { focusedTile, setFocusedTile: id => void (ui.focusedTile = id) };
  return ui;
}

describe("full screen and the stage focus", () => {
  it("focuses the Stremio tile and puts the old focus back on exit", () => {
    const ui = fake("alice:stream");
    const restore = focusForFullscreen(() => ui, "stremio", true);
    expect(ui.focusedTile).toBe("stremio");
    restore?.();
    expect(ui.focusedTile).toBe("alice:stream");
  });

  it("restores the grid when nothing was focused", () => {
    const ui = fake(null);
    focusForFullscreen(() => ui, "stremio", true)?.();
    expect(ui.focusedTile).toBeNull();
  });

  it("leaves the focus alone without a session or when the tile is already focused", () => {
    const none = fake("alice");
    expect(focusForFullscreen(() => none, "stremio", false)).toBeNull();
    expect(none.focusedTile).toBe("alice");
    const already = fake("stremio");
    expect(focusForFullscreen(() => already, "stremio", true)).toBeNull();
  });

  it("does not undo a focus the viewer chose while in full screen", () => {
    const ui = fake(null);
    const restore = focusForFullscreen(() => ui, "stremio", true);
    ui.setFocusedTile("bob");
    restore?.();
    expect(ui.focusedTile).toBe("bob");
  });
});
