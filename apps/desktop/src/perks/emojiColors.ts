// Dominant colours of an emoji, for the glow of a super reaction pill. The server sends `burst_colors: []`, so every client computes
// them itself: the emoji is drawn once onto a small canvas, its opaque pixels are bucketed and the two most common hues win.

import type { ReactionEmoji } from "../api/types";

export type Rgb = [number, number, number];

const toHex = ([r, g, b]: Rgb): string => `#${[r, g, b].map(v => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

/**
 * The `max` most common colours of RGBA pixel data, as `#rrggbb`. Pixels that are mostly transparent or nearly grey are skipped
 * (outlines and shading would otherwise win); a colour is a 4-bit-per-channel bucket averaged over its pixels. Two buckets closer than
 * `minDistance` count as one colour. Returns `[]` when no pixel qualifies.
 */
export function dominantColors(pixels: ArrayLike<number>, max = 2, minDistance = 48): string[] {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const r = pixels[i]!, g = pixels[i + 1]!, b = pixels[i + 2]!, a = pixels[i + 3]!;
    if (a < 128) continue;
    const hi = Math.max(r, g, b), lo = Math.min(r, g, b);
    if (hi - lo < 24 || hi < 40) continue; // grey, black outline
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bucket.n++;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    buckets.set(key, bucket);
  }
  const ranked = [...buckets.values()].sort((x, y) => y.n - x.n).map((v): Rgb => [v.r / v.n, v.g / v.n, v.b / v.n]);
  const picked: Rgb[] = [];
  for (const color of ranked) {
    if (picked.length >= max) break;
    if (picked.every(p => Math.hypot(p[0] - color[0], p[1] - color[1], p[2] - color[2]) >= minDistance)) picked.push(color);
  }
  return picked.map(toHex);
}

/** Used when the emoji cannot be drawn (no canvas, an image that has not loaded) or has no saturated pixels. */
export const FALLBACK_BURST_COLORS = ["var(--brand-500)", "var(--brand-360)"];

const cache = new Map<string, string[]>();
const SIZE = 32;

function drawUnicode(name: string): ArrayLike<number> | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${SIZE - 4}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
  ctx.fillText(name, SIZE / 2, SIZE / 2 + 1);
  try {
    return ctx.getImageData(0, 0, SIZE, SIZE).data;
  } catch {
    return null;
  }
}

/**
 * Glow colours for a burst pill: the server's `burst_colors` when it sent any, else the emoji's own (computed once per emoji and cached),
 * else the brand colour. Custom emoji have no image in Vokko yet, so they use the fallback.
 */
export function burstColors(emoji: ReactionEmoji, fromServer: readonly string[] = []): string[] {
  if (fromServer.length > 0) return [...fromServer];
  const key = emoji.id ? `${emoji.name}:${emoji.id}` : emoji.name;
  const hit = cache.get(key);
  if (hit) return hit;
  const pixels = emoji.id ? null : drawUnicode(emoji.name);
  const found = pixels ? dominantColors(pixels) : [];
  const colors = found.length === 0 ? FALLBACK_BURST_COLORS : found.length === 1 ? [found[0]!, found[0]!] : found;
  cache.set(key, colors);
  return colors;
}
