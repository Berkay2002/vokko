// Audio side of the VAD / PTT gate: a LiveKit TrackProcessor that routes the mic through the input chain (RNNoise,
// level tap, input volume: ./inputChain.ts) and a gate GainNode, and feeds the pure VadGate (./vad.ts) one RMS level per
// 10 ms. Not unit tested: keep it thin.

import type { AudioProcessorOptions, Track, TrackProcessor } from "livekit-client";
import { InputChain } from "./inputChain";
import { MutedTap } from "./mutedTap";
import { MutedTalkDetector, VadGate } from "./vad";
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
  private muted: boolean;
  private readonly talk = new MutedTalkDetector();
  /** The raw track: the published chain reads it, and LiveKit disables it on mute, so mute means silence whatever the gate does. */
  private raw: MediaStreamTrack | null = null;
  /** While muted only: a live clone for the "you are muted" hint. Never connected to the output. */
  private tap: MutedTap | null = null;

  constructor(
    settings: VoiceSettings,
    muted: boolean,
    private readonly onChange: (open: boolean) => void,
    /** Called when the user has been talking for about a second while muted. */
    private readonly onMutedSpeech?: () => void,
  ) {
    this.muted = muted;
    this.gate = new VadGate({ mode: settings.inputMode, thresholdDb: settings.vadThresholdDb, auto: settings.vadAuto, pttReleaseMs: settings.pttReleaseMs });
    this.gate.setForcedClosed(muted);
    this.inputGain = settings.inputGain;
    this.rnnoise = settings.rnnoise;
  }

  async init(opts: AudioProcessorOptions): Promise<void> {
    const ctx = opts.audioContext;
    this.ctx = ctx;
    this.raw = opts.track;
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
    this.syncTap();
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
    this.pauseTap();
    this.raw = null;
    this.nodes = null;
    this.processedTrack = undefined;
    this.set(false);
  }

  setKey(pressed: boolean): void {
    this.set(this.gate.setKey(pressed));
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.talk.reset();
    this.gate.setForcedClosed(muted);
    // Belt and braces: the disabled raw track already means silence; this also cuts the gate ramp at once.
    if (muted && this.nodes) {
      this.nodes.gain.gain.cancelScheduledValues(0);
      this.nodes.gain.gain.value = 0;
    }
    this.set(this.gate.open);
    this.syncTap();
  }

  /** Releases the hint's clone. The transport calls this before anything that re-captures the mic (device switch, restart). */
  pauseTap(): void {
    this.tap?.stop();
    this.tap = null;
  }

  private syncTap(): void {
    if (!this.muted) return this.pauseTap();
    if (this.tap || !this.ctx || !this.raw || !this.nodes) return;
    this.tap = new MutedTap(this.ctx, this.raw, db => {
      this.gate.push(db); // forced closed: only keeps the noise floor of the auto threshold
      if (this.talk.push(db, this.gate.effectiveThresholdDb)) this.onMutedSpeech?.();
    });
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
    if (this.muted) return; // the raw track is disabled: the clone's level (syncTap) drives the floor and the hint
    this.set(this.gate.push(levelDb));
  }

  private set(open: boolean): void {
    if (open === this.openNow) return;
    this.openNow = open;
    if (this.nodes && this.ctx) this.nodes.gain.gain.setTargetAtTime(open ? 1 : 0, this.ctx.currentTime, 0.005);
    this.onChange(open);
  }
}
