// Audio and subtitle languages of a Stremio session (docs/design/stremio-bot.md, docs/api.md "Stremio"). The audio track and a
// burned-in picture subtitle are shared and live in the session state. Text subtitles are each viewer's own: embedded ones arrive
// as cues the bot publishes as data in the media room (topic `subs:<stream id>`), addon ones are fetched from the server by an
// opaque id. Cues are plain text; the overlay renders them as React text, never HTML.

import { create } from "zustand";
import { request } from "../api/rest";
import type { Snowflake, StremioAddonSubtitles, StremioCue, StremioCues, StremioState } from "../api/types";

export const subtitleTopic = (trackId: number): string => `subs:${trackId}`;

// ---- cues from the media room ----

const MAX_CUE_CHARS = 300;
const MAX_CUE_MS = 30_000;
const MAX_MEDIA_MS = 48 * 3_600_000;

/** A cue from a data packet, or null when it is not a well formed one. The bot is trusted to send plain text, but the text still ends up on everyone's screen. */
export function parseCue(payload: Uint8Array): StremioCue | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return null;
  }
  const { start_ms: start, end_ms: end, text } = (value ?? {}) as Record<string, unknown>;
  if (typeof text !== "string" || typeof start !== "number" || typeof end !== "number") return null;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > MAX_MEDIA_MS || end <= start) return null;
  const clean = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "").slice(0, MAX_CUE_CHARS);
  return clean.trim() ? { start_ms: start, end_ms: Math.min(end, start + MAX_CUE_MS), text: clean } : null;
}

type CueListener = (topic: string, cue: StremioCue) => void;
const listeners = new Map<string, Set<CueListener>>();

/** Listens to the cues of one session (keyed by the bot's identity). Returns the unsubscribe. */
export function onCues(bot: string, listener: CueListener): () => void {
  const set = listeners.get(bot) ?? new Set();
  set.add(listener);
  listeners.set(bot, set);
  return () => {
    set.delete(listener);
    if (set.size === 0 && listeners.get(bot) === set) listeners.delete(bot);
  };
}

/** The viewer Room calls this for every data packet the bot sends; anything else is ignored. */
export function receiveCue(bot: string, topic: string | undefined, payload: Uint8Array): void {
  if (!topic?.startsWith("subs:")) return;
  const cue = parseCue(payload);
  if (cue) listeners.get(bot)?.forEach(listener => listener(topic, cue));
}

/** The cue to show at `positionMs`: the last one that has started and not ended. */
export function activeCue(cues: readonly StremioCue[], positionMs: number): StremioCue | undefined {
  let found: StremioCue | undefined;
  for (const cue of cues) if (cue.start_ms <= positionMs && positionMs < cue.end_ms && (!found || cue.start_ms >= found.start_ms)) found = cue;
  return found;
}

/** Keeps the list short while a long film plays: cues that ended long ago are not needed again unless the viewer seeks back. */
export function addCue(cues: readonly StremioCue[], cue: StremioCue, max = 1500): StremioCue[] {
  if (cues.some(c => c.start_ms === cue.start_ms && c.end_ms === cue.end_ms && c.text === cue.text)) return cues as StremioCue[];
  const next = [...cues, cue];
  return next.length > max ? next.slice(next.length - max) : next;
}

// ---- addon subtitles (the server fetches the file) ----

export const listAddonSubtitles = (channelId: Snowflake) => request<StremioAddonSubtitles>("GET", `/channels/${channelId}/stremio/subtitles`);
export const getAddonCues = (channelId: Snowflake, sid: string) => request<StremioCues>("GET", `/channels/${channelId}/stremio/subtitles/${encodeURIComponent(sid)}`);

// ---- language names ----

/** ISO 639-2/B codes that files use for some languages, mapped to the 639-3 codes Intl knows. */
const BIBLIOGRAPHIC: Record<string, string> = {
  alb: "sqi", arm: "hye", baq: "eus", bur: "mya", chi: "zho", cze: "ces", dut: "nld", fre: "fra", geo: "kat", ger: "deu", gre: "ell", ice: "isl",
  mac: "mkd", mao: "mri", may: "msa", per: "fas", rum: "ron", slo: "slk", tib: "bod", wel: "cym",
};
let names: Intl.DisplayNames | null | undefined;

/** "English" for "eng", "Swedish (Sweden)" for "sv-se"; the code itself when the browser does not know it, "Unknown" with none. */
export function languageName(code: string | undefined): string {
  if (!code) return "Unknown";
  if (names === undefined) {
    try {
      names = new Intl.DisplayNames(["en"], { type: "language" });
    } catch {
      names = null;
    }
  }
  const [base = code, ...rest] = code.split("-");
  const tag = [BIBLIOGRAPHIC[base] ?? base, ...rest.map((part, i) => (i === 0 && part.length === 2 ? part.toUpperCase() : part))].join("-");
  try {
    const name = names?.of(tag);
    if (name && name !== tag) return name;
  } catch {
    /* not a language tag */
  }
  return code.toUpperCase();
}

/** "English", "English · Commentary": what a track is called in the menu. */
export const trackName = (track: { language?: string; title?: string }): string => [languageName(track.language), track.title].filter(Boolean).join(" · ");

// ---- this viewer's choice ----

/** The viewer's own text subtitle: one of the file's text tracks, or an addon's file. `lang` is remembered for the next film. */
export type TextPick = { kind: "text"; id: number; lang?: string } | { kind: "addon"; sid: string; lang?: string };

const LANG_KEY = "vokko.stremio.subtitleLang";

export function readLang(): string | null {
  try {
    return localStorage.getItem(LANG_KEY);
  } catch {
    return null;
  }
}

export function writeLang(lang: string | null | undefined): void {
  try {
    if (lang) localStorage.setItem(LANG_KEY, lang);
    else localStorage.removeItem(LANG_KEY);
  } catch {
    /* not saved */
  }
}

/** Which film the pick belongs to: a new item starts without one. */
export const itemKey = (state: Pick<StremioState, "item" | "started_by">): string => `${state.item.title}|${state.item.subtitle ?? ""}|${state.item.label}`;

interface PickStore {
  /** Per channel. */
  picks: Record<Snowflake, { item: string; pick: TextPick | null; auto: boolean } | undefined>;
  set(channelId: Snowflake, item: string, pick: TextPick | null, auto?: boolean): void;
}

export const useSubtitleStore = create<PickStore>()(set => ({
  picks: {},
  set: (channelId, item, pick, auto = true) => set(s => ({ picks: { ...s.picks, [channelId]: { item, pick, auto } } })),
}));

/** The viewer's pick for the item that is playing now. */
export function pickOf(store: PickStore, channelId: Snowflake, state: StremioState): TextPick | null {
  const entry = store.picks[channelId];
  return entry && entry.item === itemKey(state) ? entry.pick : null;
}

/** The text track in the file that matches the language the viewer used last time, if any. */
export function preferredTrack(state: Pick<StremioState, "subtitle_tracks">, lang: string | null): number | undefined {
  if (!lang) return undefined;
  return state.subtitle_tracks?.find(t => t.kind === "text" && t.language === lang)?.id;
}
