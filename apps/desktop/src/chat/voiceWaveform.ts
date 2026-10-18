// Voice-message data in Discord's shape: `waveform` is base64 of at most 256 bytes, each an amplitude 0-255 sampled evenly over the clip.

export const MAX_WAVEFORM_SAMPLES = 256;
export const MAX_VOICE_SECONDS = 20 * 60;

/** Averages `values` into `count` evenly sized buckets (or returns them as they are when there are fewer). */
export function resample(values: readonly number[], count: number): number[] {
  if (values.length <= count) return [...values];
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const start = Math.floor((i * values.length) / count), end = Math.floor(((i + 1) * values.length) / count);
    let sum = 0;
    for (let j = start; j < end; j++) sum += values[j]!;
    out.push(sum / (end - start));
  }
  return out;
}

/** Levels (0-1, one per analyser tick) to the wire waveform: at most 256 samples, scaled so the loudest is 255. */
export function encodeWaveform(levels: readonly number[]): string {
  const samples = resample(levels.length ? levels : [0], MAX_WAVEFORM_SAMPLES);
  const peak = Math.max(...samples);
  const bytes = samples.map(v => (peak > 0 ? Math.round((Math.max(0, v) / peak) * 255) : 0));
  return btoa(String.fromCharCode(...bytes));
}

/** The wire waveform as 0-1 values; an empty or broken one gives []. */
export function decodeWaveform(waveform: string | undefined): number[] {
  if (!waveform) return [];
  try {
    return [...atob(waveform)].slice(0, MAX_WAVEFORM_SAMPLES).map(ch => ch.charCodeAt(0) / 255);
  } catch {
    return [];
  }
}

/** The best MediaRecorder type: opus in webm (Chromium) or ogg (Firefox), else AAC in mp4 (Safari / WKWebView). */
export function pickVoiceType(isTypeSupported: (type: string) => boolean): { mimeType: string; extension: string } | null {
  const candidates: [string, string][] = [['audio/ogg;codecs=opus', 'ogg'], ['audio/webm;codecs=opus', 'webm'], ['audio/mp4', 'm4a'], ['audio/mp4;codecs=mp4a.40.2', 'm4a']];
  const hit = candidates.find(([type]) => isTypeSupported(type));
  return hit ? { mimeType: hit[0], extension: hit[1] } : null;
}

/** 0:07, 1:05, 20:00 */
export function formatVoiceTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
