import { describe, expect, it } from "vitest";
import { preferHardwareH264, profileOf } from "./h264";
import { buildScreenShare, h264ProfileLevelIds, screenCodecOrder } from "./options";

// The video section of a WebView2 offer, trimmed: VP8, then the H.264 formats in Chromium's order (Baseline,
// Constrained Baseline, Main, High), VP9, and RTX for one of them.
const offer = [
  "v=0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "a=rtpmap:111 opus/48000/2",
  "m=video 9 UDP/TLS/RTP/SAVPF 96 97 103 104 107 108 109 98 99",
  "a=rtpmap:96 VP8/90000",
  "a=rtpmap:97 rtx/90000",
  "a=fmtp:97 apt=96",
  "a=rtpmap:103 H264/90000",
  "a=fmtp:103 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f",
  "a=rtpmap:104 H264/90000",
  "a=fmtp:104 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
  "a=rtpmap:107 H264/90000",
  "a=fmtp:107 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f",
  "a=rtpmap:108 H264/90000",
  "a=fmtp:108 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640032",
  "a=rtpmap:109 rtx/90000",
  "a=fmtp:109 apt=108",
  "a=rtpmap:98 VP9/90000",
  "a=rtpmap:99 rtx/90000",
  "",
].join("\r\n");

const videoLine = (sdp: string) => sdp.split("\r\n").find(l => l.startsWith("m=video"));

describe("preferHardwareH264", () => {
  it("moves the hardware H.264 profiles ahead of Constrained Baseline, High first, other codecs untouched", () => {
    const out = preferHardwareH264(offer, ["4200", "4d00", "6400"]);
    expect(videoLine(out)).toBe("m=video 9 UDP/TLS/RTP/SAVPF 96 97 108 107 103 104 109 98 99");
    expect(out.replace(videoLine(out)!, "")).toBe(offer.replace(videoLine(offer)!, ""));
  });

  it("leaves software-only profiles where they were", () => {
    expect(videoLine(preferHardwareH264(offer, ["4200"]))).toBe("m=video 9 UDP/TLS/RTP/SAVPF 96 97 103 104 107 108 109 98 99");
    expect(videoLine(preferHardwareH264(offer, ["6400"]))).toBe("m=video 9 UDP/TLS/RTP/SAVPF 96 97 108 103 104 107 109 98 99");
  });

  it("returns the offer unchanged without hardware H.264, and with LF line ends too", () => {
    expect(preferHardwareH264(offer, [])).toBe(offer);
    const lf = offer.replaceAll("\r\n", "\n");
    expect(preferHardwareH264(lf, ["6400"]).split("\n")[3]).toBe("m=video 9 UDP/TLS/RTP/SAVPF 96 97 108 103 104 107 109 98 99");
  });
});

describe("H.264 profiles", () => {
  it("reads each profile-level-id once from capability fmtp lines", () => {
    const lines = [
      "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f",
      "level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42001f",
      "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640032",
      undefined,
    ];
    expect(h264ProfileLevelIds(lines)).toEqual(["42001f", "640032"]);
    expect(profileOf("640032")).toBe("6400");
    expect(profileOf("42E01F")).toBe("42e0");
  });
});

describe("screen share codec with hardware encoders", () => {
  const all = { av1: true, vp9: true, h264: true, vp8: true, svcSimulcast: true };

  it("leads with hardware H.264 at every size when VP9 is software (NVIDIA / AMD on Windows)", () => {
    for (const resolution of ["720p", "1080p", "1440p", "source"] as const) {
      expect(screenCodecOrder(resolution, { h264: true, vp9: false, av1: false })[0]).toBe("h264");
      expect(buildScreenShare({ resolution, fps: 60, audio: false }, { ...all, hardware: { h264: true } }).publish.codec).toBe("h264");
    }
    const plan = buildScreenShare({ resolution: "1080p", fps: 60, audio: false }, { ...all, hardware: { h264: true } }).publish;
    expect(plan.backupCodec).toBe(false);
    expect(plan.scalabilityMode).toBeUndefined();
    expect(plan.degradationPreference).toBe("maintain-framerate");
  });

  it("keeps VP9 first without hardware encoders, and hardware VP9 / AV1 ahead of H.264 in their usual order", () => {
    expect(buildScreenShare({ resolution: "1080p", fps: 60, audio: false }, all).publish.codec).toBe("vp9");
    expect(screenCodecOrder("1080p", { vp9: true, h264: true })).toEqual(["vp9", "h264", "av1", "vp8"]);
    expect(screenCodecOrder("1440p", { av1: true, h264: true })).toEqual(["av1", "h264", "vp9", "vp8"]);
  });
});
