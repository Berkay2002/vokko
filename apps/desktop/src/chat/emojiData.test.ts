import { beforeEach, describe, expect, it, vi } from 'vitest';
import { frequentEmoji, getFavoriteEmoji, getRecentEmoji, loadEmojiDb, pushRecentEmoji, quickReactions, recordEmojiUse, sameUnicodeEmoji, toggleFavoriteEmoji } from './emojiData';

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

  it('records unicode emoji and known shortcodes, first in the text first', async () => {
    await loadEmojiDb();
    recordEmojiUse('nice ❤️🎉 and :fire: but not <:vokko:123> or `🙈` or :nosuchcode: or © 2026, 🇸🇪 👍🏽 ❤️');
    expect(getRecentEmoji()).toEqual(['❤️', '🎉', '🔥', '🇸🇪', '👍🏽']);
    recordEmojiUse('plain text');
    expect(getRecentEmoji()).toHaveLength(5);
  });

  it('toggles favourites, keeping the order they were added', () => {
    toggleFavoriteEmoji('😀');
    toggleFavoriteEmoji('👍️');
    expect(getFavoriteEmoji()).toEqual(['😀', '👍️']);
    expect(toggleFavoriteEmoji('👍')).toEqual(['😀']);
  });
});
