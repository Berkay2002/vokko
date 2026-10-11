// Local playback of soundboard clips. No LiveKit track: every member in the channel plays the file itself when
// VOICE_CHANNEL_EFFECT_SEND arrives, so clients stay in sync and the mock works the same way.

import { resolveUrl } from "../api/rest";
import { SOUNDBOARD_MAX_DURATION_MS } from "../api/types";
import { getPrefs } from "../ui/prefs";

export interface PlayRecord {
  url: string;
  volume: number;
  /** "effect" = someone played it in your channel, "preview" = hover / button preview that only you hear. */
  kind: "effect" | "preview";
  at: number;
}

/** The last clips played (newest last); tests and the dev console read it through `window.__vokkoSoundboard`. */
export const playLog: PlayRecord[] = [];

type SinkAudio = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };

let preview: HTMLAudioElement | null = null;

function start(url: string, volume: number, kind: PlayRecord["kind"]): HTMLAudioElement | null {
  playLog.push({ url, volume, kind, at: Date.now() });
  if (playLog.length > 50) playLog.shift();
  if (typeof Audio === "undefined" || volume <= 0) return null;
  const audio = new Audio(resolveUrl(url)) as SinkAudio;
  audio.volume = Math.min(1, Math.max(0, volume));
  const device = getPrefs().outputDevice;
  if (device && device !== "default" && audio.setSinkId) void audio.setSinkId(device).catch(() => undefined);
  void audio.play().catch(() => undefined);
  // The server measures the length from file headers; this cap covers whatever a decoder plays beyond that. It starts when
  // playback does, so a slow download doesn't eat into the clip.
  if (kind === "effect") audio.addEventListener("playing", () => setTimeout(() => audio.pause(), SOUNDBOARD_MAX_DURATION_MS + 300), { once: true });
  return audio;
}

/** A clip someone played in your voice channel. */
export const playEffect = (url: string, volume: number): void => void start(url, volume, "effect");

/** Only you hear it; a new preview stops the previous one. */
export function playPreview(url: string, volume: number): void {
  stopPreview();
  preview = start(url, volume, "preview");
}

export function stopPreview(): void {
  preview?.pause();
  preview = null;
}
