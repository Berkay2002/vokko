import { create } from "zustand";
import type { ChannelType, Snowflake } from "../api/types";
import { blockedByUnsaved } from "./settings/unsaved";

export type ModalSpec =
  | { type: "createServer" }
  | { type: "invite"; channelId: Snowflake }
  | { type: "createChannel"; guildId: Snowflake; parentId?: Snowflake | null; channelType?: ChannelType }
  | { type: "leaveServer"; guildId: Snowflake }
  | { type: "deleteServer"; guildId: Snowflake }
  | { type: "deleteChannel"; channelId: Snowflake }
  | { type: "serverSettings"; guildId: Snowflake; section?: string }
  | { type: "editChannel"; channelId: Snowflake }
  | { type: "channelSettings"; channelId: Snowflake; section?: string }
  | { type: "kickMember"; guildId: Snowflake; userId: Snowflake }
  | { type: "banMember"; guildId: Snowflake; userId: Snowflake }
  | { type: "timeoutMember"; guildId: Snowflake; userId: Snowflake }
  | { type: "nickname"; guildId: Snowflake; userId: Snowflake }
  | { type: "notificationSettings"; scopeId: Snowflake; title: string; guild?: boolean }
  | { type: "createDM"; /** Users already in the conversation (the new group DM keeps them). */ base?: Snowflake[] }
  | { type: "quickSwitcher" }
  | { type: "shortcuts" }
  | { type: "profile"; userId: Snowflake; guildId?: Snowflake | null }
  | { type: "inbox" }
  | { type: "logout" }
  | { type: "removeFriend"; userId: Snowflake }
  | { type: "voiceStatus"; channelId: Snowflake }
  | { type: "cameraPreview" }
  | { type: "screenShare" }
  | { type: "userSettings"; section?: string };

/** Full-screen settings stay mounted underneath these small dialogs and come back when the dialog closes. */
const SETTINGS_TYPES = new Set<ModalSpec["type"]>(["serverSettings", "channelSettings", "editChannel", "userSettings"]);
const DIALOG_TYPES = new Set<ModalSpec["type"]>(["kickMember", "banMember", "timeoutMember", "nickname", "deleteServer", "deleteChannel", "leaveServer", "invite", "createChannel", "logout", "removeFriend", "quickSwitcher", "shortcuts", "voiceStatus", "cameraPreview", "screenShare"]);

interface ModalStore {
  modal: ModalSpec | null;
  /** React key serial of the open modal: a re-opened modal of the same type starts with fresh state. */
  serial: number;
  /** Monotonic open counter (the source of `serial`). */
  counter: number;
  /** A settings screen parked under an open dialog, with the serial it was opened with (keeps its React key stable). */
  base: { spec: ModalSpec; serial: number } | null;
  open(modal: ModalSpec): void;
  close(): void;
}

export const useModals = create<ModalStore>()(set => ({
  modal: null,
  serial: 0,
  counter: 0,
  base: null,
  open: modal => {
    const current = useModals.getState().modal;
    // Shortcuts (Ctrl+I, Ctrl+Shift+N) must not replace User Settings while it has unsaved changes; dialogs park it instead.
    if (current?.type === "userSettings" && !DIALOG_TYPES.has(modal.type) && blockedByUnsaved()) return;
    set(s => {
      const park = s.modal && SETTINGS_TYPES.has(s.modal.type) && DIALOG_TYPES.has(modal.type) ? { spec: s.modal, serial: s.serial } : null;
      const counter = s.counter + 1;
      return { modal, serial: counter, counter, base: park };
    });
  },
  close: () => set(s => (s.base ? { modal: s.base.spec, serial: s.base.serial, base: null } : { modal: null })),
}));

export const openModal = (modal: ModalSpec) => useModals.getState().open(modal);
export const closeModal = () => useModals.getState().close();
