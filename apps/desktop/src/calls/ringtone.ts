// Call tones, synthesised with Web Audio (our own, no audio files): a two-note ring for incoming calls and a soft ringback
// while we are calling someone. One tone at a time; `setTone(null)` stops it.

import { getPrefs } from "../ui/prefs";

export type Tone = "incoming" | "outgoing";

interface Burst {
  at: number;
  dur: number;
  freqs: number[];
}

/** One period of each tone (seconds) and the bursts in it. */
const PATTERNS: Record<Tone, { period: number; bursts: Burst[] }> = {
  // Rising major third twice, then a pause.
  incoming: {
    period: 2.6,
    bursts: [
      { at: 0, dur: 0.32, freqs: [587.33, 739.99] },
      { at: 0.42, dur: 0.32, freqs: [659.25, 830.61] },
    ],
  },
  // Long, low, quiet beat like a phone line ringback.
  outgoing: { period: 3.2, bursts: [{ at: 0, dur: 1.1, freqs: [440, 494] }] },
};

const MASTER = 0.12;

let context: AudioContext | null = null;
/** What should be playing (also without audio output, e.g. in tests or before the first gesture). */
let wanted: Tone | null = null;
let current: { tone: Tone; timer: ReturnType<typeof setInterval>; output: GainNode } | null = null;

function audio(): AudioContext | null {
  if (context) return context;
  if (typeof AudioContext === "undefined") return null;
  try {
    context = new AudioContext();
  } catch {
    context = null;
  }
  return context;
}

function schedule(ctx: AudioContext, output: GainNode, tone: Tone): void {
  const start = ctx.currentTime + 0.02;
  for (const burst of PATTERNS[tone].bursts) {
    const t0 = start + burst.at;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(1, t0 + 0.02);
    env.gain.setValueAtTime(1, t0 + burst.dur - 0.05);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + burst.dur);
    env.connect(output);
    for (const freq of burst.freqs) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, t0);
      osc.connect(env);
      osc.start(t0);
      osc.stop(t0 + burst.dur + 0.02);
    }
  }
}

/** The tone currently playing (tests and the UI). */
export const currentTone = (): Tone | null => wanted;

/** Plays `tone` in a loop at the user's output volume, or stops with null. Replaying the same tone keeps it going. */
export function setTone(tone: Tone | null): void {
  wanted = tone;
  if (current?.tone === tone) return;
  if (current) {
    clearInterval(current.timer);
    current.output.disconnect();
    current = null;
  }
  if (!tone) return;
  const ctx = audio();
  const volume = Math.max(0, Math.min(1, getPrefs().outputVolume / 100));
  if (!ctx || volume === 0) return;
  if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
  const output = ctx.createGain();
  output.gain.value = MASTER * volume;
  output.connect(ctx.destination);
  schedule(ctx, output, tone);
  const timer = setInterval(() => schedule(ctx, output, tone), PATTERNS[tone].period * 1000);
  current = { tone, timer, output };
}
