import { describe, expect, it } from "vitest";
import { clampCrop, isAnimatedImage, outputSize, sourceRect } from "./crop";

describe("crop maths", () => {
  // A 300x900 portrait image in a 100x100 box: scale 1/3, so the image is 100x300 and can pan 100px each way.
  it("clamps the offset so the image always covers the box", () => {
    expect(clampCrop({ zoom: 1, x: 50, y: 500 }, 300, 900, 100, 100)).toEqual({ zoom: 1, x: 0, y: 100 });
    expect(clampCrop({ zoom: 9, x: 0, y: 0 }, 300, 900, 100, 100).zoom).toBe(4);
    expect(clampCrop({ zoom: 0.2, x: 0, y: 0 }, 300, 900, 100, 100).zoom).toBe(1);
  });

  it("centred, the source rect is the middle square; dragged to the edge it is the top band", () => {
    expect(sourceRect({ zoom: 1, x: 0, y: 0 }, 300, 900, 100, 100)).toEqual({ sx: 0, sy: 300, sw: 300, sh: 300 });
    // Image pushed all the way down (y = +100): the top of the picture is in the box.
    expect(sourceRect({ zoom: 1, x: 0, y: 100 }, 300, 900, 100, 100)).toEqual({ sx: 0, sy: 0, sw: 300, sh: 300 });
  });

  it("zooming in shrinks the source rect around the centre", () => {
    expect(sourceRect({ zoom: 2, x: 0, y: 0 }, 300, 900, 100, 100)).toEqual({ sx: 75, sy: 375, sw: 150, sh: 150 });
  });

  it("outputs the box aspect, capped at maxWidth and never above the source", () => {
    expect(outputSize(2000, 17 / 6, 1360)).toEqual({ width: 1360, height: 480 });
    expect(outputSize(200, 1, 512)).toEqual({ width: 200, height: 200 });
  });
});

describe("isAnimatedImage", () => {
  const blob = (type: string, text: string) => new Blob([text], { type });
  it("flags GIFs, APNGs and animated WebPs, not still PNGs, WebPs or JPEGs", async () => {
    expect(await isAnimatedImage(blob("image/gif", "GIF89a"))).toBe(true);
    expect(await isAnimatedImage(blob("image/png", "PNG....IHDR....acTL....IDAT"))).toBe(true);
    expect(await isAnimatedImage(blob("image/png", "PNG....IHDR....IDAT"))).toBe(false);
    expect(await isAnimatedImage(blob("image/webp", "RIFF....WEBPVP8X....ANIM"))).toBe(true);
    expect(await isAnimatedImage(blob("image/webp", "RIFF....WEBPVP8 "))).toBe(false);
    expect(await isAnimatedImage(blob("image/jpeg", "ANIM"))).toBe(false);
  });
});
