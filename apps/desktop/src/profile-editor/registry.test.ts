import { beforeEach, describe, expect, it } from "vitest";
import { hasProfileEditorTile, registerBuiltinTile, registerProfileEditorTile, resetProfileEditorTiles, resolveProfileEditorTile, type ProfileEditorTile } from "./registry";

const tile = (): ProfileEditorTile => () => null;

describe("profile editor tile registry", () => {
  beforeEach(resetProfileEditorTiles);

  it("falls back to the coming-soon tile while nothing is registered", () => {
    const soon = tile();
    expect(hasProfileEditorTile("nameplate")).toBe(false);
    expect(resolveProfileEditorTile("nameplate", soon)).toBe(soon);
  });

  it("a registered picker plugs in with one call and unregisters cleanly", () => {
    const soon = tile();
    const picker = tile();
    const off = registerProfileEditorTile("nameplate", picker);
    expect(resolveProfileEditorTile("nameplate", soon)).toBe(picker);
    off();
    expect(resolveProfileEditorTile("nameplate", soon)).toBe(soon);
  });

  it("a registered picker wins over a built-in tile whatever the import order", () => {
    const builtin = tile();
    const picker = tile();
    registerProfileEditorTile("avatar-decoration", picker);
    registerBuiltinTile("avatar-decoration", builtin);
    expect(resolveProfileEditorTile("avatar-decoration", tile())).toBe(picker);
  });

  it("an old unregister function does not drop a newer registration", () => {
    const first = tile();
    const second = tile();
    const offFirst = registerProfileEditorTile("profile-effect", first);
    registerProfileEditorTile("profile-effect", second);
    offFirst();
    expect(resolveProfileEditorTile("profile-effect", tile())).toBe(second);
  });
});
