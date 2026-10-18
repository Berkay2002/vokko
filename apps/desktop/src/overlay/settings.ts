// Settings > Game Overlay. Per device (localStorage `vokko.overlay`), not synced: the overlay is about this PC's games and screens.

import { create } from "zustand";
import type { Corner } from "./protocol";

export interface OverlaySettings {
  enabled: boolean;
  /** Keys of the interactive-mode toggle, in the Keybinds format ("Shift+`"). */
  hotkey: string;
  corner: Corner;
  notifications: Corner | "off";
  opacity: number;
  /** Show the overlay only while in a call (no toasts outside calls). */
  onlyInCall: boolean;
  /** Show over any window, not only fullscreen and borderless ones. */
  always: boolean;
}

const KEY = "vokko.overlay";
const CORNERS: readonly Corner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];

/** Windows only for now (src-tauri/src/overlay.rs): elsewhere it starts off and the page says it isn't available. */
const IS_WINDOWS = typeof navigator !== "undefined" && /Win/.test(navigator.platform);

export const DEFAULT_OVERLAY: OverlaySettings = {
  enabled: IS_WINDOWS,
  hotkey: "Shift+`",
  corner: "top-left",
  notifications: "bottom-right",
  opacity: 100,
  onlyInCall: false,
  always: false,
};

export function sanitizeOverlay(raw: unknown): OverlaySettings {
  const out = { ...DEFAULT_OVERLAY };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Partial<Record<keyof OverlaySettings, unknown>>;
  if (typeof r.enabled === "boolean") out.enabled = r.enabled;
  if (typeof r.hotkey === "string" && r.hotkey.length <= 40) out.hotkey = r.hotkey;
  if (CORNERS.includes(r.corner as Corner)) out.corner = r.corner as Corner;
  if (r.notifications === "off" || CORNERS.includes(r.notifications as Corner)) out.notifications = r.notifications as Corner | "off";
  if (typeof r.opacity === "number" && Number.isFinite(r.opacity)) out.opacity = Math.round(Math.min(100, Math.max(20, r.opacity)));
  if (typeof r.onlyInCall === "boolean") out.onlyInCall = r.onlyInCall;
  if (typeof r.always === "boolean") out.always = r.always;
  return out;
}

function load(): OverlaySettings {
  try {
    const raw = localStorage.getItem(KEY);
    return sanitizeOverlay(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_OVERLAY };
  }
}

export const useOverlaySettings = create<OverlaySettings>()(() => load());

export function setOverlaySetting<K extends keyof OverlaySettings>(key: K, value: OverlaySettings[K]): void {
  useOverlaySettings.setState({ [key]: value } as Pick<OverlaySettings, K>);
  try {
    localStorage.setItem(KEY, JSON.stringify(useOverlaySettings.getState()));
  } catch {
    /* storage unavailable: applies for this session */
  }
}
