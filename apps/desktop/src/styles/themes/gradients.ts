/**
 * Discord's gradient colour themes ("Mint Apple", "Hanami", ... a Nitro perk there, free here).
 *
 * A gradient theme is a `linear-gradient` painted once on the whole viewport (`background-attachment: fixed`), plus a veil of
 * black (dark base) or white (light base) at 65-95% opacity over it for every surface level, so panes stay readable while the
 * gradient shows through. The base surface and text tokens are mixed with a colour taken from the gradient's own hue (Discord's
 * `--custom-theme-base-color`), then text is moved only as far as needed to reach WCAG AA on every veiled stop.
 *
 * `generate.ts` turns this into the gradient part of `themes.generated.css`; `prefs.ts` adds `.custom-theme-background` to <html>.
 */
import { contrast, ensureContrast, hslToHex, hue, luminance, mix, mixOklab, over, parseColor, rgba, toHex } from "./color";
import type { Adjustment } from "./derive";
import type { ThemeBase } from "./palettes";

export const GRADIENT_THEME_IDS = [
  "mint-apple",
  "citrus-sherbert",
  "retro-raincloud",
  "hanami",
  "sunrise",
  "cotton-candy",
  "lofi-vibes",
  "desert-khaki",
  "sunset",
  "chroma-glow",
  "forest",
  "crimson",
  "midnight-blurple",
  "mars",
  "dusk",
  "under-the-sea",
  "retro-storm",
  "neon-nights",
  "strawberry-lemonade",
  "aurora",
  "sepia",
  "blurple-twilight",
] as const;
export type GradientThemeId = (typeof GRADIENT_THEME_IDS)[number];

export interface GradientStop {
  color: string;
  /** Position along the gradient line, percent. */
  at: number;
}

export interface GradientDef {
  id: GradientThemeId;
  label: string;
  base: ThemeBase;
  /** CSS `linear-gradient` angle in degrees. */
  angle: number;
  stops: readonly GradientStop[];
}

const stops = (...pairs: [string, number][]): GradientStop[] => pairs.map(([color, at]) => ({ color, at }));

/** In picker order. Values are Discord's presets (`BACKGROUND_GRADIENT_PRESET`: theme, colour stops, angle). */
export const GRADIENT_THEMES: readonly GradientDef[] = [
  { id: "mint-apple", label: "Mint Apple", base: "light", angle: 180, stops: stops(["#56b69f", 6.15], ["#63bc61", 48.7], ["#9eca67", 93.07]) },
  { id: "citrus-sherbert", label: "Citrus Sherbert", base: "light", angle: 180, stops: stops(["#f3b336", 31.1], ["#ee8558", 67.09]) },
  { id: "retro-raincloud", label: "Retro Raincloud", base: "light", angle: 148.71, stops: stops(["#3a7ca1", 5.64], ["#7f7eb9", 26.38], ["#7f7eb9", 49.92], ["#3a7ca1", 73.12]) },
  { id: "hanami", label: "Hanami", base: "light", angle: 38.08, stops: stops(["#efaab3", 3.56], ["#efd696", 35.49], ["#a6daa2", 68.78]) },
  { id: "sunrise", label: "Sunrise", base: "light", angle: 154.19, stops: stops(["#9f4175", 8.62], ["#c49064", 48.07], ["#a6953d", 76.04]) },
  { id: "cotton-candy", label: "Cotton Candy", base: "light", angle: 180.14, stops: stops(["#f4abb8", 8.5], ["#b1c2fc", 94.28]) },
  { id: "lofi-vibes", label: "Lofi Vibes", base: "light", angle: 179.52, stops: stops(["#a4c0f7", 7.08], ["#a9e4e8", 34.94], ["#b0e2b8", 65.12], ["#cfdfa2", 96.23]) },
  { id: "desert-khaki", label: "Desert Khaki", base: "light", angle: 38.99, stops: stops(["#e7dbd0", 12.92], ["#dfd0b2", 32.92], ["#e0d6a3", 52.11]) },
  { id: "sunset", label: "Sunset", base: "dark", angle: 141.68, stops: stops(["#48288c", 27.57], ["#db7f4b", 71.25]) },
  { id: "chroma-glow", label: "Chroma Glow", base: "dark", angle: 128.92, stops: stops(["#0eb5bf", 3.94], ["#4c0ce0", 26.1], ["#a308a7", 39.82], ["#9a53ff", 56.89], ["#218be0", 76.45]) },
  { id: "forest", label: "Forest", base: "dark", angle: 162.27, stops: stops(["#142215", 11.2], ["#2d4d39", 29.93], ["#454c32", 48.64], ["#5a7c58", 67.85], ["#a98e4b", 83.54]) },
  { id: "crimson", label: "Crimson", base: "dark", angle: 64.92, stops: stops(["#950909", 16.17], ["#000000", 72]) },
  { id: "midnight-blurple", label: "Midnight Blurple", base: "dark", angle: 48.17, stops: stops(["#5348ca", 11.21], ["#140730", 61.92]) },
  { id: "mars", label: "Mars", base: "dark", angle: 170.82, stops: stops(["#895240", 14.61], ["#8f4343", 74.62]) },
  { id: "dusk", label: "Dusk", base: "dark", angle: 180, stops: stops(["#665069", 12.84], ["#91a3d1", 85.99]) },
  { id: "under-the-sea", label: "Under The Sea", base: "dark", angle: 179.14, stops: stops(["#647962", 1.91], ["#588575", 48.99], ["#6a8482", 96.35]) },
  { id: "retro-storm", label: "Retro Storm", base: "dark", angle: 148.71, stops: stops(["#3a7ca1", 5.64], ["#58579a", 26.38], ["#58579a", 49.92], ["#3a7ca1", 73.12]) },
  { id: "neon-nights", label: "Neon Nights", base: "dark", angle: 180, stops: stops(["#01a89e", 0], ["#7d60ba", 50], ["#b43898", 100]) },
  { id: "strawberry-lemonade", label: "Strawberry Lemonade", base: "dark", angle: 161.03, stops: stops(["#af1a6c", 18.79], ["#c26b20", 49.76], ["#e7a525", 80.72]) },
  { id: "aurora", label: "Aurora", base: "dark", angle: 239.16, stops: stops(["#062053", 10.39], ["#191fbb", 26.87], ["#13929a", 48.31], ["#218573", 64.98], ["#051a81", 92.5]) },
  { id: "sepia", label: "Sepia", base: "dark", angle: 69.98, stops: stops(["#857664", 14.14], ["#5b4421", 60.35]) },
  { id: "blurple-twilight", label: "Blurple Twilight", base: "dark", angle: 47.61, stops: stops(["#2c3fe7", 11.18], ["#261d83", 64.54]) },
];

export const gradientCss = (def: Pick<GradientDef, "angle" | "stops">): string => `linear-gradient(${def.angle}deg, ${def.stops.map(s => `${s.color} ${s.at}%`).join(", ")})`;

/** The surface levels Discord layers over the gradient, in the order the variables are emitted. */
export const VEIL_LEVELS = ["lowest", "lower", "low", "high", "higher", "chat", "app-frame", "highest"] as const;
export type VeilLevel = (typeof VEIL_LEVELS)[number];

/** Veil colour and opacity per level (Discord's `--custom-background-gradient-*-opacity`; app-frame equals `higher`). */
export const VEIL: Record<ThemeBase, { color: string; opacity: Record<VeilLevel, number> }> = {
  dark: { color: "#000000", opacity: { chat: 0.8, highest: 0.65, lowest: 0.9, lower: 0.85, low: 0.8, high: 0.75, higher: 0.7, "app-frame": 0.7 } },
  light: { color: "#ffffff", opacity: { chat: 0.85, highest: 0.95, lowest: 0.85, lower: 0.8, low: 0.75, high: 0.7, higher: 0.65, "app-frame": 0.65 } },
};

/** Discord's `--custom-theme-base-color-amount` and `--custom-theme-text-color-amount`. */
const BASE_AMOUNT = 0.5;
const TEXT_AMOUNT = 0.38;
const HIGH = "#ffffff";
const LOW = "#000000";

/** Surfaces mixed with the theme's base colour (the whole background family of both base sets, minus the window colour). */
export const TINTED_SURFACES: readonly string[] = [
  "background-accent",
  "background-base-low",
  "background-base-lower",
  "background-base-lowest",
  "background-secondary-alt",
  "background-surface-high",
  "background-surface-higher",
  "background-surface-highest",
  "bg-surface-raised",
  "channeltextarea-background",
  "modal-background",
  "modal-footer-background",
  "embed-background",
  "embed-background-alternate",
  "card-background-default",
  "home-background",
  "card-primary-pressed-bg",
  "card-secondary-pressed-bg",
  "panel-bg",
  "channel-background-default",
  "chat-background",
  "chat-background-default",
  "guild-profile-banner-background-default",
  "spoiler-hidden-background",
  "spoiler-hidden-background-hover",
  "scrollbar-auto-thumb",
  "scrollbar-auto-scrollbar-color-thumb",
  "scrollbar-thin-thumb",
  "scrollbar-auto-scrollbar-color-track",
];

/** Text and icon colours mixed with the theme's text colour, then fitted to AA (4.5:1 for text, 3:1 for icons). */
export const TINTED_TEXT: readonly string[] = [
  "text-default",
  "text-strong",
  "text-subtle",
  "text-muted",
  "chat-text-muted",
  "textbox-markdown-syntax",
  "channel-text-area-placeholder",
  "input-placeholder-text-default",
  "interactive-text-active",
  "interactive-text-hover",
  "interactive-text-default",
  "input-text-default",
  "reaction-text-default",
  "reaction-text-hover",
  "reaction-text-active",
  "channel-icon",
  "channels-default",
  "icon-muted",
  "icon-default",
  "icon-strong",
  "icon-subtle",
  "interactive-icon-active",
  "interactive-icon-hover",
  "interactive-icon-default",
  "input-icon-default",
];

/** Coloured text kept as in the base set, only fitted to AA on the veiled gradient. */
export const FITTED_TEXT: readonly string[] = ["text-link", "text-brand", "text-feedback-critical", "text-feedback-info", "text-feedback-positive", "text-feedback-warning"];

/** Icons need 3:1 (non-text UI), everything else 4.5:1. */
export const isIcon = (name: string): boolean => /(^|-)icon(-|$)/.test(name) || name === "channels-default";

export interface DerivedGradient {
  id: GradientThemeId;
  base: ThemeBase;
  /** `--custom-theme-*` properties (without the leading `--`). */
  props: Record<string, string>;
  /** Base-set tokens that differ in this theme. */
  tokens: Record<string, string>;
  adjustments: Adjustment[];
}

/** Colour of the gradient at `at` percent along its line (clamped, sRGB like CSS). */
export function gradientColorAt(def: Pick<GradientDef, "stops">, at: number): string {
  const s = def.stops;
  if (at <= s[0]!.at) return s[0]!.color;
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1]!;
    const b = s[i]!;
    if (at <= b.at) return b.at === a.at ? b.color : mix(a.color, b.color, (at - a.at) / (b.at - a.at));
  }
  return s[s.length - 1]!.color;
}

/** The stops plus evenly spaced points between them, i.e. every colour the gradient line passes through (approximately). */
export function gradientSamples(def: Pick<GradientDef, "stops">): string[] {
  const out: string[] = [];
  const s = def.stops;
  for (let i = 0; i < s.length; i++) {
    out.push(s[i]!.color);
    const next = s[i + 1];
    if (next) for (let k = 1; k < 8; k++) out.push(gradientColorAt(def, s[i]!.at + ((next.at - s[i]!.at) * k) / 8));
  }
  return out;
}

/** What a surface level looks like over one gradient colour. */
export const veiled = (base: ThemeBase, level: VeilLevel, under: string): string => over(rgba(VEIL[base].color, VEIL[base].opacity[level]), under);

/** Discord's `--custom-theme-base-color` / `--custom-theme-text-color` for a theme (hue of the darker or lighter end stop). */
export function themeColors(def: GradientDef): { primary: string; secondary: string; baseColor: string; textColor: string } {
  const primary = def.stops[0]!.color;
  const secondary = def.stops[def.stops.length - 1]!.color;
  const dark = def.base === "dark";
  const darker = luminance(primary) <= luminance(secondary) ? primary : secondary;
  const lighter = luminance(primary) > luminance(secondary) ? primary : secondary;
  const h = hue(dark ? darker : lighter);
  const blueish = h >= 200 && h <= 300;
  return {
    primary,
    secondary,
    baseColor: hslToHex(h, 1, dark ? 0.05 : 0.9),
    textColor: hslToHex(h, 1, dark ? (blueish ? 0.8 : 0.95) : blueish ? 0.25 : 0.15),
  };
}

export function deriveGradientTheme(def: GradientDef, baseTokens: Readonly<Record<string, string>>): DerivedGradient {
  const { primary, secondary, baseColor, textColor } = themeColors(def);
  const dark = def.base === "dark";
  const tokens: Record<string, string> = {};
  const adjustments: Adjustment[] = [];
  const get = (name: string): string => {
    const value = baseTokens[name];
    if (!value || !value.startsWith("#")) throw new Error(`--${name} is not a hex token in the ${def.base} base set`);
    return toHex(parseColor(value).rgb);
  };

  const samples = gradientSamples(def);
  // The window colour (Tauri's background) is the frame veil over the gradient's average, so it matches what paints on top of it.
  const average = toHex([0, 1, 2].map(i => samples.reduce((sum, c) => sum + parseColor(c).rgb[i]!, 0) / samples.length) as [number, number, number]);
  tokens["app-frame-background"] = veiled(def.base, "app-frame", average);

  for (const name of TINTED_SURFACES) tokens[name] = mixOklab(get(name), baseColor, BASE_AMOUNT / (1 + BASE_AMOUNT));

  // Text sits on the veiled gradient (every level, every sampled colour) and on the solid tinted surfaces popouts and inputs use.
  const backgrounds = [
    ...new Set([...VEIL_LEVELS.flatMap(level => samples.map(s => veiled(def.base, level, s))), ...["chat-background", "background-base-lower", "background-surface-high", "channeltextarea-background"].map(n => tokens[n]!)]),
  ];
  const extreme = dark ? HIGH : LOW;
  for (const name of [...TINTED_TEXT, ...FITTED_TEXT]) {
    const original = get(name);
    const tinted = TINTED_TEXT.includes(name) ? mixOklab(original, textColor, TEXT_AMOUNT / (1 + TEXT_AMOUNT)) : original;
    const fitted = ensureContrast(tinted, backgrounds, isIcon(name) ? 3 : 4.5, extreme);
    if (fitted !== tinted) adjustments.push({ role: name, upstream: tinted, shipped: fitted });
    tokens[name] = fitted;
  }
  // Only what differs from the base set goes into the CSS.
  for (const name of Object.keys(tokens)) if (toHex(parseColor(baseTokens[name]!).rgb) === tokens[name]) delete tokens[name];

  return {
    id: def.id,
    base: def.base,
    props: {
      "custom-theme-background": gradientCss(def),
      "custom-theme-primary-color": primary,
      "custom-theme-secondary-color": secondary,
      "custom-theme-base-color": baseColor,
      "custom-theme-text-color": textColor,
    },
    tokens,
    adjustments,
  };
}

/** Contrast of `color` over every veil level and sampled gradient colour: the lowest ratio and where it happens. */
export function worstContrastOnGradient(def: GradientDef, color: string): { ratio: number; level: VeilLevel; under: string } {
  let worst = { ratio: Infinity, level: VEIL_LEVELS[0] as VeilLevel, under: "" };
  for (const level of VEIL_LEVELS) {
    for (const under of gradientSamples(def)) {
      const ratio = contrast(color, veiled(def.base, level, under));
      if (ratio < worst.ratio) worst = { ratio, level, under };
    }
  }
  return worst;
}
