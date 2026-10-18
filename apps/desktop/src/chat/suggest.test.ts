import { describe, expect, it } from 'vitest';
import { ChannelType, type Channel } from '../api/types';
import { matchRank, mentionableChannels, userSuggestions } from './suggest';

const ch = (id: string, name: string, type: ChannelType | number) => ({ id, name, type }) as Channel;

describe('matchRank', () => {
  it('prefix, word start, substring, none', () => {
    expect(matchRank('', 'x')).toBe(0);
    expect(matchRank('al', 'Alice')).toBe(0);
    expect(matchRank('sm', 'john smith')).toBe(1);
    expect(matchRank('be', 'amber_berry')).toBe(1);
    expect(matchRank('ic', 'Alice')).toBe(2);
    expect(matchRank('zz', 'Alice', 'alice99')).toBe(3);
    expect(matchRank('al', 'Bob', 'alice')).toBe(0);
  });
});

describe('mentionableChannels', () => {
  const list = [
    ch('1', 'general', ChannelType.GuildText), ch('2', 'announcements', ChannelType.GuildAnnouncement), ch('3', 'support', ChannelType.GuildForum),
    ch('4', 'Gaming', ChannelType.GuildVoice), ch('5', 'stage', ChannelType.GuildStage), ch('6', 'Text Channels', ChannelType.GuildCategory),
    ch('7', 'gallery', 16), ch('8', 'a thread', ChannelType.PublicThread), ch('9', 'dm', ChannelType.DM),
  ];
  it('keeps every mentionable type, never categories or DMs', () => {
    expect(mentionableChannels(list, '', 20).map(c => c.id)).toEqual(['1', '2', '3', '4', '5', '7', '8']);
    expect(mentionableChannels(list, 'ann', 20).map(c => c.name)).toEqual(['announcements']);
    expect(mentionableChannels(list, 'gam', 20).map(c => c.name)).toEqual(['Gaming']);
  });
  it('ranks prefix matches first, then keeps the given order', () => {
    expect(mentionableChannels(list, 'a', 20).map(c => c.name)).toEqual(['announcements', 'a thread', 'general', 'Gaming', 'stage', 'gallery']);
    expect(mentionableChannels(list, '', 2).map(c => c.id)).toEqual(['1', '2']);
  });
});

describe('userSuggestions', () => {
  const people = Array.from({ length: 14 }, (_, i) => ({ id: `u${i}`, name: `Person ${String(i).padStart(2, '0')}`, username: `p${i}` }));
  const roles = [{ id: 'r1', name: 'Moderator' }, { id: 'r2', name: 'Events' }];
  const kinds = (q: string, everyone = true) => userSuggestions(people, roles, q, everyone).map(s => (s.kind === 'user' ? s.person.id : s.kind === 'role' ? s.role.name : `@${s.name}`));

  it('keeps roles and @everyone/@here under the cap', () => {
    const rows = kinds('');
    expect(rows).toHaveLength(12);
    expect(rows.slice(8)).toEqual(['Events', 'Moderator', '@everyone', '@here']);
  });
  it('@everyone/@here only with the permission', () => {
    expect(kinds('', false)).not.toContain('@here');
    expect(kinds('', false).filter(r => r.startsWith('u'))).toHaveLength(8);
  });
  it('word-start matches before substring matches', () => {
    const list = [{ id: 'a', name: 'Alice', username: 'alice' }, { id: 'b', name: 'amber_eve', username: 'amber' }, { id: 'c', name: 'Eve', username: 'eve' }];
    const rows = userSuggestions(list, roles, 'e', true).map(s => (s.kind === 'user' ? s.person.name : s.kind === 'role' ? s.role.name : s.name));
    expect(rows).toEqual(['Eve', 'amber_eve', 'Alice', 'Events', 'Moderator', 'everyone']);
  });
  it('ten members when nothing else matches', () => {
    expect(kinds('person')).toHaveLength(10);
  });
});
