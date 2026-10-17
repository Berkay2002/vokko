import { appIconSrc } from "../api/appIcons";
import type { Activity, Presence } from "../api/types";

/** The activity to show for a presence: the first "Playing" one. */
export function playingActivity(presence: Pick<Presence, "activities"> | undefined | null): Activity | null {
  return presence?.activities?.find(activity => activity.type === 0) ?? null;
}

/** "Using" for an app (the sender set `app`), "Playing" for a game and for senders that predate the flag. */
export function playingVerb(activity: Activity): string {
  return activity.app === true ? "Using" : "Playing";
}

/** "Playing Factorio" or "Using Google Chrome". */
export function playingLabel(activity: Activity): string {
  return `${playingVerb(activity)} ${activity.name}`;
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

/** The server counts Unicode code points (not UTF-16 units) and closes the connection (4002) on control or invisible characters. */
const MAX_TEXT = 128;
const UNSHOWN_CHARS = /[\p{Cc}­͏؜ᅟᅠ᠎​-‏‪-‮⁠-⁩ㅤ﻿ﾠ]/gu;

/** A name or title the server accepts: no control or zero-width/bidi characters, at most 128 code points (never splitting a surrogate pair). */
export function cleanName(name: string): string {
  return Array.from(name.replace(UNSHOWN_CHARS, "").trim()).slice(0, MAX_TEXT).join("").trim();
}

/** The "Listening to Spotify" activity (type 2) of a presence. */
export function listeningActivity(presence: Pick<Presence, "activities"> | undefined | null): Activity | null {
  return presence?.activities?.find(activity => activity.type === 2) ?? null;
}

/** What lists show for a presence: the game, else Spotify. */
export function shownActivity(presence: Pick<Presence, "activities"> | undefined | null): Activity | null {
  return playingActivity(presence) ?? listeningActivity(presence);
}

/** "Playing Factorio", "Using Google Chrome" or "Listening to Spotify". */
export function activityLabel(activity: Activity): string {
  return activity.type === 2 ? "Listening to Spotify" : playingLabel(activity);
}

const APP_IMAGE = /^app:([0-9a-f]{64})$/;

/** The icon of a Playing activity's app, built from the validated hash only (never a URL taken from the activity); null without one. */
export function appIconUrl(activity: Activity): string | null {
  const hash = activity.type === 0 ? APP_IMAGE.exec(activity.assets?.large_image ?? "")?.[1] : undefined;
  return hash ? appIconSrc(hash) : null;
}

const IMAGE_ID = /^spotify:([0-9a-f]{40})$/;
const TRACK_ID = /^[A-Za-z0-9]{22}$/;

/** The album art URL, built from the validated image id only (never a URL taken from the activity); null without art. */
export function spotifyImageUrl(activity: Activity): string | null {
  const id = IMAGE_ID.exec(activity.assets?.large_image ?? "")?.[1];
  return id ? `https://i.scdn.co/image/${id}` : null;
}

/** Where "Play on Spotify" goes: the track when its id is known, else a Spotify search for title and artists. */
export function spotifyOpenUrl(activity: Activity): string {
  const id = activity.sync_id;
  if (id && TRACK_ID.test(id)) return `https://open.spotify.com/track/${id}`;
  return `https://open.spotify.com/search/${encodeURIComponent([activity.details, activity.state].filter(Boolean).join(" "))}`;
}

/** "3:05" for a track position or length in ms. */
export function formatTrackTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
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
