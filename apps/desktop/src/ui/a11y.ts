/**
 * Accessibility settings, pure part: value scales, migration of stored settings and colour maths. No DOM access here, so
 * vitest can run it in node. The side effects (classes, CSS variables, zoom) live in a11yApply.ts.
 */

export type StickerAnimation = "always" | "interaction" | "never";

/** Zoom levels of the slider (percent); Ctrl +/- steps through them. */
export const ZOOM_STEPS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200] as const;
/** Saturation of the app chrome (percent). */
export const SATURATION_STEPS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const;
/** Minimum time a pop-up notification stays on screen (seconds). */
export const NOTIFICATION_SECONDS = [3, 5, 10, 15, 20] as const;
/**
 * Speech rate multipliers of the text-to-speech slider: main's 0.5..2 range with 1.0x kept as a stop, 11 stops instead of 7.
 * shortcut: 1.0x is a third of the way along 0.5..2, so 11 stops cannot be all equal steps and still contain it (0.1 below, 0.2
 * above); the reference's real stop values were never read, only that it has 11 ticks.
 */
export const TTS_RATES = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.2, 1.4, 1.6, 1.8, 2] as const;

export const DEFAULT_ZOOM = 100;

/** The step closest to `value`; a value halfway between two steps goes to the one closer to `towards` (the lower one by default). */
export function nearestStep(steps: readonly number[], value: number, towards?: number): number {
  let best = steps[0] ?? value;
  for (const step of steps) {
    const d = Math.abs(step - value);
    const bestD = Math.abs(best - value);
    const tie = Math.abs(d - bestD) < 1e-9 && towards !== undefined && Math.abs(step - towards) < Math.abs(best - towards);
    if (d < bestD - 1e-9 || tie) best = step;
  }
  return best;
}

/** Settings that sit on a slider stop, with the value ties settle towards. Used for stored and for synced values alike. */
const STEPPED: Record<string, { steps: readonly number[]; towards?: number }> = {
  zoom: { steps: ZOOM_STEPS },
  minNotificationDuration: { steps: NOTIFICATION_SECONDS },
  ttsRate: { steps: TTS_RATES, towards: 1 },
};

/** `value` moved onto its slider stop when the setting has stops; any other setting comes back unchanged. */
export function snapStepped(key: string, value: number): number {
  const entry = STEPPED[key];
  return entry && Number.isFinite(value) ? nearestStep(entry.steps, value, entry.towards) : value;
}

/** One Ctrl + / Ctrl - press: the next zoom level up or down (a value between two levels moves to the neighbour on that side). */
export function stepZoom(current: number, direction: 1 | -1): number {
  if (direction === 1) return ZOOM_STEPS.find(z => z > current) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]!;
  return [...ZOOM_STEPS].reverse().find(z => z < current) ?? ZOOM_STEPS[0]!;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/**
 * Settings stored before the reduced-motion split kept one `reducedMotion` string ("system" | "on" | "off"). Discord has two
 * toggles instead: "Enable reduced motion" and "Sync with computer". Returns the stored object with the two new keys filled in
 * from the old one (unless the new keys are already there). Pure: does not touch localStorage.
 */
export function migrateStoredPrefs(stored: Record<string, unknown>): Record<string, unknown> {
  const out = { ...stored };
  const legacy = stored.reducedMotion;
  if (typeof legacy === "string") {
    if (typeof out.reducedMotionEnabled !== "boolean") out.reducedMotionEnabled = legacy === "on";
    if (typeof out.syncReducedMotion !== "boolean") out.syncReducedMotion = legacy === "system";
    delete out.reducedMotion;
  }
  return out;
}

/** Brings out-of-range or foreign values of the accessibility settings back to something the UI can render. */
export function sanitizeA11y<T extends Record<string, unknown>>(prefs: T): T {
  const out: Record<string, unknown> = { ...prefs };
  const num = (key: string, lo: number, hi: number, fallback: number) => {
    const v = out[key];
    out[key] = typeof v === "number" && Number.isFinite(v) ? clamp(v, lo, hi) : fallback;
  };
  const snap = (key: string) => {
    out[key] = snapStepped(key, out[key] as number);
  };
  num("zoom", ZOOM_STEPS[0], ZOOM_STEPS[ZOOM_STEPS.length - 1]!, DEFAULT_ZOOM);
  snap("zoom");
  num("saturation", 0, 100, 100);
  num("messageGroupGap", 0, 24, 16);
  num("minNotificationDuration", NOTIFICATION_SECONDS[0], NOTIFICATION_SECONDS[NOTIFICATION_SECONDS.length - 1]!, 3);
  snap("minNotificationDuration");
  num("ttsRate", TTS_RATES[0], TTS_RATES[TTS_RATES.length - 1]!, 1);
  snap("ttsRate");
  if (out.stickerAnimation !== "always" && out.stickerAnimation !== "interaction" && out.stickerAnimation !== "never") out.stickerAnimation = "always";
  return out as T;
}

// ---- colour maths (saturation setting) ----

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB = /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/i;

/** Parses `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()`; anything else (var(), named, hsl, gradients) is null. */
export function parseColor(value: string): Rgba | null {
  const text = value.trim();
  const hex = HEX.exec(text);
  if (hex) {
    let h = hex[1]!;
    if (h.length <= 4) h = [...h].map(c => c + c).join("");
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  const rgb = RGB.exec(text);
  if (rgb) {
    const alpha = rgb[4] === undefined ? 1 : rgb[4].endsWith("%") ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4]);
    return { r: clamp(+rgb[1]!, 0, 255), g: clamp(+rgb[2]!, 0, 255), b: clamp(+rgb[3]!, 0, 255), a: clamp(alpha, 0, 1) };
  }
  return null;
}

export function formatColor({ r, g, b, a }: Rgba): string {
  const byte = (n: number) => clamp(Math.round(n), 0, 255);
  if (a >= 1) return `#${[r, g, b].map(c => byte(c).toString(16).padStart(2, "0")).join("")}`;
  return `rgba(${byte(r)}, ${byte(g)}, ${byte(b)}, ${Math.round(a * 1000) / 1000})`;
}

/** The same matrix as the CSS `saturate()` filter, applied to one colour: 0 = grey, 1 = unchanged. */
export function saturateRgba(color: Rgba, amount: number): Rgba {
  const s = clamp(amount, 0, 1);
  const { r, g, b } = color;
  return {
    r: (0.213 + 0.787 * s) * r + (0.715 - 0.715 * s) * g + (0.072 - 0.072 * s) * b,
    g: (0.213 - 0.213 * s) * r + (0.715 + 0.285 * s) * g + (0.072 - 0.072 * s) * b,
    b: (0.213 - 0.213 * s) * r + (0.715 - 0.715 * s) * g + (0.072 + 0.928 * s) * b,
    a: color.a,
  };
}

/** `value` with its colour saturation scaled to `percent` (0..100); null when `value` is not a plain colour. */
export function saturateColor(value: string, percent: number): string | null {
  const parsed = parseColor(value);
  if (!parsed) return null;
  if (percent >= 100) return formatColor(parsed);
  return formatColor(saturateRgba(parsed, percent / 100));
}

/** WCAG relative luminance and contrast ratio (tests use these for the high-contrast token sets). */
export function relativeLuminance({ r, g, b }: Rgba): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
