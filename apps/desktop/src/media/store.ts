// State of the media actions: server stickers, favourite GIFs, bookmarks, reminders, due-reminder notices and the forward modal target.
// Kept in its own zustand store and fed by gateway events, so the app store (api/store.ts) and the chat area stay untouched.

import { create } from 'zustand';
import type { Bookmark, BookmarksPage, Gif, Message, Reminder, Snowflake, Sticker } from '../api/types';
import type { Gone } from './lists';
import { addFavorite, dropNotice, isBookmarked, isFavorite, purgeBookmarks, purgeReminders, pushNotice, removeBookmark, removeFavorite, removeReminder, upsertBookmark, upsertReminder } from './lists';
import { ApiRequestError, appStore, chatToast, gateway, request } from './shell';

export interface MediaState {
  /** guild id → its stickers (READY / GUILD_CREATE / GUILD_STICKERS_UPDATE). */
  stickers: Record<Snowflake, Sticker[]>;
  /** null = not loaded yet. */
  favorites: Gif[] | null;
  bookmarks: Bookmark[] | null;
  reminders: Reminder[] | null;
  /** Reminders that fired while the app was open, shown as notices until dismissed. */
  notices: Reminder[];
  /** The message the Forward modal is open for. */
  forwardTarget: Message | null;
}

const initial: MediaState = { stickers: {}, favorites: null, bookmarks: null, reminders: null, notices: [], forwardTarget: null };

export const useMedia = create<MediaState>()(() => initial);
const set = useMedia.setState;
const get = useMedia.getState;

const errorText = (e: unknown, fallback: string): string => (e instanceof ApiRequestError || e instanceof Error ? e.message : fallback);

// ---- forward modal ----

export const openForward = (message: Message): void => set({ forwardTarget: message });
export const closeForward = (): void => set({ forwardTarget: null });

// ---- stickers ----

/** Re-read every joined server's stickers (the picker does this when it opens; events keep them current afterwards). */
export async function refreshStickers(): Promise<void> {
  const ids = appStore.getState().guildOrder;
  const lists = await Promise.all(ids.map(id => request<Sticker[]>('GET', `/guilds/${id}/stickers`).then(list => [id, list] as const, () => null)));
  const next: Record<Snowflake, Sticker[]> = {};
  for (const entry of lists) if (entry) next[entry[0]] = entry[1];
  set(s => ({ stickers: { ...s.stickers, ...next } }));
}

// ---- favourite GIFs ----

export async function loadFavorites(): Promise<void> {
  try { set({ favorites: await request<Gif[]>('GET', '/users/@me/gifs/favorites') }); } catch { set(s => ({ favorites: s.favorites ?? [] })); }
}

/** Star toggle: optimistic, rolled back when the server says no. */
export async function toggleFavorite(gif: Gif): Promise<void> {
  const before = get().favorites ?? [];
  const had = isFavorite(before, gif.id);
  set({ favorites: had ? removeFavorite(before, gif.id) : addFavorite(before, gif) });
  try {
    if (had) await request<null>('DELETE', `/users/@me/gifs/favorites/${encodeURIComponent(gif.id)}`);
    else await request<Gif>('PUT', '/users/@me/gifs/favorites', gif);
  } catch (e) {
    set({ favorites: before });
    chatToast(errorText(e, 'Could not update your favorite GIFs.'));
  }
}

// ---- bookmarks ----

export async function loadBookmarks(): Promise<void> {
  // At most 250 are stored per user: three pages of 100 reach all of them (the cursor is saved_at plus the message id).
  try {
    const all: Bookmark[] = [];
    let path = '/users/@me/bookmarks?limit=100';
    for (let page = 0; page < 3; page++) {
      const { items, has_more } = await request<BookmarksPage>('GET', path);
      all.push(...items);
      const last = items[items.length - 1];
      if (!has_more || !last) break;
      path = `/users/@me/bookmarks?limit=100&before=${encodeURIComponent(last.saved_at)}&before_id=${last.message.id}`;
    }
    set({ bookmarks: all });
  } catch { set(s => ({ bookmarks: s.bookmarks ?? [] })); }
}

export const useIsBookmarked = (channelId: Snowflake, messageId: Snowflake): boolean => useMedia(s => isBookmarked(s.bookmarks, channelId, messageId));

export async function toggleBookmark(message: Message): Promise<void> {
  const path = `/channels/${message.channel_id}/messages/${message.id}/bookmark`;
  const saved = isBookmarked(get().bookmarks, message.channel_id, message.id);
  try {
    if (saved) {
      await request<null>('DELETE', path);
      set(s => ({ bookmarks: removeBookmark(s.bookmarks ?? [], message.channel_id, message.id) }));
    } else {
      await request<null>('PUT', path);
      set(s => ({ bookmarks: upsertBookmark(s.bookmarks ?? [], { message, saved_at: new Date().toISOString() }) }));
      chatToast('Message saved to your bookmarks.');
    }
  } catch (e) {
    chatToast(errorText(e, 'Could not update the bookmark.'));
  }
}

export async function removeBookmarkOf(bookmark: Bookmark): Promise<void> {
  const { channel_id, id } = bookmark.message;
  try {
    await request<null>('DELETE', `/channels/${channel_id}/messages/${id}/bookmark`);
    set(s => ({ bookmarks: removeBookmark(s.bookmarks ?? [], channel_id, id) }));
  } catch (e) {
    chatToast(errorText(e, 'Could not remove the bookmark.'));
  }
}

// ---- reminders ----

export async function loadReminders(): Promise<void> {
  try { set({ reminders: await request<Reminder[]>('GET', '/users/@me/reminders') }); } catch { set(s => ({ reminders: s.reminders ?? [] })); }
}

const whenFormat = (at: Date): string => new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(at);

/** Sets (or moves) the reminder of a message. Resolves true when it was saved. */
export async function createReminder(message: Message, at: Date): Promise<boolean> {
  try {
    const reminder = await request<Reminder>('POST', '/users/@me/reminders', { channel_id: message.channel_id, message_id: message.id, remind_at: at.toISOString() });
    set(s => ({ reminders: upsertReminder(s.reminders ?? [], reminder), notices: dropNotice(s.notices, reminder.id) }));
    chatToast(`Reminder set for ${whenFormat(at)}.`);
    return true;
  } catch (e) {
    chatToast(errorText(e, 'Could not set the reminder.'));
    return false;
  }
}

/** Cancels a pending reminder or dismisses a delivered one. */
export async function dismissReminder(id: Snowflake): Promise<void> {
  try {
    await request<null>('DELETE', `/users/@me/reminders/${id}`);
    set(s => ({ reminders: removeReminder(s.reminders ?? [], id), notices: dropNotice(s.notices, id) }));
  } catch (e) {
    chatToast(errorText(e, 'Could not dismiss the reminder.'));
  }
}

/** Hides a notice without touching the reminder (it stays in the inbox until dismissed there). */
export const hideNotice = (id: Snowflake): void => set(s => ({ notices: dropNotice(s.notices, id) }));

// ---- gateway wiring (once, at module load) ----

let wired = false;
/** Drops bookmarks, reminders and notices that pointed at something that no longer exists. */
function purge(gone: Gone): void {
  set(s => ({
    bookmarks: s.bookmarks && purgeBookmarks(s.bookmarks, gone),
    reminders: s.reminders && purgeReminders(s.reminders, gone),
    notices: purgeReminders(s.notices, gone),
  }));
}

export function wireMedia(): void {
  if (wired) return;
  wired = true;
  gateway.on('READY', ready => {
    const stickers: Record<Snowflake, Sticker[]> = {};
    for (const guild of ready.guilds) stickers[guild.id] = guild.stickers ?? [];
    set({ stickers, favorites: null, bookmarks: null, reminders: null, notices: [] });
    void loadFavorites();
    void loadBookmarks();
    void loadReminders();
  });
  gateway.on('GUILD_CREATE', guild => set(s => ({ stickers: { ...s.stickers, [guild.id]: guild.stickers ?? [] } })));
  gateway.on('GUILD_DELETE', ({ id }) => {
    set(s => {
      const { [id]: _gone, ...rest } = s.stickers;
      void _gone;
      return { stickers: rest };
    });
    purge({ guildId: id });
  });
  gateway.on('MESSAGE_DELETE', ({ id }) => purge({ messageId: id }));
  gateway.on('MESSAGE_DELETE_BULK', ({ ids }) => ids.forEach(id => purge({ messageId: id })));
  gateway.on('CHANNEL_DELETE', channel => purge({ channelId: channel.id }));
  gateway.on('GUILD_STICKERS_UPDATE', ({ guild_id, stickers }) => set(s => ({ stickers: { ...s.stickers, [guild_id]: stickers } })));
  gateway.on('BOOKMARK_ADD', bookmark => set(s => ({ bookmarks: upsertBookmark(s.bookmarks ?? [], bookmark) })));
  gateway.on('BOOKMARK_REMOVE', ({ channel_id, message_id }) => set(s => ({ bookmarks: removeBookmark(s.bookmarks ?? [], channel_id, message_id) })));
  gateway.on('REMINDER_CREATE', reminder => set(s => ({ reminders: upsertReminder(s.reminders ?? [], reminder) })));
  gateway.on('REMINDER_DELETE', ({ id }) => set(s => ({ reminders: removeReminder(s.reminders ?? [], id), notices: dropNotice(s.notices, id) })));
  gateway.on('REMINDER_DUE', reminder => set(s => ({ reminders: upsertReminder(s.reminders ?? [], reminder), notices: pushNotice(s.notices, reminder) })));
}
