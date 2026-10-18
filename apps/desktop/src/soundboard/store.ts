// Soundboard state: every joined server's sounds, the default sounds, your entrance sounds, local favourites, and the
// effect flashes on speaking rings. Fed by gateway events; plays clips on VOICE_CHANNEL_EFFECT_SEND. "Soundboard volume"
// is the synced `soundboardVolume` pref.

import { create } from "zustand";
import { MOCK } from "../api/config";
import { ApiRequestError, RateLimitedError } from "../api/errors";
import { gateway } from "../api/gateway";
import { request, uploadAttachment } from "../api/rest";
import { appStore } from "../api/store";
import type { CreateSoundboardSoundRequest, EditSoundboardSoundRequest, EntranceSound, EntranceSounds, Snowflake, SoundboardSound, SoundboardSoundList } from "../api/types";
import { getPrefs, setPref } from "../ui/prefs";
import { voiceStore } from "../voice/store";
import { effectiveVolume, soundKey } from "./helpers";
import { playEffect, playLog, playPreview } from "./playback";

const KEY = "vokko.soundboard";
/** How long the emoji flashes on the sender's tile. */
export const FLASH_MS = 2500;

export interface SoundEffect {
  emoji: string | null;
  /** Changes on every play, so the same emoji twice restarts the animation. */
  serial: number;
  entrance: boolean;
}

export interface SoundboardState {
  /** guild id → its sounds, oldest first. */
  guildSounds: Record<Snowflake, SoundboardSound[]>;
  /** null = not loaded yet. */
  defaults: SoundboardSound[] | null;
  entrance: EntranceSound[] | null;
  /** `soundKey`s, most recent first. */
  favorites: string[];
  /** user id → the effect flashing on their tile. */
  effects: Record<Snowflake, SoundEffect>;
}

interface Persisted {
  favorites: string[];
}

function load(): Persisted {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Persisted> & { volume?: unknown };
    const favorites = Array.isArray(raw.favorites) ? raw.favorites.filter((k): k is string => typeof k === "string").slice(0, 200) : [];
    // the volume used to live here: move it to the pref once, then drop it
    if ("volume" in raw) {
      if (typeof raw.volume === "number" && raw.volume >= 0 && raw.volume <= 100 && getPrefs().soundboardVolume === 100) setPref("soundboardVolume", raw.volume);
      save({ favorites });
    }
    return { favorites };
  } catch {
    return { favorites: [] };
  }
}

function save(state: Persisted): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ favorites: state.favorites }));
  } catch {
    /* storage unavailable: the setting still applies for this session */
  }
}

export const useSoundboard = create<SoundboardState>()(() => ({ guildSounds: {}, defaults: null, entrance: null, effects: {}, ...load() }));
const set = useSoundboard.setState;
const get = useSoundboard.getState;

const errorText = (e: unknown, fallback: string): string => (e instanceof ApiRequestError || e instanceof Error ? e.message : fallback);

// ---- local settings ----

export function setSoundboardVolume(volume: number): void {
  setPref("soundboardVolume", Math.min(100, Math.max(0, Math.round(volume))));
}

export function toggleFavorite(sound: SoundboardSound): void {
  const key = soundKey(sound);
  const favorites = get().favorites.includes(key) ? get().favorites.filter(k => k !== key) : [key, ...get().favorites];
  set({ favorites });
  save(get());
}

// ---- loading ----

export async function loadDefaults(): Promise<void> {
  try {
    set({ defaults: await request<SoundboardSound[]>("GET", "/soundboard-default-sounds") });
  } catch {
    set(s => ({ defaults: s.defaults ?? [] }));
  }
}

export async function loadEntrance(): Promise<void> {
  try {
    set({ entrance: (await request<EntranceSounds>("GET", "/users/@me/entrance-sounds")).entrance_sounds });
  } catch {
    set(s => ({ entrance: s.entrance ?? [] }));
  }
}

export async function refreshGuildSounds(guildId: Snowflake): Promise<void> {
  try {
    const { items } = await request<SoundboardSoundList>("GET", `/guilds/${guildId}/soundboard-sounds`);
    set(s => ({ guildSounds: { ...s.guildSounds, [guildId]: items } }));
  } catch {
    /* keep what the gateway gave us */
  }
}

function upsert(sound: SoundboardSound): void {
  const guildId = sound.guild_id;
  if (!guildId) return;
  set(s => {
    const list = s.guildSounds[guildId] ?? [];
    const next = list.some(x => x.sound_id === sound.sound_id) ? list.map(x => (x.sound_id === sound.sound_id ? sound : x)) : [...list, sound];
    return { guildSounds: { ...s.guildSounds, [guildId]: next } };
  });
}

function drop(guildId: Snowflake, soundId: Snowflake): void {
  set(s => ({ guildSounds: { ...s.guildSounds, [guildId]: (s.guildSounds[guildId] ?? []).filter(x => x.sound_id !== soundId) } }));
}

// ---- playing ----

/** Plays a sound in the voice channel you are in (everyone there hears it via VOICE_CHANNEL_EFFECT_SEND). Resolves to an error text, or null. */
export async function sendSound(sound: SoundboardSound): Promise<string | null> {
  const channelId = voiceStore.getState().channelId;
  if (!channelId) return "Join a voice channel to play sounds.";
  try {
    await request<null>("POST", `/channels/${channelId}/send-soundboard-sound`, sound.guild_id ? { sound_id: sound.sound_id, source_guild_id: sound.guild_id } : { sound_id: sound.sound_id });
    return null;
  } catch (e) {
    return e instanceof RateLimitedError ? "Slow down! You can play a sound every 3 seconds." : errorText(e, "Could not play that sound.");
  }
}

/** Hover / button preview: only you hear it, at the same volume the channel would. */
export const previewSound = (sound: SoundboardSound): void => playPreview(sound.url, effectiveVolume(sound.volume, getPrefs().soundboardVolume));

let serial = 0;
function flash(userId: Snowflake, emoji: string | null, entrance: boolean): void {
  serial += 1;
  const mine = serial;
  set(s => ({ effects: { ...s.effects, [userId]: { emoji, serial: mine, entrance } } }));
  setTimeout(() => {
    if (get().effects[userId]?.serial !== mine) return;
    set(s => {
      const { [userId]: _done, ...rest } = s.effects;
      void _done;
      return { effects: rest };
    });
  }, FLASH_MS);
}

/** The effect flashing on a user's tile, if any. */
export const useSoundEffect = (userId: Snowflake): SoundEffect | undefined => useSoundboard(s => s.effects[userId]);

// ---- managing guild sounds ----

export async function createSound(guildId: Snowflake, uploadChannelId: Snowflake, file: File, fields: Omit<CreateSoundboardSoundRequest, "attachment_id">): Promise<SoundboardSound> {
  const attachment = await uploadAttachment(uploadChannelId, file);
  const sound = await request<SoundboardSound>("POST", `/guilds/${guildId}/soundboard-sounds`, { ...fields, attachment_id: attachment.id });
  upsert(sound);
  return sound;
}

export async function editSound(guildId: Snowflake, soundId: Snowflake, body: EditSoundboardSoundRequest): Promise<SoundboardSound> {
  const sound = await request<SoundboardSound>("PATCH", `/guilds/${guildId}/soundboard-sounds/${soundId}`, body);
  upsert(sound);
  return sound;
}

export async function deleteSound(guildId: Snowflake, soundId: Snowflake): Promise<void> {
  await request<null>("DELETE", `/guilds/${guildId}/soundboard-sounds/${soundId}`);
  drop(guildId, soundId);
}

// ---- entrance sounds ----

/** Sets (sound) or clears (null) the entrance sound of a server, or the global one with `guildId` null. Resolves to an error text, or null. */
export async function setEntranceSound(guildId: Snowflake | null, sound: SoundboardSound | null): Promise<string | null> {
  try {
    const body = { guild_id: guildId, sound_id: sound?.sound_id ?? null, source_guild_id: sound?.guild_id ?? null };
    set({ entrance: (await request<EntranceSounds>("PUT", "/users/@me/entrance-sounds", body)).entrance_sounds });
    return null;
  } catch (e) {
    return errorText(e, "Could not set the entrance sound.");
  }
}

/** The sound object an entrance entry points at (null when it no longer exists or is not loaded). */
export function findSound(state: Pick<SoundboardState, "defaults" | "guildSounds">, soundId: Snowflake, sourceGuildId: Snowflake | null): SoundboardSound | null {
  const list = sourceGuildId ? state.guildSounds[sourceGuildId] ?? [] : state.defaults ?? [];
  return list.find(sound => sound.sound_id === soundId) ?? null;
}

// ---- gateway wiring (once) ----

let wired = false;
export function wireSoundboard(): void {
  if (wired) return;
  wired = true;
  gateway.on("READY", ready => {
    const guildSounds: Record<Snowflake, SoundboardSound[]> = {};
    for (const guild of ready.guilds) guildSounds[guild.id] = guild.soundboard_sounds ?? [];
    set({ guildSounds, entrance: null, effects: {} });
    void loadDefaults();
    void loadEntrance();
  });
  gateway.on("GUILD_CREATE", guild => set(s => ({ guildSounds: { ...s.guildSounds, [guild.id]: guild.soundboard_sounds ?? [] } })));
  gateway.on("GUILD_DELETE", ({ id }) =>
    set(s => {
      const { [id]: _gone, ...rest } = s.guildSounds;
      void _gone;
      return { guildSounds: rest, entrance: s.entrance?.filter(e => e.guild_id !== id) ?? null };
    }),
  );
  gateway.on("GUILD_SOUNDBOARD_SOUND_CREATE", upsert);
  gateway.on("GUILD_SOUNDBOARD_SOUND_UPDATE", upsert);
  gateway.on("GUILD_SOUNDBOARD_SOUND_DELETE", ({ guild_id, sound_id }) => drop(guild_id, sound_id));
  gateway.on("ENTRANCE_SOUNDS_UPDATE", ({ entrance_sounds }) => set({ entrance: entrance_sounds }));
  gateway.on("VOICE_CHANNEL_EFFECT_SEND", effect => {
    const voice = voiceStore.getState();
    if (voice.channelId !== effect.channel_id) return;
    flash(effect.user_id, effect.emoji?.name ?? null, !!effect.entrance);
    // Deafened: you hear nothing, soundboard included.
    if (!voice.selfDeaf) playEffect(effect.sound_url, effectiveVolume(effect.sound_volume, getPrefs().soundboardVolume));
  });
  if (MOCK && typeof window !== "undefined") (window as unknown as { __vokkoSoundboard: { plays: typeof playLog } }).__vokkoSoundboard = { plays: playLog };
}

/** The guild names in rail order, for section titles. */
export function guildNames(): Record<Snowflake, string> {
  const { guilds } = appStore.getState();
  return Object.fromEntries(Object.values(guilds).map(g => [g.id, g.name]));
}
