import { describe, expect, it } from "vitest";
import { FRAME_MS, HANGOVER_MS, MutedTalkDetector, VadGate, rmsDb, sensitivityToDb } from "./vad";

/** Feeds `frames` and returns the gate state after each one. */
function run(gate: VadGate, frames: number[]): boolean[] {
  return frames.map(level => gate.push(level));
}

const repeat = (level: number, count: number): number[] => Array.from({ length: count }, () => level);

describe("VadGate (voice activity)", () => {
  it("stays closed below the threshold and opens on the first frame above it", () => {
    const gate = new VadGate({ mode: "vad", thresholdDb: -50, auto: false });
    const out = run(gate, [...repeat(-80, 20), -40]);
    expect(out.slice(0, 20).every(open => !open)).toBe(true);
    expect(out[20]).toBe(true);
  });

  it("treats a level exactly at the threshold as speech", () => {
    const gate = new VadGate({ mode: "vad", thresholdDb: -50, auto: false });
    expect(gate.push(-50)).toBe(true);
  });

  it("closes only after the 400 ms hangover of quiet frames", () => {
    const gate = new VadGate({ mode: "vad", thresholdDb: -50, auto: false });
    run(gate, repeat(-30, 5));
    const quiet = run(gate, repeat(-90, HANGOVER_MS / FRAME_MS + 5));
    const hangoverFrames = HANGOVER_MS / FRAME_MS;
    // Open for the first 39 quiet frames (390 ms), closed from the 40th (400 ms) on.
    expect(quiet.slice(0, hangoverFrames - 1).every(Boolean)).toBe(true);
    expect(quiet[hangoverFrames - 1]).toBe(false);
    expect(quiet.slice(hangoverFrames).some(Boolean)).toBe(false);
  });

  it("restarts the hangover when speech resumes inside it", () => {
    const gate = new VadGate({ mode: "vad", thresholdDb: -50, auto: false });
    run(gate, [-30]);
    run(gate, repeat(-90, 30)); // 300 ms quiet
    gate.push(-30); // speech again
    const quiet = run(gate, repeat(-90, 39));
    expect(quiet.every(Boolean)).toBe(true);
    expect(gate.push(-90)).toBe(false);
  });

  it("never opens while forced closed (self mute), whatever the level", () => {
    const gate = new VadGate({ mode: "vad", thresholdDb: -50, auto: false });
    gate.setForcedClosed(true);
    expect(run(gate, repeat(0, 50)).some(Boolean)).toBe(false);
    gate.setForcedClosed(false);
    expect(gate.push(0)).toBe(true);
  });

  it("auto sensitivity opens 15 dB above the tracked noise floor, not on the noise itself", () => {
    const gate = new VadGate({ mode: "vad", thresholdDb: 0, auto: true });
    const noise = run(gate, repeat(-75, 300)); // 3 s of steady room noise
    expect(noise.some(Boolean)).toBe(false);
    expect(gate.effectiveThresholdDb).toBeGreaterThan(-61);
    expect(gate.effectiveThresholdDb).toBeLessThan(-59);
    expect(gate.push(-64)).toBe(false); // louder noise, still under floor + 15 dB
    expect(gate.push(-30)).toBe(true);
  });

  it("silence (-Infinity / NaN) counts as the bottom of the scale", () => {
    const gate = new VadGate({ mode: "vad", thresholdDb: -99, auto: false });
    expect(gate.push(Number.NEGATIVE_INFINITY)).toBe(false);
    expect(gate.push(Number.NaN)).toBe(false);
  });
});

describe("VadGate (push to talk)", () => {
  it("never opens from the input level", () => {
    const gate = new VadGate({ mode: "ptt", thresholdDb: -50, auto: false });
    expect(run(gate, [...repeat(0, 100), ...repeat(-10, 100)]).some(Boolean)).toBe(false);
  });

  it("opens while the key is held and closes 20 ms after release", () => {
    const gate = new VadGate({ mode: "ptt", thresholdDb: -50, auto: false });
    expect(gate.setKey(true)).toBe(true);
    expect(run(gate, repeat(-90, 10)).every(Boolean)).toBe(true); // silence does not close it while held
    gate.setKey(false);
    expect(gate.open).toBe(true);
    expect(gate.push(-90)).toBe(true); // 10 ms after release
    expect(gate.push(-90)).toBe(false); // 20 ms after release
  });

  it("closes on release immediately with a 0 ms release delay", () => {
    const gate = new VadGate({ mode: "ptt", thresholdDb: -50, auto: false, pttReleaseMs: 0 });
    gate.setKey(true);
    expect(gate.setKey(false)).toBe(false);
  });

  it("ignores the key while self muted", () => {
    const gate = new VadGate({ mode: "ptt", thresholdDb: -50, auto: false });
    gate.setForcedClosed(true);
    expect(gate.setKey(true)).toBe(false);
    expect(gate.push(0)).toBe(false);
  });

  it("switching from PTT to voice activity resets the gate", () => {
    const gate = new VadGate({ mode: "ptt", thresholdDb: -50, auto: false });
    gate.setKey(true);
    gate.configure({ mode: "vad" });
    expect(gate.open).toBe(false);
    expect(gate.push(-80)).toBe(false);
    expect(gate.push(-20)).toBe(true);
  });
});

describe("level helpers", () => {
  it("rmsDb: full-scale square wave is 0 dBFS, half scale about -6 dBFS, zeros are silence", () => {
    expect(rmsDb([1, -1, 1, -1])).toBeCloseTo(0, 5);
    expect(rmsDb([0.5, -0.5])).toBeCloseTo(-6.02, 1);
    expect(rmsDb(new Float32Array(480))).toBe(-100);
  });

  it("sensitivityToDb maps the 0..100 slider onto -100..0 dBFS", () => {
    expect(sensitivityToDb(0)).toBe(-100);
    expect(sensitivityToDb(40)).toBe(-60);
    expect(sensitivityToDb(100)).toBe(0);
    expect(sensitivityToDb(150)).toBe(0);
  });
});

describe("MutedTalkDetector", () => {
  const loud = (d: MutedTalkDetector, n: number) => Array.from({ length: n }, () => d.push(-30, -50)).some(Boolean);

  it("fires after about a second above the threshold, then starts over", () => {
    const d = new MutedTalkDetector();
    expect(loud(d, 99)).toBe(false);
    expect(d.push(-30, -50)).toBe(true);
    expect(loud(d, 99)).toBe(false);
  });

  it("bridges short gaps (speech) but a long pause starts over", () => {
    const d = new MutedTalkDetector();
    loud(d, 50);
    for (let i = 0; i < HANGOVER_MS / FRAME_MS; i += 1) d.push(-90, -50);
    expect(loud(d, 49)).toBe(false);
    expect(d.push(-30, -50)).toBe(true);
    const e = new MutedTalkDetector();
    loud(e, 90);
    for (let i = 0; i < HANGOVER_MS / FRAME_MS + 1; i += 1) e.push(-90, -50);
    expect(loud(e, 99)).toBe(false);
  });

  it("never fires on quiet input", () => {
    const d = new MutedTalkDetector();
    expect(Array.from({ length: 1000 }, () => d.push(-80, -50)).some(Boolean)).toBe(false);
  });
});
