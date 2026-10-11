import { describe, expect, it } from "vitest";
import { findKeyword } from "./automod";

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
