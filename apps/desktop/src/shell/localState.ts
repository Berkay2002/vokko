import { useEffect, useReducer } from "react";
import { create } from "zustand";
import type { Snowflake } from "../api/types";
import { chatLocale, formatTime } from "../chat/util";

/**
 * Notification/visibility choices (channel/server mute, notification level, suppress flags, Hide Muted Channels). The account's
 * copy is the server's user guild settings (notify/guildSettingsSync.ts keeps both in step); this is the local cache, persisted in
 * localStorage under `vokko.local`. Ids are guild, category, channel or DM snowflakes (old builds also kept thread ids here).
 */

export type NotifyLevel = "default" | "all" | "unreads-mentions" | "mentions" | "none";

/** -1 means "until I turn it back on". */
export const FOREVER = -1;

export const MUTE_DURATIONS: { id: string; label: string; ms: number }[] = [
  { id: "15m", label: "For 15 Minutes", ms: 15 * 60_000 },
  { id: "1h", label: "For 1 Hour", ms: 60 * 60_000 },
  { id: "3h", label: "For 3 Hours", ms: 3 * 60 * 60_000 },
  { id: "8h", label: "For 8 Hours", ms: 8 * 60 * 60_000 },
  { id: "24h", label: "For 24 Hours", ms: 24 * 60 * 60_000 },
  { id: "forever", label: "Until I turn it back on", ms: FOREVER },
];

export const NOTIFY_LABELS: Record<Exclude<NotifyLevel, "default">, string> = {
  all: "All Messages",
  "unreads-mentions": "@Mentions + Unreads",
  mentions: "Only @mentions",
  none: "Nothing",
};

export interface LocalState {
  /** Expiry timestamp in ms, or -1 for forever. */
  mutedUntil: Record<Snowflake, number>;
  notify: Record<Snowflake, NotifyLevel>;
  hideMuted: Record<Snowflake, boolean>;
  suppressEveryone: Record<Snowflake, boolean>;
  suppressRoles: Record<Snowflake, boolean>;
}

const KEY = "vokko.local";
const EMPTY: LocalState = { mutedUntil: {}, notify: {}, hideMuted: {}, suppressEveryone: {}, suppressRoles: {} };

function load(): LocalState {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<LocalState> | null;
    return { ...EMPTY, ...(parsed ?? {}) };
  } catch {
    return { ...EMPTY };
  }
}

export const useLocalState = create<LocalState>()(() => load());

useLocalState.subscribe(state => {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable: choices last for this session */
  }
});

export const isMutedAt = (state: Pick<LocalState, "mutedUntil">, id: Snowflake, now = Date.now()): boolean => {
  const until = state.mutedUntil[id];
  return until === FOREVER || (until !== undefined && until > now);
};

/** guildUnread's `isMuted`: the channel/category mute test at `now`. */
export const mutedTest =
  (state: Pick<LocalState, "mutedUntil">, now = Date.now()) =>
  (id: Snowflake): boolean =>
    isMutedAt(state, id, now);

/** The mute map; also re-renders when a timed mute lapses. */
export function useMutedUntil(): Record<Snowflake, number> {
  const mutedUntil = useLocalState(s => s.mutedUntil);
  useMuteLapse(Object.values(mutedUntil));
  return mutedUntil;
}

/** Ms until the soonest timed mute among `untils` lapses (a little late, so the check sees it expired); null when none is pending. */
export function msUntilLapse(untils: readonly (number | undefined)[], now: number): number | null {
  const pending = untils.filter((u): u is number => u !== undefined && u !== FOREVER && u > now);
  return pending.length === 0 ? null : Math.min(Math.min(...pending) - now + 50, 2 ** 31 - 1);
}

/** Re-renders once the soonest of `untils` lapses, so a timed mute stops showing as muted without another update. Returns a count that grows per lapse, for memo deps. */
export function useMuteLapse(untils: readonly (number | undefined)[]): number {
  const [lapses, bump] = useReducer((n: number) => n + 1, 0);
  const delay = msUntilLapse(untils, Date.now());
  const next = delay === null ? null : Date.now() + delay;
  useEffect(() => {
    if (next === null) return;
    const timer = setTimeout(bump, Math.max(next - Date.now(), 0));
    return () => clearTimeout(timer);
  }, [next]);
  return lapses;
}

export const useIsMuted = (id: Snowflake | null | undefined): boolean => {
  useMuteLapse([id ? useLocalState.getState().mutedUntil[id] : undefined]);
  return useLocalState(s => (id ? isMutedAt(s, id) : false));
};
export const useNotifyLevel = (id: Snowflake): NotifyLevel => useLocalState(s => s.notify[id] ?? "default");

export function muteFor(id: Snowflake, ms: number): void {
  useLocalState.setState(s => ({ mutedUntil: { ...s.mutedUntil, [id]: ms === FOREVER ? FOREVER : Date.now() + ms } }));
}

export function unmute(id: Snowflake): void {
  useLocalState.setState(s => {
    const { [id]: _removed, ...rest } = s.mutedUntil;
    return { mutedUntil: rest };
  });
}

export function setNotifyLevel(id: Snowflake, level: NotifyLevel): void {
  useLocalState.setState(s => ({ notify: { ...s.notify, [id]: level } }));
}

type FlagKey = "hideMuted" | "suppressEveryone" | "suppressRoles";

export function toggleFlag(key: FlagKey, id: Snowflake): void {
  useLocalState.setState(s => ({ [key]: { ...s[key], [id]: !s[key][id] } }) as Partial<LocalState>);
}

/** "Muted until 14:05" style text for the unmute item, null when not muted or muted forever. */
export function mutedUntilText(id: Snowflake): string | null {
  const until = useLocalState.getState().mutedUntil[id];
  if (until === undefined || until === FOREVER || until <= Date.now()) return null;
  return untilLabel(until);
}

/** "Until 14:05" today; "Until Oct 13, 09:00" on another day, with the year when it is not this one. */
export function untilLabel(until: number, now = Date.now(), locale = chatLocale()): string {
  const end = new Date(until);
  const time = formatTime(end, locale); // follows the 12/24-hour preference like message timestamps
  if (end.toDateString() === new Date(now).toDateString()) return `Until ${time}`;
  const sameYear = end.getFullYear() === new Date(now).getFullYear();
  const date = end.toLocaleDateString(locale, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
  return `Until ${date}, ${time}`;
}
