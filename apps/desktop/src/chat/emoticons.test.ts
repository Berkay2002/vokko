import { describe, expect, it } from 'vitest';
import { convertEmoticons } from './emoticons';

describe('convertEmoticons', () => {
  it('converts standalone emoticons', () => {
    expect(convertEmoticons(':)')).toBe('🙂');
    expect(convertEmoticons('hello :) world ;)')).toBe('hello 🙂 world 😉');
    expect(convertEmoticons(':) :) :(')).toBe('🙂 🙂 🙁');
    expect(convertEmoticons('I <3 this')).toBe('I ❤️ this');
    expect(convertEmoticons('a\n:D\nb')).toBe('a\n😃\nb');
    expect(convertEmoticons(':-)')).toBe('🙂');
  });

  it('leaves emoticons that are part of a word, a link or a custom emoji', () => {
    expect(convertEmoticons('ok:) fine')).toBe('ok:) fine');
    expect(convertEmoticons('see http://example.com/a:/b')).toBe('see http://example.com/a:/b');
    expect(convertEmoticons('<:smile:123456> :)')).toBe('<:smile:123456> 🙂');
    expect(convertEmoticons(':))')).toBe(':))');
  });

  it('never converts inside code', () => {
    expect(convertEmoticons('use `a :) b` here :)')).toBe('use `a :) b` here 🙂');
    expect(convertEmoticons('```\n:)\n```\n:)')).toBe('```\n:)\n```\n🙂');
  });
});
