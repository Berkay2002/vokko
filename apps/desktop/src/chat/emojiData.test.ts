import { beforeEach, describe, expect, it, vi } from 'vitest';
import { frecencyRank, frequentEmoji, getFavoriteEmoji, getRecentEmoji, isFavoriteEmoji, loadEmojiDb, pushRecentEmoji, quickReactions, recordEmojiUse, sameUnicodeEmoji, toggleFavoriteEmoji } from './emojiData';
import { getPrefs, setPref } from '../ui/prefs';

describe('recent emoji: 👍 and 👍️ (U+FE0F) are one emoji', () => {
  beforeEach(() => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) });
  });

  it('compares without variation selectors', () => {
    expect(sameUnicodeEmoji('👍', '👍️')).toBe(true);
    expect(sameUnicodeEmoji('❤', '❤️')).toBe(true);
    expect(sameUnicodeEmoji('👍', '👎')).toBe(false);
  });

  it('quick reactions and the frequent list show it once', () => {
    pushRecentEmoji('👍️'); // the picker's (emojibase) spelling; the default quick list has 👍 without it
    expect(quickReactions()).toEqual(['👍️', '😂', '❤️', '🎉']);
    expect(frequentEmoji().filter(e => sameUnicodeEmoji(e, '👍'))).toHaveLength(1);
    pushRecentEmoji('👍');
    expect(quickReactions().filter(e => sameUnicodeEmoji(e, '👍'))).toEqual(['👍']);
  });
});

describe('Frequently Used counts sent messages; favourites', () => {
  beforeEach(() => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) });
  });

  it('records custom emoji, then unicode and known shortcodes in text order', async () => {
    await loadEmojiDb();
    recordEmojiUse('nice ❤️🎉 and :fire: but not <:vokko:123> or `🙈` or :nosuchcode: or © 2026, 🇸🇪 👍🏽 ❤️');
    expect(getRecentEmoji()).toEqual(['<:vokko:123>', '❤️', '🎉', '🔥', '🇸🇪', '👍🏽']);
    recordEmojiUse('plain text');
    expect(getRecentEmoji()).toHaveLength(6);
  });

  it('toggles favourites, keeping the order they were added', () => {
    toggleFavoriteEmoji('😀');
    toggleFavoriteEmoji('👍️');
    expect(getFavoriteEmoji()).toEqual(['😀', '👍️']);
    expect(toggleFavoriteEmoji('👍')).toEqual(['😀']);
  });
});

describe('Frequently Used is frecency: count with time decay', () => {
  const DAY = 86_400_000;
  const now = 1_800_000_000_000;
  let data: Map<string, string>;
  beforeEach(() => {
    data = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) });
    setPref('emojiFavorites', []);
  });

  it('an emoji used often lately outranks one used once just now, an old one does not', () => {
    for (let i = 0; i < 5; i++) pushRecentEmoji('🔥', now - 10 * DAY);
    pushRecentEmoji('😀', now);
    pushRecentEmoji('🐢', now - 200 * DAY);
    expect(getRecentEmoji(now)).toEqual(['🔥', '😀', '🐢']); // 5×30 > 1×100 > 0
    expect(getRecentEmoji(now + 50 * DAY)).toEqual(['🔥', '😀', '🐢']); // 5×10 > 1×10
    pushRecentEmoji('😀', now + 50 * DAY);
    expect(getRecentEmoji(now + 50 * DAY)[0]).toBe('😀'); // 2×55 > 5×10
  });

  it('counts custom emoji by id (a rename keeps the count); the quick lists stay unicode', () => {
    recordEmojiUse('hi <:vokko:123> <a:party:9>');
    pushRecentEmoji('<:vokko_new:123>');
    expect(getRecentEmoji()[0]).toBe('<:vokko_new:123>');
    expect(getRecentEmoji()).toHaveLength(2);
    expect(quickReactions().some(e => e.startsWith('<'))).toBe(false);
    const rank = frecencyRank();
    expect(rank('<:vokko:123>')).toBe(0);
    expect(rank('😀')).toBe(2);
  });

  it('seeds from the old most-recent-first list and moves old local favourites into the synced pref', () => {
    data.set('vokko.emoji.recent', JSON.stringify(['🎉', '❤️']));
    data.set('vokko.emoji.favorites', JSON.stringify(['🔥', '<:vokko:123>']));
    expect(getRecentEmoji()).toEqual(['🎉', '❤️']);
    expect(getFavoriteEmoji()).toEqual(['🔥', '<:vokko:123>']);
    expect(getPrefs().emojiFavorites).toEqual(['🔥', '<:vokko:123>']);
    expect(data.has('vokko.emoji.favorites')).toBe(false);
    expect(isFavoriteEmoji(getFavoriteEmoji(), '<:renamed:123>')).toBe(true);
  });
});
