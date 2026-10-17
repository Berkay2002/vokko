// Navigation and account state of the Stremio panel as a reducer, so the flow (link, browse, title, streams) is testable without a DOM.

import type { StremioLinkStart, StremioSearchItem } from "../api/types";

export type Account = "loading" | "unavailable" | "unlinked" | "linking" | "email" | "linked";

export type PanelView =
  | { name: "home" }
  | { name: "title"; item: StremioSearchItem }
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
  | { type: "openTitle"; item: StremioSearchItem }
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
      return { ...state, trail: [...state.trail, { name: "title", item: action.item }] };
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
