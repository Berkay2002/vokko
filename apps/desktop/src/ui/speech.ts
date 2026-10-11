/** Text-to-speech through the Web Speech API (Settings > Accessibility > Text-to-speech rate). */

export function speechAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

/** Speaks `text` at `rate` (0.5..2), replacing anything already being read. Returns false when the browser has no speech synthesis. */
export function speak(text: string, rate: number): boolean {
  if (!speechAvailable()) return false;
  const synth = window.speechSynthesis;
  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = rate;
  synth.speak(utterance);
  return true;
}
