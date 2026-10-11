// Pure soundboard helpers: volumes, trimming, WAV encoding and probing, file checks and the popout's sections.

import { SOUNDBOARD_MAX_BYTES, SOUNDBOARD_MAX_DURATION_MS, type SoundboardSound } from "../api/types";

export const MAX_SECONDS = SOUNDBOARD_MAX_DURATION_MS / 1000;
/** Rate trimmed uploads are re-encoded at: 5.2 s of 16-bit mono stays far below 512 KiB. */
export const UPLOAD_RATE = 22050;

// ---- volume ----

const clamp = (value: number, min: number, max: number): number => (Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min);

/** The clip's playback volume: the sound's own volume (0..1) times the "Soundboard volume" setting (0..100 %). */
export function effectiveVolume(soundVolume: number, boardPercent: number): number {
  return clamp(soundVolume, 0, 1) * (clamp(boardPercent, 0, 100) / 100);
}

/** Volume slider (0..100) ↔ the API's 0..1, rounded to 2 decimals. */
export const percentToVolume = (percent: number): number => Math.round(clamp(percent, 0, 100)) / 100;
export const volumeToPercent = (volume: number): number => Math.round(clamp(volume, 0, 1) * 100);

// ---- files ----

const AUDIO_TYPES = new Set(["audio/mpeg", "audio/mp3", "audio/ogg", "audio/opus", "audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"]);
const AUDIO_EXTENSIONS = /\.(mp3|ogg|oga|opus|wav)$/i;

/** MP3, OGG or WAV, by type or (when the browser gives no type) by extension. */
export function isAcceptedAudio(file: { type: string; name: string }): boolean {
  return file.type ? AUDIO_TYPES.has(file.type.toLowerCase()) : AUDIO_EXTENSIONS.test(file.name);
}

export function validateSoundName(name: string): string | null {
  const length = [...name.trim()].length;
  return length < 2 || length > 32 ? "Name must be between 2 and 32 characters." : null;
}

// ---- trimming ----

export interface Trim {
  /** Seconds into the file. */
  start: number;
  end: number;
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/** The first 5.2 s (or the whole clip when shorter). */
export const initialTrim = (duration: number): Trim => ({ start: 0, end: round3(Math.min(Math.max(duration, 0), MAX_SECONDS)) });

/**
 * Keeps a trim inside the clip and at most `max` long. `moved` says which handle the user dragged: the other one follows
 * when the window would get too long, so the dragged handle stays where it was put.
 */
export function clampTrim(trim: Trim, duration: number, moved: "start" | "end" = "end", max = MAX_SECONDS): Trim {
  const total = Math.max(duration, 0);
  let start = clamp(trim.start, 0, total);
  let end = clamp(trim.end, 0, total);
  if (end < start) [start, end] = moved === "start" ? [start, start] : [end, end];
  if (end - start > max) {
    if (moved === "start") end = start + max;
    else start = end - max;
  }
  return { start: round3(start), end: round3(end) };
}

/** Whether the picked file can go up as is, or must be cut / re-encoded first. */
export function needsReencode(file: { type: string; name: string; size: number }, duration: number, trim: Trim): boolean {
  const whole = trim.start <= 0.001 && trim.end >= duration - 0.001;
  return !isAcceptedAudio(file) || file.size > SOUNDBOARD_MAX_BYTES || duration > MAX_SECONDS || !whole;
}

// ---- WAV ----

/**
 * 16-bit PCM mono WAV of `channels` (downmixed) between `start` and `end` seconds, resampled linearly to `targetRate` (never
 * up). This is what a trimmed upload sends: the server measures exactly `end - start` seconds.
 */
export function encodeWav(channels: Float32Array[], sampleRate: number, start: number, end: number, targetRate = UPLOAD_RATE): Uint8Array {
  const length = channels[0]?.length ?? 0;
  const from = Math.max(0, Math.min(length, Math.floor(start * sampleRate)));
  const to = Math.max(from, Math.min(length, Math.floor(end * sampleRate)));
  const rate = Math.min(targetRate, sampleRate);
  const step = sampleRate / rate;
  const count = Math.floor(((to - from) * rate) / sampleRate + 1e-9);
  const mono = (index: number): number => {
    let sum = 0;
    for (const channel of channels) sum += channel[index] ?? 0;
    return channels.length ? sum / channels.length : 0;
  };
  const out = new Uint8Array(44 + count * 2);
  const view = new DataView(out.buffer);
  const text = (at: number, value: string) => [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + count * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i += 1) {
    const position = from + i * step;
    const left = Math.floor(position);
    const fraction = position - left;
    const value = mono(left) * (1 - fraction) + mono(Math.min(left + 1, to - 1)) * fraction;
    view.setInt16(44 + i * 2, Math.round(clamp(value, -1, 1) * 32767), true);
  }
  return out;
}

/** Bytes 2..16 of the KSDATAFORMAT_SUBTYPE_PCM / _IEEE_FLOAT GUIDs (bytes 0..2 hold the format tag). */
const SUBFORMAT_TAIL = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];

/** Duration of a RIFF/WAVE file in ms from its `fmt ` and `data` chunks (rounded up), null when it is not one. */
export function wavDurationMs(bytes: Uint8Array): number | null {
  if (bytes.length < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let byteRate = 0;
  let data = -1;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const size = view.getUint32(at + 4, true);
    if (tag(at) === "fmt ") {
      // Decoders disagree on which of two fmt or data chunks counts, so a second one is refused (as on the server).
      if (byteRate > 0) return null;
      // Decoders play at sample rate x block align and ignore the advisory byte-rate field, so it must agree, and block align
      // must match channels x bytes per sample for every format.
      if (at + 24 > bytes.length) return null;
      const format = view.getUint16(at + 8, true);
      if (format !== 1 && format !== 3 && format !== 0xfffe) return null;
      // Extensible: the real format is the SubFormat GUID, which must be PCM or IEEE float like the plain tags.
      if (format === 0xfffe) {
        if (size < 40 || at + 48 > bytes.length || view.getUint16(at + 24, true) < 22) return null;
        const subFormat = view.getUint16(at + 32, true);
        if ((subFormat !== 1 && subFormat !== 3) || SUBFORMAT_TAIL.some((b, i) => bytes[at + 34 + i] !== b)) return null;
      }
      const channels = view.getUint16(at + 10, true);
      const sampleRate = view.getUint32(at + 12, true);
      const blockAlign = view.getUint16(at + 20, true);
      const bits = view.getUint16(at + 22, true);
      if (channels === 0 || bits === 0 || blockAlign !== channels * Math.ceil(bits / 8)) return null;
      byteRate = sampleRate * blockAlign;
      if (byteRate === 0 || view.getUint32(at + 16, true) !== byteRate) return null;
    }
    if (tag(at) === "data") {
      if (data >= 0) return null;
      data = Math.min(size, bytes.length - at - 8);
    }
    at += 8 + size + (size & 1);
  }
  return byteRate > 0 && data > 0 ? Math.ceil((data * 1000) / byteRate) : null;
}

export const formatSeconds = (seconds: number): string => `${(Math.round(seconds * 10) / 10).toFixed(1)}s`;

// ---- popout sections ----

/** Stable key of a sound across guilds (default sounds share small ids). */
export const soundKey = (sound: Pick<SoundboardSound, "sound_id" | "guild_id">): string => `${sound.guild_id ?? "default"}:${sound.sound_id}`;

export const matchesQuery = (sound: Pick<SoundboardSound, "name" | "emoji_name">, query: string): boolean => {
  const q = query.trim().toLowerCase();
  return q === "" || sound.name.toLowerCase().includes(q) || (sound.emoji_name ?? "") === q;
};

export interface SoundSection {
  id: string;
  title: string;
  /** null for favourites and default sounds. */
  guildId: string | null;
  sounds: SoundboardSound[];
}

export interface SectionInput {
  query: string;
  favorites: string[];
  /** The guild of the voice channel you are in: its section comes first. */
  currentGuildId: string | null;
  guildOrder: string[];
  guildNames: Record<string, string>;
  guildSounds: Record<string, SoundboardSound[]>;
  defaults: SoundboardSound[];
}

/** Favourites, the current server, every other server (in rail order), then the default sounds; empty sections are dropped. */
export function buildSections(input: SectionInput): SoundSection[] {
  const filter = (list: SoundboardSound[]) => list.filter(sound => matchesQuery(sound, input.query));
  const everything = [...input.defaults, ...input.guildOrder.flatMap(id => input.guildSounds[id] ?? [])];
  const byKey = new Map(everything.map(sound => [soundKey(sound), sound]));
  const favorites = input.favorites.map(key => byKey.get(key)).filter((sound): sound is SoundboardSound => !!sound);
  const order = input.currentGuildId ? [input.currentGuildId, ...input.guildOrder.filter(id => id !== input.currentGuildId)] : input.guildOrder;
  const sections: SoundSection[] = [{ id: "favorites", title: "Favorites", guildId: null, sounds: filter(favorites) }];
  for (const id of order) sections.push({ id: `guild:${id}`, title: input.guildNames[id] ?? "Server", guildId: id, sounds: filter(input.guildSounds[id] ?? []) });
  sections.push({ id: "defaults", title: "Default Sounds", guildId: null, sounds: filter(input.defaults) });
  return sections.filter(section => section.sounds.length > 0);
}
