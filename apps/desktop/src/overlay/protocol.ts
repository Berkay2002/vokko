// What the main window and the in-game overlay window say to each other over app events (src-tauri/src/overlay.rs shows the
// window; it never sees these payloads). The overlay has no gateway or stores of its own: everything it shows comes from here.

export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** Main → overlay: the whole picture (toasts included, so a window created by a toast still shows it), sent on every change and
 * when the overlay asks (`overlay-ready`). */
export const STATE_EVENT = "overlay-state";
/** Overlay → main: the page loaded and wants the state. */
export const READY_EVENT = "overlay-ready";
/** Overlay → main: a button was used. */
export const ACTION_EVENT = "overlay-action";
/** Rust → overlay: interactive mode on or off (src-tauri/src/overlay.rs INTERACTIVE_EVENT). */
export const INTERACTIVE_EVENT = "overlay-interactive";

export interface OverlayMember {
  id: string;
  name: string;
  avatar: string;
  speaking: boolean;
  /** Muted by themselves or by the server. */
  muted: boolean;
  deafened: boolean;
}

export interface OverlayCall {
  /** Channel name ("General") or the DM's name. */
  channel: string;
  /** Server name; null for a DM call. */
  guild: string | null;
  members: OverlayMember[];
}

export interface OverlayView {
  corner: Corner;
  /** Notification position; "off" shows no toasts. */
  notifications: Corner | "off";
  /** 20-100 (%): the widget's opacity while passive. Interactive mode is always fully opaque. */
  opacity: number;
  /** The interactive-mode hotkey as the user sees it ("Shift+`"); "" when none. */
  hotkey: string;
}

export interface OverlayState {
  view: OverlayView;
  call: OverlayCall | null;
  selfMute: boolean;
  selfDeaf: boolean;
  /** Newest last; the main window drops each one after TOAST_MS. */
  toasts: OverlayToast[];
}

export interface OverlayToast {
  id: string;
  title: string;
  body: string;
  icon: string;
  channelId: string;
  guildId: string | null;
  messageId: string;
}

export type OverlayAction = { type: "mute" } | { type: "deafen" } | { type: "open"; toastId: string } | { type: "dismiss"; toastId: string };

/** How long a toast stays. */
export const TOAST_MS = 6000;
/** At most this many toasts at once (older ones go first). */
export const TOAST_MAX = 3;
