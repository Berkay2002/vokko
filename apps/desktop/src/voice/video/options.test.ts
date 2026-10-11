import { describe, expect, it } from "vitest";
import {
  SCREEN_FPS,
  SCREEN_RESOLUTIONS,
  buildCamera,
  buildScreenShare,
  codecOrder,
  codecSupportFrom,
  contentHintOf,
  describeScreenShare,
  dimensionsOf,
  isCameraResolution,
  isScreenFps,
  isScreenResolution,
  isViewerQuality,
  pickCodec,
  viewerRequest,
  type CodecSupport,
} from "./options";

const vp8Only: CodecSupport = { vp8: true };
const everything: CodecSupport = { av1: true, vp9: true, h264: true, vp8: true };

describe("buildScreenShare", () => {
  it("passes the capture constraints for every resolution and fps", () => {
    for (const resolution of SCREEN_RESOLUTIONS) {
      for (const fps of SCREEN_FPS) {
        const r = buildScreenShare({ resolution, fps, audio: true }, vp8Only);
        const { width, height } = dimensionsOf(resolution);
        expect(r.capture.resolution).toEqual({ width, height, frameRate: fps });
        expect(r.capture.audio).toBe(true);
        expect(r.publish.encoding.maxFramerate).toBe(fps);
      }
    }
  });

  it("source asks for 4K, others for their fixed size", () => {
    expect(dimensionsOf("720p")).toEqual({ width: 1280, height: 720 });
    expect(dimensionsOf("1080p")).toEqual({ width: 1920, height: 1080 });
    expect(dimensionsOf("1440p")).toEqual({ width: 2560, height: 1440 });
    expect(dimensionsOf("source")).toEqual({ width: 3840, height: 2160 });
  });

  it("forwards the audio flag", () => {
    expect(buildScreenShare({ resolution: "720p", fps: 30, audio: false }, vp8Only).capture.audio).toBe(false);
  });

  it("uses motion at 60 fps and detail otherwise, unless content overrides", () => {
    expect(contentHintOf({ fps: 60 })).toBe("motion");
    expect(contentHintOf({ fps: 30 })).toBe("detail");
    expect(contentHintOf({ fps: 15 })).toBe("detail");
    expect(contentHintOf({ fps: 60, content: "detail" })).toBe("detail");
    expect(contentHintOf({ fps: 15, content: "motion" })).toBe("motion");
    expect(buildScreenShare({ resolution: "1080p", fps: 60, audio: false }, vp8Only).capture.contentHint).toBe("motion");
    expect(buildScreenShare({ resolution: "1080p", fps: 30, audio: false }, vp8Only).capture.contentHint).toBe("detail");
    expect(buildScreenShare({ resolution: "1080p", fps: 60, audio: false, content: "detail" }, vp8Only).capture.contentHint).toBe("detail");
  });

  it("degradation preference follows the content hint", () => {
    expect(buildScreenShare({ resolution: "720p", fps: 15, audio: false }, vp8Only).publish.degradationPreference).toBe("maintain-resolution");
    expect(buildScreenShare({ resolution: "720p", fps: 60, audio: false }, vp8Only).publish.degradationPreference).toBe("maintain-framerate");
  });

  it("bitrate increases with fps at a fixed resolution and with resolution at a fixed fps", () => {
    const rate = (resolution: (typeof SCREEN_RESOLUTIONS)[number], fps: 15 | 30 | 60) =>
      buildScreenShare({ resolution, fps, audio: false }, vp8Only).publish.encoding.maxBitrate;
    for (const resolution of SCREEN_RESOLUTIONS) {
      expect(rate(resolution, 15)).toBeLessThan(rate(resolution, 30));
      expect(rate(resolution, 30)).toBeLessThan(rate(resolution, 60));
    }
    for (const fps of SCREEN_FPS) {
      for (let i = 1; i < SCREEN_RESOLUTIONS.length; i++) {
        expect(rate(SCREEN_RESOLUTIONS[i - 1], fps)).toBeLessThan(rate(SCREEN_RESOLUTIONS[i], fps));
      }
    }
    expect(rate("720p", 30)).toBe(2_000_000);
    expect(rate("1080p", 60)).toBe(6_000_000);
  });

  it("publishes simulcast with a lower layer for vp8 and h264", () => {
    for (const support of [{ vp8: true }, { h264: true }] as CodecSupport[]) {
      const p = buildScreenShare({ resolution: "1080p", fps: 60, audio: false }, support).publish;
      expect(p.simulcast).toBe(true);
      expect(p.scalabilityMode).toBeUndefined();
      expect(p.layers).toEqual([{ width: 1280, height: 720, maxBitrate: 2_000_000, maxFramerate: 30 }]);
    }
  });

  it("uses a 360p15 lower layer under 720p", () => {
    const p = buildScreenShare({ resolution: "720p", fps: 30, audio: false }, vp8Only).publish;
    expect(p.layers).toEqual([{ width: 640, height: 360, maxBitrate: 400_000, maxFramerate: 15 }]);
  });

  it("turns simulcast off for vp9 and av1 (SVC)", () => {
    const vp9 = buildScreenShare({ resolution: "1080p", fps: 30, audio: false }, { vp9: true, vp8: true }).publish;
    expect(vp9.codec).toBe("vp9");
    expect(vp9.simulcast).toBe(false);
    expect(vp9.scalabilityMode).toBe("L1T3");
    expect(vp9.layers).toEqual([]);
    expect(vp9.backupCodec).toBe("vp8");
    const av1 = buildScreenShare({ resolution: "1440p", fps: 30, audio: false }, { ...everything, hardware: { av1: true } }).publish;
    expect(av1.codec).toBe("av1");
    expect(av1.simulcast).toBe(false);
    expect(av1.layers).toEqual([]);
  });

  it("has no backup codec for vp8 / h264", () => {
    expect(buildScreenShare({ resolution: "720p", fps: 30, audio: false }, vp8Only).publish.backupCodec).toBe(false);
  });

  it("backup falls back to h264 when vp8 is explicitly unsupported", () => {
    const p = buildScreenShare({ resolution: "720p", fps: 30, audio: false }, { vp9: true, vp8: false, h264: true }).publish;
    expect(p.codec).toBe("vp9");
    expect(p.backupCodec).toBe("h264");
    expect(buildScreenShare({ resolution: "720p", fps: 30, audio: false }, { vp9: true, vp8: false }).publish.backupCodec).toBe(false);
  });
});

describe("buildCamera", () => {
  it("720p: 1280x720 capture, two lower layers on vp8", () => {
    const r = buildCamera("720p", vp8Only);
    expect(r.capture).toEqual({ width: 1280, height: 720, frameRate: 30 });
    expect(r.publish.simulcast).toBe(true);
    expect(r.publish.encoding.maxBitrate).toBe(1_200_000);
    expect(r.publish.layers.map(l => l.height)).toEqual([180, 360]);
    expect(r.publish.degradationPreference).toBe("maintain-framerate");
  });

  it("1080p: 1920x1080 capture, three lower layers on vp8, 2.5 Mbps top", () => {
    const r = buildCamera("1080p", vp8Only);
    expect(r.capture).toEqual({ width: 1920, height: 1080, frameRate: 30 });
    expect(r.publish.encoding.maxBitrate).toBe(2_500_000);
    expect(r.publish.layers.map(l => l.height)).toEqual([180, 360, 720]);
  });

  it("uses SVC without simulcast layers on vp9", () => {
    const r = buildCamera("720p", everything);
    expect(r.publish.codec).toBe("vp9");
    expect(r.publish.simulcast).toBe(false);
    expect(r.publish.scalabilityMode).toBe("L3T3_KEY");
    expect(r.publish.layers).toEqual([]);
  });
});

describe("codec selection", () => {
  it("orders vp9 first for small streams; av1 leads the largest only with AV1 hardware encode", () => {
    expect(codecOrder("720p")).toEqual(["vp9", "av1", "vp8", "h264"]);
    expect(codecOrder("1080p")).toEqual(["vp9", "av1", "vp8", "h264"]);
    expect(codecOrder("1440p", { av1: true })).toEqual(["av1", "vp9", "vp8", "h264"]);
    expect(codecOrder("source", { av1: true })).toEqual(["av1", "vp9", "vp8", "h264"]);
  });

  it("does not lead with software av1 at 1440p or Source; hardware-encoded codecs go first", () => {
    expect(codecOrder("1440p")).toEqual(["vp9", "av1", "vp8", "h264"]);
    expect(codecOrder("source", { av1: false, h264: true })).toEqual(["h264", "vp9", "av1", "vp8"]);
    expect(codecOrder("1440p", { vp9: true })).toEqual(["vp9", "av1", "vp8", "h264"]);
  });

  it("picks the first supported codec in order", () => {
    expect(pickCodec(codecOrder("1080p"), everything)).toBe("vp9");
    expect(pickCodec(codecOrder("source", { av1: true }), everything)).toBe("av1");
    expect(pickCodec(codecOrder("source"), everything)).toBe("vp9");
    expect(pickCodec(codecOrder("1080p"), { av1: true, vp8: true })).toBe("av1");
  });

  it("falls back to vp8 / h264 when vp9 and av1 are unsupported", () => {
    expect(pickCodec(codecOrder("1080p"), { vp9: false, av1: false, vp8: true, h264: true })).toBe("vp8");
    expect(pickCodec(codecOrder("1080p"), { vp9: false, av1: false, vp8: false, h264: true })).toBe("h264");
  });

  it("falls back to vp8 when nothing is supported", () => {
    expect(pickCodec(codecOrder("1080p"), {})).toBe("vp8");
    expect(pickCodec(codecOrder("1080p"), { av1: false, vp9: false, h264: false, vp8: false })).toBe("vp8");
  });

  it("reads support from mime types, case-insensitively", () => {
    expect(codecSupportFrom(["video/VP8", "video/H264", "video/rtx", "audio/opus"])).toEqual({ av1: false, vp9: false, h264: true, vp8: true });
    expect(codecSupportFrom(["video/AV1", "video/vp9"])).toEqual({ av1: true, vp9: true, h264: false, vp8: false });
  });

  it("treats null / undefined / empty as nothing supported", () => {
    const none = { av1: false, vp9: false, h264: false, vp8: false };
    expect(codecSupportFrom(null)).toEqual(none);
    expect(codecSupportFrom(undefined)).toEqual(none);
    expect(codecSupportFrom([])).toEqual(none);
  });
});

describe("viewerRequest", () => {
  it("auto and source ask for the high layer", () => {
    expect(viewerRequest("auto")).toEqual({ kind: "quality", quality: "high" });
    expect(viewerRequest("source")).toEqual({ kind: "quality", quality: "high" });
  });
  it("720p and 480p cap by dimensions", () => {
    expect(viewerRequest("720p")).toEqual({ kind: "dimensions", width: 1280, height: 720 });
    expect(viewerRequest("480p")).toEqual({ kind: "dimensions", width: 854, height: 480 });
  });
});

describe("describeScreenShare", () => {
  it("formats resolution label and fps", () => {
    expect(describeScreenShare({ resolution: "1080p", fps: 60, audio: true })).toBe("1080p · 60 fps");
    expect(describeScreenShare({ resolution: "source", fps: 15, audio: false })).toBe("Source · 15 fps");
  });
});

describe("type guards", () => {
  it("isScreenResolution", () => {
    expect(isScreenResolution("source")).toBe(true);
    expect(isScreenResolution("1440p")).toBe(true);
    expect(isScreenResolution("480p")).toBe(false);
    expect(isScreenResolution(1080)).toBe(false);
    expect(isScreenResolution(null)).toBe(false);
  });
  it("isScreenFps", () => {
    expect(isScreenFps(15)).toBe(true);
    expect(isScreenFps(60)).toBe(true);
    expect(isScreenFps(24)).toBe(false);
    expect(isScreenFps("30")).toBe(false);
  });
  it("isCameraResolution", () => {
    expect(isCameraResolution("720p")).toBe(true);
    expect(isCameraResolution("1080p")).toBe(true);
    expect(isCameraResolution("1440p")).toBe(false);
    expect(isCameraResolution(undefined)).toBe(false);
  });
  it("isViewerQuality", () => {
    expect(isViewerQuality("auto")).toBe(true);
    expect(isViewerQuality("480p")).toBe(true);
    expect(isViewerQuality("1080p")).toBe(false);
    expect(isViewerQuality({})).toBe(false);
  });
});
