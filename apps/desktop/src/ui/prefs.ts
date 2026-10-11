import { create } from "zustand";

/** Client-side settings, persisted in localStorage under `vokko.prefs` and applied to <html> immediately (also on the login page). */

export type ThemeChoice = "dark" | "ash" | "onyx" | "light" | "system";
export type ThemeName = Exclude<ThemeChoice, "system">;
export type MessageDisplay = "cozy" | "compact";
export type Density = "compact" | "default" | "cozy";
export type ReducedMotion = "system" | "on" | "off";
export type RoleColors = "name" | "dot" | "none";
export type SpoilerContent = "click" | "always" | "moderated";
export type InputMode = "vad" | "ptt";

export interface Prefs {
  // Appearance
  theme: ThemeChoice;
  /** Chat text size in px (Discord's choices: 12, 15, 16, 18, 20, 24). Applied as root font-size percentage and `--chat-font-size`. */
  fontSize: number;
  /** Cozy shows avatars and names above the text, compact puts everything on one line. Read by src/chat. */
  messageDisplay: MessageDisplay;
  density: Density;
  /** Gap between message groups in px (Discord: 0..16 slider). Read by src/chat via `--message-group-gap`. */
  messageGroupGap: number;
  // Messages / chat box (read by src/chat)
  showEmbeds: boolean;
  showReactions: boolean;
  showCompactAvatars: boolean;
  spoilerContent: SpoilerContent;
  previewMarkdown: boolean;
  convertEmoticons: boolean;
  // Accessibility
  reducedMotion: ReducedMotion;
  underlineLinks: boolean;
  roleColors: RoleColors;
  playGifs: boolean;
  playAnimatedEmoji: boolean;
  showImageDescriptions: boolean;
  // Streamer mode
  streamerMode: boolean;
  streamerHideInvites: boolean;
  streamerDisableSounds: boolean;
  streamerDisableNotifications: boolean;
  // Notifications
  desktopNotifications: boolean;
  notificationSounds: boolean;
  soundCurrentChannel: boolean;
  unreadBadge: boolean;
  friendsOnlineAlerts: boolean;
  reactionNotifications: "all" | "dm" | "never";
  // Voice & video (visual: the app has no voice transport yet)
  inputDevice: string;
  outputDevice: string;
  cameraDevice: string;
  inputVolume: number;
  outputVolume: number;
  inputMode: InputMode;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  autoSensitivity: boolean;
  inputSensitivity: number;
  alwaysPreviewVideo: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  theme: "dark",
  fontSize: 16,
  messageDisplay: "cozy",
  density: "default",
  messageGroupGap: 16,
  showEmbeds: true,
  showReactions: true,
  showCompactAvatars: true,
  spoilerContent: "click",
  previewMarkdown: true,
  convertEmoticons: true,
  reducedMotion: "system",
  underlineLinks: false,
  roleColors: "name",
  playGifs: true,
  playAnimatedEmoji: true,
  showImageDescriptions: false,
  streamerMode: false,
  streamerHideInvites: true,
  streamerDisableSounds: true,
  streamerDisableNotifications: true,
  desktopNotifications: false,
  notificationSounds: true,
  soundCurrentChannel: false,
  unreadBadge: true,
  friendsOnlineAlerts: false,
  reactionNotifications: "all",
  inputDevice: "default",
  outputDevice: "default",
  cameraDevice: "default",
  inputVolume: 100,
  outputVolume: 100,
  inputMode: "vad",
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
  autoSensitivity: true,
  inputSensitivity: 40,
  alwaysPreviewVideo: false,
};

const KEY = "vokko.prefs";

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    const merged = { ...DEFAULT_PREFS } as Record<string, unknown>;
    for (const key of Object.keys(DEFAULT_PREFS) as (keyof Prefs)[]) {
      // Only accept values of the same type as the default, so an old or hand-edited file can't break the UI.
      if (typeof parsed[key] === typeof DEFAULT_PREFS[key]) merged[key] = parsed[key];
    }
    return merged as unknown as Prefs;
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export const usePrefs = create<Prefs>()(() => load());

/** Current values outside React. */
export const getPrefs = (): Prefs => usePrefs.getState();

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  usePrefs.setState({ [key]: value } as Pick<Prefs, K>);
}

export function resetPrefs(keys?: (keyof Prefs)[]): void {
  const patch: Partial<Prefs> = {};
  for (const key of keys ?? (Object.keys(DEFAULT_PREFS) as (keyof Prefs)[])) (patch as Record<string, unknown>)[key] = DEFAULT_PREFS[key];
  usePrefs.setState(patch);
}

export const FONT_SIZES = [12, 15, 16, 18, 20, 24] as const;

export const THEMES: { id: ThemeName; label: string; swatch: string; chat: string }[] = [
  { id: "light", label: "Light", swatch: "#fbfbfb", chat: "#ffffff" },
  { id: "ash", label: "Ash", swatch: "#323339", chat: "#313338" },
  { id: "dark", label: "Dark", swatch: "#1a1a1e", chat: "#31323b" },
  { id: "onyx", label: "Onyx", swatch: "#000000", chat: "#000000" },
];

const systemDark = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
const systemMotion = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

export function resolveTheme(choice: ThemeChoice): ThemeName {
  if (choice !== "system") return choice;
  return systemDark && !systemDark.matches ? "light" : "dark";
}

export function reducedMotionActive(prefs: Prefs): boolean {
  if (prefs.reducedMotion === "on") return true;
  if (prefs.reducedMotion === "off") return false;
  return !!systemMotion?.matches;
}

function apply(prefs: Prefs): void {
  const root = document.documentElement;
  const theme = resolveTheme(prefs.theme);
  for (const name of ["dark", "ash", "onyx", "light"]) root.classList.toggle(`theme-${name}`, name === theme);
  for (const name of ["compact", "default", "cozy"]) root.classList.toggle(`density-${name}`, name === prefs.density);
  root.classList.toggle("reduce-motion", reducedMotionActive(prefs));
  root.classList.toggle("full-motion", !reducedMotionActive(prefs));
  root.classList.toggle("underline-links", prefs.underlineLinks);
  root.classList.toggle("message-compact", prefs.messageDisplay === "compact");
  root.classList.toggle("streamer-mode", prefs.streamerMode);
  root.style.fontSize = `${(prefs.fontSize / 16) * 100}%`;
  root.style.setProperty("--chat-font-size", `${prefs.fontSize}px`);
  root.style.setProperty("--message-group-gap", `${prefs.messageGroupGap}px`);
}

if (typeof document !== "undefined") {
  apply(getPrefs());
  usePrefs.subscribe(prefs => {
    apply(prefs);
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {
      /* storage full or unavailable: the setting still applies for this session */
    }
  });
  const reapply = () => apply(getPrefs());
  systemDark?.addEventListener("change", reapply);
  systemMotion?.addEventListener("change", reapply);
  // Another window of the app changed a setting.
  window.addEventListener("storage", event => {
    if (event.key === KEY) usePrefs.setState(load());
  });
}
