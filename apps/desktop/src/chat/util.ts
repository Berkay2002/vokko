import type { Snowflake } from '../api/types';

const DISCORD_EPOCH = 1420070400000n;

export function compareIds(a: Snowflake, b: Snowflake): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function snowflakeToMs(id: Snowflake): number {
  try { return Number((BigInt(id) >> 22n) + DISCORD_EPOCH); } catch { return 0; }
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Locale of the chat area: the document language (the shell may set it from a language setting), else the webview's own. */
export function chatLocale(): string {
  const lang = typeof document !== 'undefined' ? document.documentElement.lang : '';
  if (lang) return lang;
  if (typeof navigator === 'undefined') return 'en-US';
  return navigator.languages?.[0] || navigator.language || 'en-US';
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(locale: string, key: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const k = `${locale}|${key}`;
  let f = fmtCache.get(k);
  if (!f) {
    try { f = new Intl.DateTimeFormat(locale, opts); } catch { f = new Intl.DateTimeFormat('en-US', opts); }
    fmtCache.set(k, f);
  }
  return f;
}

/** "9:24 PM" in 12-hour locales, "21:24" / "09:05" (two-digit hour, like Discord) in 24-hour ones. */
export function formatTime(d: Date, locale = chatLocale()): string {
  const h12 = fmt(locale, 'time', { hour: 'numeric', minute: '2-digit' });
  const cycle = h12.resolvedOptions().hourCycle;
  return (cycle === 'h23' || cycle === 'h24' ? fmt(locale, 'time24', { hour: '2-digit', minute: '2-digit' }) : h12).format(d);
}
export const formatShortDate = (d: Date, locale = chatLocale()): string => fmt(locale, 'short', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
export const formatFullDate = (d: Date, locale = chatLocale()): string =>
  fmt(locale, 'long', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
export const formatDivider = (d: Date, locale = chatLocale()): string => fmt(locale, 'divider', { year: 'numeric', month: 'long', day: 'numeric' }).format(d);

// "Today at 9:24 PM" / "Idag kl. 21:24": the day word plus the locale's connector. Unlisted languages fall back to Intl's relative word.
const DAY_WORDS: Record<string, { today: string; yesterday: string; at: string }> = {
  en: { today: 'Today', yesterday: 'Yesterday', at: 'at' },
  sv: { today: 'Idag', yesterday: 'Igår', at: 'kl.' },
  de: { today: 'Heute', yesterday: 'Gestern', at: 'um' },
  fr: { today: "Aujourd'hui", yesterday: 'Hier', at: 'à' },
  es: { today: 'Hoy', yesterday: 'Ayer', at: 'a las' },
  nb: { today: 'I dag', yesterday: 'I går', at: 'kl.' },
  da: { today: 'I dag', yesterday: 'I går', at: 'kl.' },
};

function dayWords(locale: string): { today: string; yesterday: string; at: string } {
  const base = locale.toLowerCase().split('-')[0] ?? 'en';
  const known = DAY_WORDS[base];
  if (known) return known;
  try {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    const cap = (s: string) => s.charAt(0).toLocaleUpperCase(locale) + s.slice(1);
    return { today: cap(rtf.format(0, 'day')), yesterday: cap(rtf.format(-1, 'day')), at: '' };
  } catch { return DAY_WORDS.en!; }
}

/** Message header time: "Today at 9:24 PM" / "Idag kl. 21:24", "Yesterday at …" / "Igår kl. …", older "10/09/2026 9:24 PM" / "2026-10-09 21:24". */
export function formatMessageTimestamp(d: Date, now = new Date(), locale = chatLocale()): string {
  const time = formatTime(d, locale);
  const words = dayWords(locale);
  const withDay = (day: string) => `${day} ${words.at ? `${words.at} ` : ''}${time}`;
  if (sameDay(d, now)) return withDay(words.today);
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (sameDay(d, y)) return withDay(words.yesterday);
  return `${formatShortDate(d, locale)} ${time}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function clamp(n: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, n)); }

export function newNonce(): string { return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`; }

// Shift state for "Shift+click skips the delete confirm" (menu items don't receive the click event).
let shiftDown = false;
let shiftBound = false;
export function isShiftDown(): boolean {
  if (!shiftBound && typeof window !== 'undefined') {
    shiftBound = true;
    const set = (e: KeyboardEvent) => { shiftDown = e.shiftKey; };
    window.addEventListener('keydown', set, true);
    window.addEventListener('keyup', set, true);
    window.addEventListener('mousedown', e => { shiftDown = e.shiftKey; }, true);
    window.addEventListener('blur', () => { shiftDown = false; });
  }
  return shiftDown;
}

if (typeof window !== 'undefined') isShiftDown();
