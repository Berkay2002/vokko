/** Small colour helpers shared by the community-theme palettes, the generator and the contrast tests. Pure functions, no DOM. */

export type Rgb = readonly [number, number, number];
export interface Rgba {
  rgb: Rgb;
  a: number;
}

const clamp = (n: number, lo = 0, hi = 255): number => Math.min(hi, Math.max(lo, n));

/** Parses `#rgb`, `#rrggbb`, `#rrggbbaa` and `rgb()/rgba()` (comma syntax). Throws on anything else, so a typo in a palette fails loudly. */
export function parseColor(input: string): Rgba {
  const s = input.trim().toLowerCase();
  if (s.startsWith("#")) {
    const h = s.slice(1);
    const full = h.length === 3 ? [...h].map(c => c + c).join("") : h;
    if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(full)) throw new Error(`bad hex colour: ${input}`);
    const n = (i: number): number => parseInt(full.slice(i, i + 2), 16);
    return { rgb: [n(0), n(2), n(4)], a: full.length === 8 ? n(6) / 255 : 1 };
  }
  const m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (!m) throw new Error(`bad colour: ${input}`);
  return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], a: m[4] === undefined ? 1 : Number(m[4]) };
}

export function toHex(rgb: Rgb): string {
  return `#${rgb.map(c => clamp(Math.round(c)).toString(16).padStart(2, "0")).join("")}`;
}

/** `t` = 0 returns `a`, `t` = 1 returns `b`. Opaque colours only. */
export function mix(a: string, b: string, t: number): string {
  const x = parseColor(a).rgb;
  const y = parseColor(b).rgb;
  return toHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

/** `rgba(r, g, b, a)` in the spacing the existing token sets use. */
export function rgba(color: string, alpha: number): string {
  const [r, g, b] = parseColor(color).rgb;
  return `rgba(${r}, ${g}, ${b}, ${Number(alpha.toFixed(3))})`;
}

/** WCAG relative luminance. */
export function luminance(color: string): number {
  const lin = parseColor(color).rgb.map(v => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}

/** WCAG contrast ratio of two opaque colours (1..21). */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Flattens a (possibly translucent) colour over an opaque backdrop. */
export function over(color: string, backdrop: string): string {
  const c = parseColor(color);
  const b = parseColor(backdrop).rgb;
  return toHex([c.rgb[0] * c.a + b[0] * (1 - c.a), c.rgb[1] * c.a + b[1] * (1 - c.a), c.rgb[2] * c.a + b[2] * (1 - c.a)]);
}

/**
 * Moves `color` towards `towards` in 2% steps until it reaches `min` contrast on every background in `backgrounds`.
 * Returns `color` untouched when it already passes; the result stays on the line between the palette colour and `towards`.
 */
export function ensureContrast(color: string, backgrounds: readonly string[], min: number, towards: string): string {
  const worst = (c: string): number => Math.min(...backgrounds.map(bg => contrast(c, bg)));
  if (worst(color) >= min) return color;
  for (let t = 0.02; t <= 1.0001; t += 0.02) {
    const candidate = mix(color, towards, t);
    if (worst(candidate) >= min) return candidate;
  }
  return towards;
}

const toLinear = (v: number): number => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (c: number): number => 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

function toOklab(color: string): [number, number, number] {
  const [r, g, b] = parseColor(color).rgb.map(toLinear) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

function fromOklab([L, a, b]: readonly [number, number, number]): string {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return toHex([
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ]);
}

/** CSS `color-mix(in oklab, a, b t)`: `t` = 0 returns `a`, `t` = 1 returns `b`. Opaque colours only. */
export function mixOklab(a: string, b: string, t: number): string {
  const x = toOklab(a);
  const y = toOklab(b);
  return fromOklab([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

/** Hue in degrees (0..360) of an opaque colour; 0 for greys. */
export function hue(color: string): number {
  const [r, g, b] = parseColor(color).rgb.map(v => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

/** `hsl(h, s, l)` as hex; `h` in degrees, `s` and `l` 0..1. */
export function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const sector = Math.floor((((h % 360) + 360) % 360) / 60);
  const [r, g, b] = ([[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]] as const)[sector]!;
  return toHex([(r + m) * 255, (g + m) * 255, (b + m) * 255]);
}
