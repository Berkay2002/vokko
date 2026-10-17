// Spotify's local volume (0..100, default 60), kept apart from Stremio's so music and movies keep their own level.

import { create } from "zustand";

const KEY = "vokko.spotify.volume";

function read(): number {
  try {
    const raw = localStorage.getItem(KEY);
    const value = Number(raw);
    return raw !== null && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 60;
  } catch {
    return 60;
  }
}

export const useSpotifyVolume = create<{ volume: number }>()(() => ({ volume: read() }));

export function setSpotifyVolume(volume: number): void {
  useSpotifyVolume.setState({ volume });
  try {
    localStorage.setItem(KEY, String(volume));
  } catch {
    /* not saved */
  }
}
