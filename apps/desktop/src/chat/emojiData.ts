// Emoji data (emojibase, MIT): loaded lazily because data.json is ~750 KB. Emoji render natively (no Twemoji assets, so no NOTICE needed).
import { useEffect, useState } from 'react';

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

// ---- recents + skin tone (localStorage) ----

const RECENT_KEY = 'vokko.emoji.recent';
const TONE_KEY = 'vokko.emoji.tone';
const DEFAULT_QUICK = ['👍', '😂', '❤️', '🎉'];

export function getRecentEmoji(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 36) : [];
  } catch { return []; }
}
/** The same unicode emoji, with or without variation selectors (emojibase spells 👍 as "👍️", typed or pasted text often without). */
export function sameUnicodeEmoji(a: string, b: string): boolean {
  return a.replace(/️/g, '') === b.replace(/️/g, '');
}
export function pushRecentEmoji(emoji: string): void {
  try {
    const next = [emoji, ...getRecentEmoji().filter(e => !sameUnicodeEmoji(e, emoji))].slice(0, 36);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* storage unavailable */ }
}
export function quickReactions(): string[] {
  const recent = getRecentEmoji();
  const out: string[] = [];
  for (const e of [...recent, ...DEFAULT_QUICK]) if (!out.some(x => sameUnicodeEmoji(x, e))) out.push(e);
  return out.slice(0, 4);
}
const FILLER_QUICK = ['😀', '😢', '😮', '🔥', '👀', '🙏', '😍', '😡', '👏', '💯', '😊', '🤔', '😭', '👋', '🙌', '✅'];
/** Up to `limit` unicode emoji for the "Add Reaction" submenu: recents first, then the defaults. */
export function frequentEmoji(limit = 12): string[] {
  const out: string[] = [];
  for (const e of [...getRecentEmoji(), ...DEFAULT_QUICK, ...FILLER_QUICK]) {
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
