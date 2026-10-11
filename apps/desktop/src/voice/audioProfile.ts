// Input profile → what the microphone is asked for and what Vokko itself runs on it (pure, unit tested).
// Voice Isolation: everything on. Studio: nothing (an open mic). Custom: the individual controls.

export type InputProfile = "isolation" | "studio" | "custom";
export type NoiseSuppressionKind = "standard" | "rnnoise";

export interface AudioPrefs {
  inputProfile: InputProfile;
  /** Noise suppression on at all (custom); the kind says which one. */
  noiseSuppression: boolean;
  noiseSuppressionKind: NoiseSuppressionKind;
  echoCancellation: boolean;
  autoGainControl: boolean;
  /** "Bypass system input processing": request the raw capture, no browser / OS echo, noise or gain processing. */
  bypassSystemProcessing: boolean;
}

export interface ResolvedAudio {
  /** getUserMedia constraints. */
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  /** RNNoise in the input chain (replaces the browser's noise suppression, never stacked with it). */
  rnnoise: boolean;
}

export function isInputProfile(value: unknown): value is InputProfile {
  return value === "isolation" || value === "studio" || value === "custom";
}

export function resolveAudio(p: AudioPrefs): ResolvedAudio {
  let echo: boolean;
  let noise: boolean;
  let gain: boolean;
  let kind: NoiseSuppressionKind = p.noiseSuppressionKind;
  switch (p.inputProfile) {
    case "isolation":
      echo = true;
      noise = true;
      gain = true;
      break;
    case "studio":
      echo = false;
      noise = false;
      gain = false;
      break;
    default:
      echo = p.echoCancellation;
      noise = p.noiseSuppression;
      gain = p.autoGainControl;
  }
  const rnnoise = noise && kind === "rnnoise";
  if (p.bypassSystemProcessing) return { echoCancellation: false, noiseSuppression: false, autoGainControl: false, rnnoise };
  return { echoCancellation: echo, noiseSuppression: noise && !rnnoise, autoGainControl: gain, rnnoise };
}

/** The dropdown value (None / Standard / RNNoise) for the stored pair. */
export function suppressionChoice(noiseSuppression: boolean, kind: NoiseSuppressionKind): "none" | NoiseSuppressionKind {
  return noiseSuppression ? kind : "none";
}

export function fromSuppressionChoice(choice: "none" | NoiseSuppressionKind, current: NoiseSuppressionKind): { noiseSuppression: boolean; noiseSuppressionKind: NoiseSuppressionKind } {
  return choice === "none" ? { noiseSuppression: false, noiseSuppressionKind: current } : { noiseSuppression: true, noiseSuppressionKind: choice };
}
