import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestMock = vi.hoisted(() => vi.fn());
vi.mock('../api/rest', async orig => ({ ...(await orig<typeof import('../api/rest')>()), request: requestMock }));

import { appStore } from '../api/store';
import { ChannelType, type Channel, type Message, type ReadState } from '../api/types';
import { markChannelsRead, markGuildsRead } from './actions';
import { unreadPreview, unreadRows } from './InboxUnreads';
import { clearPreviews, loadPreview, previewCreate, previewDrop, previewOf } from './inboxPreviews';

const channel = (id: string, last: string | null, extra: Partial<Channel> = {}) => ({ id, guild_id: '1', type: ChannelType.GuildText, last_message_id: last, name: id, ...extra }) as unknown as Channel;
const read = (channel_id: string, last_message_id: string | null, mention_count = 0): ReadState => ({ channel_id, last_message_id, mention_count }) as ReadState;
const view = (channels: Channel[], reads: ReadState[], threads: Channel[] = []) => ({ channels: Object.fromEntries(channels.map(c => [c.id, c])), threads: Object.fromEntries(threads.map(c => [c.id, c])), readStates: Object.fromEntries(reads.map(r => [r.channel_id, r])) }) as never;

describe('unreadRows (Inbox > Unreads)', () => {
  it('lists unread channels newest first, skipping read ones and categories, keeping voice text chats', () => {
    const rows = unreadRows(view([
      channel('10', '100'),
      channel('11', '300'),
      channel('12', '120'),
      channel('13', '500', { type: ChannelType.GuildCategory }),
      channel('14', '200', { type: ChannelType.GuildVoice }),
    ], [read('12', '120'), read('11', '250', 2)]));
    expect(rows.map(r => r.channel.id)).toEqual(['11', '14', '10']);
    expect(rows[0]?.mentions).toBe(2);
  });

  it('drops a muted channel or one in a muted category, mentions or not', () => {
    const muted = new Set(['10', 'cat']);
    const rows = unreadRows(view([
      channel('10', '100'),
      channel('11', '110', { parent_id: 'cat' }),
      channel('12', '120', { parent_id: 'cat' }),
      channel('13', '130'),
    ], [read('12', '1', 1)]), id => muted.has(id));
    expect(rows.map(r => r.channel.id)).toEqual(['13']);
  });
});

describe('unreadRows with threads', () => {
  const member = { id: 't', user_id: 'me', join_timestamp: '', flags: 0, muted: false, mute_config: null };
  const thread = (id: string, last: string, extra: Partial<Channel> = {}) => channel(id, last, { type: ChannelType.PublicThread, parent_id: '10', member, ...extra } as Partial<Channel>);

  it('lists an unread joined thread among the channels by newest activity', () => {
    const rows = unreadRows(view([channel('10', '100', { type: ChannelType.GuildText })], [read('10', '100'), read('20', '150', 1)], [thread('20', '300')]));
    expect(rows.map(r => r.channel.id)).toEqual(['20']);
    expect(rows[0]?.mentions).toBe(1);
  });

  it('hides a thread under a muted channel, category or its own mute, and one with no read state', () => {
    const threads = [thread('20', '300')];
    const channels = [channel('10', '100', { parent_id: 'cat' })];
    const reads = [read('10', '100'), read('20', '150')];
    expect(unreadRows(view(channels, reads, threads), id => id === '10')).toEqual([]);
    expect(unreadRows(view(channels, reads, threads), id => id === 'cat')).toEqual([]);
    expect(unreadRows(view(channels, reads, [thread('20', '300', { member: { ...member, muted: true, mute_config: { end_time: null } } } as Partial<Channel>)]))).toEqual([]);
    expect(unreadRows(view(channels, [read('10', '100')], threads))).toEqual([]);
    expect(unreadRows(view(channels, reads, threads)).map(r => r.channel.id)).toEqual(['20']);
  });
});

describe('unreadPreview', () => {
  const page = ['30', '20', '10'].map(id => ({ id }) as Message);
  it('keeps the messages after the read pointer, oldest first', () => {
    expect(unreadPreview(page, '15').map(m => m.id)).toEqual(['20', '30']);
  });
  it('shows the whole page for a channel never read', () => {
    expect(unreadPreview(page, null).map(m => m.id)).toEqual(['10', '20', '30']);
  });
});

describe('markChannelsRead (Mark All as Read)', () => {
  beforeEach(() => { requestMock.mockReset(); requestMock.mockResolvedValue(undefined); });

  it('acks the shown message ids, skipping channels already read that far', async () => {
    appStore.setState(view([], [read('11', '110'), read('12', '90')]));
    await markChannelsRead([{ channel_id: '10', message_id: '100' }, { channel_id: '11', message_id: '110' }, { channel_id: '12', message_id: '120' }]);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith('POST', '/read-states/ack-bulk', { read_states: [{ channel_id: '10', message_id: '100' }, { channel_id: '12', message_id: '120' }] });
  });

  it('sends nothing when every channel is read', async () => {
    appStore.setState(view([], [read('10', '100')]));
    await markChannelsRead([{ channel_id: '10', message_id: '100' }]);
    expect(requestMock).not.toHaveBeenCalled();
  });
});

describe('markGuildsRead (Mark Server as Read)', () => {
  beforeEach(() => { requestMock.mockReset(); requestMock.mockResolvedValue(undefined); });

  it('acks the unread channels and the unread joined threads of the server, not archived or read ones', async () => {
    const member = { id: 't', user_id: 'me', join_timestamp: '', flags: 0, muted: false, mute_config: null };
    const thread = (id: string, last: string, extra: Partial<Channel> = {}) => channel(id, last, { type: ChannelType.PublicThread, parent_id: '10', member, ...extra } as Partial<Channel>);
    const state = view([channel('10', '100')], [read('10', '90'), read('20', '150'), read('21', '400'), read('22', '150')], [thread('20', '300'), thread('21', '400'), thread('22', '300', { thread_metadata: { archived: true } } as Partial<Channel>)]);
    appStore.setState(state);
    await markGuildsRead(['1']);
    expect(requestMock).toHaveBeenCalledWith('POST', '/read-states/ack-bulk', { read_states: [{ channel_id: '10', message_id: '100' }, { channel_id: '20', message_id: '300' }] });
  });
});

describe('inboxPreviews (one request per channel, then gateway events)', () => {
  const msg = (id: string, channel_id = '10') => ({ id, channel_id }) as Message;
  const settle = () => new Promise(r => setTimeout(r, 0));
  beforeEach(() => { requestMock.mockReset(); clearPreviews(); });

  it('fetches a channel once and keeps it current from new messages', async () => {
    requestMock.mockResolvedValue([msg('30'), msg('20'), msg('10')]);
    loadPreview('10');
    loadPreview('10');
    await settle();
    loadPreview('10');
    previewCreate(msg('40'));
    previewCreate(msg('40'));
    previewCreate(msg('99', 'other'));
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(previewOf('10')?.map(m => m.id)).toEqual(['40', '30', '20']);
    expect(previewOf('other')).toBeUndefined();
  });

  it('drops a channel when a message it holds is edited or deleted, and refetches on the next load', async () => {
    requestMock.mockResolvedValue([msg('30'), msg('20')]);
    loadPreview('10');
    await settle();
    previewDrop('10', ['5']);
    expect(previewOf('10')).toBeDefined();
    previewDrop('10', ['20']);
    expect(previewOf('10')).toBeUndefined();
    loadPreview('10');
    await settle();
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it('clears everything on sign-out', async () => {
    requestMock.mockResolvedValue([msg('30')]);
    appStore.setState({ token: 't' } as never);
    loadPreview('10');
    await settle();
    appStore.setState({ token: null } as never);
    expect(previewOf('10')).toBeUndefined();
  });
});
