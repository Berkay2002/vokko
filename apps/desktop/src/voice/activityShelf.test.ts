import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUILTIN_GAMES } from "../games/builtin";
import { coverUrl } from "./ActivityShelf";

describe("coverUrl (Activities shelf art)", () => {
  it("has a cover for Watch Together and every public built-in game, each one shipped in public/", () => {
    const ids = ["watch-together", ...BUILTIN_GAMES.filter(g => g.id !== "builtin:mock").map(g => g.id)];
    for (const id of ids) {
      const url = coverUrl(id);
      expect(url, id).not.toBeNull();
      expect(existsSync(new URL(`../../public${url}`, import.meta.url)), url ?? id).toBe(true);
    }
  });

  it("draws the tinted icon for Stremio, Spotify, the mock game and a server's own games", () => {
    for (const id of ["stremio", "spotify", "builtin:mock", "1234567890"]) expect(coverUrl(id), id).toBeNull();
  });
});
