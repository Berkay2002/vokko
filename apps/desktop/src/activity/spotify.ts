import { ApiRequestError, RateLimitedError } from "../api/rest";
import type { Activity, SpotifySearchResults, SpotifyTrack } from "../api/types";
import type { NowPlaying } from "../desktop/spotify";
import { search } from "../spotify/api";
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
  return a.details === b.details && a.state === b.state && a.sync_id === b.sync_id &&
    a.assets?.large_image === b.assets?.large_image &&
    Math.abs((a.timestamps?.start ?? 0) - (b.timestamps?.start ?? 0)) < 3000;
}

/** Whether the local Spotify app plays what a Spotify session in a call plays (docs/design/spotify-bot.md section 9.6): then the
 * "Listening to Spotify" presence is dropped, so the house account's playback never shows as someone's status. By track id where the
 * player gives one (macOS), else by title and artists (Windows). Needs no knowledge of whose account the house one is. */
export function playsInCall(listening: Activity, callTracks: SpotifyTrack[]): boolean {
  return callTracks.some(t =>
    listening.sync_id ? t.uri === `spotify:track:${listening.sync_id}` : cleanName(t.title) === listening.details && cleanName(t.artists.map(cleanName).filter(Boolean).join("; ")) === (listening.state ?? ""),
  );
}

/** The catalog track a title and artists stand for (the Windows media session has no track id or art). */
export interface CatalogMatch {
  sync_id: string;
  /** 40-hex image id, when the catalog has art. */
  image?: string;
}

const same = (a: string, b: string) => cleanName(a).toLowerCase() === cleanName(b).toLowerCase();

/** The first search result named `title` (any case) whose artists include `artist`. */
export function matchTrack(title: string, artist: string, results: SpotifyTrack[]): CatalogMatch | null {
  const hit = results.find(t => same(t.title, title) && t.artists.some(a => same(a, artist)));
  const id = hit?.uri.match(/^spotify:track:([A-Za-z0-9]{22})$/)?.[1];
  if (!hit || !id) return null;
  return { sync_id: id, ...(hit.art && /^[0-9a-f]{40}$/.test(hit.art) ? { image: hit.art } : {}) };
}

/** Definite answers (a 200, match or not) and lookups in flight, by title and artist: a track is asked about once while it answers. */
const lookups = new Map<string, Promise<CatalogMatch | null>>();
/** Failed lookups (offline, 5xx, 429, ...) by title and artist: failures in a row, and when the track may be asked about again. */
const failures = new Map<string, { count: number; until: number }>();
/** Waits after the 1st, 2nd and 3rd+ failure in a row for one track. */
export const LOOKUP_BACKOFF_MS = [30_000, 120_000, 600_000];
/** How long a 404 10000 (the server has no Spotify catalog) stops all lookups. */
export const CATALOG_OFF_MS = 5 * 60_000;
let catalogOffUntil = 0;

/** Finds the catalog track for a title and its first artist through the server; null on no match or any failure (429, offline, ...).
 * Failures are not kept: the track is asked about again after a backoff, or after the server's Retry-After when that is longer. */
export function lookUpTrack(title: string, artist: string, find = (q: string) => search(q, "track")): Promise<CatalogMatch | null> {
  const key = `${cleanName(title).toLowerCase()}\n${cleanName(artist).toLowerCase()}`;
  const known = lookups.get(key);
  if (known) return known;
  const now = Date.now();
  if (now < catalogOffUntil || now < (failures.get(key)?.until ?? 0)) return Promise.resolve(null);
  const quoted = (text: string) => `"${cleanName(text).replace(/"/g, " ")}"`;
  const q = `track:${quoted(title)} artist:${quoted(artist)}`;
  const pending =
    q.length > 100
      ? Promise.resolve(null)
      : find(q).then(
          (found: SpotifySearchResults) => {
            failures.delete(key);
            return matchTrack(title, artist, found.tracks);
          },
          (error: unknown) => {
            lookups.delete(key);
            const at = Date.now();
            if (error instanceof ApiRequestError && error.status === 404 && error.api.code === 10000) {
              catalogOffUntil = at + CATALOG_OFF_MS;
              return null;
            }
            const count = (failures.get(key)?.count ?? 0) + 1;
            const backoff = LOOKUP_BACKOFF_MS[Math.min(count, LOOKUP_BACKOFF_MS.length) - 1] ?? 0;
            const asked = error instanceof RateLimitedError ? error.retryAfter * 1000 : 0;
            failures.set(key, { count, until: at + Math.max(backoff, asked) });
            return null;
          },
        );
  lookups.set(key, pending);
  return pending;
}

/** Adds the track id and art of a catalog match to a Spotify activity that has none. */
export function withCatalog(activity: Activity, match: CatalogMatch | null): Activity {
  if (!match || activity.sync_id) return activity;
  return { ...activity, sync_id: match.sync_id, ...(match.image && !activity.assets ? { assets: { large_image: `spotify:${match.image}` } } : {}) };
}

/** Forgets this session's lookups (tests). */
export function resetTrackLookups(): void {
  lookups.clear();
  failures.clear();
  catalogOffUntil = 0;
}
