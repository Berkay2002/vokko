// Small pure helpers for the Spotify panel and tile.

import { ApiRequestError } from "../api/rest";
import { SPOTIFY_ART_URL, type SpotifyState } from "../api/types";
import { expectedPositionMs } from "../watch/youtube";

const ART_ID = /^[0-9a-f]{40}$/;

/** The only image URL the client builds: https://i.scdn.co/image/<40-hex id>; anything else shows the placeholder. */
export const artUrl = (art: string | undefined): string | undefined => (art && ART_ID.test(art) ? SPOTIFY_ART_URL + art : undefined);

export const artistsText = (artists: string[]): string => artists.join(", ");

/** Where the track is at `nowMs`: the server's position plus the time since, while it plays. */
export function shownPositionMs(state: Pick<SpotifyState, "status" | "playing" | "position_ms" | "updated_at_ms" | "track">, nowMs: number): number {
  const running = state.playing && state.status === "playing";
  const at = expectedPositionMs({ playing: running, position_ms: state.position_ms, updated_at_ms: state.updated_at_ms }, nowMs);
  return state.track ? Math.min(at, state.track.duration_ms) : 0;
}

/** The status line of the tile, or "" when it plays normally. */
export function statusText(state: Pick<SpotifyState, "status" | "error" | "track">, room: "connecting" | "connected" | "closed" | "failed"): string {
  if (state.status === "error") return state.error || "Playback failed.";
  if (state.status === "starting") return "Starting…";
  if (state.status === "loading") return "Loading…";
  if (!state.track) return "Nothing left to play. Add something from the panel.";
  if (room === "failed" || room === "closed") return "Couldn't reach the music. Trying again…";
  if (room === "connecting") return "Connecting…";
  return "";
}

/** A conflict the panel shows as a notice instead of a plain error line (40034 another media activity, 40035 Spotify is busy). */
export function conflictOf(e: unknown): string | null {
  return e instanceof ApiRequestError && e.status === 409 && (e.code === 40034 || e.code === 40035) ? e.message : null;
}
