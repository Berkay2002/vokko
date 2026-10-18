import { describe, expect, it } from "vitest";
import { PRESET_WORDS, findKeyword, mentionCount } from "./automod";

describe("AutoMod presets and mention counting", () => {
  it("reads the shared preset lists without comments", () => {
    for (const preset of [1, 2, 3]) {
      const words = PRESET_WORDS[preset] ?? [];
      expect(words.length).toBeGreaterThanOrEqual(10);
      expect(words.some(w => w.startsWith("#"))).toBe(false);
    }
    expect(findKeyword("what the FUCKING hell", PRESET_WORDS[1] ?? [])).toBe("fuck*");
  });

  it("counts unique user and role mentions, not @everyone", () => {
    expect(mentionCount("<@1> <@!1> <@&1> @everyone <@x>")).toBe(2);
  });
});

describe("AutoMod keyword matching (same rules as the server)", () => {
  const hit = (content: string, keyword: string, allow: string[] = []) => findKeyword(content, [keyword], allow) !== null;

  it("matches whole words case-insensitively", () => {
    expect(hit("I like Cats.", "cats")).toBe(true);
    expect(hit("concatenate", "cat")).toBe(false);
    expect(hit("ÅSKA och regn", "åska")).toBe(true);
    expect(hit("", "x")).toBe(false);
  });

  it("treats * as prefix / suffix / substring wildcards", () => {
    expect(hit("catalogue", "cat*")).toBe(true);
    expect(hit("bobcat", "cat*")).toBe(false);
    expect(hit("bobcat!", "*cat")).toBe(true);
    expect(hit("concatenate", "*cat*")).toBe(true);
  });

  it("matches multi-word keywords only as written", () => {
    expect(hit("well, free money here", "free money")).toBe(true);
    expect(hit("freemoney", "free money")).toBe(false);
  });

  it("lets the allow list save a word but not the rest of the message", () => {
    expect(findKeyword("a badge", ["bad*"], ["badge"])).toBeNull();
    expect(findKeyword("a badge and a baddie", ["bad*"], ["badge"])).toBe("bad*");
    expect(findKeyword("badminton", ["bad*"], ["*minton"])).toBeNull();
  });
});
