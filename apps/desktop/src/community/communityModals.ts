// Which community dialog is open. Kept apart from the shell's modal store so the shell only mounts `CommunityHost`.
import { create } from "zustand";
import type { Snowflake } from "../api/types";

export type CommunityModal =
  | { type: "events"; guildId: Snowflake }
  | { type: "wizard"; guildId: Snowflake; /** Present when editing. */ eventId?: Snowflake; /** Where Back / close returns to. */ from?: "events" | "detail" }
  | { type: "detail"; guildId: Snowflake; eventId: Snowflake; from?: "events" };

interface Store {
  modal: CommunityModal | null;
  open(modal: CommunityModal): void;
  close(): void;
}

export const useCommunityModal = create<Store>()(set => ({
  modal: null,
  open: modal => set({ modal }),
  close: () => set({ modal: null }),
}));

export const openEvents = (guildId: Snowflake) => useCommunityModal.getState().open({ type: "events", guildId });
export const openCreateEvent = (guildId: Snowflake) => useCommunityModal.getState().open({ type: "wizard", guildId });
export const openEventDetail = (guildId: Snowflake, eventId: Snowflake, from?: "events") => useCommunityModal.getState().open({ type: "detail", guildId, eventId, from });
export const closeCommunityModal = () => useCommunityModal.getState().close();
