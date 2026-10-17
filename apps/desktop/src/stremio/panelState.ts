// Navigation and account state of the Stremio panel as a reducer, so the flow (link, browse, title, streams) is testable without a DOM.

import type { StremioContinueItem, StremioLinkStart, StremioSearchItem, StremioVideo } from "../api/types";

export type Account = "loading" | "unavailable" | "unlinked" | "linking" | "email" | "linked";

export type PanelView =
  | { name: "home" }
  /** `resume` is the Continue watching card the page was opened from: its episode is preselected and plays from the saved position. */
  | { name: "title"; item: StremioSearchItem; resume?: StremioContinueItem }
  /** The stream list of one movie or episode (`videoId` tt… or tt…:season:episode); `label` names it in the list's header. */
  | { name: "streams"; item: StremioSearchItem; videoId: string; label: string };

export interface PanelState {
  account: Account;
  link: StremioLinkStart | null;
  /** Why the last link / sign-in attempt failed. */
  problem: string | null;
  query: string;
  /** Titles opened, newest last: Back pops one. */
  trail: PanelView[];
}

export const initialPanel: PanelState = { account: "loading", link: null, problem: null, query: "", trail: [{ name: "home" }] };

export type PanelAction =
  | { type: "account"; linked: boolean }
  | { type: "unavailable" }
  | { type: "linkStarted"; link: StremioLinkStart }
  | { type: "linkFailed"; message: string }
  | { type: "showEmail" }
  | { type: "showLink" }
  | { type: "linked" }
  | { type: "unlinked" }
  | { type: "query"; query: string }
  | { type: "openTitle"; item: StremioSearchItem; resume?: StremioContinueItem }
  | { type: "openStreams"; videoId: string; label: string }
  | { type: "back" };

export const currentView = (state: PanelState): PanelView => state.trail[state.trail.length - 1] ?? { name: "home" };

export function panelReducer(state: PanelState, action: PanelAction): PanelState {
  switch (action.type) {
    case "account":
      return { ...state, account: action.linked ? "linked" : "unlinked" };
    case "unavailable":
      return { ...state, account: "unavailable" };
    case "linkStarted":
      return { ...state, account: "linking", link: action.link, problem: null };
    case "linkFailed":
      // A failed attempt returns to where it began: the code step goes back to the card, the email form stays.
      return { ...state, account: state.account === "email" ? "email" : "unlinked", link: state.account === "email" ? state.link : null, problem: action.message };
    case "showEmail":
      return { ...state, account: "email", problem: null };
    case "showLink":
      return { ...state, account: state.link ? "linking" : "unlinked", problem: null };
    case "linked":
      return { ...state, account: "linked", link: null, problem: null };
    case "unlinked":
      return { ...initialPanel, account: "unlinked" };
    case "query":
      return { ...state, query: action.query, trail: [{ name: "home" }] };
    case "openTitle":
      return { ...state, trail: [...state.trail, { name: "title", item: action.item, ...(action.resume ? { resume: action.resume } : {}) }] };
    case "openStreams": {
      const view = currentView(state);
      if (view.name === "home") return state;
      return { ...state, trail: [...state.trail, { name: "streams", item: view.item, videoId: action.videoId, label: action.label }] };
    }
    case "back":
      return state.trail.length > 1 ? { ...state, trail: state.trail.slice(0, -1) } : state;
  }
}

/** The stream to pre-select: the first playable row (the server ranks the list, best first). */
export const bestStream = <T extends { playable: boolean }>(streams: T[]): T | undefined => streams.find(s => s.playable);

/** Season numbers of a series' episodes, ascending (specials, season 0, last). */
export function seasonsOf(videos: { season: number }[]): number[] {
  const seasons = [...new Set(videos.map(v => v.season))].sort((a, b) => a - b);
  return seasons.filter(s => s > 0).concat(seasons.filter(s => s === 0));
}

/** Past this share of an episode it is finished (stremio-core CREDITS_THRESHOLD_COEF, the same line the server writes back with). */
export const FINISHED_SHARE = 0.9;

/** The video after `id` in watching order (seasons ascending, specials last), unless it is not released yet or would leave the seasons for the specials. */
export function nextVideo(videos: StremioVideo[], id: string, now = Date.now()): StremioVideo | undefined {
  const ordered = seasonsOf(videos).flatMap(season => videos.filter(v => v.season === season).sort((a, b) => a.episode - b.episode));
  const at = ordered.findIndex(v => v.id === id);
  const current = ordered[at];
  const next = ordered[at + 1];
  if (!current || !next || (next.season === 0 && current.season !== 0)) return undefined;
  return next.released && Date.parse(next.released) > now ? undefined : next;
}

/** What a Continue watching card plays: `videoId` is the episode (null for a movie), `positionMs` where it starts, `next` when it is the episode after one that was finished. */
export interface ResumeTarget {
  videoId: string | null;
  positionMs: number;
  next: boolean;
}

/** The server writes a finished episode back as the next one (offset 1, shown as position 0 and duration 0); a card whose position is already past the credits gets the same treatment here, from the title's episodes. */
export function resumeTarget(item: StremioContinueItem, videos: StremioVideo[], now = Date.now()): ResumeTarget {
  const finished = item.duration_ms > 0 && item.position_ms > item.duration_ms * FINISHED_SHARE;
  if (item.type === "movie") return { videoId: null, positionMs: finished ? 0 : item.position_ms, next: false };
  if (!item.video_id) return { videoId: null, positionMs: 0, next: false };
  if (!finished) return { videoId: item.video_id, positionMs: item.position_ms, next: item.duration_ms === 0 };
  const next = nextVideo(videos, item.video_id, now);
  return { videoId: next?.id ?? item.video_id, positionMs: 0, next: next !== undefined };
}

/** "S2E5", and "S2E6 · Up next" when the episode is waiting after a finished one. */
export function episodeLabel(item: Pick<StremioContinueItem, "type" | "season" | "episode" | "duration_ms">): string | null {
  if (item.type !== "series" || item.season === undefined || item.episode === undefined) return null;
  return `S${item.season}E${item.episode}${item.duration_ms === 0 ? " · Up next" : ""}`;
}

/** How far into the episode or movie the card is, 0 to 1. */
export const progressOf = (item: Pick<StremioContinueItem, "position_ms" | "duration_ms">): number =>
  item.duration_ms > 0 ? Math.min(1, Math.max(0, item.position_ms / item.duration_ms)) : 0;
