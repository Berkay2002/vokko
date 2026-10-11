// Notification sounds, synthesised with Web Audio (no audio files, so no licences to carry). Open assets only.

import { getPrefs } from "../ui/prefs";
import { isSoundEnabled, type VoiceSoundId } from "./soundCatalog";

export type SoundName = "message" | "mention" | VoiceSoundId;

interface Note {
  /** Seconds after the sound starts. */
  at: number;
  freq: number;
  /** Optional glide target in Hz over the note. */
  to?: number;
  dur: number;
  gain: number;
  type?: OscillatorType;
}

// Soft two-note blip for plain messages, brighter three-note rise for mentions and DMs, short glides for voice.
const SOUNDS: Record<SoundName, Note[]> = {
  message: [
    { at: 0, freq: 659.25, dur: 0.11, gain: 0.7 },
    { at: 0.09, freq: 880, dur: 0.16, gain: 0.55 },
  ],
  mention: [
    { at: 0, freq: 784, dur: 0.1, gain: 0.7 },
    { at: 0.09, freq: 987.77, dur: 0.1, gain: 0.7 },
    { at: 0.18, freq: 1318.51, dur: 0.24, gain: 0.6, type: "triangle" },
  ],
  mute: [{ at: 0, freq: 622, to: 415, dur: 0.12, gain: 0.6 }],
  unmute: [{ at: 0, freq: 415, to: 622, dur: 0.12, gain: 0.6 }],
  deafen: [
    { at: 0, freq: 523, dur: 0.08, gain: 0.55 },
    { at: 0.08, freq: 330, to: 262, dur: 0.14, gain: 0.55 },
  ],
  undeafen: [
    { at: 0, freq: 262, dur: 0.08, gain: 0.55 },
    { at: 0.08, freq: 330, to: 523, dur: 0.14, gain: 0.55 },
  ],
  "camera-on": [
    { at: 0, freq: 587, dur: 0.07, gain: 0.55, type: "triangle" },
    { at: 0.07, freq: 880, dur: 0.12, gain: 0.55, type: "triangle" },
  ],
  "camera-off": [
    { at: 0, freq: 880, dur: 0.07, gain: 0.55, type: "triangle" },
    { at: 0.07, freq: 587, dur: 0.12, gain: 0.55, type: "triangle" },
  ],
  "voice-connected": [{ at: 0, freq: 440, to: 740, dur: 0.18, gain: 0.7 }],
  "voice-disconnected": [{ at: 0, freq: 740, to: 392, dur: 0.18, gain: 0.7 }],
  "user-join": [
    { at: 0, freq: 523, dur: 0.07, gain: 0.55 },
    { at: 0.07, freq: 659, dur: 0.1, gain: 0.55 },
  ],
  "user-leave": [
    { at: 0, freq: 659, dur: 0.07, gain: 0.55 },
    { at: 0.07, freq: 440, dur: 0.1, gain: 0.55 },
  ],
  "user-moved": [
    { at: 0, freq: 587, dur: 0.06, gain: 0.5 },
    { at: 0.1, freq: 587, dur: 0.06, gain: 0.5 },
  ],
  "stream-start": [
    { at: 0, freq: 392, dur: 0.08, gain: 0.6, type: "triangle" },
    { at: 0.08, freq: 523, dur: 0.08, gain: 0.6, type: "triangle" },
    { at: 0.16, freq: 784, dur: 0.16, gain: 0.6, type: "triangle" },
  ],
  "stream-stop": [
    { at: 0, freq: 784, dur: 0.08, gain: 0.6, type: "triangle" },
    { at: 0.08, freq: 523, dur: 0.08, gain: 0.6, type: "triangle" },
    { at: 0.16, freq: 392, dur: 0.16, gain: 0.6, type: "triangle" },
  ],
  "ptt-activate": [{ at: 0, freq: 880, dur: 0.04, gain: 0.45 }],
  "ptt-deactivate": [{ at: 0, freq: 660, dur: 0.04, gain: 0.45 }],
  "server-mute": [
    { at: 0, freq: 330, dur: 0.1, gain: 0.6, type: "triangle" },
    { at: 0.12, freq: 247, dur: 0.16, gain: 0.6, type: "triangle" },
  ],
  "server-deaf": [
    { at: 0, freq: 262, dur: 0.1, gain: 0.6, type: "triangle" },
    { at: 0.12, freq: 196, dur: 0.18, gain: 0.6, type: "triangle" },
  ],
  "connection-lost": [
    { at: 0, freq: 330, dur: 0.12, gain: 0.55, type: "triangle" },
    { at: 0.14, freq: 262, dur: 0.12, gain: 0.55, type: "triangle" },
    { at: 0.28, freq: 196, dur: 0.2, gain: 0.55, type: "triangle" },
  ],
  "connection-restored": [
    { at: 0, freq: 262, dur: 0.1, gain: 0.55, type: "triangle" },
    { at: 0.1, freq: 392, dur: 0.14, gain: 0.55, type: "triangle" },
  ],
};

const isVoiceSound = (name: SoundName): name is VoiceSoundId => name !== "message" && name !== "mention";

/** Master level: quiet by design, the output-volume pref scales it. */
const MASTER = 0.22;
/** Don't stack the same sound inside this window (a burst of messages is one ping). */
const MIN_GAP_MS = 150;

let context: AudioContext | null = null;
const lastPlayed = new Map<SoundName, number>();
let unlockWired = false;

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

/** Browsers keep audio suspended until a user gesture: resume it on the first one so later pings are audible. */
export function wireAudioUnlock(): void {
  if (unlockWired || typeof window === "undefined") return;
  unlockWired = true;
  const unlock = () => {
    const ctx = audio();
    if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    if (ctx) {
      window.removeEventListener("pointerdown", unlock, true);
      window.removeEventListener("keydown", unlock, true);
    }
  };
  window.addEventListener("pointerdown", unlock, true);
  window.addEventListener("keydown", unlock, true);
}

/** Plays a notification sound at the user's output volume. Returns false when nothing was played. */
export function playSound(name: SoundName, now = Date.now()): boolean {
  if (isVoiceSound(name) && !isSoundEnabled(getPrefs().disabledSounds, name)) return false;
  return play(name, now, false);
}

/** The Preview button: plays even when the sound is switched off, and without the burst guard. */
export function previewSound(name: SoundName): boolean {
  return play(name, Date.now(), true);
}

function play(name: SoundName, now: number, preview: boolean): boolean {
  const last = lastPlayed.get(name);
  if (!preview && last !== undefined && now - last < MIN_GAP_MS) return false;
  const volume = Math.max(0, Math.min(1, getPrefs().outputVolume / 100));
  if (volume === 0) return false;
  const ctx = audio();
  if (!ctx) return false;
  lastPlayed.set(name, now);
  if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
  const start = ctx.currentTime + 0.01;
  for (const note of SOUNDS[name]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const t0 = start + note.at;
    const peak = MASTER * volume * note.gain;
    osc.type = note.type ?? "sine";
    osc.frequency.setValueAtTime(note.freq, t0);
    if (note.to) osc.frequency.linearRampToValueAtTime(note.to, t0 + note.dur);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + note.dur + 0.08);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + note.dur + 0.1);
  }
  return true;
}
