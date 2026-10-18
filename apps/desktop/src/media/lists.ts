// Pure list transitions for bookmarks, reminders and the due-reminder notices. Unit-tested in helpers.test.ts.

import type { Bookmark, Gif, Reminder, Snowflake, Sticker } from '../api/types';

export const bookmarkKey = (channelId: Snowflake, messageId: Snowflake): string => `${channelId}:${messageId}`;

/** A (re)saved message goes to the top: lists are newest saved first. */
export function upsertBookmark(list: readonly Bookmark[], bookmark: Bookmark): Bookmark[] {
  return [bookmark, ...list.filter(b => b.message.id !== bookmark.message.id)];
}

export function removeBookmark(list: readonly Bookmark[], channelId: Snowflake, messageId: Snowflake): Bookmark[] {
  return list.filter(b => !(b.message.channel_id === channelId && b.message.id === messageId));
}

export const isBookmarked = (list: readonly Bookmark[] | null, channelId: Snowflake, messageId: Snowflake): boolean => !!list?.some(b => b.message.channel_id === channelId && b.message.id === messageId);

const byRemindAt = (a: Reminder, b: Reminder): number => Date.parse(a.remind_at) - Date.parse(b.remind_at) || a.id.localeCompare(b.id);

/** Insert or replace by id; the list stays ordered by remind_at ascending like GET /users/@me/reminders. */
export function upsertReminder(list: readonly Reminder[], reminder: Reminder): Reminder[] {
  return [...list.filter(r => r.id !== reminder.id), reminder].sort(byRemindAt);
}

export const removeReminder = (list: readonly Reminder[], id: Snowflake): Reminder[] => list.filter(r => r.id !== id);

/** The reminder set on a message, if any (one per user and message). */
export const reminderOf = (list: readonly Reminder[] | null, messageId: Snowflake): Reminder | undefined => list?.find(r => r.message_id === messageId);

/** Reminders that fired and wait to be dismissed come first in the inbox; pending ones follow by time. */
export function sortReminders(list: readonly Reminder[]): Reminder[] {
  return [...list].sort((a, b) => Number(!!b.delivered_at) - Number(!!a.delivered_at) || byRemindAt(a, b));
}

/** Live "reminder due" notices: one per reminder, newest last, at most `max` kept. */
export function pushNotice(notices: readonly Reminder[], reminder: Reminder, max = 3): Reminder[] {
  return [...notices.filter(n => n.id !== reminder.id), reminder].slice(-max);
}

export const dropNotice = (notices: readonly Reminder[], id: Snowflake): Reminder[] => notices.filter(n => n.id !== id);

/** Add a favourite GIF to the top (a known id moves up), like PUT /users/@me/gifs/favorites. */
export function addFavorite(list: readonly Gif[], gif: Gif): Gif[] {
  return [gif, ...list.filter(g => g.id !== gif.id)];
}

export const removeFavorite = (list: readonly Gif[], id: string): Gif[] => list.filter(g => g.id !== id);

export const isFavorite = (list: readonly Gif[] | null, id: string): boolean => !!list?.some(g => g.id === id);

/** What disappeared: a deleted message, a deleted channel or a guild the user left (kick, ban, leave, delete). */
export type Gone = { messageId: Snowflake } | { channelId: Snowflake } | { guildId: Snowflake };

/** Bookmarks of messages that can no longer be opened are dropped at once instead of waiting for the next reload. */
export function purgeBookmarks(list: readonly Bookmark[], gone: Gone): Bookmark[] {
  return list.filter(b => !('messageId' in gone ? b.message.id === gone.messageId : 'channelId' in gone ? b.message.channel_id === gone.channelId : b.message.guild_id === gone.guildId));
}

/** Same for reminders (the server drops them with the message or channel too). */
export function purgeReminders(list: readonly Reminder[], gone: Gone): Reminder[] {
  return list.filter(r => !('messageId' in gone ? r.message_id === gone.messageId : 'channelId' in gone ? r.channel_id === gone.channelId : r.guild_id === gone.guildId));
}

// ---- recents and sticker favourites (the pickers' "Recent" and "Favorites" rows) ----

export const MAX_RECENT = 24;
/** Same cap as the server's `sticker_favorites` allow-list entry. */
export const MAX_FAVORITE_STICKERS = 100;

const idOf = (item: string | { id: string }): string => (typeof item === 'string' ? item : item.id);

/** The item just used goes first (a known one moves up); the list keeps the newest `max`. */
export function pushRecent<T extends string | { id: string }>(list: readonly T[], item: T, max = MAX_RECENT): T[] {
  return [item, ...list.filter(x => idOf(x) !== idOf(item))].slice(0, max);
}

/** Adds an id at the end (the order they were added) or removes it; a full list is returned unchanged. */
export function toggleId(list: readonly string[], id: string, max = MAX_FAVORITE_STICKERS): string[] {
  return list.includes(id) ? list.filter(x => x !== id) : list.length >= max ? [...list] : [...list, id];
}

/** Stickers by id, in the order of `ids`; ids whose sticker is gone (deleted, or a server the user left) are dropped. */
export function resolveStickers(ids: readonly string[], stickers: Readonly<Record<Snowflake, readonly Sticker[]>>): Sticker[] {
  const byId = new Map<string, Sticker>();
  for (const list of Object.values(stickers)) for (const s of list) byId.set(s.id, s);
  return ids.flatMap(id => byId.get(id) ?? []);
}
