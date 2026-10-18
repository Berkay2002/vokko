import { create } from "zustand";
import type { ChannelType, Snowflake } from "../api/types";
import { blockedByUnsaved } from "./settings/unsaved";
import { useProfile } from "./profileStore";
import type { ReportTarget } from "./ReportModal";

export type ModalSpec =
  | { type: "createServer" }
  | { type: "invite"; channelId: Snowflake }
  | { type: "applyToJoin"; code: string }
  | { type: "createChannel"; guildId: Snowflake; parentId?: Snowflake | null; channelType?: ChannelType }
  | { type: "leaveServer"; guildId: Snowflake }
  | { type: "leaveGroup"; channelId: Snowflake }
  | { type: "editGroup"; channelId: Snowflake }
  | { type: "deleteServer"; guildId: Snowflake }
  | { type: "deleteChannel"; channelId: Snowflake }
  | { type: "serverSettings"; guildId: Snowflake; section?: string }
  | { type: "editChannel"; channelId: Snowflake }
  | { type: "channelSettings"; channelId: Snowflake; section?: string }
  | { type: "channelTopic"; channelId: Snowflake }
  | { type: "kickMember"; guildId: Snowflake; userId: Snowflake }
  | { type: "banMember"; guildId: Snowflake; userId: Snowflake }
  | { type: "timeoutMember"; guildId: Snowflake; userId: Snowflake }
  | { type: "nickname"; guildId: Snowflake; userId: Snowflake }
  | { type: "notificationSettings"; scopeId: Snowflake; title: string; guild?: boolean }
  | { type: "createDM"; /** Users already in the conversation (the new group DM keeps them). */ base?: Snowflake[]; /** An existing group DM: friends are added to it instead of creating a new group. */ groupId?: Snowflake }
  | { type: "quickSwitcher" }
  | { type: "shortcuts" }
  | { type: "profile"; userId: Snowflake; guildId?: Snowflake | null }
  | { type: "inbox" }
  | { type: "logout" }
  | { type: "removeFriend"; userId: Snowflake }
  | { type: "blockUser"; userId: Snowflake; /** The guild the menu was opened in: the dialog names the member by nickname. */ guildId?: Snowflake | null }
  | { type: "report"; target: ReportTarget }
  | { type: "reportProblem" }
  | { type: "guildPrivacy"; guildId: Snowflake }
  | { type: "dmRefused" }
  | { type: "voiceStatus"; channelId: Snowflake }
  | { type: "watchTogether"; channelId: Snowflake }
  | { type: "gameCredits" }
  | { type: "cameraPreview" }
  | { type: "screenShare" }
  | { type: "userSettings"; section?: string; guildId?: string }
  | { type: "profileEditor" };

/** Full-screen settings stay mounted underneath these small dialogs and come back when the dialog closes. */
const SETTINGS_TYPES = new Set<ModalSpec["type"]>(["serverSettings", "channelSettings", "editChannel", "userSettings"]);
/** Settings frames whose save bar is wired to the unsaved guard. */
const GUARDED_TYPES = new Set<ModalSpec["type"]>(["userSettings", "channelSettings", "editChannel", "serverSettings"]);
const DIALOG_TYPES = new Set<ModalSpec["type"]>(["kickMember", "banMember", "timeoutMember", "nickname", "deleteServer", "deleteChannel", "leaveServer", "leaveGroup", "editGroup", "invite", "createChannel", "logout", "removeFriend", "blockUser", "report", "reportProblem", "guildPrivacy", "dmRefused", "channelTopic", "quickSwitcher", "shortcuts", "voiceStatus", "watchTogether", "gameCredits", "cameraPreview", "screenShare", "profileEditor"]);

interface ModalStore {
  modal: ModalSpec | null;
  /** React key serial of the open modal: a re-opened modal of the same type starts with fresh state. */
  serial: number;
  /** Monotonic open counter (the source of `serial`). */
  counter: number;
  /** A settings screen parked under an open dialog, with the serial it was opened with (keeps its React key stable). */
  base: { spec: ModalSpec; serial: number } | null;
  /** The last modal asked for while the profile editor was open: it opens once the editor is closed. */
  queued: ModalSpec | null;
  open(modal: ModalSpec): void;
  close(): void;
}

export const useModals = create<ModalStore>()(set => ({
  modal: null,
  serial: 0,
  counter: 0,
  base: null,
  queued: null,
  open: modal => {
    const { modal: current, base } = useModals.getState();
    // The profile editor has no way back to the settings parked under it once another modal replaces it: wait for it to close.
    if (current?.type === "profileEditor") {
      set({ queued: modal });
      return;
    }
    // Modal shortcuts (Ctrl+I, Ctrl+Shift+N) must not replace User, Channel or Server Settings while it has unsaved changes, also when it is
    // parked under a dialog; dialogs park it instead, and a dialog opened over a dialog keeps the parked settings.
    const settings = current && SETTINGS_TYPES.has(current.type) ? current : base?.spec;
    if (settings && GUARDED_TYPES.has(settings.type) && !DIALOG_TYPES.has(modal.type) && blockedByUnsaved()) return;
    // A profile card left open would end up under (or, from a dialog, over) the new modal.
    useProfile.getState().close();
    set(s => {
      const park = !DIALOG_TYPES.has(modal.type) ? null : s.modal && SETTINGS_TYPES.has(s.modal.type) ? { spec: s.modal, serial: s.serial } : s.base;
      const counter = s.counter + 1;
      return { modal, serial: counter, counter, base: park };
    });
  },
  close: () => {
    const { modal, queued } = useModals.getState();
    set(s => (s.base ? { modal: s.base.spec, serial: s.base.serial, base: null, queued: null } : { modal: null, queued: null }));
    if (modal?.type === "profileEditor" && queued) useModals.getState().open(queued);
  },
}));

export const openModal = (modal: ModalSpec) => useModals.getState().open(modal);
export const closeModal = () => useModals.getState().close();
