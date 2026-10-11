import { create } from "zustand";
import type { Snowflake } from "../api/types";

/**
 * Per-device notification/visibility choices the backend has no field for yet (channel/server mute, notification level,
 * Hide Muted Channels). Persisted in localStorage under `vokko.local`; ids are guild, category or channel snowflakes.
 */

export type NotifyLevel = "default" | "all" | "unreads-mentions" | "mentions" | "none";

/** -1 means "until I turn it back on". */
const FOREVER = -1;

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

interface LocalState {
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

export const isMutedAt = (state: LocalState, id: Snowflake, now = Date.now()): boolean => {
  const until = state.mutedUntil[id];
  return until === FOREVER || (until !== undefined && until > now);
};

export const useIsMuted = (id: Snowflake | null | undefined): boolean => useLocalState(s => (id ? isMutedAt(s, id) : false));
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
  return `Until ${new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}
