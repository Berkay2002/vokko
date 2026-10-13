// Pure helpers for Watch Together: pulling a video id out of whatever link someone pastes, and the sync maths.

import type { WatchTogetherState } from "../api/types";

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"]);
/** Paths whose next segment is the video id: /shorts/ID, /live/ID, /embed/ID, /v/ID. */
const ID_PATHS = new Set(["shorts", "live", "embed", "v"]);

export const isVideoId = (text: string): boolean => VIDEO_ID.test(text);

/**
 * The video id of a YouTube link: youtube.com/watch?v=, youtu.be/, /shorts/, /live/, /embed/, music.youtube.com/watch?v=.
 * A bare 11-character id works too. Anything else (other sites, playlists without a video, junk) is null.
 */
export function parseYouTubeLink(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  if (isVideoId(text)) return text;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  let id: string | null = null;
  if (host === "youtu.be" || host === "www.youtu.be") {
    id = url.pathname.split("/")[1] ?? null;
  } else if (HOSTS.has(host)) {
    const [, first, second] = url.pathname.split("/");
    if (first === "watch") id = url.searchParams.get("v");
    else if (first && ID_PATHS.has(first)) id = second ?? null;
  }
  return id && isVideoId(id) ? id : null;
}

/** Where the video should be at `nowMs` (the viewer's clock): the server's position plus the time since, while playing. */
export function expectedPositionMs(state: Pick<WatchTogetherState, "playing" | "position_ms" | "updated_at_ms">, nowMs: number): number {
  return state.playing ? state.position_ms + Math.max(0, nowMs - state.updated_at_ms) : state.position_ms;
}

/** A player further than this from the expected position gets a seek. */
export const DRIFT_MS = 2000;

export const needsSeek = (playerMs: number, expectedMs: number, toleranceMs = DRIFT_MS): boolean => Math.abs(playerMs - expectedMs) > toleranceMs;

/** 3:07 or 1:02:09. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
