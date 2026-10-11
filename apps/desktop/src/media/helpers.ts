// Pure helpers of the media actions (GIF/sticker pickers, forward, bookmarks, reminders). No React, no I/O: unit-tested in helpers.test.ts.

import { Perm, channelPermissions, hasBit, memberLike } from '../api/permissions';
import { ChannelType, type Channel, type Embed, type Guild, type GuildMember, type Message, type Snowflake, type Sticker, type User } from '../api/types';

// ---- reminders ----

export type ReminderPreset = 'hour' | 'three-hours' | 'tomorrow';

export const REMINDER_PRESETS: { id: ReminderPreset; label: string }[] = [
  { id: 'hour', label: 'In 1 hour' },
  { id: 'three-hours', label: 'In 3 hours' },
  { id: 'tomorrow', label: 'Tomorrow' },
];

/** The server rejects reminders further than a year out (docs/api.md). */
export const MAX_REMIND_AHEAD_MS = 365 * 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;

/** When a preset fires: 1 h / 3 h from now, "tomorrow" = 09:00 local time on the next calendar day (DST-safe: built from calendar fields). */
export function presetReminderTime(preset: ReminderPreset, now: Date = new Date()): Date {
  switch (preset) {
    case 'hour': return new Date(now.getTime() + HOUR_MS);
    case 'three-hours': return new Date(now.getTime() + 3 * HOUR_MS);
    case 'tomorrow': return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0, 0);
  }
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** `<input type="datetime-local">` value (local time, minute precision). */
export function toDatetimeLocal(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export type CustomReminder = { ok: true; at: Date } | { ok: false; error: string };

/** A datetime-local value (local time) → the instant to remind at; rejects empty, impossible, past and more-than-a-year-ahead times. */
export function parseCustomReminder(value: string, now: Date = new Date()): CustomReminder {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value.trim());
  if (!m) return { ok: false, error: 'Pick a date and time.' };
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const at = new Date(y, mo - 1, d, h, mi, 0, 0);
  if (at.getFullYear() !== y || at.getMonth() !== mo - 1 || at.getDate() !== d || at.getHours() !== h) return { ok: false, error: 'That date does not exist.' };
  if (at.getTime() <= now.getTime()) return { ok: false, error: 'Pick a time in the future.' };
  if (at.getTime() > now.getTime() + MAX_REMIND_AHEAD_MS) return { ok: false, error: 'Reminders can be at most a year ahead.' };
  return { ok: true, at };
}

// ---- GIF messages ----

/** What a GIF-only message shows instead of its URL. */
export interface GifMedia {
  /** The URL the message consists of. */
  url: string;
  /** Still/animated image to show (a GIF/WebP, an embed thumbnail), null when only a video exists. */
  src: string | null;
  /** Looping video (gifv embeds), when the unfurl has one. */
  video: string | null;
  width: number | null;
  height: number | null;
}

/** http(s) and server-relative URLs, plus data: images (the mock's generated art). Never javascript: or other schemes. */
export function safeMediaUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  if (/^data:image\/(png|gif|webp|jpeg|svg\+xml)[;,]/i.test(url)) return url;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch { return null; }
}

const DIRECT_GIF = /\.(gif|webp|apng)$/i;

/** A direct media link by its path (query and hash ignored). */
export function looksLikeDirectGif(url: string): boolean {
  try { return DIRECT_GIF.test(new URL(url).pathname); } catch { return false; }
}

const isGifEmbed = (e: Embed): boolean => e.type === 'gifv' || e.type === 'image';

/**
 * Is this message a GIF, i.e. is its whole content one http(s) URL that has an image/gifv embed or is a direct .gif/.webp link? Returns
 * what to render in place of the URL, else null (ordinary text, a link with other words, an article embed...).
 */
export function gifMessageMedia(message: Pick<Message, 'content' | 'embeds'>): GifMedia | null {
  const url = message.content.trim();
  if (!/^https?:\/\/[^\s<>]+$/i.test(url)) return null;
  const embed = message.embeds?.find(isGifEmbed);
  const direct = looksLikeDirectGif(url);
  if (!embed && !direct) return null;
  const video = safeMediaUrl(embed?.video?.url);
  const embedImage = embed?.thumbnail ?? embed?.image;
  const src = safeMediaUrl(embedImage?.proxy_url ?? embedImage?.url) ?? (direct ? safeMediaUrl(url) : null);
  if (!src && !video) return null;
  return { url, src, video, width: embedImage?.width ?? embed?.video?.width ?? null, height: embedImage?.height ?? embed?.video?.height ?? null };
}

export const isGifOnlyMessage = (message: Pick<Message, 'content' | 'embeds'>): boolean => gifMessageMedia(message) !== null;

// ---- forward ----

export const MAX_FORWARD_DESTINATIONS = 5;

export interface ForwardDestination {
  id: Snowflake;
  kind: 'channel' | 'dm' | 'group';
  /** "general", "alice", "alice, bob" (no # prefix). */
  name: string;
  /** Server name for channels, null for conversations. */
  sub: string | null;
}

export interface DestinationInput {
  me: User;
  channels: Record<Snowflake, Channel>;
  /** DM / group DM ids, most recent first. */
  privateChannels: readonly Snowflake[];
  guildOrder: readonly Snowflake[];
  guilds: Record<Snowflake, Guild>;
  members: Record<Snowflake, Record<Snowflake, GuildMember>>;
  query: string;
  dmLabel(channel: Channel): string;
}

/** Everything the user can post to: conversations first (most recent first), then text channels they may send in, grouped by server. */
export function forwardDestinations(input: DestinationInput): ForwardDestination[] {
  const out: ForwardDestination[] = [];
  for (const id of input.privateChannels) {
    const c = input.channels[id];
    if (!c || (c.type !== ChannelType.DM && c.type !== ChannelType.GroupDM)) continue;
    out.push({ id, kind: c.type === ChannelType.GroupDM ? 'group' : 'dm', name: input.dmLabel(c), sub: null });
  }
  for (const guildId of input.guildOrder) {
    const guild = input.guilds[guildId];
    const member = input.members[guildId]?.[input.me.id];
    if (!guild || !member) continue;
    const text = Object.values(input.channels).filter(c => c.guild_id === guildId && c.type === ChannelType.GuildText);
    const categoryPosition = (c: Channel): number => (c.parent_id ? input.channels[c.parent_id]?.position ?? 0 : -1);
    text.sort((a, b) => categoryPosition(a) - categoryPosition(b) || a.position - b.position);
    for (const c of text) {
      const bits = channelPermissions(guild, memberLike(member), c);
      if (!hasBit(bits, Perm.VIEW_CHANNEL) || !hasBit(bits, Perm.SEND_MESSAGES)) continue;
      out.push({ id: c.id, kind: 'channel', name: c.name ?? 'unknown', sub: guild.name });
    }
  }
  const q = input.query.trim().toLowerCase().replace(/^[#@]/, '');
  if (!q) return out;
  return out.filter(d => d.name.toLowerCase().includes(q) || (d.sub?.toLowerCase().includes(q) ?? false));
}

/** Click on a destination row: deselects when selected, adds when there is room (at most 5), else leaves the selection unchanged. */
export function toggleDestination(selected: readonly Snowflake[], id: Snowflake, max = MAX_FORWARD_DESTINATIONS): Snowflake[] {
  if (selected.includes(id)) return selected.filter(s => s !== id);
  return selected.length >= max ? [...selected] : [...selected, id];
}

// ---- stickers ----

const words = (text: string): string[] => text.toLowerCase().split(/[\s,]+/).filter(Boolean);

/** Search by name, tags (comma separated) and description: every query word must start a word of one of them or be inside the name. */
export function stickerMatches(sticker: Pick<Sticker, 'name' | 'tags' | 'description'>, query: string): boolean {
  const q = words(query);
  if (q.length === 0) return true;
  const name = sticker.name.toLowerCase();
  const pool = [...words(sticker.name), ...words(sticker.tags), ...words(sticker.description ?? '')];
  return q.every(w => name.includes(w) || pool.some(p => p.startsWith(w)));
}

export interface StickerGroup {
  guildId: Snowflake;
  name: string;
  stickers: Sticker[];
}

/** Stickers grouped by server: the current channel's server first, the rest in rail order. Empty groups are left out. */
export function groupStickers(order: readonly Snowflake[], byGuild: Record<Snowflake, Sticker[]>, guilds: Record<Snowflake, Pick<Guild, 'name'>>, query: string, currentGuildId: Snowflake | null): StickerGroup[] {
  const ids = [...(currentGuildId && order.includes(currentGuildId) ? [currentGuildId] : []), ...order.filter(id => id !== currentGuildId)];
  const groups: StickerGroup[] = [];
  for (const guildId of ids) {
    const stickers = (byGuild[guildId] ?? []).filter(s => stickerMatches(s, query));
    const guild = guilds[guildId];
    if (guild && stickers.length > 0) groups.push({ guildId, name: guild.name, stickers });
  }
  return groups;
}

/** A sticker of the channel's own server always works; another server's needs USE_EXTERNAL_STICKERS (DMs pass `null` = everything allowed). */
export function canUseSticker(sticker: Pick<Sticker, 'guild_id'>, channelGuildId: Snowflake | null, channelBits: bigint | null): boolean {
  if (channelGuildId === null || sticker.guild_id === channelGuildId) return true;
  return channelBits === null || hasBit(channelBits, Perm.USE_EXTERNAL_STICKERS);
}

// ---- plain text of a message (inbox rows, notices, forward preview) ----

/** One line of plain text: mentions and emoji tokens made readable, attachments/stickers/forwards named. Never HTML. */
export function messageSnippet(message: Pick<Message, 'content' | 'attachments' | 'sticker_items' | 'message_snapshots' | 'mentions'>, max = 140): string {
  const names = new Map(message.mentions.map(u => [u.id, u.global_name || u.username]));
  const plain = (text: string): string => text
    .replace(/<@!?(\d+)>/g, (_, id: string) => `@${names.get(id) ?? 'user'}`)
    .replace(/<@&\d+>/g, '@role')
    .replace(/<#\d+>/g, '#channel')
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/\s+/g, ' ')
    .trim();
  let text = plain(message.content);
  const snap = message.message_snapshots?.[0]?.message;
  if (!text && snap) text = `Forwarded: ${messageSnippet({ ...snap, sticker_items: snap.sticker_items, message_snapshots: undefined }, max)}`;
  if (!text && message.sticker_items?.length) text = `Sticker: ${message.sticker_items.map(s => s.name).join(', ')}`;
  if (!text && message.attachments.length) text = message.attachments.length === 1 ? (message.attachments[0]?.filename ?? 'Attachment') : `${message.attachments.length} attachments`;
  if (!text) text = 'Message';
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
