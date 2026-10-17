// Navigation of the Spotify panel as a reducer, so the flow (search tabs, album / playlist / artist pages, Back) is testable without a DOM.

import type { SpotifySearchType } from "../api/types";

export type PageKind = "album" | "playlist" | "artist";

export type PanelView = { name: "search" } | { name: "page"; kind: PageKind; id: string; title: string };

export interface PanelState {
  query: string;
  tab: SpotifySearchType;
  /** Pages opened, newest last: Back pops one. */
  trail: PanelView[];
}

export const initialPanel: PanelState = { query: "", tab: "track", trail: [{ name: "search" }] };

export type PanelAction =
  | { type: "query"; query: string }
  | { type: "tab"; tab: SpotifySearchType }
  | { type: "open"; kind: PageKind; id: string; title: string }
  | { type: "back" };

export const currentView = (state: PanelState): PanelView => state.trail[state.trail.length - 1] ?? { name: "search" };

export function panelReducer(state: PanelState, action: PanelAction): PanelState {
  switch (action.type) {
    case "query":
      return { ...state, query: action.query, trail: [{ name: "search" }] };
    case "tab":
      return { ...state, tab: action.tab };
    case "open":
      return { ...state, trail: [...state.trail, { name: "page", kind: action.kind, id: action.id, title: action.title }] };
    case "back":
      return state.trail.length > 1 ? { ...state, trail: state.trail.slice(0, -1) } : state;
  }
}
