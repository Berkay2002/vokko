import { describe, expect, it } from "vitest";
import { PingSmoother, selectedPairRttMs } from "./ping";

const report = (entries: Record<string, unknown>[]) => new Map(entries.map(e => [e.id as string, e])) as unknown as RTCStatsReport;

describe("PingSmoother", () => {
  it("averages the last samples and drops the oldest", () => {
    const s = new PingSmoother(3);
    expect(s.push(30)).toBe(30);
    expect(s.push(60)).toBe(45);
    expect(s.push(30)).toBe(40);
    expect(s.push(30)).toBe(40); // 60, 30, 30
    expect(s.push(30)).toBe(30); // 30, 30, 30
  });

  it("starts over after reset", () => {
    const s = new PingSmoother(3);
    s.push(100);
    s.reset();
    expect(s.push(20)).toBe(20);
  });

  it("damps a spike", () => {
    const s = new PingSmoother(6);
    for (let i = 0; i < 5; i += 1) s.push(20);
    expect(s.push(80)).toBe(30);
  });
});

describe("selectedPairRttMs", () => {
  it("reads the pair the transport selected, in ms", () => {
    const r = report([
      { id: "t", type: "transport", selectedCandidatePairId: "p2" },
      { id: "p1", type: "candidate-pair", currentRoundTripTime: 0.2 },
      { id: "p2", type: "candidate-pair", currentRoundTripTime: 0.0334 },
    ]);
    expect(selectedPairRttMs(r)).toBeCloseTo(33.4);
  });

  it("falls back to a nominated succeeded pair", () => {
    const r = report([{ id: "p", type: "candidate-pair", nominated: true, state: "succeeded", currentRoundTripTime: 0.02 }]);
    expect(selectedPairRttMs(r)).toBeCloseTo(20);
  });

  it("is null before any round trip was measured", () => {
    expect(selectedPairRttMs(report([{ id: "t", type: "transport", selectedCandidatePairId: "p" }, { id: "p", type: "candidate-pair" }]))).toBeNull();
    expect(selectedPairRttMs(report([]))).toBeNull();
  });
});
