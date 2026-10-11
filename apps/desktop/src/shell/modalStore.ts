import { create } from "zustand";
import type { ChannelType, Snowflake } from "../api/types";

export type ModalSpec =
  | { type: "createServer" }
  | { type: "invite"; channelId: Snowflake }
  | { type: "createChannel"; guildId: Snowflake; parentId?: Snowflake | null; channelType?: ChannelType }
  | { type: "leaveServer"; guildId: Snowflake }
  | { type: "deleteServer"; guildId: Snowflake }
  | { type: "deleteChannel"; channelId: Snowflake }
  | { type: "serverSettings"; guildId: Snowflake; section?: string }
  | { type: "editChannel"; channelId: Snowflake }
  | { type: "notificationSettings"; scopeId: Snowflake; title: string; guild?: boolean }
  | { type: "createDM"; /** Users already in the conversation (the new group DM keeps them). */ base?: Snowflake[] }
  | { type: "quickSwitcher" }
  | { type: "profile"; userId: Snowflake; guildId?: Snowflake | null }
  | { type: "inbox" }
  | { type: "userSettings"; section?: string };

interface ModalStore {
  modal: ModalSpec | null;
  /** Bumped on every open so a re-opened modal of the same type starts with fresh state. */
  serial: number;
  open(modal: ModalSpec): void;
  close(): void;
}

export const useModals = create<ModalStore>()(set => ({
  modal: null,
  serial: 0,
  open: modal => set(s => ({ modal, serial: s.serial + 1 })),
  close: () => set({ modal: null }),
}));

export const openModal = (modal: ModalSpec) => useModals.getState().open(modal);
export const closeModal = () => useModals.getState().close();
