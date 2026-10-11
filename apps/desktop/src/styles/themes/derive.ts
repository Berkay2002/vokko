/**
 * Maps a community-theme palette onto the app's semantic tokens.
 *
 * Input: the base token set the theme starts from (`theme-dark` or `theme-light` as parsed from tokens.css).
 * Output: only the tokens whose value differs from that base, plus the shade adjustments that were needed to reach WCAG AA.
 *
 * Every hex-valued token of both base sets is listed in `TABLE` or `KEEP_BASE` (the tests enforce it), translucent
 * overlays are retinted generically from the theme's own colours, and nothing here is a Discord value except the
 * alpha levels, which stay as measured so a community theme has the same layering as the Discord ones.
 */
import { contrast, ensureContrast, mix, over, parseColor, rgba, toHex } from "./color";
import { COMMUNITY_THEMES, type Palette, type ThemeDef } from "./palettes";

const WHITE = "#ffffff";
const BLACK = "#000000";

export interface Adjustment {
  role: string;
  upstream: string;
  shipped: string;
}

export interface DerivedTheme {
  id: string;
  base: "dark" | "light";
  /** `--name` -> value, only where it differs from the base set. */
  tokens: Record<string, string>;
  adjustments: Adjustment[];
}

/** Hex tokens deliberately inherited from the base set (white/black primitives, rarity badges, overlays). */
export const KEEP_BASE: ReadonlySet<string> = new Set([
  "text-overlay-dark",
  "text-overlay-light",
  "icon-overlay-dark",
  "icon-overlay-light",
  "white",
  "black",
  "status-positive-text", // replaced per theme below, listed so the dark default is explicit
  "status-warning-text",
  "control-connected-text-default",
  "control-critical-primary-text-default",
  "control-overlay-primary-background-default",
  "control-overlay-primary-text-default",
  "control-overlay-secondary-text-default",
  "badge-epic-text",
  "badge-mythic-text",
]);

/** `rgba(r, g, b, a)` triples in the base sets and the theme colour they stand for. Anything else (black scrims, white edges, pink tiles, rarity tints) is kept. */
interface Ctx {
  P: Palette;
  dark: boolean;
  bg0: string;
  bg1: string;
  bg2: string;
  bg3: string;
  bg4: string;
  low: string;
  higher: string;
  highest: string;
  raised: string;
  home: string;
  pressed: string;
  pressed2: string;
  frame: string;
  chatDefault: string;
  input: string;
  strong: string;
  text: string;
  subtle: string;
  muted: string;
  placeholder: string;
  accent: string;
  onAccent: string;
  accentText: string;
  accentActive: string;
  accentHover: string;
  /** Colour the hover and pressed shades move towards (away from the button text). */
  away: string;
  link: string;
  goodText: string;
  warnText: string;
  badText: string;
  infoText: string;
  dangerSolid: string;
  goodSolid: string;
  warnSolid: string;
  overlay: string;
  adjustments: Adjustment[];
}

function buildCtx(def: ThemeDef): Ctx {
  const P = def.palette;
  const dark = def.base === "dark";
  const adjustments: Adjustment[] = [];
  const surfaces = [P.bg1, P.bg2, P.bg3];
  const input = dark ? mix(P.bg2, P.bg4, 0.5) : mix(P.bg1, P.bg2, 0.45);
  const textSurfaces = [...surfaces, input];
  // Code chips and mention tints lighten the surface they sit on; body text has to hold up there too.
  const tinted = [P.bg2, P.bg3].map(bg => over(rgba(P.accent, 0.16), bg));
  // Hues (links, status colours) move towards white or black, so they stay recognisable; the text ladder moves towards its own strongest step.
  const extreme = dark ? WHITE : BLACK;
  const fit = (role: string, color: string, backgrounds: readonly string[], min: number, towards: string = extreme): string => {
    const out = ensureContrast(color, backgrounds, min, towards);
    if (out !== color) adjustments.push({ role, upstream: color, shipped: out });
    return out;
  };

  // Text on the theme's surfaces: AA for normal text (4.5:1).
  const strong = fit("text-strong", P.fgStrong, [...textSurfaces, ...tinted], 4.5);
  const text = fit("text-default", P.fg, [...textSurfaces, ...tinted], 4.5, strong);
  const mutedFit = fit("text-muted", P.fgMuted, textSurfaces, 4.5, strong);
  // Keep the ladder readable: subtle sits clearly above muted even when muted had to be lifted to reach AA.
  const subtleFit = fit("text-subtle", P.fgSubtle, textSurfaces, 4.5, strong);
  const subtleFloor = mix(mutedFit, text, 0.45);
  const subtle = contrast(subtleFit, P.bg2) >= contrast(subtleFloor, P.bg2) ? subtleFit : subtleFloor;
  if (subtle === subtleFloor && subtleFloor !== subtleFit) adjustments.push({ role: "text-subtle (kept above text-muted)", upstream: subtleFit, shipped: subtleFloor });
  const muted = mutedFit;
  const placeholder = muted;

  // Button text on the accent: take the theme's own darkest/lightest colour; if neither reaches AA, move the accent away from it.
  const darkText = dark ? P.bg1 : P.fgStrong;
  const lightText = dark ? P.fgStrong : P.bg3;
  let accent = P.accent;
  let onAccent = contrast(accent, darkText) >= contrast(accent, lightText) ? darkText : lightText;
  if (contrast(accent, onAccent) < 4.5) {
    const away = onAccent === darkText ? WHITE : BLACK;
    const shifted = ensureContrast(accent, [onAccent], 4.5, away);
    adjustments.push({ role: "accent (button background)", upstream: accent, shipped: shifted });
    accent = shifted;
  }
  const accentText = fit("text-brand", accent, textSurfaces, 4.5);
  const link = fit("text-link", P.link, textSurfaces, 4.5);
  const goodText = fit("text-feedback-positive", P.good, textSurfaces, 4.5);
  const warnText = fit("text-feedback-warning", P.warn, textSurfaces, 4.5);
  const badText = fit("text-feedback-critical", P.bad, textSurfaces, 4.5);
  const infoText = fit("text-feedback-info", P.info, textSurfaces, 4.5);
  // Fills that carry hard-coded white text (notification badges, danger and connected buttons).
  const dangerSolid = fit("status-danger (white text)", P.bad, [WHITE], 4.5, BLACK);
  const goodSolid = fit("control-connected-background (white text)", P.good, [WHITE], 4.5, BLACK);
  // The base sets pair the warning fill with black text (dark) or white text (light).
  const warnSolid = dark ? fit("status-warning (black text)", P.warn, [BLACK], 4.5, WHITE) : fit("status-warning (white text)", P.warn, [WHITE], 4.5, BLACK);

  return {
    P,
    dark,
    bg0: P.bg0,
    bg1: P.bg1,
    bg2: P.bg2,
    bg3: P.bg3,
    bg4: P.bg4,
    low: dark ? mix(P.bg1, P.bg2, 0.35) : P.bg1,
    higher: dark ? mix(P.bg3, P.bg4, 0.35) : P.bg3,
    highest: dark ? mix(P.bg3, P.bg4, 0.7) : P.bg3,
    raised: dark ? mix(P.bg2, P.bg3, 0.5) : P.bg3,
    home: dark ? mix(P.bg2, P.bg3, 0.5) : mix(P.bg1, P.bg2, 0.5),
    pressed: mix(P.bg1, P.bg2, 0.45),
    pressed2: dark ? mix(P.bg0, P.bg1, 0.5) : mix(P.bg1, P.bg2, 0.45),
    frame: dark ? mix(P.bg0, BLACK, 0.5) : P.bg0,
    chatDefault: dark ? mix(P.bg1, P.bg2, 0.5) : P.bg2,
    input,
    strong,
    text,
    subtle,
    muted,
    placeholder,
    accent,
    onAccent,
    accentText,
    // Pressed and hover shades move away from the button text, so the text never loses contrast.
    away: onAccent === darkText ? WHITE : BLACK,
    accentActive: mix(accent, onAccent === darkText ? WHITE : BLACK, 0.3),
    accentHover: mix(accent, onAccent === darkText ? WHITE : BLACK, 0.12),
    link,
    goodText,
    warnText,
    badText,
    infoText,
    dangerSolid,
    goodSolid,
    warnSolid,
    overlay: mix(P.fg, P.bg2, 0.4),
    adjustments,
  };
}

type Role = (c: Ctx) => string | undefined;

const codeOn = (c: Ctx, color: string): string => ensureContrast(color, [c.bg1, c.bg2, c.bg3], 4.5, c.dark ? WHITE : BLACK);
const solidTint = (c: Ctx, hue: string, amount: number): string => mix(c.bg2, hue, amount);
/** Text on a notice banner: the hue pulled towards the strong text colour until it reads on the tinted background. */
const noticeText = (c: Ctx, hue: string): string => ensureContrast(mix(hue, c.strong, 0.5), [solidTint(c, hue, c.dark ? 0.24 : 0.16)], 4.5, c.dark ? WHITE : BLACK);
const mentionOn = (c: Ctx): string => {
  const backgrounds = [c.bg1, c.bg2, c.bg3].map(bg => over(rgba(c.accent, 0.24), bg));
  return ensureContrast(mix(c.accent, c.strong, 0.5), backgrounds, 4.5, c.dark ? WHITE : BLACK);
};

const TABLE: Record<string, Role> = {};
const set = (names: string[], role: Role): void => {
  for (const name of names) TABLE[name] = role;
};

// Backgrounds and surfaces
set(["background-accent"], c => c.accent);
set(["background-base-low"], c => c.low);
set(["background-base-lower", "panel-bg", "channel-background-default"], c => c.bg1);
set(["background-base-lowest"], c => c.bg0);
set(["background-brand"], c => c.accent);
set(["background-feedback-notification", "icon-feedback-notification", "control-critical-primary-background-default", "button-danger-background-disabled", "badge-notification-background"], c => c.dangerSolid);
set(["background-secondary-alt", "channeltextarea-background"], c => c.input);
set(["background-surface-high", "modal-background", "modal-footer-background", "embed-background", "embed-background-alternate", "card-background-default"], c => c.bg3);
set(["background-surface-higher"], c => c.higher);
set(["background-surface-highest"], c => c.highest);
set(["bg-surface-raised"], c => c.raised);
set(["home-background"], c => c.home);
set(["card-primary-pressed-bg"], c => c.pressed);
set(["card-secondary-pressed-bg"], c => c.pressed2);
set(["app-frame-background"], c => c.frame);
set(["chat-background"], c => c.bg2);
set(["chat-background-default"], c => c.chatDefault);
set(["guild-profile-banner-background-default"], c => (c.dark ? c.bg0 : ensureContrast(mix(c.P.fgMuted, c.bg2, 0.1), [WHITE], 4.5, c.strong)));

// Muted text, placeholders, scrollbars, spoilers
set(["chat-text-muted", "channel-icon", "channels-default", "text-muted", "icon-muted", "textbox-markdown-syntax"], c => c.muted);
set(["channel-text-area-placeholder", "input-placeholder-text-default"], c => c.placeholder);
set(["spoiler-hidden-background", "scrollbar-auto-thumb"], c => mix(c.bg2, c.P.fgMuted, 0.65));
set(["spoiler-hidden-background-hover"], c => mix(c.bg2, c.P.fgMuted, 0.8));
set(["spoiler-revealed-background"], c => (c.dark ? undefined : c.input)); // dark sets keep a translucent tint (retinted below), light sets a solid
set(["scrollbar-auto-scrollbar-color-thumb", "scrollbar-thin-thumb"], c => mix(c.bg2, c.P.fgMuted, 0.55));
set(["scrollbar-auto-scrollbar-color-track"], c => (c.dark ? mix(c.bg0, BLACK, 0.4) : c.bg1));

// Light sets use solid control borders (the dark sets use translucent ones, retinted below). 3:1 for non-text UI.
set(["checkbox-border-default", "radio-border-default"], c => (c.dark ? undefined : ensureContrast(mix(c.bg2, c.P.fgMuted, 0.75), [c.bg2, c.bg3], 3, c.strong)));
set(["checkbox-border-hover"], c => (c.dark ? undefined : ensureContrast(mix(c.bg2, c.P.fgMuted, 0.9), [c.bg2, c.bg3], 3.5, c.strong)));

// Brand
set(["text-brand", "icon-brand", "tabs-indicator-default"], c => c.accentText);
set(
  [
    "interactive-accent-background-hover",
    "interactive-accent-background-selected",
    "input-border-active",
    "reaction-border-reacted-default",
    "progressbar-indicator-background",
    "control-primary-background-default",
    "button-outline-brand-background-hover",
    "badge-background-brand",
    "checkbox-background-selected-default",
    "switch-background-selected-default",
    "radio-background-selected-default",
    "switch-thumb-icon-active",
  ],
  c => c.accent,
);
set(["interactive-accent-background-active", "checkbox-background-active", "switch-background-active", "button-outline-brand-border-active"], c => c.accentActive);
set(["checkbox-background-selected-hover", "switch-background-selected-hover"], c => c.accentHover);
set(["control-primary-text-default", "badge-text-brand", "checkbox-icon-active", "button-outline-primary-text", "switch-thumb-background-selected-default"], c => c.onAccent);
set(["control-expressive-background-default", "badge-expressive-background-default"], c => (c.dark ? WHITE : c.accent));
set(["control-expressive-text-default", "badge-expressive-text-default"], c => (c.dark ? BLACK : c.onAccent));
set(["border-focus"], c => c.accentText);
set(["mention-foreground", "reaction-text-reacted-default"], mentionOn);
set(["badge-rare-text"], c => ensureContrast(mix(c.accent, c.strong, 0.35), [c.bg1, c.bg2, c.bg3], 4.5, c.strong));
set(["logo-primary"], c => (c.dark ? WHITE : c.accent));
set(["navigator-header-tint"], c => (c.dark ? WHITE : c.subtle));

// Text and icon ladder
set(["text-default", "input-text-default", "input-text-error-default", "icon-default", "text-code", "text-code-variable"], c => c.text);
set(
  ["text-strong", "interactive-icon-active", "interactive-icon-hover", "interactive-text-active", "interactive-text-hover", "icon-strong", "reaction-text-active", "reaction-text-hover", "tabs-indicator-overlay", "control-secondary-text-default", "badge-text-default"],
  c => c.strong,
);
set(["text-subtle", "interactive-icon-default", "interactive-text-default", "input-icon-default", "icon-subtle", "reaction-text-default", "badge-common-text"], c => c.subtle);
set(["text-invert", "icon-invert"], c => (c.dark ? c.bg1 : c.bg3));
set(["switch-thumb-icon-default"], c => (c.dark ? c.bg1 : c.bg3));
set(["switch-thumb-background-default"], c => (c.dark ? WHITE : c.subtle));
set(["text-link", "icon-link"], c => c.link);
set(["interactive-muted", "thread-channel-spine"], c => mix(c.bg2, c.P.fgMuted, 0.45));
set(["spine-default", "slider-track-background"], c => mix(c.bg2, c.P.fgMuted, 0.4));

// Feedback and status
set(["text-feedback-critical", "text-voice-disconnected", "border-feedback-critical", "input-border-error-default", "icon-feedback-critical", "icon-voice-disconnected", "control-critical-secondary-text-default", "toast-critical-border"], c => c.badText);
set(["text-feedback-info", "border-feedback-info", "icon-feedback-info"], c => c.infoText);
set(["text-feedback-positive", "border-feedback-positive", "icon-feedback-positive", "toast-success-border"], c => c.goodText);
set(["text-feedback-warning", "border-feedback-warning", "icon-feedback-warning"], c => c.warnText);
set(["text-status-dnd", "icon-status-dnd", "icon-voice-muted"], c => c.badText);
set(["text-status-idle", "icon-status-idle"], c => c.warnText);
set(["text-status-offline", "icon-status-offline"], c => c.muted);
set(["text-status-online", "text-voice-speaking", "icon-status-online", "icon-voice-speaking", "text-voice-connected", "icon-voice-connected"], c => c.goodText);
set(["status-danger"], c => c.dangerSolid);
set(["status-positive-background", "control-connected-background-default"], c => c.goodSolid);
set(["status-warning", "status-warning-background"], c => c.warnSolid);
set(["notice-background-critical"], c => solidTint(c, c.P.bad, c.dark ? 0.24 : 0.16));
set(["notice-background-info"], c => solidTint(c, c.P.info, c.dark ? 0.24 : 0.16));
set(["notice-background-positive"], c => solidTint(c, c.P.good, c.dark ? 0.24 : 0.16));
set(["notice-background-warning"], c => solidTint(c, c.P.warn, c.dark ? 0.24 : 0.16));
set(["notice-text-critical"], c => noticeText(c, c.P.bad));
set(["notice-text-info"], c => noticeText(c, c.P.info));
set(["notice-text-positive"], c => noticeText(c, c.P.good));
set(["notice-text-warning"], c => noticeText(c, c.P.warn));

// Code
set(["text-code-addition"], c => codeOn(c, c.P.good));
set(["text-code-attribute", "text-code-bullet", "text-code-link", "text-code-namespace"], c => codeOn(c, c.P.syn.title));
set(["text-code-builtin", "text-code-decorator"], c => codeOn(c, c.P.syn.type));
set(["text-code-comment"], c => codeOn(c, c.P.syn.comment));
set(["text-code-deletion", "text-code-error"], c => codeOn(c, c.P.syn.deletion));
set(["text-code-keyword", "text-code-section", "text-code-operator", "text-code-tag"], c => codeOn(c, c.P.syn.keyword));
set(["text-code-escape"], c => codeOn(c, c.P.syn.symbol));
set(["text-code-type"], c => codeOn(c, c.P.syn.type));
set(["text-code-number"], c => codeOn(c, c.P.syn.number));
set(["text-code-property"], c => codeOn(c, c.P.syn.symbol));
set(["text-code-regexp", "text-code-string"], c => codeOn(c, c.P.syn.string));
set(["text-code-title"], c => codeOn(c, c.P.syn.title));

/** Non-theme `:root` values the base sets do not define but components read (brand ramp, legacy aliases) and chat.css locals. */
function extras(c: Ctx): Record<string, string> {
  const a = c.accent;
  return {
    "brand-360": mix(a, WHITE, 0.25),
    "brand-400": mix(a, WHITE, 0.12),
    "brand-500": a,
    "brand-530": mix(a, c.away, 0.1),
    "brand-560": mix(a, c.away, 0.2),
    "brand-600": mix(a, c.away, 0.35),
    "text-on-brand": c.onAccent,
    "red-hover": mix(c.dangerSolid, BLACK, 0.15),
    "red-active": mix(c.dangerSolid, BLACK, 0.25),
    "green-hover": mix(c.goodSolid, BLACK, 0.15),
    "green-active": c.goodSolid,
    "status-online": c.goodText,
    "status-positive": c.goodText,
    "chat-mentioned-bg": rgba(c.P.warn, 0.08),
    "chat-mentioned-hover": rgba(c.P.warn, 0.04),
    "chat-mentioned-bar": c.warnText,
    "syn-base": c.text,
    "syn-comment": codeOn(c, c.P.syn.comment),
    "syn-keyword": codeOn(c, c.P.syn.keyword),
    "syn-string": codeOn(c, c.P.syn.string),
    "syn-number": codeOn(c, c.P.syn.number),
    "syn-title": codeOn(c, c.P.syn.title),
    "syn-type": codeOn(c, c.P.syn.type),
    "syn-symbol": codeOn(c, c.P.syn.symbol),
    "syn-deletion": codeOn(c, c.P.syn.deletion),
  };
}

/** Names of the extras, so tests and the generator can tell them apart from base-set tokens. */
export const EXTRA_TOKENS: readonly string[] = Object.keys(extras(buildCtx(COMMUNITY_THEMES[0]!)));

/** Colour of the translucent tokens' rgb triple in the base sets, mapped onto theme colours. */
function tintFor(c: Ctx, r: number, g: number, b: number): string | undefined {
  const key = `${r},${g},${b}`;
  switch (key) {
    case "151,151,159": // the neutral overlay of every hover/selected/border token
    case "108,111,124":
      return c.overlay;
    case "88,101,242":
      return c.accent;
    case "210,45,57":
    case "250,119,123":
    case "242,63,67":
      return c.P.bad;
    case "0,133,69":
      return c.P.good;
    case "0,116,227":
      return c.P.info;
    case "248,163,0":
      return c.P.warn;
    default:
      return undefined;
  }
}

export function deriveTheme(def: ThemeDef, baseTokens: Readonly<Record<string, string>>): DerivedTheme {
  const c = buildCtx(def);
  const tokens: Record<string, string> = {};
  for (const [name, value] of Object.entries(baseTokens)) {
    let next: string | undefined = TABLE[name]?.(c);
    if (next === undefined && value.startsWith("rgba(")) {
      const { rgb, a } = parseColor(value);
      const tint = tintFor(c, rgb[0], rgb[1], rgb[2]);
      if (tint) next = rgba(tint, a);
    }
    if (next !== undefined && normalise(next) !== normalise(value)) tokens[name] = next;
  }
  for (const [name, value] of Object.entries(extras(c))) tokens[name] = value;
  return { id: def.id, base: def.base, tokens, adjustments: c.adjustments };
}

function normalise(value: string): string {
  return value.startsWith("#") ? toHex(parseColor(value).rgb) : value.replace(/\s+/g, "").toLowerCase();
}

/** Tokens the table assigns, for the coverage test. */
export const TABLE_TOKENS: readonly string[] = Object.keys(TABLE);

/** The rgb triples `tintFor` retints; the leak test uses it to know what "still the base colour" looks like. */
export const RETINTED_TRIPLES: readonly string[] = ["151,151,159", "108,111,124", "88,101,242", "210,45,57", "250,119,123", "242,63,67", "0,133,69", "0,116,227", "248,163,0"];
