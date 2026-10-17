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
  isWebKit,
  missingAudioNote,
  nearestChoice,
  serverTakesSvcSimulcast,
  pickCodec,
  screenLayers,
  viewerChoices,
  viewerQualityLabel,
  viewerRequest,
  type CodecSupport,
  type StreamLayer,
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
      expect(p.layers).toEqual([
        { width: 640, height: 360, maxBitrate: 500_000, maxFramerate: 30 },
        { width: 1280, height: 720, maxBitrate: 3_000_000, maxFramerate: 60 },
      ]);
    }
  });

  it("uses only a 360p lower layer under 720p", () => {
    const p = buildScreenShare({ resolution: "720p", fps: 30, audio: false }, vp8Only).publish;
    expect(p.layers).toEqual([{ width: 640, height: 360, maxBitrate: 500_000, maxFramerate: 30 }]);
  });

  it("layers stay below the top layer in size, bitrate and frame rate for every preset", () => {
    for (const resolution of SCREEN_RESOLUTIONS) {
      for (const fps of SCREEN_FPS) {
        const plan = buildScreenShare({ resolution, fps, audio: false }, vp8Only).publish;
        const layers = screenLayers({ resolution, fps });
        expect(plan.layers).toEqual(layers);
        expect(layers.length).toBe(resolution === "720p" ? 1 : 2);
        for (const l of layers) {
          expect(l.height).toBeLessThan(dimensionsOf(resolution).height);
          expect(l.maxBitrate).toBeLessThan(plan.encoding.maxBitrate);
          expect(l.maxFramerate).toBeLessThanOrEqual(fps);
        }
        // Lowest first, as LiveKit expects.
        expect(layers.map(l => l.height)).toEqual([...layers.map(l => l.height)].sort((a, b) => a - b));
      }
    }
  });

  it("sends vp9 and av1 as rid simulcast with L1T3 per layer (one SVC stream would be a single spatial layer)", () => {
    const vp9 = buildScreenShare({ resolution: "1080p", fps: 30, audio: false }, { vp9: true, vp8: true, svcSimulcast: true }).publish;
    expect(vp9.codec).toBe("vp9");
    expect(vp9.simulcast).toBe(true);
    expect(vp9.scalabilityMode).toBe("L1T3");
    expect(vp9.layers.map(l => l.height)).toEqual([360, 720]);
    expect(vp9.backupCodec).toBe("vp8");
    const av1 = buildScreenShare({ resolution: "1440p", fps: 30, audio: false }, { ...everything, hardware: { av1: true } }).publish;
    expect(av1.codec).toBe("av1");
    expect(av1.simulcast).toBe(true);
    expect(av1.layers.map(l => l.height)).toEqual([360, 720]);
  });

  it("avoids vp9 / av1 where they can't be simulcast (WebKit), so lower layers still exist", () => {
    const p = buildScreenShare({ resolution: "1080p", fps: 60, audio: false }, { ...everything, svcSimulcast: false }).publish;
    expect(p.codec).toBe("vp8");
    expect(p.scalabilityMode).toBeUndefined();
    expect(p.layers.length).toBe(2);
    expect(buildScreenShare({ resolution: "1080p", fps: 60, audio: false }, { vp9: true, h264: true, vp8: false, svcSimulcast: false }).publish.codec).toBe("h264");
  });

  it("presets: 720p30, 1080p30, 1080p60 and Source get rising bitrates and the right hint", () => {
    const plan = (resolution: (typeof SCREEN_RESOLUTIONS)[number], fps: 15 | 30 | 60) => buildScreenShare({ resolution, fps, audio: true }, everything);
    expect(plan("720p", 30).publish.encoding).toEqual({ maxBitrate: 2_000_000, maxFramerate: 30 });
    expect(plan("1080p", 30).publish.encoding).toEqual({ maxBitrate: 4_000_000, maxFramerate: 30 });
    expect(plan("1080p", 60).publish.encoding).toEqual({ maxBitrate: 6_000_000, maxFramerate: 60 });
    expect(plan("source", 60).publish.encoding).toEqual({ maxBitrate: 12_000_000, maxFramerate: 60 });
    expect(plan("1080p", 60).capture.contentHint).toBe("motion");
    expect(plan("1080p", 30).capture.contentHint).toBe("detail");
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
  it("without known layers, a height caps by 16:9 dimensions", () => {
    expect(viewerRequest("720p")).toEqual({ kind: "dimensions", width: 1280, height: 720 });
    expect(viewerRequest("480p")).toEqual({ kind: "dimensions", width: 853, height: 480 });
  });
  it("with layers, a height picks the tallest layer that fits, else the smallest", () => {
    const layers: StreamLayer[] = [
      { width: 640, height: 360, quality: "low" },
      { width: 1920, height: 1080, quality: "high" },
      { width: 1280, height: 720, quality: "medium" },
    ];
    expect(viewerRequest("720p", layers)).toEqual({ kind: "quality", quality: "medium" });
    expect(viewerRequest("480p", layers)).toEqual({ kind: "quality", quality: "low" });
    expect(viewerRequest("1080p", layers)).toEqual({ kind: "quality", quality: "high" });
    expect(viewerRequest("240p", layers)).toEqual({ kind: "quality", quality: "low" });
    expect(viewerRequest("auto", layers)).toEqual({ kind: "quality", quality: "high" });
  });
});

describe("viewerChoices", () => {
  it("offers Auto, Source and each lower layer the stream has", () => {
    const layers: StreamLayer[] = [
      { width: 640, height: 400, quality: "low" },
      { width: 1280, height: 800, quality: "medium" },
      { width: 1920, height: 1200, quality: "high" },
    ];
    expect(viewerChoices(layers)).toEqual(["auto", "source", "800p", "400p"]);
    expect(viewerChoices([{ width: 1280, height: 720, quality: "high" }])).toEqual(["auto", "source"]);
  });
  it("falls back to the settings list when the layers are unknown", () => {
    expect(viewerChoices()).toEqual(["auto", "source", "720p", "480p"]);
    expect(viewerChoices([])).toEqual(["auto", "source", "720p", "480p"]);
  });
  it("labels", () => {
    expect(viewerChoices(undefined).map(viewerQualityLabel)).toEqual(["Auto", "Source", "720p", "480p"]);
  });
});

describe("serverTakesSvcSimulcast", () => {
  it("is true only for servers newer than 1.13.6", () => {
    expect(serverTakesSvcSimulcast("1.13.9")).toBe(true);
    expect(serverTakesSvcSimulcast("1.13.7")).toBe(true);
    expect(serverTakesSvcSimulcast("1.14.0")).toBe(true);
    expect(serverTakesSvcSimulcast("2.0.0")).toBe(true);
    expect(serverTakesSvcSimulcast("1.13.6")).toBe(false);
    expect(serverTakesSvcSimulcast("1.12.10")).toBe(false);
    expect(serverTakesSvcSimulcast("0.15.0")).toBe(false);
    expect(serverTakesSvcSimulcast(undefined)).toBe(false);
    expect(serverTakesSvcSimulcast("")).toBe(false);
    expect(serverTakesSvcSimulcast("dev")).toBe(false);
  });
});

describe("nearestChoice", () => {
  const layered = ["auto", "source", "720p", "360p"] as const;
  it("keeps an offered entry", () => {
    expect(nearestChoice("auto", layered)).toBe("auto");
    expect(nearestChoice("720p", layered)).toBe("720p");
  });
  it("maps a settings default to the tallest offered height not above it, else the smallest", () => {
    expect(nearestChoice("480p", layered)).toBe("360p");
    expect(nearestChoice("1080p", layered)).toBe("720p");
    expect(nearestChoice("240p", layered)).toBe("360p");
  });
  it("is Source when the stream has no lower layer", () => {
    expect(nearestChoice("480p", ["auto", "source"])).toBe("source");
  });
});

describe("share audio", () => {
  const edge = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";
  const wkwebview = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
  it("tells WebView2 / Chromium from WebKit", () => {
    expect(isWebKit(edge)).toBe(false);
    expect(isWebKit(wkwebview)).toBe(true);
    expect(isWebKit("")).toBe(false);
  });
  it("explains the missing sound per platform", () => {
    expect(missingAudioNote(edge)).toMatch(/whole screen/);
    expect(missingAudioNote(wkwebview)).toMatch(/can't share audio/);
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
    expect(isViewerQuality("1080p")).toBe(true);
    expect(isViewerQuality("p")).toBe(false);
    expect(isViewerQuality("0p")).toBe(false);
    expect(isViewerQuality("720")).toBe(false);
    expect(isViewerQuality({})).toBe(false);
  });
});
