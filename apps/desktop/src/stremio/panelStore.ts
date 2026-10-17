// Whether the Stremio side panel is open. One panel for the call we are in; it closes when the call ends or changes channel.

import { create } from "zustand";
import { voiceStore } from "../voice/store";

interface PanelStore {
  open: boolean;
  setOpen(open: boolean): void;
}

export const useStremioPanel = create<PanelStore>()(set => ({ open: false, setOpen: open => set({ open }) }));

export const openStremioPanel = (): void => useStremioPanel.getState().setOpen(true);

if (typeof window !== "undefined") {
  voiceStore.subscribe((state, prev) => {
    if (state.channelId !== prev.channelId) useStremioPanel.setState({ open: false });
  });
}
