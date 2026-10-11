import type { Activity, Presence } from "../api/types";

/** The activity to show for a presence: the first "Playing" one. */
export function playingActivity(presence: Pick<Presence, "activities"> | undefined | null): Activity | null {
  return presence?.activities?.find(activity => activity.type === 0) ?? null;
}

/** "Playing Factorio". */
export function playingLabel(activity: Activity): string {
  return `Playing ${activity.name}`;
}

/** Whole minutes since `start` as a compact string: "<1m", "12m", "1h 05m", "2d 3h". Empty without a start time. */
export function formatPlaytime(start: number | undefined, now: number): string {
  if (!start || !Number.isFinite(start)) return "";
  const minutes = Math.max(0, Math.floor((now - start) / 60_000));
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** "12:03" or "1:02:03" for a live elapsed timer. */
export function formatClock(start: number, now: number): string {
  const total = Math.max(0, Math.floor((now - start) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
