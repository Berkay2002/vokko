// Mock of docs/api.md "Soundboard and entrance sounds": default and guild sounds, playing into a voice channel (with the
// per-channel play limit), entrance sounds on join, and the same gateway events as the server. Sounds are synthesized in the
// browser (src/soundboard/synth.ts); nothing is recorded or downloaded.

import { ChannelType, SOUNDBOARD_MAX_BYTES, SOUNDBOARD_MAX_DURATION_MS, SOUNDBOARD_SOUNDS_PER_GUILD, type Attachment, type EntranceSound, type SoundboardSound } from "../types";
import { RateLimitedError } from "../errors";
import { Perm, hasBit } from "../permissions";
import { DEFAULT_SOUNDS, synthWav } from "../../soundboard/synth";
import { isAcceptedAudio, wavDurationMs } from "../../soundboard/helpers";
import { channelPermsOf, guildPermsOf } from "./access";
import { db, nextId, userOf, type MockChannel } from "./db";
import { fail, guildAudience, MISSING_PERMISSIONS, pendingAttachment, requireChannel, requireGuildMember } from "./ops";
import { ID, route, str } from "./router";
import { emit } from "./socket";
import { voiceJoinListeners, voiceStates } from "./voice";

export const PLAY_INTERVAL_MS = 3000;

const invalid = (field: string, message: string): never => fail(400, 50035, "Invalid Form Body", { [field]: { code: "INVALID", message } });
const unknownSound = (): never => fail(404, 10097, "Unknown Sound");

/** An object URL for synthesized audio (a placeholder string where Blob URLs do not exist, e.g. some test runners). */
function audioUrl(bytes: Uint8Array): string {
  try {
    return URL.createObjectURL(new Blob([bytes as BlobPart], { type: "audio/wav" }));
  } catch {
    return `mock://sound/${nextId()}`;
  }
}

let defaults: SoundboardSound[] | null = null;
export function defaultSounds(): SoundboardSound[] {
  defaults ??= DEFAULT_SOUNDS.map(meta => ({
    sound_id: meta.id,
    name: meta.name,
    volume: meta.volume,
    emoji_id: null,
    emoji_name: meta.emoji,
    available: true,
    url: audioUrl(synthWav(meta.id) ?? new Uint8Array()),
  }));
  return defaults;
}

/** user id → entrance sounds (one per scope). */
export const entranceSounds = new Map<string, EntranceSound[]>();
/** Durations of uploaded audio the mock could measure (WAV), by attachment id; null = unknown format. */
const audioDurations = new Map<string, number | null>();
/** "user:channel" → time of the last play. */
const lastPlay = new Map<string, number>();

export const soundsOf = (guildId: string): SoundboardSound[] => db.soundboard.get(guildId) ?? [];

/** mockUpload hands audio files here so a sound create can check the duration like the server does (from the WAV header). */
export async function noteAudioUpload(attachment: Attachment, file: Blob): Promise<void> {
  if (!attachment.content_type?.startsWith("audio/")) return;
  try {
    audioDurations.set(attachment.id, wavDurationMs(new Uint8Array(await file.arrayBuffer())));
  } catch {
    audioDurations.set(attachment.id, null);
  }
}

/** A guild's seeded sounds (the mock's equivalent of an admin having uploaded a few). */
export function seedGuildSounds(guildId: string, uploaderId: string): void {
  const picks: [string, string, string, number][] = [
    ["5", "Victory", "🏆", 0.7],
    ["3", "Doorbell", "🚪", 0.8],
    ["4", "Robot", "🤖", 0.6],
  ];
  db.soundboard.set(
    guildId,
    picks.map(([recipe, name, emoji, volume]) => ({
      sound_id: nextId(),
      name,
      volume,
      emoji_id: null,
      emoji_name: emoji,
      guild_id: guildId,
      available: true,
      user: userOf(uploaderId),
      url: audioUrl(synthWav(recipe) ?? new Uint8Array()),
    })),
  );
}

function mayManage(guildId: string, viewerId: string, sound: SoundboardSound | null): void {
  const bits = guildPermsOf(guildId, viewerId);
  if (hasBit(bits, Perm.MANAGE_GUILD_EXPRESSIONS)) return;
  if (hasBit(bits, Perm.CREATE_GUILD_EXPRESSIONS) && (!sound || sound.user?.id === viewerId)) return;
  fail(403, 50013, MISSING_PERMISSIONS);
}

function nameOf(raw: unknown): string {
  const name = (str(raw) ?? "").trim();
  if ([...name].length < 2 || [...name].length > 32) invalid("name", "Must be between 2 and 32 in length.");
  return name;
}

function volumeOf(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1) invalid("volume", "Must be between 0 and 1.");
  return raw as number;
}

function emojiOf(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const text = (str(raw) ?? "").trim();
  if (text === "") return null;
  if ([...text].length > 32 || /[\sA-Za-z0-9]/.test(text)) invalid("emoji_name", "Must be a unicode emoji.");
  return text;
}

function findGuildSound(guildId: string, soundId: string | undefined): SoundboardSound {
  return soundsOf(guildId).find(s => s.sound_id === soundId) ?? unknownSound();
}

/** A sound the user may pick: defaults always, guild sounds while a member of that guild. */
function pickable(userId: string, soundId: string, sourceGuildId: string | null): SoundboardSound | null {
  if (!sourceGuildId) return defaultSounds().find(s => s.sound_id === soundId) ?? null;
  if (!db.guilds.get(sourceGuildId)?.members.has(userId)) return null;
  return soundsOf(sourceGuildId).find(s => s.sound_id === soundId) ?? null;
}

function mayPlay(channel: MockChannel, userId: string, sound: SoundboardSound): boolean {
  const bits = channelPermsOf(channel, userId);
  const external = !!sound.guild_id && sound.guild_id !== channel.guild_id;
  return hasBit(bits, Perm.USE_SOUNDBOARD) && hasBit(bits, Perm.SPEAK) && (!external || hasBit(bits, Perm.USE_EXTERNAL_SOUNDS));
}

function sendEffect(channel: MockChannel, userId: string, sound: SoundboardSound, entrance: boolean): void {
  const listeners = [...voiceStates.values()].filter(s => s.channel_id === channel.id).map(s => s.user_id);
  emit(listeners, "VOICE_CHANNEL_EFFECT_SEND", {
    channel_id: channel.id,
    guild_id: channel.guild_id ?? "",
    user_id: userId,
    sound_id: sound.sound_id,
    sound_volume: sound.volume,
    emoji: sound.emoji_id || sound.emoji_name ? { id: sound.emoji_id, name: sound.emoji_name } : null,
    source_guild_id: sound.guild_id ?? null,
    sound_url: sound.url,
    ...(entrance ? { entrance: true as const } : {}),
  });
}

route("GET", "/soundboard-default-sounds", () => defaultSounds());

route("GET", `/guilds/${ID}/soundboard-sounds`, ({ viewer, params }) => {
  const guildId = params[0] ?? "";
  requireGuildMember(guildId, viewer.user.id);
  return { items: soundsOf(guildId) };
});

route("GET", `/guilds/${ID}/soundboard-sounds/${ID}`, ({ viewer, params }) => {
  const guildId = params[0] ?? "";
  requireGuildMember(guildId, viewer.user.id);
  return findGuildSound(guildId, params[1]);
});

route("POST", `/guilds/${ID}/soundboard-sounds`, ({ viewer, params, body }) => {
  const guildId = params[0] ?? "";
  requireGuildMember(guildId, viewer.user.id);
  mayManage(guildId, viewer.user.id, null);
  const name = nameOf(body.name);
  const volume = body.volume === undefined || body.volume === null ? 1 : volumeOf(body.volume);
  if (body.emoji_id !== undefined && body.emoji_id !== null) invalid("emoji_id", "Unknown emoji.");
  const emoji = emojiOf(body.emoji_name);
  if (soundsOf(guildId).length >= SOUNDBOARD_SOUNDS_PER_GUILD) fail(400, 30045, "Maximum number of soundboard sounds reached");
  const attachment = pendingAttachment(str(body.attachment_id), viewer.user.id);
  if (!attachment) return invalid("attachment_id", "Unknown attachment.");
  if (!isAcceptedAudio({ type: attachment.content_type ?? "", name: attachment.filename })) invalid("attachment_id", "A sound must be an MP3, OGG or WAV file.");
  if (attachment.size > SOUNDBOARD_MAX_BYTES) invalid("attachment_id", "A sound can be at most 512 KiB.");
  const duration = audioDurations.get(attachment.id);
  if (duration !== undefined && duration !== null && duration > SOUNDBOARD_MAX_DURATION_MS) invalid("attachment_id", "A sound can be at most 5.2 seconds long.");
  const sound: SoundboardSound = { sound_id: nextId(), name, volume, emoji_id: null, emoji_name: emoji, guild_id: guildId, available: true, user: userOf(viewer.user.id), url: attachment.url };
  db.soundboard.set(guildId, [...soundsOf(guildId), sound]);
  db.pending.delete(attachment.id);
  emit(guildAudience(guildId), "GUILD_SOUNDBOARD_SOUND_CREATE", { ...sound, guild_id: guildId });
  return sound;
});

route("PATCH", `/guilds/${ID}/soundboard-sounds/${ID}`, ({ viewer, params, body }) => {
  const guildId = params[0] ?? "";
  requireGuildMember(guildId, viewer.user.id);
  const sound = findGuildSound(guildId, params[1]);
  mayManage(guildId, viewer.user.id, sound);
  if (body.emoji_id !== undefined && body.emoji_id !== null) invalid("emoji_id", "Unknown emoji.");
  const next: SoundboardSound = {
    ...sound,
    name: "name" in body ? nameOf(body.name) : sound.name,
    volume: "volume" in body ? volumeOf(body.volume) : sound.volume,
    emoji_name: "emoji_name" in body ? emojiOf(body.emoji_name) : sound.emoji_name,
  };
  db.soundboard.set(guildId, soundsOf(guildId).map(s => (s.sound_id === sound.sound_id ? next : s)));
  emit(guildAudience(guildId), "GUILD_SOUNDBOARD_SOUND_UPDATE", { ...next, guild_id: guildId });
  return next;
});

route("DELETE", `/guilds/${ID}/soundboard-sounds/${ID}`, ({ viewer, params }) => {
  const guildId = params[0] ?? "";
  requireGuildMember(guildId, viewer.user.id);
  const sound = findGuildSound(guildId, params[1]);
  mayManage(guildId, viewer.user.id, sound);
  db.soundboard.set(guildId, soundsOf(guildId).filter(s => s.sound_id !== sound.sound_id));
  emit(guildAudience(guildId), "GUILD_SOUNDBOARD_SOUND_DELETE", { sound_id: sound.sound_id, guild_id: guildId });
  return undefined;
});

route("POST", `/channels/${ID}/send-soundboard-sound`, ({ viewer, params, body }) => {
  const userId = viewer.user.id;
  const channel = requireChannel(params[0] ?? "", userId);
  if (channel.type !== ChannelType.GuildVoice || !channel.guild_id) fail(400, 50024, "Cannot execute action on this channel type");
  const state = voiceStates.get(userId);
  if (!state || state.channel_id !== channel.id || state.self_deaf || state.deaf || state.mute || state.suppress) fail(403, 50013, MISSING_PERMISSIONS);
  const soundId = str(body.sound_id) ?? "";
  const explicit = str(body.source_guild_id);
  const source = explicit ?? (defaultSounds().some(s => s.sound_id === soundId) ? null : channel.guild_id);
  const sound = pickable(userId, soundId, source) ?? unknownSound();
  if (!mayPlay(channel, userId, sound)) fail(403, 50013, MISSING_PERMISSIONS);
  const key = `${userId}:${channel.id}`;
  const wait = PLAY_INTERVAL_MS - (Date.now() - (lastPlay.get(key) ?? -Infinity));
  if (wait > 0) throw new RateLimitedError(wait / 1000, false);
  lastPlay.set(key, Date.now());
  sendEffect(channel, userId, sound, false);
  return undefined;
});

function entranceOf(userId: string): EntranceSound[] {
  return (entranceSounds.get(userId) ?? []).filter(e => !e.guild_id || db.guilds.get(e.guild_id)?.members.has(userId));
}

route("GET", "/users/@me/entrance-sounds", ({ viewer }) => ({ entrance_sounds: entranceOf(viewer.user.id) }));

route("PUT", "/users/@me/entrance-sounds", ({ viewer, body }) => {
  const userId = viewer.user.id;
  const scope = str(body.guild_id) ?? null;
  if (scope) requireGuildMember(scope, userId);
  const soundId = str(body.sound_id) ?? null;
  const rest = (entranceSounds.get(userId) ?? []).filter(e => e.guild_id !== scope);
  if (soundId) {
    const source = str(body.source_guild_id) ?? null;
    if (!pickable(userId, soundId, source)) unknownSound();
    rest.push({ guild_id: scope, sound_id: soundId, source_guild_id: source });
  }
  rest.sort((a, b) => (a.guild_id ?? "").localeCompare(b.guild_id ?? ""));
  entranceSounds.set(userId, rest);
  const payload = { entrance_sounds: entranceOf(userId) };
  emit([userId], "ENTRANCE_SOUNDS_UPDATE", payload);
  return payload;
});

/** On a join into a guild voice channel: the guild's entrance sound, else the global one, for everyone in the channel. */
const lastEntrance = new Map<string, number>();
voiceJoinListeners.push((userId, channel) => {
  if (!channel.guild_id) return;
  const list = entranceOf(userId);
  const picked = list.find(e => e.guild_id === channel.guild_id) ?? list.find(e => e.guild_id === null);
  if (!picked) return;
  const sound = pickable(userId, picked.sound_id, picked.source_guild_id);
  if (!sound || !mayPlay(channel, userId, sound)) return;
  // At most one entrance sound per user and channel every 3 s; extra joins are silent.
  const key = `${userId}:${channel.id}`;
  const now = Date.now();
  if (now - (lastEntrance.get(key) ?? -Infinity) < PLAY_INTERVAL_MS) return;
  lastEntrance.set(key, now);
  sendEffect(channel, userId, sound, true);
});
