// Whether the Spotify side panel is open. One panel for the call we are in; it closes when the call ends or changes channel, and
// it shares the side-sheet slot with the Stremio panel (opening one closes the other).

import { create } from "zustand";
import { useStremioPanel } from "../stremio/panelStore";
import { voiceStore } from "../voice/store";

interface PanelStore {
  open: boolean;
  setOpen(open: boolean): void;
}

export const useSpotifyPanel = create<PanelStore>()(set => ({ open: false, setOpen: open => set({ open }) }));

export function openSpotifyPanel(): void {
  useStremioPanel.getState().setOpen(false);
  useSpotifyPanel.getState().setOpen(true);
}

if (typeof window !== "undefined") {
  voiceStore.subscribe((state, prev) => {
    if (state.channelId !== prev.channelId) useSpotifyPanel.setState({ open: false });
  });
  useStremioPanel.subscribe(state => {
    if (state.open) useSpotifyPanel.setState({ open: false });
  });
}
