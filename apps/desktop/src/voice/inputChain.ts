// The microphone's Web Audio chain, shared by the published track (gate.ts) and the settings mic test:
//
//   source ─ [RNNoise] ─ level tap (10 ms RMS, dBFS) ─ input gain ─▶ output
//
// The level is taken after noise suppression and before the input volume, so the sensitivity slider means the same
// whatever the volume is set to, and noise RNNoise removed does not open the gate. Not unit tested: keep it thin.

import { FRAME_MS, rmsDb } from "./vad";
import { createRnnoiseNode } from "./rnnoise";

const loaded = new WeakSet<BaseAudioContext>();

async function loadLevelWorklet(ctx: AudioContext): Promise<boolean> {
  if (!ctx.audioWorklet || typeof AudioWorkletNode === "undefined") return false;
  if (loaded.has(ctx)) return true;
  try {
    // A real file (public/level-worklet.js), not a blob: or data: URL, so the Tauri CSP does not need script-src blob:.
    const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
    await ctx.audioWorklet.addModule(`${base}level-worklet.js`);
    loaded.add(ctx);
    return true;
  } catch {
    return false;
  }
}

export interface InputChainOptions {
  /** 0..2 (input volume 0-200 %). */
  gain: number;
  rnnoise: boolean;
  /** One RMS level in dBFS per 10 ms. */
  onLevel(db: number): void;
  /** RNNoise was asked for but could not start (sample rate, load error). */
  onDenoiseUnavailable?(): void;
}

export class InputChain {
  /** Connect this to the gate / destination. */
  readonly output: GainNode;
  private readonly junction: GainNode;
  private denoise: AudioNode | null = null;
  private level: AudioNode | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private wantDenoise: boolean;
  private generation = 0;
  private destroyed = false;

  private constructor(
    private readonly ctx: AudioContext,
    private readonly source: MediaStreamAudioSourceNode,
    private readonly options: InputChainOptions,
  ) {
    this.junction = ctx.createGain();
    this.output = ctx.createGain();
    this.output.gain.value = options.gain;
    this.wantDenoise = options.rnnoise;
    source.connect(this.junction);
    this.junction.connect(this.output);
  }

  static async create(ctx: AudioContext, source: MediaStreamAudioSourceNode, options: InputChainOptions): Promise<InputChain> {
    const chain = new InputChain(ctx, source, options);
    await chain.attachLevel();
    if (options.rnnoise) await chain.setDenoise(true);
    return chain;
  }

  private async attachLevel(): Promise<void> {
    if (await loadLevelWorklet(this.ctx)) {
      const node = new AudioWorkletNode(this.ctx, "vokko-level", { numberOfInputs: 1, numberOfOutputs: 0, processorOptions: { frameMs: FRAME_MS } });
      node.port.onmessage = (event: MessageEvent<number>) => this.options.onLevel(event.data);
      this.level = node;
    } else {
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;
      const buffer = new Float32Array(analyser.fftSize);
      this.poll = setInterval(() => {
        analyser.getFloatTimeDomainData(buffer);
        this.options.onLevel(rmsDb(buffer));
      }, FRAME_MS);
      this.level = analyser;
    }
    this.junction.connect(this.level);
  }

  setGain(gain: number): void {
    this.output.gain.setTargetAtTime(Math.max(0, Math.min(2, gain)), this.ctx.currentTime, 0.01);
  }

  /** Switches RNNoise on or off in place (no gap longer than the node load). Resolves false when it could not start. */
  async setDenoise(on: boolean): Promise<boolean> {
    this.wantDenoise = on;
    const generation = ++this.generation;
    if (!on) {
      this.rewire(null);
      return true;
    }
    if (this.denoise) return true;
    const node = await createRnnoiseNode(this.ctx);
    if (this.destroyed || generation !== this.generation) {
      node?.disconnect();
      node?.destroy();
      return !!node;
    }
    if (!node) {
      this.options.onDenoiseUnavailable?.();
      return false;
    }
    this.rewire(node);
    return true;
  }

  get denoising(): boolean {
    return this.denoise !== null && this.wantDenoise;
  }

  private rewire(node: AudioNode | null): void {
    this.source.disconnect();
    const old = this.denoise;
    if (old) {
      old.disconnect();
      (old as { destroy?: () => void }).destroy?.();
    }
    this.denoise = node;
    if (node) {
      this.source.connect(node);
      node.connect(this.junction);
    } else {
      this.source.connect(this.junction);
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    if (this.level instanceof AudioWorkletNode) this.level.port.onmessage = null;
    for (const node of [this.source, this.denoise, this.junction, this.level, this.output]) node?.disconnect();
    (this.denoise as { destroy?: () => void } | null)?.destroy?.();
    this.denoise = null;
  }
}
