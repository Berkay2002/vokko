// The default soundboard sounds, synthesized (no recorded or third-party audio, docs/assets-credits.md). Same recipes as the
// server's crates/server/src/soundboard/defaults.rs; the in-memory mock serves these, a real server serves its own render.

import { encodeWav } from "./helpers";

export const SYNTH_RATE = 22050;

export interface DefaultSoundMeta {
  id: string;
  name: string;
  emoji: string;
  volume: number;
}

type Render = () => Float32Array;

const seconds = (s: number): number => Math.floor(s * SYNTH_RATE);

function fade(samples: Float32Array): Float32Array {
  const edge = Math.max(1, Math.min(seconds(0.005), Math.floor(samples.length / 2)));
  for (let i = 0; i < edge; i += 1) {
    const gain = i / edge;
    samples[i] = (samples[i] ?? 0) * gain;
    const j = samples.length - 1 - i;
    samples[j] = (samples[j] ?? 0) * gain;
  }
  return samples;
}

function note(out: Float32Array, start: number, frequency: number, length: number, decay: number, gain: number): void {
  const offset = seconds(start);
  const count = seconds(length);
  for (let i = 0; i < count && offset + i < out.length; i += 1) {
    const t = i / SYNTH_RATE;
    out[offset + i] = (out[offset + i] ?? 0) + Math.sin(2 * Math.PI * frequency * t) * Math.exp(-t * decay) * gain;
  }
}

const chime: Render = () => {
  const out = new Float32Array(seconds(0.9));
  note(out, 0, 880, 0.9, 5, 0.45);
  note(out, 0.18, 1318.5, 0.72, 5, 0.4);
  return fade(out);
};

const pop: Render = () => {
  const length = seconds(0.14);
  const out = new Float32Array(length);
  let phase = 0;
  for (let i = 0; i < length; i += 1) {
    const progress = i / length;
    phase += (2 * Math.PI * (900 - 700 * progress)) / SYNTH_RATE;
    out[i] = Math.sin(phase) * (1 - progress) ** 2 * 0.8;
  }
  return fade(out);
};

const ding: Render = () => {
  const out = new Float32Array(seconds(1.3));
  for (const [ratio, decay, gain] of [[1, 3, 0.5], [2.76, 5, 0.2], [5.4, 8, 0.12]] as const) note(out, 0, 660 * ratio, 1.3, decay, gain);
  return fade(out);
};

const boop: Render = () => {
  const out = new Float32Array(seconds(0.5));
  for (const [start, frequency] of [[0, 220], [0.25, 330]] as const) {
    const offset = seconds(start);
    for (let i = 0; i < seconds(0.24); i += 1) out[offset + i] = Math.tanh(Math.sin((2 * Math.PI * frequency * i) / SYNTH_RATE) * 3) * 0.35;
  }
  return fade(out);
};

const fanfare: Render = () => {
  const out = new Float32Array(seconds(1.1));
  for (const [start, frequency, length] of [[0, 523.25, 0.16], [0.15, 659.25, 0.16], [0.3, 783.99, 0.16], [0.45, 1046.5, 0.65]] as const) {
    for (let harmonic = 1; harmonic <= 5; harmonic += 1) note(out, start, frequency * harmonic, length, 3, 0.22 / harmonic);
  }
  return fade(out);
};

const whoosh: Render = () => {
  const length = seconds(0.8);
  const out = new Float32Array(length);
  let seed = 0x2545f491;
  let low = 0;
  for (let i = 0; i < length; i += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const noise = ((seed >>> 8) / (1 << 24)) * 2 - 1;
    const progress = i / length;
    const cutoff = 0.02 + 0.25 * Math.sin(progress * Math.PI);
    low += cutoff * (noise - low);
    out[i] = low * Math.sin(progress * Math.PI) * 1.6;
  }
  return fade(out);
};

const RECIPES: [DefaultSoundMeta, Render][] = [
  [{ id: "1", name: "Chime", emoji: "🎐", volume: 1 }, chime],
  [{ id: "2", name: "Pop", emoji: "🫧", volume: 1 }, pop],
  [{ id: "3", name: "Ding", emoji: "🔔", volume: 0.9 }, ding],
  [{ id: "4", name: "Boop", emoji: "🤖", volume: 0.8 }, boop],
  [{ id: "5", name: "Fanfare", emoji: "🎺", volume: 0.8 }, fanfare],
  [{ id: "6", name: "Whoosh", emoji: "💨", volume: 1 }, whoosh],
];

export const DEFAULT_SOUNDS: DefaultSoundMeta[] = RECIPES.map(([meta]) => meta);

/** Samples of a recipe by default-sound id (also used by the mock to make its seeded guild sounds). */
export function synthSamples(id: string): Float32Array | null {
  const recipe = RECIPES.find(([meta]) => meta.id === id);
  return recipe ? recipe[1]() : null;
}

/** 16-bit mono WAV of a default sound. */
export function synthWav(id: string): Uint8Array | null {
  const samples = synthSamples(id);
  return samples ? encodeWav([samples], SYNTH_RATE, 0, samples.length / SYNTH_RATE, SYNTH_RATE) : null;
}
