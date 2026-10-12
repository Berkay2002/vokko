import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestMock = vi.hoisted(() => vi.fn());
vi.mock('../api/rest', async orig => ({ ...(await orig<typeof import('../api/rest')>()), request: requestMock }));

import { appStore } from '../api/store';
import { ChannelType, type Channel } from '../api/types';
import { markGuildRead, markGuildsRead } from './actions';

const channel = (id: string, guild_id: string, last: string | null, type = ChannelType.GuildText) => ({ id, guild_id, type, last_message_id: last, name: id }) as unknown as Channel;

function seed(channels: Channel[], read: Record<string, string>) {
  appStore.setState({
    channels: Object.fromEntries(channels.map(c => [c.id, c])),
    readStates: Object.fromEntries(Object.entries(read).map(([id, last]) => [id, { id, last_message_id: last, mention_count: 0 }])),
  } as never);
}

describe('markGuildsRead (Mark Folder As Read)', () => {
  beforeEach(() => { requestMock.mockReset(); requestMock.mockResolvedValue(undefined); });

  it('sends one bulk ack for every unread channel across the folder and skips guilds with nothing unread', async () => {
    seed([
      channel('10', '1', '100'),
      channel('11', '1', '110'),
      channel('20', '2', '200'),
      channel('21', '2', '210', ChannelType.GuildCategory),
      channel('30', '3', '300'),
    ], { '11': '110', '30': '300' });
    await markGuildsRead(['1', '2', '3']);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith('POST', '/read-states/ack-bulk', { read_states: [
      { channel_id: '10', message_id: '100' },
      { channel_id: '20', message_id: '200' },
    ] });
  });

  it('sends nothing when no guild of the folder is unread', async () => {
    seed([channel('10', '1', '100')], { '10': '100' });
    await markGuildsRead(['1', '2']);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('splits into chunks of 100 entries', async () => {
    const many = Array.from({ length: 150 }, (_, i) => channel(String(1000 + i), String(1 + (i % 3)), String(5000 + i)));
    seed(many, {});
    await markGuildsRead(['1', '2', '3']);
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock.mock.calls.map(c => (c[2] as { read_states: unknown[] }).read_states.length)).toEqual([100, 50]);
  });

  it('markGuildRead acks one guild in one request', async () => {
    seed([channel('10', '1', '100'), channel('11', '1', '110'), channel('20', '2', '200')], {});
    await markGuildRead('1');
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock.mock.calls[0]?.[2]).toEqual({ read_states: [{ channel_id: '10', message_id: '100' }, { channel_id: '11', message_id: '110' }] });
  });
});
