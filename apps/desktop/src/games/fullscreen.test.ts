import { describe, expect, it } from "vitest";
import { gameOwnsKeys } from "./fullscreen";

const el = (selector: string) => ({ matches: (s: string) => s === selector }) as unknown as Element;
const frame = el("iframe.game-frame");
const tile = el("[data-game-tile]");
const button = el("button");

describe("gameOwnsKeys", () => {
  it("is true while a game frame has focus", () => {
    expect(gameOwnsKeys(frame, null)).toBe(true);
  });

  it("is true while a game tile is full screen, wherever focus is inside it", () => {
    expect(gameOwnsKeys(button, tile)).toBe(true);
  });

  it("is false for the app's own controls, and when something else is full screen", () => {
    expect(gameOwnsKeys(button, null)).toBe(false);
    expect(gameOwnsKeys(null, null)).toBe(false);
    expect(gameOwnsKeys(button, el("section.voice-page"))).toBe(false);
  });
});
