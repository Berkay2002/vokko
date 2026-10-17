import { describe, expect, it } from "vitest";
import { parseVideoStats } from "./viewerStats";

const report = (entries: Record<string, unknown>[]) => new Map(entries.map(e => [String(e.id), e])) as unknown as RTCStatsReport;

describe("viewer receive stats", () => {
  it("reads the inbound video stream and its codec", () => {
    const stats = parseVideoStats(
      report([
        { id: "a", type: "inbound-rtp", kind: "audio", framesPerSecond: 99 },
        { id: "v", type: "inbound-rtp", kind: "video", codecId: "c", framesPerSecond: 23, frameWidth: 1920, frameHeight: 800, framesDecoded: 500, framesDropped: 2, freezeCount: 1, totalFreezesDuration: 0.6, jitterBufferDelay: 12, jitterBufferEmittedCount: 100, jitter: 0.004, packetsLost: 3, bytesReceived: 9000 },
        { id: "c", type: "codec", mimeType: "video/VP8" },
      ]),
    );
    expect(stats).toEqual({ fps: 23, width: 1920, height: 800, codec: "video/VP8", framesDecoded: 500, framesDropped: 2, freezeCount: 1, freezeMs: 600, jitterBufferMs: 120, jitterMs: 4, packetsLost: 3, bytesReceived: 9000 });
  });

  it("is null without a video stream and zero where the browser reports nothing", () => {
    expect(parseVideoStats(report([{ id: "a", type: "inbound-rtp", kind: "audio" }]))).toBeNull();
    expect(parseVideoStats(report([{ id: "v", type: "inbound-rtp", kind: "video" }]))).toMatchObject({ fps: 0, jitterBufferMs: 0, codec: "" });
  });
});
