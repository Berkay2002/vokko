import { create } from "zustand";
import { GRADIENT_THEMES, gradientCss, type GradientThemeId } from "../styles/themes/gradients";
import { COMMUNITY_THEMES, type CommunityThemeId } from "../styles/themes/palettes";
import { syncWindowTheme } from "../desktop/window";

/** Client-side settings, persisted in localStorage under `vokko.prefs` and applied to <html> immediately (also on the login page). */

/** Discord's four themes plus the community ones (src/styles/themes); `system` follows the OS light/dark setting. */
export type DiscordThemeName = "dark" | "ash" | "onyx" | "light";
export type ThemeName = DiscordThemeName | GradientThemeId | CommunityThemeId;
export type ThemeChoice = ThemeName | "system";
export type MessageDisplay = "cozy" | "compact";
export type Density = "compact" | "default" | "cozy";
/** How much air the chat gets: "compact" is the original tight layout, "roomy" also pads the lines inside a group. */
export type MessageSpacing = "compact" | "balanced" | "roomy";
export type ReducedMotion = "system" | "on" | "off";
export type RoleColors = "name" | "dot" | "none";
export type SpoilerContent = "click" | "always" | "moderated";
export type InputMode = "vad" | "ptt";
export type TimeFormat = "auto" | "12" | "24";

export interface Prefs {
  // Appearance
  theme: ThemeChoice;
  /** Chat text size in px (Discord's choices: 12, 15, 16, 18, 20, 24). Applied as root font-size percentage and `--chat-font-size`. */
  fontSize: number;
  /** Cozy shows avatars and names above the text, compact puts everything on one line. Read by src/chat. */
  messageDisplay: MessageDisplay;
  /** Interface density (Accessibility): member list width. Not the chat spacing, that is `messageSpacing`. */
  density: Density;
  /** Chat spacing preset. It sets `messageGroupGap` and the row padding (`--message-pad-y`); both work in cozy and compact display. */
  messageSpacing: MessageSpacing;
  /** Gap between message groups in px, one of GROUP_GAPS (Discord's slider stops). Read by src/chat via `--message-group-gap`. */
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
  // Language & time (settings modal)
  /** Clock of message timestamps: the locale's own ("auto"), 12-hour or 24-hour. Read by src/chat/util.ts. */
  timeFormat: TimeFormat;
}

export const DEFAULT_PREFS: Prefs = {
  theme: "dark",
  fontSize: 16,
  messageDisplay: "cozy",
  density: "default",
  messageSpacing: "balanced",
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
  timeFormat: "auto",
};

export interface ThemeCard {
  id: ThemeName;
  label: string;
  /** Sidebar colour and chat colour: the two halves of the picker swatch. */
  swatch: string;
  chat: string;
  /** Gradient themes: the CSS gradient the picker swatch shows (Discord's `linear-gradient`). */
  gradient?: string;
}

/** Discord's themes, in the order of its picker. */
export const THEMES: ThemeCard[] = [
  { id: "light", label: "Light", swatch: "#fbfbfb", chat: "#ffffff" },
  { id: "ash", label: "Ash", swatch: "#323339", chat: "#313338" },
  { id: "dark", label: "Dark", swatch: "#1a1a1e", chat: "#31323b" },
  { id: "onyx", label: "Onyx", swatch: "#000000", chat: "#000000" },
];

/** Discord's gradient colour themes (Mint Apple, Hanami, ...), in the order of its picker. */
export const GRADIENT_THEME_CARDS: ThemeCard[] = GRADIENT_THEMES.map(t => ({
  id: t.id,
  label: t.label,
  swatch: t.stops[0]!.color,
  chat: t.stops[t.stops.length - 1]!.color,
  gradient: gradientCss(t),
}));

/** Community themes (Dracula, Gruvbox, ...), dark ones first. */
export const COMMUNITY_THEME_CARDS: ThemeCard[] = COMMUNITY_THEMES.map(t => ({ id: t.id, label: t.label, swatch: t.palette.bg1, chat: t.palette.bg2 }));

// Declared before `load()` runs (module evaluation order): load validates the stored theme against these.
const ALL_THEME_IDS: readonly ThemeName[] = [...THEMES.map(t => t.id), ...GRADIENT_THEMES.map(t => t.id), ...COMMUNITY_THEMES.map(t => t.id)];
/** Themes layered on a Discord base set (their own id class plus `theme-dark` or `theme-light` go on <html>). */
const NAMED_BASE = new Map<ThemeName, "dark" | "light">([...GRADIENT_THEMES, ...COMMUNITY_THEMES].map(t => [t.id, t.base]));
const GRADIENT_IDS: ReadonlySet<ThemeName> = new Set(GRADIENT_THEMES.map(t => t.id));

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === "system" || (typeof value === "string" && (ALL_THEME_IDS as readonly string[]).includes(value));
}

/** Whether a theme is built on Discord's dark or light value set (community themes name theirs). */
export function themeBase(theme: ThemeName): "dark" | "light" {
  return NAMED_BASE.get(theme) ?? (theme === "light" ? "light" : "dark");
}

/** Every `theme-*` class a theme can put on <html>: its own id, plus `theme-dark` or `theme-light` for community themes. */
const THEME_CLASSES: readonly string[] = [...ALL_THEME_IDS, "dark", "light"].map(id => `theme-${id}`);

/** Discord's "space between message groups" stops, in px. */
export const GROUP_GAPS = [0, 4, 8, 16, 24] as const;

/** What a spacing preset sets: the gap between groups, and the vertical padding of every message row (2px was the original). */
export const SPACING_PRESETS: Record<MessageSpacing, { gap: number; padY: number }> = {
  compact: { gap: 0, padY: 2 }, // the layout before the presets: the groups touch
  balanced: { gap: 16, padY: 2 }, // Discord's default
  roomy: { gap: 24, padY: 4 },
};

const nearestGap = (value: number): number => GROUP_GAPS.reduce((best, g) => (Math.abs(g - value) < Math.abs(best - value) ? g : best));

const KEY = "vokko.prefs";

/** Saved JSON (any age) -> prefs. Unknown or mistyped values fall back to the defaults. */
export function migratePrefs(parsed: Partial<Record<keyof Prefs, unknown>>): Prefs {
  const merged = { ...DEFAULT_PREFS } as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_PREFS) as (keyof Prefs)[]) {
    // Only accept values of the same type as the default, so an old or hand-edited file can't break the UI.
    if (typeof parsed[key] === typeof DEFAULT_PREFS[key]) merged[key] = parsed[key];
  }
  // A theme id from a newer or older build must not leave the app without a theme class.
  if (!isThemeChoice(merged.theme)) merged.theme = DEFAULT_PREFS.theme;
  if (!["auto", "12", "24"].includes(merged.timeFormat as string)) merged.timeFormat = DEFAULT_PREFS.timeFormat;
  const spacing = parsed.messageSpacing;
  const hasSpacing = spacing === "compact" || spacing === "balanced" || spacing === "roomy";
  if (!hasSpacing) {
    // Saved before the spacing presets: the old default gap (16) was never chosen, so it moves to the new default;
    // a gap the user picked is kept (snapped to a slider stop) with the original row padding, i.e. "compact".
    // (Until the presets the list's `.chat-row:first-child` rule zeroed every row margin, so the old gap had no effect.)
    const old = typeof parsed.messageGroupGap === "number" ? parsed.messageGroupGap : null;
    merged.messageSpacing = DEFAULT_PREFS.messageSpacing; // also replaces a string that is not a preset
    if (old !== null && old !== 16) {
      merged.messageSpacing = "compact";
      merged.messageGroupGap = nearestGap(old);
    } else {
      merged.messageGroupGap = DEFAULT_PREFS.messageGroupGap;
    }
  } else {
    merged.messageGroupGap = nearestGap(merged.messageGroupGap as number);
  }
  return merged as unknown as Prefs;
}

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    return migratePrefs(JSON.parse(raw) as Partial<Record<keyof Prefs, unknown>>);
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** Applies a spacing preset: its group gap and row padding (the slider can then move the gap on its own). */
export function setMessageSpacing(spacing: MessageSpacing): void {
  usePrefs.setState({ messageSpacing: spacing, messageGroupGap: SPACING_PRESETS[spacing].gap });
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

const systemDark = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
const systemMotion = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

export function resolveTheme(choice: ThemeChoice): ThemeName {
  if (choice !== "system") return choice;
  return systemDark && !systemDark.matches ? "light" : "dark";
}

/** Theme shown instead of the saved one while the picker previews on hover/focus. Never persisted. */
let previewTheme: ThemeName | null = null;

/** Previews `theme` on the whole app without saving it; `null` goes back to the saved choice. */
export function previewThemeChoice(theme: ThemeName | null): void {
  if (previewTheme === theme) return;
  previewTheme = theme;
  apply(getPrefs());
}

export function reducedMotionActive(prefs: Prefs): boolean {
  if (prefs.reducedMotion === "on") return true;
  if (prefs.reducedMotion === "off") return false;
  return !!systemMotion?.matches;
}

/**
 * What the native window gets for the saved theme `choice` (shown as `resolved`). "Sync with computer" sends `null` so the
 * window keeps following the OS: forcing "dark" or "light" would pin the webview's prefers-color-scheme and the OS switch
 * would never reach `systemDark` again. `key` tells "dark" and "system, currently dark" apart for the sent-already cache.
 */
export function windowSyncPlan(choice: ThemeChoice, resolved: ThemeName): { key: string; scheme: "dark" | "light" | null } {
  if (choice === "system") return { key: `system:${resolved}`, scheme: null };
  return { key: resolved, scheme: themeBase(resolved) };
}

let syncedWindowKey: string | null = null;

/** Tauri window background and light/dark chrome follow the saved theme, never a hover preview (no-op in the browser). */
function syncWindow(choice: ThemeChoice, resolved: ThemeName): void {
  const plan = windowSyncPlan(choice, resolved);
  if (syncedWindowKey === plan.key) return;
  const frame = getComputedStyle(document.documentElement).getPropertyValue("--app-frame-background").trim();
  // Before the token CSS is in the document there is no colour yet: try again on the next apply().
  if (!/^#[0-9a-f]{6}$/i.test(frame)) return;
  syncedWindowKey = plan.key;
  void syncWindowTheme(frame, plan.scheme);
}

function apply(prefs: Prefs): void {
  const root = document.documentElement;
  const saved = resolveTheme(prefs.theme);
  const theme = previewTheme ?? saved;
  // A community or gradient theme sits on top of Discord's dark or light set, so <html> carries both classes (theme-dark theme-dracula).
  const wanted = new Set([`theme-${theme}`, ...(NAMED_BASE.has(theme) ? [`theme-${themeBase(theme)}`] : [])]);
  for (const cls of THEME_CLASSES) root.classList.toggle(cls, wanted.has(cls));
  // Gradient themes paint the gradient on the app background and veil it per surface (see themes.generated.css).
  root.classList.toggle("custom-theme-background", GRADIENT_IDS.has(theme));
  if (previewTheme === null) syncWindow(prefs.theme, saved);
  for (const name of ["compact", "default", "cozy"]) root.classList.toggle(`density-${name}`, name === prefs.density);
  root.classList.toggle("reduce-motion", reducedMotionActive(prefs));
  root.classList.toggle("full-motion", !reducedMotionActive(prefs));
  root.classList.toggle("underline-links", prefs.underlineLinks);
  root.classList.toggle("message-compact", prefs.messageDisplay === "compact");
  root.classList.toggle("streamer-mode", prefs.streamerMode);
  root.style.fontSize = `${(prefs.fontSize / 16) * 100}%`;
  root.style.setProperty("--chat-font-size", `${prefs.fontSize}px`);
  // chat.css redeclares --chat-font-size on its own roots, so menus.css maps this one onto them.
  root.style.setProperty("--user-chat-font-size", `${prefs.fontSize}px`);
  root.style.setProperty("--message-group-gap", `${prefs.messageGroupGap}px`);
  root.style.setProperty("--message-pad-y", `${SPACING_PRESETS[prefs.messageSpacing].padY}px`);
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

/** Message layout for src/chat: "cozy" (avatars, grouped) or "compact" (one line, no avatars). Also on <html> as `.message-compact`. */
export const useMessageDisplay = (): MessageDisplay => usePrefs(s => s.messageDisplay);

/** Chat text size relative to the 16px default (0.75 .. 1.5). The px value itself is `--user-chat-font-size` on <html>. */
export const useChatFontScale = (): number => usePrefs(s => s.fontSize / 16);
