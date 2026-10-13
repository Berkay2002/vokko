import type { Activity } from "../api/types";
import type { NowPlaying } from "../desktop/spotify";
import { cleanName } from "./format";

/** Maps the track Spotify is playing to the presence activity (type 2) the server accepts, null when there is nothing to show. */
export function spotifyActivity(track: NowPlaying | null | undefined, now: number): Activity | null {
  const title = cleanName(track?.title ?? "");
  if (!track || !title) return null;
  const artists = cleanName(track.artists.map(cleanName).filter(Boolean).join("; "));
  const duration = Math.max(0, Math.floor(track.duration_ms || 0));
  const position = Math.min(Math.max(0, Math.floor(track.position_ms || 0)), duration || Infinity);
  const start = Math.max(0, now - position);
  return {
    name: "Spotify",
    type: 2,
    details: title,
    ...(artists ? { state: artists } : {}),
    // ids come from the player; anything that is not the exact shape the server accepts is left out
    ...(track.image_id && /^[0-9a-f]{40}$/.test(track.image_id) ? { assets: { large_image: `spotify:${track.image_id}` } } : {}),
    ...(track.track_id && /^[A-Za-z0-9]{22}$/.test(track.track_id) ? { sync_id: track.track_id } : {}),
    timestamps: { start, ...(duration > 0 ? { end: start + duration } : {}) },
  };
}

/** Whether two polls describe the same moment of the same track, so nothing needs resending (a seek or restart moves `start`). */
export function sameSpotifyMoment(a: Activity | null, b: Activity | null): boolean {
  if (!a || !b) return a === b;
  return a.details === b.details && a.state === b.state && a.sync_id === b.sync_id && Math.abs((a.timestamps?.start ?? 0) - (b.timestamps?.start ?? 0)) < 3000;
}
