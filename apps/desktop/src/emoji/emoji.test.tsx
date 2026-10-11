import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { isJumbo, parseMarkdown } from '../chat/markdown/parse';
import { Markdown, type MarkdownContext } from '../chat/markdown/render';
import type { Guild, GuildEmoji, GuildMember, User } from '../api/types';
import { canUseEmoji, customEmojiUrl, emojiMarkup, findEmoji, searchCustomEmoji, usableSections, type EmojiState } from './store';
import { checkEmojiFile, nameFromFile } from './EmojiSettingsPage';

const paragraph = (src: string) => {
  const [block] = parseMarkdown(src);
  if (!block || block.t !== 'paragraph') throw new Error(`not a paragraph: ${JSON.stringify(block)}`);
  return block.c;
};

describe('markdown parser: custom emoji', () => {
  it('parses static and animated custom emoji with their ids', () => {
    expect(paragraph('hi <:blob_wave:123> and <a:party:456>!')).toEqual([
      { t: 'text', v: 'hi ' },
      { t: 'customEmoji', name: 'blob_wave', id: '123', animated: false },
      { t: 'text', v: ' and ' },
      { t: 'customEmoji', name: 'party', id: '456', animated: true },
      { t: 'text', v: '!' },
    ]);
  });

  it('only accepts 2-32 name characters of [A-Za-z0-9_] and a numeric id', () => {
    expect(paragraph('<:a:1>')).toEqual([{ t: 'text', v: '<:a:1>' }]);
    expect(paragraph(`<:${'x'.repeat(33)}:1>`)[0]).toMatchObject({ t: 'text' });
    expect(paragraph(`<:${'x'.repeat(32)}:1>`)).toEqual([{ t: 'customEmoji', name: 'x'.repeat(32), id: '1', animated: false }]);
    expect(paragraph('<:has-dash:1>')).toEqual([{ t: 'text', v: '<:has-dash:1>' }]);
    expect(paragraph('<:ok:abc>')).toEqual([{ t: 'text', v: '<:ok:abc>' }]);
    expect(paragraph('<b:ok:1>')).toEqual([{ t: 'text', v: '<b:ok:1>' }]);
  });

  it('stays literal inside code and works inside formatting', () => {
    expect(paragraph('`<:blob:1>`')).toEqual([{ t: 'code', v: '<:blob:1>' }]);
    expect(paragraph('**<:blob:1>**')).toEqual([{ t: 'bold', c: [{ t: 'customEmoji', name: 'blob', id: '1', animated: false }] }]);
    expect(paragraph('\\<:blob:1>')[0]).toMatchObject({ t: 'text' });
  });

  it('makes custom-only and mixed emoji messages jumbo, but not with text or past 30 emoji', () => {
    expect(isJumbo(parseMarkdown('<:blob:1>'))).toBe(true);
    expect(isJumbo(parseMarkdown('<a:party:2> 🎉 <:blob:1>'))).toBe(true);
    expect(isJumbo(parseMarkdown('look <:blob:1>'))).toBe(false);
    expect(isJumbo(parseMarkdown(Array.from({ length: 31 }, () => '<:blob:1>').join('')))).toBe(false);
  });
});

describe('markdown render: custom emoji', () => {
  const ctx: MarkdownContext = {
    userName: () => null,
    roleInfo: () => null,
    channelName: () => null,
    currentUserId: null,
    customEmojiUrl: id => (id === '9' ? null : `https://x.test/e/${id}`),
  };
  it('renders an image for known urls, the text name otherwise, and uses the chat hook when given', () => {
    const html = renderToStaticMarkup(<Markdown content="<:blob:1> <:gone:9>" ctx={ctx} />);
    expect(html).toContain('src="https://x.test/e/1"');
    expect(html).toContain('alt=":blob:"');
    expect(html).toContain(':gone:');
    const hooked = renderToStaticMarkup(<Markdown content="<a:party:2>" ctx={{ ...ctx, renderCustomEmoji: e => <b data-id={e.id} data-animated={String(e.animated)}>{e.src}</b> }} />);
    expect(hooked).toContain('<b data-id="2" data-animated="true">https://x.test/e/2</b>');
  });
});

const user = (id: string): User => ({ id, username: `u${id}`, global_name: null, avatar: null, banner_color: null, bio: null, bot: false });
const guild = (id: string, name: string): Guild => ({ id, name, icon: null, owner_id: '1', roles: [], system_channel_id: null });
const emoji = (id: string, name: string, roles: string[] = [], animated = false): GuildEmoji => ({
  id, name, roles, animated, require_colons: true, managed: false, available: true, url: `blob:${id}`,
});
const member = (roles: string[]): GuildMember => ({ user: user('1'), nick: null, roles, joined_at: '2026-10-11T00:00:00Z' });

describe('emoji store helpers', () => {
  const state: EmojiState = { byGuild: { g1: [emoji('11', 'blob_wave'), emoji('12', 'vip_only', ['r1'])], g2: [emoji('21', 'party', [], true), emoji('22', 'wave_hi')] } };
  const app = {
    me: user('1'),
    guilds: { g1: guild('g1', 'One'), g2: guild('g2', 'Two'), g3: guild('g3', 'Empty') },
    guildOrder: ['g1', 'g2', 'g3'],
    members: { g1: { '1': member([]) }, g2: { '1': member([]) } },
  };

  it('lists usable sections in rail order with the current server first and role-restricted emoji filtered', () => {
    const sections = usableSections(app, state, null);
    expect(sections.map(s => [s.guild.id, s.emojis.map(e => e.name)])).toEqual([['g1', ['blob_wave']], ['g2', ['party', 'wave_hi']]]);
    expect(usableSections(app, state, 'g2').map(s => s.guild.id)).toEqual(['g2', 'g1']);
    const withRole = { ...app, members: { ...app.members, g1: { '1': member(['r1']) } } };
    expect(usableSections(withRole, state, null)[0]?.emojis.map(e => e.name)).toEqual(['blob_wave', 'vip_only']);
    expect(canUseEmoji(emoji('1', 'x', ['r1']), undefined)).toBe(false);
  });

  it('searches by name (exact, then prefix, then substring) across servers', () => {
    const sections = usableSections(app, state, null);
    expect(searchCustomEmoji(sections, 'wave').map(h => h.emoji.name)).toEqual(['wave_hi', 'blob_wave']);
    expect(searchCustomEmoji(sections, ':party:').map(h => [h.emoji.name, h.guild.name])).toEqual([['party', 'Two']]);
    expect(searchCustomEmoji(sections, '  ')).toEqual([]);
  });

  it('builds message markup and resolves urls by id', () => {
    expect(emojiMarkup(emoji('11', 'blob_wave'))).toBe('<:blob_wave:11>');
    expect(emojiMarkup(emoji('21', 'party', [], true))).toBe('<a:party:21>');
    expect(findEmoji('21', state)?.guildId).toBe('g2');
    expect(customEmojiUrl('12', state)).toBe('blob:12');
    // the test run has no VITE_VOKKO_API, i.e. mock mode: an unknown emoji has no URL and renders as text
    expect(customEmojiUrl('999', state)).toBeNull();
  });
});

describe('emoji settings helpers', () => {
  it('derives a valid name from a file name', () => {
    expect(nameFromFile('blob wave!.png')).toBe('blob_wave');
    expect(nameFromFile('ä.gif')).toBe('emoji');
    expect(nameFromFile(`${'long'.repeat(20)}.webp`)).toHaveLength(32);
  });
  it('checks type and the 256 KiB cap before uploading', () => {
    expect(checkEmojiFile({ type: 'image/png', size: 256 * 1024 })).toBeNull();
    expect(checkEmojiFile({ type: 'image/png', size: 256 * 1024 + 1 })).toMatch(/256 KiB/);
    expect(checkEmojiFile({ type: 'image/jpeg', size: 10 })).toMatch(/PNG, GIF or WebP/);
  });
});
