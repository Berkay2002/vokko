import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioProcessorOptions } from "livekit-client";
import { GateProcessor } from "./gate";
import type { VoiceSettings } from "./reducer";

// A Web Audio double that records every connection, so the tests can say where a track's audio can and cannot go.
interface FakeNode {
  kind: string;
  tracks?: FakeTrack[];
  gain: { value: number; cancelScheduledValues(): void; setTargetAtTime(): void };
  fftSize: number;
  connect(to: FakeNode): FakeNode;
  disconnect(): void;
  getFloatTimeDomainData(buffer: Float32Array): void;
}
interface FakeTrack {
  name: string;
  enabled: boolean;
  stopped: boolean;
  clone(): FakeTrack;
  stop(): void;
}

let edges: [FakeNode, FakeNode][];
let sources: FakeNode[];
let clones: FakeTrack[];
let amplitude: number;

const track = (name: string): FakeTrack => ({
  name,
  enabled: true,
  stopped: false,
  clone() {
    const copy = track(`${name}-clone`);
    clones.push(copy);
    return copy;
  },
  stop() {
    this.stopped = true;
  },
});

const node = (kind: string): FakeNode => ({
  kind,
  gain: { value: 1, cancelScheduledValues() {}, setTargetAtTime() {} },
  fftSize: 0,
  connect(to) {
    edges.push([this, to]);
    return to;
  },
  disconnect() {},
  getFloatTimeDomainData(buffer) {
    buffer.fill(amplitude);
  },
});

const ctx = {
  currentTime: 0,
  createGain: () => node("gain"),
  createAnalyser: () => node("analyser"),
  createMediaStreamSource: (stream: { tracks: FakeTrack[] }) => {
    const source = node("source");
    source.tracks = stream.tracks;
    sources.push(source);
    return source;
  },
  createMediaStreamDestination: () => Object.assign(node("destination"), { stream: { getAudioTracks: () => [track("processed")], getTracks: () => [] } }),
};

const settings = { inputMode: "vad", vadThresholdDb: -50, vadAuto: false, pttReleaseMs: 200, inputGain: 1, rnnoise: false } as unknown as VoiceSettings;
const options = (raw: FakeTrack) => ({ track: raw, audioContext: ctx }) as unknown as AudioProcessorOptions;

/** Every node the audio of `from` can reach through the recorded connections. */
function reachable(from: FakeNode): Set<FakeNode> {
  const seen = new Set<FakeNode>();
  const walk = (n: FakeNode) => edges.filter(([a]) => a === n).forEach(([, b]) => !seen.has(b) && (seen.add(b), walk(b)));
  walk(from);
  return seen;
}

beforeEach(() => {
  vi.useFakeTimers();
  edges = [];
  sources = [];
  clones = [];
  amplitude = 0;
  vi.stubGlobal("AudioWorkletNode", class {});
  vi.stubGlobal("MediaStream", class { constructor(public tracks: FakeTrack[]) {} });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("GateProcessor: muted", () => {
  it("publishes from the raw track, and the muted-speech clone never reaches the output", async () => {
    const raw = track("raw");
    const gate = new GateProcessor(settings, true, () => {});
    await gate.init(options(raw));
    expect(sources[0]?.tracks).toEqual([raw]); // the published chain: a disabled raw track means silence
    const tap = sources.find(s => s.tracks?.[0] === clones[0]);
    expect(tap).toBeDefined();
    const destination = edges.map(([, b]) => b).find(b => b.kind === "destination")!;
    expect([...reachable(tap!)].map(n => n.kind)).toEqual(["analyser"]);
    expect(reachable(tap!).has(destination)).toBe(false);
    expect(reachable(sources[0]!).has(destination)).toBe(true);
    expect(gate.processedTrack).toBeDefined();
  });

  it("runs the clone only while muted: stops it on unmute, restarts it on mute, stops it on destroy", async () => {
    const gate = new GateProcessor(settings, false, () => {});
    await gate.init(options(track("raw")));
    expect(clones).toHaveLength(0);
    gate.setMuted(true);
    expect(clones).toHaveLength(1);
    gate.setMuted(true);
    expect(clones).toHaveLength(1); // not cloned twice
    gate.setMuted(false);
    expect(clones[0]?.stopped).toBe(true);
    gate.setMuted(true);
    expect(clones).toHaveLength(2);
    await gate.destroy();
    expect(clones[1]?.stopped).toBe(true);
  });

  it("releases the clone before the mic is re-captured, and takes a new one on the new track", async () => {
    const gate = new GateProcessor(settings, true, () => {});
    await gate.init(options(track("raw")));
    gate.pauseTap();
    expect(clones[0]?.stopped).toBe(true);
    await gate.restart(options(track("raw2")));
    expect(clones).toHaveLength(2);
    expect(clones[1]?.name).toBe("raw2-clone");
    expect(clones[1]?.stopped).toBe(false);
  });

  it("raises the hint after about a second of speech and stays quiet when not muted", async () => {
    const heard = vi.fn();
    const gate = new GateProcessor(settings, true, () => {}, heard);
    await gate.init(options(track("raw")));
    amplitude = 0.3;
    vi.advanceTimersByTime(800);
    expect(heard).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(heard).toHaveBeenCalledTimes(1);
    gate.setMuted(false);
    vi.advanceTimersByTime(3000);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("sets the published gain to zero on mute", async () => {
    const gate = new GateProcessor(settings, false, () => {});
    await gate.init(options(track("raw")));
    const gain = edges.map(([, b]) => b).find(b => b.kind === "gain" && edges.some(([a, c]) => a === b && c.kind === "destination"))!;
    gain.gain.value = 1;
    gate.setMuted(true);
    expect(gain.gain.value).toBe(0);
  });
});
