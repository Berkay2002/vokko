import { describe, expect, it } from 'vitest';
import type { AppState } from '../api/store';
import { ChannelType, type Channel } from '../api/types';
import { whereText } from './InboxLists';

const ch = (id: string, extra: Partial<Channel> = {}) => ({ id, type: ChannelType.GuildText, guild_id: 'g', name: id, ...extra }) as Channel;
const state = (channels: Channel[], threads: Channel[] = []) => ({
  channels: Object.fromEntries(channels.map(c => [c.id, c])),
  threads: Object.fromEntries(threads.map(c => [c.id, c])),
  guilds: { g: { id: 'g', name: 'Lab' } },
}) as unknown as AppState;

describe('whereText', () => {
  it('names a channel, a thread with its parent, a DM and an unknown channel', () => {
    const s = state([ch('general'), ch('dm', { type: ChannelType.DM, guild_id: undefined, name: null, recipients: [{ id: 'u', username: 'alice' }] as Channel['recipients'] })], [ch('t', { type: ChannelType.PublicThread, name: 'gateway docs', parent_id: 'general' })]);
    expect(whereText(s, { channel_id: 'general', guild_id: 'g' })).toBe('#general · Lab');
    expect(whereText(s, { channel_id: 't', guild_id: 'g' })).toBe('gateway docs, in #general · Lab');
    expect(whereText(s, { channel_id: 'dm', guild_id: null })).toBe('Direct message with alice');
    expect(whereText(s, { channel_id: 'gone', guild_id: 'g' })).toBe('A channel you can no longer see');
  });
});
