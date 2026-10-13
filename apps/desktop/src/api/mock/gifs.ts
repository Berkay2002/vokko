// Placeholder media for the mock GIF provider and the seeded stickers. Everything is generated SVG (data: URIs): no network, no
// assets, deterministic (the same query always lists the same items) so tests and screenshots are stable.

import type { Embed, Gif, GifCategory } from "../types";

/** Host of the fake "direct media" URLs. `.invalid` never resolves, so a stray request cannot leave the machine. */
export const MOCK_GIF_HOST = "media.mock.vokko.invalid";
/** Items per query/trending listing. */
export const GIF_TOTAL = 60;

const SIZES: [number, number][] = [
  [320, 240],
  [280, 280],
  [360, 200],
  [240, 320],
];
const TRENDING_WORDS = ["wow", "facepalm", "party", "applause", "thumbs up", "dance", "shrug", "mind blown", "high five", "cheers", "sleepy", "yes"];
export const GIF_CATEGORIES = ["Reactions", "Happy", "Sad", "Love", "Party", "Cats", "Gaming", "Memes"];

export const svgDataUri = (svg: string): string => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

const escapeXml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Small deterministic string hash (FNV-1a, unsigned). */
export function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const slugOf = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "gif";

/** A looping gradient card with the label on it (SMIL animation, so it moves like a GIF in an <img>); an empty label draws just the gradient. */
export function gifSvg(label: string, hue: number, width: number, height: number): string {
  const a = `hsl(${hue} 70% 45%)`;
  const b = `hsl(${(hue + 60) % 360} 75% 55%)`;
  const size = Math.max(14, Math.min(34, Math.floor((width * 1.6) / Math.max(6, label.length))));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
<rect width="${width}" height="${height}" fill="url(#g)"/>
<circle cx="${width * 0.2}" cy="${height * 0.25}" r="${Math.round(height * 0.12)}" fill="#fff" opacity="0.35"><animate attributeName="cx" values="${width * 0.2};${width * 0.8};${width * 0.2}" dur="2.4s" repeatCount="indefinite"/></circle>
${label === "" ? "" : `<text x="${width / 2}" y="${height / 2}" fill="#fff" font-family="Noto Sans, sans-serif" font-size="${size}" font-weight="700" text-anchor="middle" dominant-baseline="middle">${escapeXml(label)}</text>
<text x="${width - 8}" y="${height - 8}" fill="#fff" opacity="0.7" font-family="Noto Sans, sans-serif" font-size="11" font-weight="700" text-anchor="end">GIF</text>`}
</svg>`;
}

/** Direct media URL of a mock GIF; hue, size and label are in the path so the image can be regenerated from the URL alone. */
export function mockGifUrl(label: string, hue: number, width: number, height: number): string {
  return `https://${MOCK_GIF_HOST}/gifs/${hue}/${width}x${height}/${slugOf(label)}.gif`;
}

interface Parsed {
  label: string;
  hue: number;
  width: number;
  height: number;
}

export function parseMockGifUrl(url: string): Parsed | null {
  const m = new RegExp(`^https://${MOCK_GIF_HOST.replace(/\./g, "\\.")}/gifs/(\\d{1,3})/(\\d{2,4})x(\\d{2,4})/([a-z0-9-]+)\\.gif$`).exec(url);
  if (!m) return null;
  return { hue: Number(m[1]), width: Number(m[2]), height: Number(m[3]), label: (m[4] ?? "").replace(/-/g, " ") };
}

/** What the real server's link unfurl would attach to a message whose content is a mock GIF URL: an image embed. */
export function gifEmbeds(content: string): Embed[] {
  const url = content.trim();
  const parsed = parseMockGifUrl(url);
  if (!parsed) return [];
  const thumbnail = { url: svgDataUri(gifSvg(parsed.label, parsed.hue, parsed.width, parsed.height)), width: parsed.width, height: parsed.height };
  return [{ type: "image", url, thumbnail, provider: { name: "Klipy" } }];
}

/** Item `index` of the listing for `label` (a search query or a trending word). */
export function mockGif(label: string, index: number, provider = "klipy"): Gif {
  const h = hash(`${label}:${index}`);
  const [width, height] = SIZES[h % SIZES.length] ?? SIZES[0] ?? [320, 240];
  const hue = h % 360;
  const title = `${label} ${index + 1}`;
  return {
    id: `${provider}:${slugOf(label)}-${index + 1}`,
    title,
    url: mockGifUrl(title, hue, width, height),
    preview_url: svgDataUri(gifSvg(title, hue, Math.round(width / 2), Math.round(height / 2))),
    width,
    height,
  };
}

export interface MockGifPage {
  results: Gif[];
  next: string | null;
}

/** One page of a listing of GIF_TOTAL items; `pos` is the offset as a string. */
export function gifPage(labelFor: (index: number) => string, limit: number, pos: string | null, provider = "klipy"): MockGifPage {
  const offset = Math.max(0, Math.min(GIF_TOTAL, Number(pos) || 0));
  const end = Math.min(GIF_TOTAL, offset + limit);
  const results: Gif[] = [];
  for (let i = offset; i < end; i += 1) results.push(mockGif(labelFor(i), i, provider));
  return { results, next: end < GIF_TOTAL ? String(end) : null };
}

export const trendingLabel = (index: number): string => TRENDING_WORDS[index % TRENDING_WORDS.length] ?? "wow";

export function mockCategories(): GifCategory[] {
  return GIF_CATEGORIES.map(name => ({ name, image: svgDataUri(gifSvg("", hash(name) % 360, 160, 90)) }));
}

/** Round sticker artwork: a coloured disc with a short word on it. */
export function stickerSvg(word: string, hue: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320">
<circle cx="160" cy="160" r="150" fill="hsl(${hue} 70% 50%)" stroke="#fff" stroke-width="10"/>
<circle cx="115" cy="130" r="14" fill="#fff"/><circle cx="205" cy="130" r="14" fill="#fff"/>
<path d="M105 195 Q160 245 215 195" stroke="#fff" stroke-width="12" fill="none" stroke-linecap="round"/>
<text x="160" y="290" fill="#fff" font-family="Noto Sans, sans-serif" font-size="30" font-weight="700" text-anchor="middle">${escapeXml(word)}</text>
</svg>`;
}
