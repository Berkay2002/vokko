import { describe, expect, it } from "vitest";
import { gridLayout } from "./gridLayout";

describe("gridLayout (call stage grid)", () => {
  it("returns an empty layout for no participants", () => {
    expect(gridLayout(0, 1000, 600)).toEqual({ cols: 0, rows: 0, tileWidth: 0, tileHeight: 0 });
  });

  it("fills a single tile to the limiting side", () => {
    expect(gridLayout(1, 1600, 450, 8)).toMatchObject({ cols: 1, rows: 1, tileWidth: 800, tileHeight: 450 });
    expect(gridLayout(1, 800, 2000, 8)).toMatchObject({ cols: 1, rows: 1, tileWidth: 800 });
  });

  it("puts 3 people in 2 + 1 on a typical stage", () => {
    const layout = gridLayout(3, 1100, 700, 8);
    expect(layout).toMatchObject({ cols: 2, rows: 2 });
    expect(layout.tileWidth).toBe(546);
  });

  it("puts 3 people in one row on a very wide, short stage", () => {
    expect(gridLayout(3, 1600, 500, 8)).toMatchObject({ cols: 3, rows: 1 });
  });

  it("puts 5 people in 2 columns x 3 rows on a tall stage", () => {
    expect(gridLayout(5, 1100, 900, 8)).toMatchObject({ cols: 2, rows: 3 });
  });

  it("never lets the tiles overflow the box", () => {
    for (const count of [2, 3, 4, 5, 7, 9, 12, 25]) {
      for (const [w, h] of [[1200, 700], [700, 1000], [1900, 500], [320, 240]]) {
        const { cols, rows, tileWidth, tileHeight } = gridLayout(count, w, h, 8);
        expect(cols * rows).toBeGreaterThanOrEqual(count);
        expect(cols * tileWidth + (cols - 1) * 8).toBeLessThanOrEqual(w);
        expect(rows * tileHeight + (rows - 1) * 8).toBeLessThanOrEqual(h);
      }
    }
  });

  it("returns zero-size tiles when the box has no room", () => {
    expect(gridLayout(4, 0, 0).tileWidth).toBe(0);
  });
});
