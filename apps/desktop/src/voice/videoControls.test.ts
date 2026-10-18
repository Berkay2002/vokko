import { describe, expect, it } from "vitest";
import { canShareScreen } from "./videoControls";

describe("canShareScreen", () => {
  const desktop = { mediaDevices: { getDisplayMedia: () => Promise.resolve(new MediaStream()) } } as unknown as Navigator;

  it("is offered where getDisplayMedia exists", () => {
    expect(canShareScreen(desktop, false)).toBe(true);
  });

  it("is hidden on phone browsers (no getDisplayMedia) and without mediaDevices at all", () => {
    expect(canShareScreen({ mediaDevices: {} } as unknown as Navigator, false)).toBe(false);
    expect(canShareScreen({} as Navigator, false)).toBe(false);
  });

  it("is hidden in the Linux app's native voice, which can't publish video", () => {
    expect(canShareScreen(desktop, true)).toBe(false);
  });
});
