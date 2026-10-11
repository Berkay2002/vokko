import { afterEach, describe, expect, it, vi } from "vitest";
import { usePrefs } from "../ui/prefs";
import { summariseRtpStats, voiceDebug } from "./debugLog";

describe("voice debug logging", () => {
  afterEach(() => {
    usePrefs.setState({ debugLogging: false });
    vi.restoreAllMocks();
  });

  it("stays silent unless the pref is on", () => {
    const spy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    voiceDebug("status", "connected");
    expect(spy).not.toHaveBeenCalled();
    usePrefs.setState({ debugLogging: true });
    voiceDebug("status", "connected");
    expect(spy).toHaveBeenCalledWith("[vokko:voice] status", "connected");
  });

  it("keeps only the fields that explain quality, for RTP stats", () => {
    const report = new Map<string, Record<string, unknown>>([
      ["a", { type: "outbound-rtp", kind: "video", frameWidth: 1920, frameHeight: 1080, framesPerSecond: 60, bytesSent: 1000, qualityLimitationReason: "bandwidth" }],
      ["b", { type: "candidate-pair", currentRoundTripTime: 0.02 }],
      ["c", { type: "inbound-rtp", kind: "audio", bytesReceived: 50, packetsLost: 2 }],
    ]);
    const out = summariseRtpStats(report as unknown as RTCStatsReport);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ kind: "video", width: 1920, height: 1080, fps: 60, bytes: 1000, limited: "bandwidth" });
    expect(out[1]).toMatchObject({ kind: "audio", bytes: 50, lost: 2 });
  });
});
