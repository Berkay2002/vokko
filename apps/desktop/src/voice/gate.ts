// Audio side of the VAD / PTT gate: a LiveKit TrackProcessor that routes the mic through a GainNode and feeds the pure
// VadGate (./vad.ts) one RMS level per 10 ms. Levels come from an AudioWorklet (message per 10 ms, not throttled like timers
// in background tabs); without AudioWorklet an AnalyserNode is polled every 10 ms instead. Not unit tested: keep it thin.

import type { AudioProcessorOptions, Track, TrackProcessor } from "livekit-client";
import { FRAME_MS, VadGate, rmsDb } from "./vad";
import type { VoiceSettings } from "./reducer";

const WORKLET = `
class VokkoLevel extends AudioWorkletProcessor {
  constructor() { super(); this.sum = 0; this.n = 0; this.block = Math.round(sampleRate * ${FRAME_MS} / 1000); }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) { this.sum += ch[i] * ch[i]; if (++this.n >= this.block) { const rms = Math.sqrt(this.sum / this.n); this.port.postMessage(rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100); this.sum = 0; this.n = 0; } }
    return true;
  }
}
registerProcessor("vokko-level", VokkoLevel);
`;

let workletUrl: string | null = null;
const loaded = new WeakSet<BaseAudioContext>();

async function loadWorklet(ctx: AudioContext): Promise<boolean> {
  if (!ctx.audioWorklet || typeof AudioWorkletNode === "undefined") return false;
  if (loaded.has(ctx)) return true;
  try {
    workletUrl ??= URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
    await ctx.audioWorklet.addModule(workletUrl);
    loaded.add(ctx);
    return true;
  } catch {
    return false;
  }
}

export class GateProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = "vokko-gate";
  processedTrack?: MediaStreamTrack;
  readonly gate: VadGate;
  private nodes: { source: MediaStreamAudioSourceNode; gain: GainNode; level: AudioNode; dest: MediaStreamAudioDestinationNode } | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private ctx: AudioContext | null = null;
  private openNow = false;

  constructor(
    settings: VoiceSettings,
    muted: boolean,
    private readonly onChange: (open: boolean) => void,
  ) {
    this.gate = new VadGate({ mode: settings.inputMode, thresholdDb: settings.vadThresholdDb, auto: settings.vadAuto, pttReleaseMs: settings.pttReleaseMs });
    this.gate.setForcedClosed(muted);
  }

  async init(opts: AudioProcessorOptions): Promise<void> {
    const ctx = opts.audioContext;
    this.ctx = ctx;
    const source = ctx.createMediaStreamSource(new MediaStream([opts.track]));
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const dest = ctx.createMediaStreamDestination();
    source.connect(gain).connect(dest);
    let level: AudioNode;
    if (await loadWorklet(ctx)) {
      const node = new AudioWorkletNode(ctx, "vokko-level", { numberOfInputs: 1, numberOfOutputs: 0 });
      node.port.onmessage = (event: MessageEvent<number>) => this.frame(event.data);
      level = node;
    } else {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      const buffer = new Float32Array(analyser.fftSize);
      this.poll = setInterval(() => {
        analyser.getFloatTimeDomainData(buffer);
        this.frame(rmsDb(buffer));
      }, FRAME_MS);
      level = analyser;
    }
    source.connect(level);
    this.nodes = { source, gain, level, dest };
    this.processedTrack = dest.stream.getAudioTracks()[0];
  }

  async restart(opts: AudioProcessorOptions): Promise<void> {
    await this.destroy();
    await this.init(opts);
  }

  async destroy(): Promise<void> {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    if (this.nodes) {
      const { source, gain, level, dest } = this.nodes;
      if (level instanceof AudioWorkletNode) level.port.onmessage = null;
      for (const node of [source, gain, level]) node.disconnect();
      dest.stream.getTracks().forEach(t => t.stop());
    }
    this.nodes = null;
    this.processedTrack = undefined;
    this.set(false);
  }

  setKey(pressed: boolean): void {
    this.set(this.gate.setKey(pressed));
  }

  setMuted(muted: boolean): void {
    this.gate.setForcedClosed(muted);
    this.set(this.gate.open);
  }

  configure(settings: VoiceSettings): void {
    this.gate.configure({ mode: settings.inputMode, thresholdDb: settings.vadThresholdDb, auto: settings.vadAuto, pttReleaseMs: settings.pttReleaseMs });
  }

  private frame(levelDb: number): void {
    this.set(this.gate.push(levelDb));
  }

  private set(open: boolean): void {
    if (open === this.openNow) return;
    this.openNow = open;
    if (this.nodes && this.ctx) this.nodes.gain.gain.setTargetAtTime(open ? 1 : 0, this.ctx.currentTime, 0.005);
    this.onChange(open);
  }
}
