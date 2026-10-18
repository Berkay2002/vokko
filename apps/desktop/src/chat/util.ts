import { ApiRequestError } from '../api/errors';
import { formatUploadLimit, maxUploadBytes } from '../api/limits';
import { ChannelType, type Channel, type Snowflake, type User } from '../api/types';
import { timeFormatPref } from './shell';

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

/**
 * Locale of the chat area: a document language the shell set from a language setting, else the webview's own. A bare "en" is the static
 * default of index.html (nobody chose it), so it does not shadow the OS language.
 */
export function chatLocale(): string {
  const lang = typeof document !== 'undefined' ? document.documentElement.lang : '';
  if (lang && lang.toLowerCase() !== 'en') return lang;
  if (typeof navigator === 'undefined') return 'en-US';
  return navigator.languages?.[0] || navigator.language || 'en-US';
}

/** Text for a failed upload. 413 / code 40005 names the server's per-file limit instead of the bare "Request entity too large". */
export function uploadErrorMessage(e: unknown, fileSize?: number): string {
  if (e instanceof ApiRequestError && (e.status === 413 || e.code === 40005)) {
    const max = maxUploadBytes();
    const limit = formatUploadLimit(max);
    if (fileSize !== undefined && fileSize > max) return `This file is larger than the limit of ${limit} per file.`;
    if (/pending uploads/i.test(e.message)) return `The server refused this upload because your pending uploads are over its size quota. Send or remove some first.`;
    // under the limit READY gave but still refused: the limit changed since, or a proxy in front (Cloudflare: 100 MB) is lower
    return `This file is larger than this server's upload limit (at most ${limit} per file).`;
  }
  return e instanceof Error ? e.message : 'Upload failed';
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
  const choice = timeFormatPref();
  if (choice === '12') return fmt(locale, 'time12x', { hour: 'numeric', minute: '2-digit', hourCycle: 'h12' }).format(d);
  if (choice === '24') return fmt(locale, 'time24x', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  const h12 = fmt(locale, 'time', { hour: 'numeric', minute: '2-digit' });
  const cycle = h12.resolvedOptions().hourCycle;
  return (cycle === 'h23' || cycle === 'h24' ? fmt(locale, 'time24', { hour: '2-digit', minute: '2-digit' }) : h12).format(d);
}
/** "Tue, Oct 20, 6:00 PM" / "Tue, Oct 20, 18:00": a short date with the clock, honouring Settings > Language & Time like formatTime. */
export const formatDateTime = (d: Date, locale = chatLocale()): string => {
  const choice = timeFormatPref();
  const hourCycle = choice === '12' ? 'h12' : choice === '24' ? 'h23' : undefined;
  return fmt(locale, `datetime${choice}`, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hourCycle }).format(d);
};
export const formatShortDate = (d: Date, locale = chatLocale()): string => fmt(locale, 'short', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
export const formatFullDate = (d: Date, locale = chatLocale()): string => {
  const choice = timeFormatPref();
  const hourCycle = choice === '12' ? 'h12' : choice === '24' ? 'h23' : undefined;
  return fmt(locale, `long${choice}`, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', hourCycle }).format(d);
};
export const formatDivider = (d: Date, locale = chatLocale()): string => fmt(locale, 'divider', { year: 'numeric', month: 'long', day: 'numeric' }).format(d);

// "Today at 9:24 PM": the day word plus the locale's connector. Unlisted languages fall back to Intl's relative word. An empty word means the
// locale's Discord shows no day word: Swedish today is the bare "12:37" and yesterday was never observed, so it uses the dated form.
const DAY_WORDS: Record<string, { today: string; yesterday: string; at: string }> = {
  en: { today: 'Today', yesterday: 'Yesterday', at: 'at' },
  sv: { today: '', yesterday: '', at: '' },
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

/** Message header time: "Today at 9:24 PM" / bare "21:24" (sv), "Yesterday at …", older "10/09/2026 9:24 PM" / "2026-10-09 21:24" (sv). */
export function formatMessageTimestamp(d: Date, now = new Date(), locale = chatLocale()): string {
  const time = formatTime(d, locale);
  const words = dayWords(locale);
  const withDay = (day: string) => `${day} ${words.at ? `${words.at} ` : ''}${time}`;
  if (sameDay(d, now)) return words.today ? withDay(words.today) : time;
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (words.yesterday && sameDay(d, y)) return withDay(words.yesterday);
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

// Spoiler attachments are a naming convention (the server never interprets it): the file name starts with "SPOILER_".
export const SPOILER_PREFIX = 'SPOILER_';
export const isSpoilerName = (filename: string): boolean => filename.startsWith(SPOILER_PREFIX);
export const stripSpoiler = (filename: string): string => (isSpoilerName(filename) ? filename.slice(SPOILER_PREFIX.length) : filename);
export const withSpoiler = (filename: string, spoiler: boolean): string => (spoiler ? SPOILER_PREFIX + stripSpoiler(filename) : stripSpoiler(filename));

/** The composer's placeholder: "Message @alice" in a 1:1 DM, "Message <group name>" (or its members' names) in a group DM, else "Message #general" (voice channels without the #). */
export function composerPlaceholder(channel: Channel | undefined, nameOf: (user: User) => string): string {
  if (!channel) return 'Message ';
  const recipients = channel.recipients ?? [];
  if (channel.type === ChannelType.DM) return `Message @${recipients[0] ? nameOf(recipients[0]) : ''}`;
  if (channel.type === ChannelType.GroupDM) return `Message ${channel.name || recipients.map(u => nameOf(u)).join(', ')}`;
  return `Message ${channel.type === ChannelType.GuildVoice ? channel.name ?? '' : `#${channel.name ?? ''}`}`;
}
