// Emoji data (emojibase, MIT): loaded lazily because data.json is ~750 KB. Emoji render natively (no Twemoji assets, so no NOTICE needed).
import { useEffect, useState } from 'react';
import { getPrefs, setPref } from '../ui/prefs';

export interface EmojiEntry {
  emoji: string;
  label: string;
  tags: string[];
  group: number;
  order: number;
  shortcodes: string[];
  skins: { emoji: string; tone: number }[];
}

export interface EmojiDb {
  list: EmojiEntry[];
  /** Picker categories, in display order. */
  categories: { id: string; label: string; emoji: EmojiEntry[] }[];
  /** `:name:` (no colons) → unicode. */
  shortcodes: Map<string, string>;
  search(query: string, limit?: number): EmojiEntry[];
}

interface RawEmoji {
  emoji: string;
  hexcode: string;
  label: string;
  tags?: string[];
  group?: number;
  order?: number;
  skins?: { emoji: string; tone?: number | number[] }[];
}

const GROUPS: { group: number; id: string; label: string }[] = [
  { group: 0, id: 'people', label: 'Smileys & Emotion' },
  { group: 1, id: 'body', label: 'People & Body' },
  { group: 3, id: 'nature', label: 'Animals & Nature' },
  { group: 4, id: 'food', label: 'Food & Drink' },
  { group: 6, id: 'activity', label: 'Activities' },
  { group: 5, id: 'travel', label: 'Travel & Places' },
  { group: 7, id: 'objects', label: 'Objects' },
  { group: 8, id: 'symbols', label: 'Symbols' },
  { group: 9, id: 'flags', label: 'Flags' },
];

let dbPromise: Promise<EmojiDb> | null = null;
let db: EmojiDb | null = null;

export function loadEmojiDb(): Promise<EmojiDb> {
  dbPromise ??= (async () => {
    const [data, joy, github] = await Promise.all([
      import('emojibase-data/en/data.json'),
      import('emojibase-data/en/shortcodes/joypixels.json'),
      import('emojibase-data/en/shortcodes/github.json'),
    ]);
    const raw = (data.default as unknown as RawEmoji[]).filter(e => e.group !== undefined && e.group !== 2);
    // JoyPixels names first (they are the ones Discord shows, e.g. :slight_smile:), GitHub's as extra aliases so older names keep working.
    const joyMap = joy.default as unknown as Record<string, string | string[]>;
    const githubMap = github.default as unknown as Record<string, string | string[]>;
    const namesOf = (m: Record<string, string | string[]>, hex: string): string[] => { const c = m[hex]; return c === undefined ? [] : Array.isArray(c) ? c : [c]; };
    // A few names mean different emoji in the two sets (e.g. :om:): GitHub's meaning stays, as before.
    const githubOwner = new Map<string, string>();
    for (const hex of Object.keys(githubMap)) for (const n of namesOf(githubMap, hex)) githubOwner.set(n, hex);
    const shortcodes = new Map<string, string>();
    const list: EmojiEntry[] = raw.map(e => {
      const joyNames = namesOf(joyMap, e.hexcode).filter(n => (githubOwner.get(n) ?? e.hexcode) === e.hexcode);
      const names = [...new Set([...joyNames, ...namesOf(githubMap, e.hexcode)])];
      for (const n of names) if (!shortcodes.has(n)) shortcodes.set(n, e.emoji);
      return {
        emoji: e.emoji, label: e.label, tags: e.tags ?? [], group: e.group ?? 0, order: e.order ?? 0, shortcodes: names,
        skins: (e.skins ?? []).map(s => ({ emoji: s.emoji, tone: Array.isArray(s.tone) ? (s.tone[0] ?? 0) : (s.tone ?? 0) })),
      };
    });
    list.sort((a, b) => a.order - b.order);
    const categories = GROUPS.map(g => ({ id: g.id, label: g.label, emoji: list.filter(e => e.group === g.group) })).filter(c => c.emoji.length > 0);
    const search = (query: string, limit = 60): EmojiEntry[] => {
      const q = query.trim().toLowerCase().replace(/^:|:$/g, '');
      if (!q) return [];
      const scored: { e: EmojiEntry; score: number }[] = [];
      for (const e of list) {
        let score = 0;
        for (const s of e.shortcodes) {
          const sl = s.toLowerCase();
          if (sl === q) score = Math.max(score, 100);
          else if (sl.startsWith(q)) score = Math.max(score, 80 - Math.min(20, sl.length - q.length));
          else if (sl.includes(q)) score = Math.max(score, 40);
        }
        if (score === 0) {
          if (e.label.toLowerCase().includes(q)) score = 30;
          else if (e.tags.some(t => t.toLowerCase().startsWith(q))) score = 20;
        }
        if (score > 0) scored.push({ e, score });
      }
      return scored.sort((a, b) => b.score - a.score || a.e.order - b.e.order).slice(0, limit).map(x => x.e);
    };
    db = { list, categories, shortcodes, search };
    return db;
  })();
  return dbPromise;
}

export function useEmojiDb(): EmojiDb | null {
  const [value, setValue] = useState<EmojiDb | null>(db);
  useEffect(() => {
    if (db) { setValue(db); return; }
    let live = true;
    void loadEmojiDb().then(d => { if (live) setValue(d); }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  return value;
}

// ---- Frequently Used (frecency, localStorage) + skin tone ----
// Usage stays on this device: it changes with every message and the synced settings blob is last-writer-wins per key, so two devices
// would overwrite each other's counts. Favourites are a deliberate choice and sync with the account (pref `emojiFavorites`).

const FRECENCY_KEY = 'vokko.emoji.frecency';
/** The most-recent-first list this replaced: read once to seed the counts. */
const RECENT_KEY = 'vokko.emoji.recent';
const TONE_KEY = 'vokko.emoji.tone';
const DEFAULT_QUICK = ['👍', '😂', '❤️', '🎉'];
const DAY = 86_400_000;
const MAX_TRACKED = 100;
const MAX_USES = 10;

/** One emoji's usage: `e` is the glyph or a custom emoji's `<:name:id>` markup, `uses` its last few use times (oldest first). */
interface Usage { e: string; count: number; uses: number[] }

export const customEmojiId = (e: string): string | null => /^<a?:\w+:(\d+)>$/.exec(e)?.[1] ?? null;
/** One emoji: custom ones by id (a rename keeps the history), unicode ones with or without variation selectors. */
function sameEmoji(a: string, b: string): boolean {
  const ida = customEmojiId(a), idb = customEmojiId(b);
  return ida || idb ? ida === idb : sameUnicodeEmoji(a, b);
}

// Discord-style frecency: every use counts, recent uses weigh more (each of the last 10 uses weighted by its age).
function weight(age: number): number {
  return age < DAY ? 100 : age < 3 * DAY ? 70 : age < 7 * DAY ? 50 : age < 30 * DAY ? 30 : age < 90 * DAY ? 10 : 0;
}
function score(u: Usage, now: number): number {
  return u.uses.length ? (u.count * u.uses.reduce((sum, t) => sum + weight(now - t), 0)) / u.uses.length : 0;
}
const byScore = (now: number) => (a: Usage, b: Usage) => score(b, now) - score(a, now) || (b.uses.at(-1) ?? 0) - (a.uses.at(-1) ?? 0);

function loadUsage(): Usage[] {
  try {
    const v = JSON.parse(localStorage.getItem(FRECENCY_KEY) ?? 'null') as unknown;
    if (Array.isArray(v)) {
      return v.filter((u): u is Usage => !!u && typeof u.e === 'string' && typeof u.count === 'number' && Array.isArray(u.uses) && u.uses.every((t: unknown) => typeof t === 'number'));
    }
    // seeded from the old list, keeping its order
    const old = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
    const now = Date.now();
    return Array.isArray(old) ? old.filter((x): x is string => typeof x === 'string').map((e, i) => ({ e, count: 1, uses: [now - (i + 1) * 1000] })) : [];
  } catch { return []; }
}

/** Frequently Used, best first: unicode glyphs and custom `<:name:id>` markup (callers drop the custom ones they cannot show). */
export function getRecentEmoji(now = Date.now()): string[] {
  return loadUsage().sort(byScore(now)).slice(0, 36).map(u => u.e);
}
/** The same unicode emoji, with or without variation selectors (emojibase spells 👍 as "👍️", typed or pasted text often without). */
export function sameUnicodeEmoji(a: string, b: string): boolean {
  return a.replace(/️/g, '') === b.replace(/️/g, '');
}
/** Counts one use of a unicode emoji or a custom one's `<:name:id>` markup (a sent message, an added reaction). */
export function pushRecentEmoji(emoji: string, now = Date.now()): void {
  try {
    const list = loadUsage();
    const hit = list.find(u => sameEmoji(u.e, emoji));
    if (hit) Object.assign(hit, { e: emoji, count: hit.count + 1, uses: [...hit.uses, now].slice(-MAX_USES) });
    else list.push({ e: emoji, count: 1, uses: [now] });
    localStorage.setItem(FRECENCY_KEY, JSON.stringify(list.sort(byScore(now)).slice(0, MAX_TRACKED)));
  } catch { /* storage unavailable */ }
}
/** Counts the emoji of a sent message as used: unicode, custom `<:name:id>` and typed `:shortcodes:` once the database is loaded. */
export function recordEmojiUse(content: string): void {
  // inline code and code blocks are not emoji use
  const text = content.replace(/```[\s\S]*?```|`[^`\n]*`/g, ' ');
  if (!/[\p{Extended_Pictographic}\p{Regional_Indicator}]|:\w/u.test(text)) return;
  const used: string[] = [];
  const add = (e: string) => { if (!used.some(x => sameEmoji(x, e))) used.push(e); };
  for (const m of text.matchAll(/<a?:\w+:\d+>/g)) add(m[0]);
  // known shortcodes become their emoji
  const plain = text.replace(/<a?:\w+:\d+>/g, ' ').replace(/:([\w+-]+):/g, (all, name: string) => db?.shortcodes.get(name.toLowerCase()) ?? all);
  for (const { segment } of new Intl.Segmenter().segment(plain)) {
    if (/\p{Emoji_Presentation}|️|\p{Regional_Indicator}/u.test(segment)) add(segment); // not ©, ® or ™ typed as text
  }
  const now = Date.now();
  for (const e of used.slice(0, 36)) pushRecentEmoji(e, now);
}

// ---- favourites: the picker's right-click / long-press "Favorite", shown above Frequently Used; synced with the account ----

/** Same cap as the server's `emoji_favorites` allow-list entry. */
export const MAX_FAVORITE_EMOJI = 100;
/** Where favourites lived before they moved to the synced prefs. */
const OLD_FAVORITE_KEY = 'vokko.emoji.favorites';
export function getFavoriteEmoji(): string[] {
  try {
    const old = localStorage.getItem(OLD_FAVORITE_KEY);
    if (old !== null) {
      localStorage.removeItem(OLD_FAVORITE_KEY);
      const v = JSON.parse(old) as unknown;
      if (getPrefs().emojiFavorites.length === 0 && Array.isArray(v)) setPref('emojiFavorites', v.filter((x): x is string => typeof x === 'string').slice(0, MAX_FAVORITE_EMOJI));
    }
  } catch { /* storage unavailable */ }
  return getPrefs().emojiFavorites;
}
export function isFavoriteEmoji(favorites: readonly string[], emoji: string): boolean {
  return favorites.some(e => sameEmoji(e, emoji));
}
/** Adds or removes a favourite (a glyph or custom `<:name:id>`) and returns the new list, in the order they were added. Full: unchanged. */
export function toggleFavoriteEmoji(emoji: string): string[] {
  const now = getFavoriteEmoji();
  const next = isFavoriteEmoji(now, emoji) ? now.filter(e => !sameEmoji(e, emoji)) : now.length >= MAX_FAVORITE_EMOJI ? now : [...now, emoji];
  if (next !== now) setPref('emojiFavorites', next);
  return next;
}
/** Position in Frequently Used (past the end when unused): `:` autocomplete lists used emoji first within a match rank. */
export function frecencyRank(): (emoji: string) => number {
  const list = getRecentEmoji();
  return emoji => { const i = list.findIndex(e => sameEmoji(e, emoji)); return i < 0 ? list.length : i; };
}
/** The quick reaction bars and the "Add Reaction" submenu show unicode only. */
const unicodeRecent = () => getRecentEmoji().filter(e => !customEmojiId(e));
export function quickReactions(): string[] {
  const out: string[] = [];
  for (const e of [...unicodeRecent(), ...DEFAULT_QUICK]) if (!out.some(x => sameUnicodeEmoji(x, e))) out.push(e);
  return out.slice(0, 4);
}
const FILLER_QUICK = ['😀', '😢', '😮', '🔥', '👀', '🙏', '😍', '😡', '👏', '💯', '😊', '🤔', '😭', '👋', '🙌', '✅'];
/** Up to `limit` unicode emoji for the "Add Reaction" submenu: Frequently Used first, then the defaults. */
export function frequentEmoji(limit = 12): string[] {
  const out: string[] = [];
  for (const e of [...unicodeRecent(), ...DEFAULT_QUICK, ...FILLER_QUICK]) {
    if (!out.some(x => sameUnicodeEmoji(x, e))) out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}
/** `:shortcode:` for a unicode emoji when the database is already loaded, else the glyph itself. */
export function emojiShortcodeLabel(ch: string): string {
  // emojibase spells some emoji with a variation selector (👍 is "👍️"): match with and without it
  const bare = ch.replace(/️/g, '');
  const entry = db?.list.find(e => e.emoji === ch) ?? db?.list.find(e => e.emoji.replace(/️/g, '') === bare);
  return entry?.shortcodes[0] ? `:${entry.shortcodes[0]}:` : ch;
}
export function getSkinTone(): number {
  try { return Number(localStorage.getItem(TONE_KEY) ?? 0) || 0; } catch { return 0; }
}
export function setSkinTone(tone: number): void {
  try { localStorage.setItem(TONE_KEY, String(tone)); } catch { /* storage unavailable */ }
}
