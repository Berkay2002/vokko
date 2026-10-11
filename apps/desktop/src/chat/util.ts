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

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const shortDateFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' });
const longFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const dividerFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

export const formatTime = (d: Date): string => timeFmt.format(d);
export const formatFullDate = (d: Date): string => longFmt.format(d);
export const formatDivider = (d: Date): string => dividerFmt.format(d);

/** Header time: "3:42 PM" today (the reference shows no "Today at"), "Yesterday at 3:42 PM", "10/09/2026 3:42 PM". */
export function formatMessageTimestamp(d: Date, now = new Date()): string {
  if (sameDay(d, now)) return formatTime(d);
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (sameDay(d, y)) return `Yesterday at ${formatTime(d)}`;
  return `${shortDateFmt.format(d)} ${formatTime(d)}`;
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
