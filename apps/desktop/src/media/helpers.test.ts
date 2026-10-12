import { describe, expect, it } from 'vitest';
import { Perm } from '../api/permissions';
import { ChannelType, OverwriteType, StickerFormat, type Attachment, type Bookmark, type Channel, type Embed, type Gif, type Guild, type GuildMember, type Message, type Reminder, type Sticker, type User } from '../api/types';
import {
  MAX_FORWARD_DESTINATIONS, canUseSticker, forwardDestinations, gifMessageMedia, groupStickers, isGifOnlyMessage, looksLikeDirectGif, messageSnippet, parseCustomReminder, presetReminderTime, REMINDER_PRESETS, reminderPresetLabel,
  safeMediaUrl, stickerMatches, toDatetimeLocal, toggleDestination,
} from './helpers';
import { addFavorite, dropNotice, isBookmarked, purgeBookmarks, purgeReminders, pushNotice, removeBookmark, removeFavorite, removeReminder, reminderOf, sortReminders, upsertBookmark, upsertReminder } from './lists';

const user = (id: string, name = id): User => ({ id, username: name, global_name: null, avatar: null, banner_color: null, bio: null, bot: false });

describe('reminder presets', () => {
  const now = new Date(2026, 5, 15, 14, 30, 0); // 15 June 2026, 14:30 local

  it('computes in 30 min, 1 hour and 4 hours from now', () => {
    expect(presetReminderTime('half-hour', now).getTime() - now.getTime()).toBe(1800_000);
    expect(presetReminderTime('hour', now).getTime() - now.getTime()).toBe(3600_000);
    expect(presetReminderTime('four-hours', now).getTime() - now.getTime()).toBe(4 * 3600_000);
  });

  it('lists the presets in Discord order and words the 09:00 with the given time format', () => {
    const h12 = (d: Date) => `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
    const h24 = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    expect(REMINDER_PRESETS.map(p => reminderPresetLabel(p, h12))).toEqual(['In 30 min', 'In 1 hour', 'In 4 hours', 'Tomorrow at 9:00 AM', 'Monday at 9:00 AM']);
    expect(REMINDER_PRESETS.map(p => reminderPresetLabel(p, h24)).slice(3)).toEqual(['Tomorrow at 09:00', 'Monday at 09:00']);
  });

  it('puts Monday at 09:00 local time on the next Monday, a week ahead when today is Monday', () => {
    // 15 June 2026 is a Monday
    for (const [day, expected] of [[15, 22], [16, 22], [20, 22], [21, 22], [22, 29]] as const) {
      for (const hour of [0, 8, 9, 23]) {
        const at = presetReminderTime('monday', new Date(2026, 5, day, hour, 15));
        expect([at.getDay(), at.getMonth(), at.getDate(), at.getHours(), at.getMinutes(), at.getSeconds()]).toEqual([1, 5, expected, 9, 0, 0]);
      }
    }
    const nye = presetReminderTime('monday', new Date(2026, 11, 31, 12, 0)); // Thursday
    expect([nye.getFullYear(), nye.getMonth(), nye.getDate(), nye.getHours()]).toEqual([2027, 0, 4, 9]);
  });

  it('puts tomorrow at 09:00 local time on the next calendar day, whatever the time now', () => {
    for (const hour of [0, 8, 9, 14, 23]) {
      const at = presetReminderTime('tomorrow', new Date(2026, 5, 15, hour, 15));
      expect([at.getFullYear(), at.getMonth(), at.getDate(), at.getHours(), at.getMinutes(), at.getSeconds()]).toEqual([2026, 5, 16, 9, 0, 0]);
    }
  });

  it('rolls over month and year ends', () => {
    const at = presetReminderTime('tomorrow', new Date(2026, 11, 31, 23, 59));
    expect([at.getFullYear(), at.getMonth(), at.getDate(), at.getHours()]).toEqual([2027, 0, 1, 9]);
    const feb = presetReminderTime('tomorrow', new Date(2028, 1, 28, 12, 0));
    expect([feb.getMonth(), feb.getDate()]).toEqual([1, 29]); // 2028 is a leap year
  });

  it('parses a datetime-local value as local time', () => {
    const parsed = parseCustomReminder('2026-06-16T08:45', now);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect([parsed.at.getDate(), parsed.at.getHours(), parsed.at.getMinutes()]).toEqual([16, 8, 45]);
  });

  it('round-trips through toDatetimeLocal', () => {
    expect(toDatetimeLocal(new Date(2026, 0, 5, 7, 3))).toBe('2026-01-05T07:03');
    const at = presetReminderTime('hour', now);
    const parsed = parseCustomReminder(toDatetimeLocal(at), now);
    expect(parsed.ok && parsed.at.getTime()).toBe(new Date(at.getFullYear(), at.getMonth(), at.getDate(), at.getHours(), at.getMinutes()).getTime());
  });

  it('rejects empty, impossible, past and more-than-a-year-ahead custom times', () => {
    expect(parseCustomReminder('', now)).toMatchObject({ ok: false });
    expect(parseCustomReminder('tomorrow', now)).toMatchObject({ ok: false });
    expect(parseCustomReminder('2026-02-30T10:00', now)).toMatchObject({ ok: false, error: 'That date does not exist.' });
    expect(parseCustomReminder('2026-06-15T14:30', now)).toMatchObject({ ok: false, error: 'Pick a time in the future.' });
    expect(parseCustomReminder('2026-06-15T14:31', now)).toMatchObject({ ok: true });
    expect(parseCustomReminder('2027-06-14T14:30', now)).toMatchObject({ ok: true });
    expect(parseCustomReminder('2027-06-16T14:30', now)).toMatchObject({ ok: false, error: expect.stringContaining('year') });
  });
});

describe('GIF-only messages', () => {
  const embed = (extra: Partial<Embed>): Embed => ({ type: 'image', ...extra });
  const msg = (content: string, embeds: Embed[] = []) => ({ content, embeds });

  it('is a GIF when the whole content is one URL with an image or gifv embed', () => {
    const media = gifMessageMedia(msg('https://media.example/g/1', [embed({ type: 'gifv', video: { url: 'https://media.example/g/1.mp4' }, thumbnail: { url: 'https://media.example/g/1.png', width: 320, height: 240 } })]));
    expect(media).toEqual({ url: 'https://media.example/g/1', src: 'https://media.example/g/1.png', video: 'https://media.example/g/1.mp4', width: 320, height: 240 });
    expect(isGifOnlyMessage(msg('https://media.example/p', [embed({ image: { url: 'https://media.example/p.png' } })]))).toBe(true);
    expect(gifMessageMedia(msg('  https://media.example/g/1  ', [embed({ thumbnail: { url: 'https://x/t.gif' } })]))?.url).toBe('https://media.example/g/1');
  });

  it('is a GIF without an embed when it looks like a direct gif/webp link', () => {
    expect(gifMessageMedia(msg('https://cdn.example/a/cat.gif'))).toMatchObject({ src: 'https://cdn.example/a/cat.gif', video: null });
    expect(isGifOnlyMessage(msg('https://cdn.example/a/cat.WEBP?size=2#x'))).toBe(true);
    expect(isGifOnlyMessage(msg('https://cdn.example/a/cat.png'))).toBe(false);
    expect(looksLikeDirectGif('https://cdn.example/a/cat.gif')).toBe(true);
    expect(looksLikeDirectGif('https://cdn.example/gif')).toBe(false);
  });

  it('is not a GIF for text with the URL, several URLs, article embeds or non-http schemes', () => {
    expect(isGifOnlyMessage(msg('look https://cdn.example/a/cat.gif'))).toBe(false);
    expect(isGifOnlyMessage(msg('https://cdn.example/a.gif https://cdn.example/b.gif'))).toBe(false);
    expect(isGifOnlyMessage(msg('<https://cdn.example/a.gif>'))).toBe(false);
    expect(isGifOnlyMessage(msg('https://example.com/post', [embed({ type: 'article', title: 'Post' })]))).toBe(false);
    expect(isGifOnlyMessage(msg('javascript:alert(1)//.gif'))).toBe(false);
    expect(isGifOnlyMessage(msg('ftp://cdn.example/a.gif'))).toBe(false);
    expect(isGifOnlyMessage(msg(''))).toBe(false);
  });

  it('uses data: images from the mock but never other schemes', () => {
    expect(safeMediaUrl('data:image/svg+xml;utf8,%3Csvg%3E')).toBeTruthy();
    expect(safeMediaUrl('data:text/html;base64,AAAA')).toBeNull();
    expect(safeMediaUrl('javascript:alert(1)')).toBeNull();
    expect(safeMediaUrl('//evil.example/x.gif')).toBeNull();
    expect(safeMediaUrl('/attachments/1/key/a.gif')).toBe('/attachments/1/key/a.gif');
    expect(gifMessageMedia(msg('https://m.example/g', [embed({ thumbnail: { url: 'javascript:alert(1)' } })]))).toBeNull();
  });
});

describe('forward destinations', () => {
  const ME = user('1', 'me');
  const guild: Guild = {
    id: '100', name: 'Sam', icon: null, owner_id: '9', system_channel_id: null,
    roles: [{ id: '100', name: '@everyone', color: 0, hoist: false, position: 0, permissions: (Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES).toString(), mentionable: false }],
  };
  const member: GuildMember = { user: ME, nick: null, roles: [], joined_at: '2026-01-01T00:00:00Z' };
  const ch = (id: string, over: Partial<Channel>): Channel => ({ id, type: ChannelType.GuildText, guild_id: '100', name: id, topic: null, position: 0, parent_id: null, last_message_id: null, ...over });
  const channels: Record<string, Channel> = {
    cat: ch('cat', { type: ChannelType.GuildCategory, name: 'Text', position: 1 }),
    general: ch('general', { name: 'general', position: 1, parent_id: 'cat' }),
    random: ch('random', { name: 'random', position: 0, parent_id: 'cat' }),
    voice: ch('voice', { type: ChannelType.GuildVoice, name: 'Voice', parent_id: 'cat' }),
    locked: ch('locked', { name: 'locked', parent_id: 'cat', permission_overwrites: [{ id: '100', type: OverwriteType.Role, allow: '0', deny: Perm.SEND_MESSAGES.toString() }] }),
    hidden: ch('hidden', { name: 'hidden', parent_id: 'cat', permission_overwrites: [{ id: '100', type: OverwriteType.Role, allow: '0', deny: Perm.VIEW_CHANNEL.toString() }] }),
    dmAlice: ch('dmAlice', { type: ChannelType.DM, guild_id: null, name: null, recipients: [user('2', 'alice')] }),
    group: ch('group', { type: ChannelType.GroupDM, guild_id: null, name: null, recipients: [user('3', 'nova'), user('4', 'bob')] }),
  };
  const input = {
    me: ME, channels, privateChannels: ['group', 'dmAlice'], guildOrder: ['100', '200'], guilds: { '100': guild }, members: { '100': { '1': member } },
    query: '', dmLabel: (c: Channel) => (c.recipients ?? []).map(u => u.username).join(', '),
  };

  it('lists conversations first, then the text channels the user can post to, by category and position', () => {
    const list = forwardDestinations(input);
    expect(list.map(d => `${d.kind}:${d.id}`)).toEqual(['group:group', 'dm:dmAlice', 'channel:random', 'channel:general']);
    expect(list[0]).toMatchObject({ name: 'nova, bob', sub: null });
    expect(list[2]).toMatchObject({ name: 'random', sub: 'Sam' });
  });

  it('leaves out voice and category channels, hidden channels, read-only channels and servers the user is not in', () => {
    const ids = forwardDestinations(input).map(d => d.id);
    for (const id of ['cat', 'voice', 'hidden', 'locked']) expect(ids).not.toContain(id);
    expect(forwardDestinations({ ...input, members: { '100': {} } }).map(d => d.kind)).toEqual(['group', 'dm']);
  });

  it('filters by name or server name, ignoring case and a leading # or @', () => {
    expect(forwardDestinations({ ...input, query: 'GEN' }).map(d => d.id)).toEqual(['general']);
    expect(forwardDestinations({ ...input, query: '#rand' }).map(d => d.id)).toEqual(['random']);
    expect(forwardDestinations({ ...input, query: '@ali' }).map(d => d.id)).toEqual(['dmAlice']);
    expect(forwardDestinations({ ...input, query: 'sam' }).map(d => d.id)).toEqual(['random', 'general']);
    expect(forwardDestinations({ ...input, query: 'nothing here' })).toEqual([]);
  });

  it('allows at most 5 selected destinations and still lets a selected one be unticked', () => {
    expect(MAX_FORWARD_DESTINATIONS).toBe(5);
    let selected: string[] = [];
    for (const id of ['a', 'b', 'c', 'd', 'e']) selected = toggleDestination(selected, id);
    expect(selected).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(toggleDestination(selected, 'f')).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(toggleDestination(selected, 'c')).toEqual(['a', 'b', 'd', 'e']);
    expect(toggleDestination(toggleDestination(selected, 'c'), 'f')).toEqual(['a', 'b', 'd', 'e', 'f']);
    // never mutates its input
    expect(selected).toHaveLength(5);
  });
});

describe('stickers', () => {
  const sticker = (id: string, guild: string, name: string, tags: string, description: string | null = null): Sticker => ({ id, guild_id: guild, name, description, tags, format_type: StickerFormat.PNG, url: `https://x/${id}.png`, available: true });
  const wave = sticker('1', 'g1', 'wave', 'hello,hi,greeting', 'A friendly wave');
  const party = sticker('2', 'g2', 'party-cat', 'celebrate,confetti');

  it('matches name, tags and description by word prefix, every query word required', () => {
    expect(stickerMatches(wave, '')).toBe(true);
    expect(stickerMatches(wave, 'wav')).toBe(true);
    expect(stickerMatches(wave, 'HELLO')).toBe(true);
    expect(stickerMatches(wave, 'greet')).toBe(true);
    expect(stickerMatches(wave, 'friendly')).toBe(true);
    expect(stickerMatches(wave, 'hello friendly')).toBe(true);
    expect(stickerMatches(wave, 'hello party')).toBe(false);
    expect(stickerMatches(wave, 'ello')).toBe(false);
    expect(stickerMatches(party, 'cat')).toBe(true);
    expect(stickerMatches(party, 'confetti')).toBe(true);
  });

  it('groups by server with the current server first, skipping empty groups', () => {
    const guilds = { g1: { name: 'One' }, g2: { name: 'Two' }, g3: { name: 'Three' } };
    const byGuild = { g1: [wave], g2: [party], g3: [] };
    expect(groupStickers(['g1', 'g2', 'g3'], byGuild, guilds, '', 'g2').map(g => g.name)).toEqual(['Two', 'One']);
    expect(groupStickers(['g1', 'g2', 'g3'], byGuild, guilds, '', null).map(g => g.name)).toEqual(['One', 'Two']);
    expect(groupStickers(['g1', 'g2'], byGuild, guilds, 'confetti', 'g1').map(g => g.name)).toEqual(['Two']);
    expect(groupStickers(['g1', 'g2'], byGuild, guilds, 'zzz', 'g1')).toEqual([]);
    // a server the user left (no entry in `guilds`) is not shown
    expect(groupStickers(['g1'], byGuild, {}, '', null)).toEqual([]);
  });

  it('allows own-server stickers always and external ones only with USE_EXTERNAL_STICKERS (DMs always)', () => {
    expect(canUseSticker(wave, 'g1', 0n)).toBe(true);
    expect(canUseSticker(wave, 'g2', 0n)).toBe(false);
    expect(canUseSticker(wave, 'g2', Perm.USE_EXTERNAL_STICKERS)).toBe(true);
    expect(canUseSticker(wave, null, null)).toBe(true);
    expect(canUseSticker(wave, 'g2', null)).toBe(true);
  });
});

describe('message snippets', () => {
  const base = { content: '', attachments: [] as Attachment[], mentions: [] as User[] };
  const file = (name: string): Attachment => ({ id: name, filename: name, content_type: null, size: 1, url: 'x', width: null, height: null });

  it('makes mentions, channels and custom emoji readable and collapses whitespace', () => {
    const text = messageSnippet({ ...base, content: 'hi <@2>\n\n see <#9> <:wave:123> <@&5> <@77>', mentions: [{ ...user('2', 'alice'), global_name: 'Alice' }] });
    expect(text).toBe('hi @Alice see #channel :wave: @role @user');
  });

  it('names stickers, attachments and forwards when there is no text, and truncates long text', () => {
    expect(messageSnippet({ ...base, sticker_items: [{ id: '1', name: 'wave', format_type: StickerFormat.PNG, url: 'x' }] })).toBe('Sticker: wave');
    expect(messageSnippet({ ...base, attachments: [file('cat.png')] })).toBe('cat.png');
    expect(messageSnippet({ ...base, attachments: [file('a'), file('b')] })).toBe('2 attachments');
    expect(messageSnippet(base)).toBe('Message');
    const fwd = messageSnippet({ ...base, message_snapshots: [{ message: { type: 0, content: 'original words', timestamp: 't', edited_timestamp: null, mentions: [], attachments: [], embeds: [] } }] });
    expect(fwd).toBe('Forwarded: original words');
    const long = messageSnippet({ ...base, content: 'x'.repeat(500) }, 50);
    expect(long).toHaveLength(50);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('list transitions', () => {
  const message = (id: string, channel = 'c1'): Message => ({
    id, channel_id: channel, guild_id: null, author: user('1'), content: id, timestamp: 't', edited_timestamp: null, type: 0, mentions: [], mention_everyone: false, attachments: [], embeds: [],
    reactions: [], pinned: false, tts: false, message_reference: null, referenced_message: null, nonce: null,
  });
  const bookmark = (id: string): Bookmark => ({ message: message(id), saved_at: '2026-01-01T00:00:00Z' });
  const reminder = (id: string, at: string, delivered: string | null = null, messageId = `m${id}`): Reminder => ({ id, channel_id: 'c1', message_id: messageId, guild_id: null, remind_at: at, created_at: at, delivered_at: delivered, message: null });

  it('bookmarks: newest saved first, re-saving moves to the top, removal by ids', () => {
    let list = upsertBookmark([], bookmark('1'));
    list = upsertBookmark(list, bookmark('2'));
    list = upsertBookmark(list, bookmark('1'));
    expect(list.map(b => b.message.id)).toEqual(['1', '2']);
    expect(isBookmarked(list, 'c1', '2')).toBe(true);
    expect(isBookmarked(list, 'c2', '2')).toBe(false);
    expect(isBookmarked(null, 'c1', '2')).toBe(false);
    expect(removeBookmark(list, 'c1', '2').map(b => b.message.id)).toEqual(['1']);
    expect(removeBookmark(list, 'other', '2')).toHaveLength(2);
  });

  it('reminders: ordered by remind_at, replaced by id, found by message, due ones first in the inbox', () => {
    let list = upsertReminder([], reminder('a', '2026-01-03T00:00:00Z'));
    list = upsertReminder(list, reminder('b', '2026-01-01T00:00:00Z'));
    list = upsertReminder(list, reminder('a', '2026-01-02T00:00:00Z', '2026-01-02T00:00:01Z'));
    expect(list.map(r => r.id)).toEqual(['b', 'a']);
    expect(list.find(r => r.id === 'a')?.delivered_at).not.toBeNull();
    expect(reminderOf(list, 'mb')?.id).toBe('b');
    expect(reminderOf(null, 'mb')).toBeUndefined();
    expect(sortReminders(list).map(r => r.id)).toEqual(['a', 'b']);
    expect(removeReminder(list, 'b').map(r => r.id)).toEqual(['a']);
  });

  it('deleted messages, channels and guilds drop their bookmarks and reminders', () => {
    const inGuild = (b: Bookmark, guild: string): Bookmark => ({ ...b, message: { ...b.message, guild_id: guild } });
    const bookmarks = [bookmark('1'), { ...bookmark('2'), message: message('2', 'c2') }, inGuild({ ...bookmark('3'), message: message('3', 'c3') }, 'g1')];
    expect(purgeBookmarks(bookmarks, { messageId: '1' }).map(b => b.message.id)).toEqual(['2', '3']);
    expect(purgeBookmarks(bookmarks, { channelId: 'c2' }).map(b => b.message.id)).toEqual(['1', '3']);
    expect(purgeBookmarks(bookmarks, { guildId: 'g1' }).map(b => b.message.id)).toEqual(['1', '2']);
    expect(purgeBookmarks(bookmarks, { messageId: 'nope' })).toHaveLength(3);
    const reminders = [reminder('a', 't', null, 'm1'), { ...reminder('b', 't', null, 'm2'), channel_id: 'c2' }, { ...reminder('c', 't', null, 'm3'), guild_id: 'g1' }];
    expect(purgeReminders(reminders, { messageId: 'm1' }).map(r => r.id)).toEqual(['b', 'c']);
    expect(purgeReminders(reminders, { channelId: 'c2' }).map(r => r.id)).toEqual(['a', 'c']);
    expect(purgeReminders(reminders, { guildId: 'g1' }).map(r => r.id)).toEqual(['a', 'b']);
  });

  it('notices: one per reminder, newest last, at most three, droppable', () => {
    let notices: Reminder[] = [];
    for (const id of ['1', '2', '3', '4']) notices = pushNotice(notices, reminder(id, 't'));
    expect(notices.map(n => n.id)).toEqual(['2', '3', '4']);
    notices = pushNotice(notices, reminder('2', 't'));
    expect(notices.map(n => n.id)).toEqual(['3', '4', '2']);
    expect(dropNotice(notices, '4').map(n => n.id)).toEqual(['3', '2']);
  });

  it('favourites: newest first and a known id moves up', () => {
    const gif = (id: string): Gif => ({ id, title: id, url: 'u', preview_url: 'p', width: 1, height: 1 });
    let list = addFavorite([], gif('a'));
    list = addFavorite(list, gif('b'));
    list = addFavorite(list, gif('a'));
    expect(list.map(g => g.id)).toEqual(['a', 'b']);
    expect(removeFavorite(list, 'a').map(g => g.id)).toEqual(['b']);
  });
});
