import { describe, expect, it } from "vitest";
import { chars, clip, emptyWidgets, normaliseTags, sameWidgets, validateWidgets, widgetsFromUser, widgetsToInput } from "./widgets";

describe("profile widgets", () => {
  it("round-trips the server shape and echoes unchanged images by attachment id", () => {
    const draft = widgetsFromUser({
      favorite_game: { name: "Hades", image: "/h.png", image_attachment_id: "11", reason: "tight loop", tags: ["roguelike"] },
      games_i_like: [{ name: "Celeste", image: null, image_attachment_id: null }],
    });
    expect(widgetsToInput(draft)).toEqual({
      favorite_game: { name: "Hades", image_attachment_id: "11", reason: "tight loop", tags: ["roguelike"] },
      games_i_like: [{ name: "Celeste", image_attachment_id: null }],
    });
  });

  it("no widgets means null (clears the field)", () => {
    expect(widgetsToInput(emptyWidgets())).toBeNull();
    expect(widgetsToInput(widgetsFromUser(null))).toBeNull();
  });

  it("trims names and reasons, drops blank and duplicate tags", () => {
    const input = widgetsToInput({ favorite: { name: "  Hades ", image: null, reason: "  ", tags: [" a ", "A", "", "b"] }, games: [] });
    expect(input?.favorite_game).toEqual({ name: "Hades", image_attachment_id: null, reason: null, tags: ["a", "b"] });
    expect(normaliseTags(["x", "X", " y "])).toEqual(["x", "y"]);
  });

  it("enforces the limits: name 64, reason 190, 5 tags of 20, 20 games", () => {
    const fav = (patch: Partial<{ name: string; reason: string; tags: string[] }>) => ({ favorite: { name: "G", image: null, reason: "", tags: [] as string[], ...patch }, games: [] });
    expect(validateWidgets(fav({}))).toBeNull();
    expect(validateWidgets(fav({ name: "" }))).toMatch(/favourite game/i);
    expect(validateWidgets(fav({ name: "n".repeat(65) }))).toMatch(/64/);
    expect(validateWidgets(fav({ reason: "r".repeat(190) }))).toBeNull();
    expect(validateWidgets(fav({ reason: "r".repeat(191) }))).toMatch(/190/);
    expect(validateWidgets(fav({ tags: ["1", "2", "3", "4", "5"] }))).toBeNull();
    expect(validateWidgets(fav({ tags: ["1", "2", "3", "4", "5", "6"] }))).toMatch(/5 tags/);
    expect(validateWidgets(fav({ tags: ["t".repeat(21)] }))).toMatch(/20/);
    const game = (name: string) => ({ name, image: null });
    expect(validateWidgets({ favorite: null, games: Array.from({ length: 20 }, (_, i) => game(`g${i}`)) })).toBeNull();
    expect(validateWidgets({ favorite: null, games: Array.from({ length: 21 }, (_, i) => game(`g${i}`)) })).toMatch(/20/);
    expect(validateWidgets({ favorite: null, games: [game(" ")] })).toMatch(/name/);
  });

  it("counts code points like the server: 64 emoji fit a game name, 65 do not", () => {
    const fav = (name: string) => ({ favorite: { name, image: null, reason: "", tags: [] as string[] }, games: [] });
    expect(chars("🎮".repeat(64))).toBe(64);
    expect(validateWidgets(fav("🎮".repeat(64)))).toBeNull();
    expect(validateWidgets(fav("🎮".repeat(65)))).toMatch(/64/);
    expect(clip("🎮".repeat(70), 64)).toBe("🎮".repeat(64));
    expect(clip("short", 64)).toBe("short");
  });

  it("compares by what would be sent", () => {
    const a = widgetsFromUser({ favorite_game: { name: "Hades", image: null, image_attachment_id: null, reason: null, tags: [] } });
    expect(sameWidgets(a, { ...a, favorite: { ...a.favorite!, name: "Hades " } })).toBe(true);
    expect(sameWidgets(a, emptyWidgets())).toBe(false);
  });
});
