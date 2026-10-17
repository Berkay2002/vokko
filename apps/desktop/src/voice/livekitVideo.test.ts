import { describe, expect, it } from "vitest";
import { layersOf } from "./livekitVideo";

describe("layersOf", () => {
  it("maps the TrackInfo layers and drops OFF / empty ones", () => {
    const trackInfo = {
      layers: [
        { quality: 0, width: 640, height: 360 },
        { quality: 1, width: 1280, height: 720 },
        { quality: 2, width: 1920, height: 1080 },
        { quality: 3, width: 1920, height: 1080 },
        { quality: 2, width: 0, height: 0 },
      ],
    };
    expect(layersOf({ trackInfo } as unknown as Parameters<typeof layersOf>[0])).toEqual([
      { width: 640, height: 360, quality: "low" },
      { width: 1280, height: 720, quality: "medium" },
      { width: 1920, height: 1080, quality: "high" },
    ]);
    expect(layersOf({ trackInfo: undefined })).toEqual([]);
  });
});
