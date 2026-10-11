// RNNoise noise suppression as an AudioWorklet node (xiph/rnnoise, BSD-3-Clause, through @sapphi-red/web-noise-suppressor,
// MIT: see docs/assets-credits.md). Loaded lazily: the worklet and its 150 kB WASM are only fetched the first time
// someone picks "RNNoise". RNNoise is trained for 48 kHz audio, so a context at another rate gets no node.

import type { RnnoiseWorkletNode } from "@sapphi-red/web-noise-suppressor";

export const RNNOISE_RATE = 48_000;

let wasm: Promise<ArrayBuffer> | null = null;
const loaded = new WeakSet<BaseAudioContext>();

export function rnnoiseSupported(ctx: Pick<BaseAudioContext, "sampleRate"> & { audioWorklet?: unknown }): boolean {
  return typeof AudioWorkletNode !== "undefined" && !!ctx.audioWorklet && ctx.sampleRate === RNNOISE_RATE;
}

/** A mono RNNoise node for `ctx`, or null when it cannot run here (wrong sample rate, no AudioWorklet, load failure). */
export async function createRnnoiseNode(ctx: AudioContext): Promise<RnnoiseWorkletNode | null> {
  if (!rnnoiseSupported(ctx)) return null;
  try {
    const [lib, worklet, wasmUrl, simdUrl] = await Promise.all([
      import("@sapphi-red/web-noise-suppressor"),
      import("@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url").then(m => m.default),
      import("@sapphi-red/web-noise-suppressor/rnnoise.wasm?url").then(m => m.default),
      import("@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url").then(m => m.default),
    ]);
    wasm ??= lib.loadRnnoise({ url: wasmUrl, simdUrl });
    const wasmBinary = await wasm.catch(error => {
      wasm = null;
      throw error;
    });
    if (!loaded.has(ctx)) {
      await ctx.audioWorklet.addModule(worklet);
      loaded.add(ctx);
    }
    return new lib.RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary });
  } catch (error) {
    console.warn("voice: RNNoise unavailable", error);
    return null;
  }
}
