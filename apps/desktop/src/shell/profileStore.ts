import { create } from "zustand";
import type { Snowflake } from "../api/types";

interface ProfileState {
  anchor: HTMLElement | null;
  userId: Snowflake | null;
  guildId: Snowflake | null;
  open(anchor: HTMLElement, userId: Snowflake, guildId: Snowflake | null): void;
  close(): void;
}

// Kept apart from ProfileCard.tsx so the chat can open a card without importing the card's UI (that import graph loops back into the chat).
export const useProfile = create<ProfileState>()(set => ({
  anchor: null,
  userId: null,
  guildId: null,
  open: (anchor, userId, guildId) => set({ anchor, userId, guildId }),
  close: () => set({ anchor: null, userId: null, guildId: null }),
}));

export const openProfile = (anchor: HTMLElement, userId: Snowflake, guildId: Snowflake | null) => useProfile.getState().open(anchor, userId, guildId);
