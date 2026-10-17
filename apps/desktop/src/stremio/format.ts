// Small pure helpers for the Stremio panel and tile.

import { ApiRequestError } from "../api/rest";
import { STREMIO_IMAGE_HOSTS, type StremioState, type StremioStream } from "../api/types";
import { expectedPositionMs } from "../watch/youtube";

/** What to tell the user about a failed call: a field's own message when the server named one ("Invalid Form Body" alone says nothing). */
export function reason(e: unknown): string {
  if (!(e instanceof ApiRequestError)) return "Something went wrong. Try again.";
  for (const value of Object.values(e.api.errors ?? {})) {
    const entry = value as { message?: string; _errors?: { message?: string }[] } | undefined;
    const message = entry?.message ?? entry?._errors?.[0]?.message;
    if (message) return message;
  }
  return e.message;
}

/** The picture URL when it is https on one of the poster hosts the CSP lets through, else nothing (a broken image is worse than none). */
export function safeImage(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && STREMIO_IMAGE_HOSTS.includes(parsed.hostname) ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

/** Where the movie is at `nowMs`: the server's position plus the time since, while it plays (not while it starts or buffers). */
export function shownPositionMs(state: Pick<StremioState, "status" | "playing" | "position_ms" | "updated_at_ms" | "duration_ms">, nowMs: number): number {
  const running = state.playing && state.status === "playing";
  const at = expectedPositionMs({ playing: running, position_ms: state.position_ms, updated_at_ms: state.updated_at_ms }, nowMs);
  return state.duration_ms ? Math.min(at, state.duration_ms) : at;
}

/** "22.4 GB", "850 MB". */
export function formatSize(bytes: number): string {
  const gb = bytes / 1e9;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

const HEAVY = new Set(["hdr", "dv", "remux"]);
/** Heavy sources cost the bot more to play (docs/design/stremio-bot.md section 4.3): 4K, HDR, Dolby Vision, REMUX. */
export const isHeavy = (stream: Pick<StremioStream, "flags" | "resolution">): boolean => (stream.resolution ?? 0) >= 2160 || stream.flags.some(f => HEAVY.has(f.toLowerCase()));

/** Why a row cannot be played, as the list shows it. */
export function unsupportedText(stream: StremioStream): string {
  switch (stream.unsupported) {
    case "torrent":
      return "Torrent: not supported";
    case "youtube":
      return "YouTube: open in Watch Together";
    case "external":
      return "Opens outside Stremio: not supported";
    default:
      return "Not supported";
  }
}

/** The status line on a tile that has no picture yet. */
export function statusText(state: Pick<StremioState, "status" | "error">, room: "connecting" | "connected" | "closed" | "failed"): string {
  if (state.status === "error") return state.error || "Something went wrong with the stream.";
  if (state.status === "starting") return "Starting…";
  if (state.status === "buffering") return "Buffering…";
  if (room === "failed" || room === "closed") return "Couldn't reach the movie. Trying again…";
  if (room === "connecting") return "Connecting to the movie…";
  return state.status === "paused" ? "Paused" : "";
}
