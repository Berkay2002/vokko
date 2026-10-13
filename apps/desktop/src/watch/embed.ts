// Where the Watch Together player page lives and the postMessage protocol spoken with it (public/youtube-embed.html).
// The YouTube player cannot run inside the Tauri webview directly (error 153: no usable Referer), so the app embeds a page it
// hosts itself: the server's own origin (VITE_VOKKO_API) in a real build, the page's own origin in dev and mock mode.

import { API_ORIGIN, MOCK } from "../api/config";

export const EMBED_PATH = "/youtube-embed.html";

/** The only origin the app sends commands to and accepts player events from. */
export const EMBED_ORIGIN: string = MOCK || import.meta.env.DEV || !API_ORIGIN ? (globalThis.location?.origin ?? "") : API_ORIGIN;
export const EMBED_URL = `${EMBED_ORIGIN}${EMBED_PATH}`;

export type EmbedCommand =
  | { type: "init" }
  | { type: "load"; videoId: string; startSeconds: number; autoplay: boolean }
  | { type: "play" }
  | { type: "pause" }
  | { type: "seek"; seconds: number }
  | { type: "volume"; volume: number };

export type PlayerState = "unstarted" | "playing" | "paused" | "buffering" | "ended" | "cued";

export type EmbedEvent =
  | { event: "ready" }
  | { event: "state"; state: PlayerState }
  | { event: "time"; seconds: number; duration: number }
  | { event: "meta"; title: string }
  | { event: "error"; code: number };

const STATES = new Set<string>(["unstarted", "playing", "paused", "buffering", "ended", "cued"]);

/** A message from the embed page, or null for anything else (wrong origin, wrong window, wrong shape). */
export function parseEmbedMessage(event: Pick<MessageEvent, "origin" | "source" | "data">, frame: Window | null | undefined, origin = EMBED_ORIGIN): EmbedEvent | null {
  if (!frame || event.source !== frame || event.origin !== origin) return null;
  const data = event.data as Record<string, unknown> | null;
  if (!data || typeof data !== "object" || data.source !== "vokko-embed") return null;
  switch (data.event) {
    case "ready":
      return { event: "ready" };
    case "state":
      return typeof data.state === "string" && STATES.has(data.state) ? { event: "state", state: data.state as PlayerState } : null;
    case "time":
      return typeof data.seconds === "number" && typeof data.duration === "number" ? { event: "time", seconds: data.seconds, duration: data.duration } : null;
    case "meta":
      return typeof data.title === "string" ? { event: "meta", title: data.title.slice(0, 500) } : null;
    case "error":
      return typeof data.code === "number" ? { event: "error", code: data.code } : null;
    default:
      return null;
  }
}

export function sendToEmbed(frame: Window | null | undefined, command: EmbedCommand, origin = EMBED_ORIGIN): void {
  frame?.postMessage(command, origin);
}
