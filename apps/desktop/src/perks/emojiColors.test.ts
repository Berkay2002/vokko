import { describe, expect, it } from "vitest";
import { FALLBACK_BURST_COLORS, burstColors, dominantColors } from "./emojiColors";

/** RGBA pixel data: `count` pixels of each colour. */
function pixels(...runs: [number, number, number, number, number][]): Uint8ClampedArray {
  const out: number[] = [];
  for (const [r, g, b, a, count] of runs) for (let i = 0; i < count; i++) out.push(r, g, b, a);
  return new Uint8ClampedArray(out);
}

describe("dominantColors", () => {
  it("ranks colours by how many pixels have them", () => {
    const data = pixels([255, 0, 0, 255, 10], [0, 0, 255, 255, 30], [0, 200, 0, 255, 20]);
    expect(dominantColors(data)).toEqual(["#0000ff", "#00c800"]);
    expect(dominantColors(data, 3)).toEqual(["#0000ff", "#00c800", "#ff0000"]);
  });

  it("skips transparent, grey and near-black pixels", () => {
    const data = pixels([255, 0, 0, 10, 100], [128, 128, 128, 255, 100], [10, 10, 30, 255, 100], [255, 200, 0, 255, 3]);
    expect(dominantColors(data)).toEqual(["#ffc800"]);
  });

  it("averages a bucket and merges colours that are too close", () => {
    // two shades of the same orange fall in one 4-bit bucket and average out; a near-identical third is not a second colour
    const data = pixels([240, 128, 0, 255, 2], [242, 130, 2, 255, 2], [255, 150, 20, 255, 1]);
    expect(dominantColors(data)).toEqual(["#f18101"]);
  });

  it("returns nothing for an empty or fully transparent image", () => {
    expect(dominantColors(new Uint8ClampedArray())).toEqual([]);
    expect(dominantColors(pixels([255, 0, 0, 0, 20]))).toEqual([]);
  });
});

describe("burstColors", () => {
  it("prefers colours sent by the server", () => {
    expect(burstColors({ id: null, name: "🔥" }, ["#112233"])).toEqual(["#112233"]);
  });

  it("falls back to the brand colours when the emoji cannot be drawn", () => {
    // custom emoji have no image to sample, and jsdom/node has no canvas
    expect(burstColors({ id: "1", name: "party" })).toEqual(FALLBACK_BURST_COLORS);
  });
});
