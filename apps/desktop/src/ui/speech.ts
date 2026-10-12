/** Text-to-speech through the Web Speech API (Settings > Accessibility > Text-to-speech rate). */

export function speechAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

/** Speaks `text` at `rate` (0.5..5.5), replacing anything already being read. Returns false when the browser has no speech synthesis. */
export function speak(text: string, rate: number): boolean {
  if (!speechAvailable()) return false;
  const synth = window.speechSynthesis;
  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = rate;
  synth.speak(utterance);
  return true;
}

/** How many /tts messages may wait or be speaking at once; newer ones beyond that are dropped. */
export const MAX_QUEUED_SPEECH = 3;
let queued = 0;

/**
 * Speaks `text` after whatever is already being read (speechSynthesis's own queue) without cancelling it. At most MAX_QUEUED_SPEECH
 * utterances are outstanding; further ones are dropped. Returns whether the text was queued.
 */
export function enqueueSpeech(text: string, rate: number): boolean {
  if (!speechAvailable() || queued >= MAX_QUEUED_SPEECH) return false;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = rate;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    queued = Math.max(0, queued - 1);
  };
  utterance.onend = finish;
  utterance.onerror = finish;
  queued += 1;
  window.speechSynthesis.speak(utterance);
  return true;
}

/** Test hook: forget the outstanding count. */
export function resetSpeechQueue(): void {
  queued = 0;
}
