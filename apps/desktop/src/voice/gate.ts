// Audio side of the VAD / PTT gate: a LiveKit TrackProcessor that routes the mic through the input chain (RNNoise,
// level tap, input volume: ./inputChain.ts) and a gate GainNode, and feeds the pure VadGate (./vad.ts) one RMS level per
// 10 ms. Not unit tested: keep it thin.

import type { AudioProcessorOptions, Track, TrackProcessor } from "livekit-client";
import { InputChain } from "./inputChain";
import { VadGate } from "./vad";
import type { VoiceSettings } from "./reducer";

export class GateProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = "vokko-gate";
  processedTrack?: MediaStreamTrack;
  readonly gate: VadGate;
  private nodes: { chain: InputChain; gain: GainNode; dest: MediaStreamAudioDestinationNode } | null = null;
  private ctx: AudioContext | null = null;
  private inputGain: number;
  private rnnoise: boolean;
  /** Called once when RNNoise was requested but could not start (the transport falls back to the browser's). */
  onDenoiseUnavailable: (() => void) | null = null;
  private openNow = false;

  constructor(
    settings: VoiceSettings,
    muted: boolean,
    private readonly onChange: (open: boolean) => void,
  ) {
    this.gate = new VadGate({ mode: settings.inputMode, thresholdDb: settings.vadThresholdDb, auto: settings.vadAuto, pttReleaseMs: settings.pttReleaseMs });
    this.gate.setForcedClosed(muted);
    this.inputGain = settings.inputGain;
    this.rnnoise = settings.rnnoise;
  }

  async init(opts: AudioProcessorOptions): Promise<void> {
    const ctx = opts.audioContext;
    this.ctx = ctx;
    const source = ctx.createMediaStreamSource(new MediaStream([opts.track]));
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const dest = ctx.createMediaStreamDestination();
    const chain = await InputChain.create(ctx, source, {
      gain: this.inputGain,
      rnnoise: this.rnnoise,
      onLevel: db => this.frame(db),
      onDenoiseUnavailable: () => this.onDenoiseUnavailable?.(),
    });
    chain.output.connect(gain).connect(dest);
    this.nodes = { chain, gain, dest };
    this.processedTrack = dest.stream.getAudioTracks()[0];
  }

  async restart(opts: AudioProcessorOptions): Promise<void> {
    await this.destroy();
    await this.init(opts);
  }

  async destroy(): Promise<void> {
    if (this.nodes) {
      const { chain, gain, dest } = this.nodes;
      chain.destroy();
      gain.disconnect();
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
    this.inputGain = settings.inputGain;
    this.nodes?.chain.setGain(settings.inputGain);
    if (settings.rnnoise !== this.rnnoise) {
      this.rnnoise = settings.rnnoise;
      void this.nodes?.chain.setDenoise(settings.rnnoise);
    }
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
