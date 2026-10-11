import { describe, expect, it } from 'vitest';
import { ChannelType, type Channel } from '../api/types';
import { mentionTarget, type MentionLookups } from './mentions';

const ch = (id: string, type: ChannelType): Channel => ({ id, type, guild_id: 'g1', name: `c${id}`, position: 0 } as Channel);
const env: MentionLookups = {
  guildId: 'g1',
  channels: [ch('1', ChannelType.GuildText), ch('2', ChannelType.GuildVoice), ch('3', ChannelType.GuildCategory)],
  hasUser: id => id === 'u1',
};

describe('mentionTarget', () => {
  it('a known user opens their profile in the current guild', () => {
    expect(mentionTarget('user', 'u1', env)).toEqual({ type: 'profile', userId: 'u1', guildId: 'g1' });
    expect(mentionTarget('user', 'u1', { ...env, guildId: null })).toEqual({ type: 'profile', userId: 'u1', guildId: null });
  });

  it('an unknown user has no target', () => {
    expect(mentionTarget('user', 'u2', env)).toBeNull();
  });

  it('text and voice channels of the guild navigate', () => {
    expect(mentionTarget('channel', '1', env)).toEqual({ type: 'channel', channel: env.channels[0] });
    expect(mentionTarget('channel', '2', env)).toEqual({ type: 'channel', channel: env.channels[1] });
  });

  it('unknown channels, other guilds and DMs, and categories have no target', () => {
    expect(mentionTarget('channel', '9', env)).toBeNull();
    expect(mentionTarget('channel', '3', env)).toBeNull();
    expect(mentionTarget('channel', '1', { ...env, guildId: null, channels: [] })).toBeNull();
  });

  it('roles have no target', () => {
    expect(mentionTarget('role', 'r1', env)).toBeNull();
  });
});
