// Slowmode (Channel.rate_limit_per_user): the choices Channel Settings offers, their labels, and the composer's per-channel cooldown.
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Snowflake } from '../api/types';

/** Discord's slowmode choices, in seconds (0 = off). */
export const SLOWMODE_CHOICES = [0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600] as const;

/** "Off", "5s", "1m", "2h": the short label used in the settings select. */
export function slowmodeLabel(seconds: number): string {
  if (seconds <= 0) return 'Off';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

/** "10 seconds", "1 minute", "6 hours": for the composer's tooltip. */
export function slowmodeLong(seconds: number): string {
  const [n, unit] = seconds < 60 ? [seconds, 'second'] : seconds < 3600 ? [Math.round(seconds / 60), 'minute'] : [Math.round(seconds / 3600), 'hour'];
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** Remaining wait as "0:08" / "1:05:00". */
export function formatCooldown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// ponytail: in memory only; after a reload the server's 429 (code 20016) restarts the countdown.
const until = new Map<Snowflake, number>();
const listeners = new Set<() => void>();

/** Starts (or extends) the composer's countdown for a channel. */
export function startCooldown(channelId: Snowflake, ms: number): void {
  const end = Date.now() + ms;
  if ((until.get(channelId) ?? 0) >= end) return;
  until.set(channelId, end);
  listeners.forEach(l => l());
}

export function cooldownLeft(channelId: Snowflake, now = Date.now()): number {
  return Math.max(0, (until.get(channelId) ?? 0) - now);
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** Milliseconds left on the channel's countdown, re-rendering every half second while it runs. */
export function useCooldown(channelId: Snowflake): number {
  const end = useSyncExternalStore(subscribe, () => until.get(channelId) ?? 0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (end <= Date.now()) return;
    const tick = () => { setNow(Date.now()); if (Date.now() >= end) clearInterval(timer); };
    const first = setTimeout(tick, 0); // a countdown started after mount reads the clock now, not at the next tick
    const timer = setInterval(tick, 500);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [end]);
  return Math.max(0, end - now);
}
