import { describe, expect, it } from "vitest";
import { isBlackFrame } from "./cameraSession";

const frame = (pixels: number, rgb: [number, number, number]): Uint8ClampedArray => {
  const data = new Uint8ClampedArray(pixels * 4);
  for (let i = 0; i < pixels; i++) data.set([...rgb, 255], i * 4);
  return data;
};

describe("isBlackFrame", () => {
  it("treats pure black and sensor-noise black as black", () => {
    expect(isBlackFrame(frame(576, [0, 0, 0]))).toBe(true);
    expect(isBlackFrame(frame(576, [3, 2, 4]))).toBe(true);
    expect(isBlackFrame(new Uint8ClampedArray(0))).toBe(true);
  });

  it("treats a dim room, or a dark frame with one lit spot, as a picture", () => {
    expect(isBlackFrame(frame(576, [20, 18, 16]))).toBe(false);
    const spot = frame(576, [0, 0, 0]);
    spot.set([200, 200, 200, 255], 100 * 4);
    expect(isBlackFrame(spot)).toBe(false);
  });
});
