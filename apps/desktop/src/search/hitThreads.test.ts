import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/rest', () => ({ request: vi.fn(), resolveUrl: (url: string) => url }));
vi.mock('../api/gateway', () => ({ gateway: { on: () => () => undefined, onStatus: () => () => undefined } }));

import { appStore } from '../api/store';
import { ChannelType, type Channel, type ThreadMember } from '../api/types';
import { rememberHitThreads } from './hitThreads';

const member = (extra: Partial<ThreadMember> = {}): ThreadMember => ({ id: '1', user_id: '10', join_timestamp: '2026-01-01T00:00:00.000Z', flags: 0, muted: false, mute_config: null, ...extra });
const thread = (extra: Partial<Channel> = {}): Channel => ({ id: '1', type: ChannelType.PublicThread, guild_id: '100', name: 't', topic: null, position: 0, parent_id: '200', last_message_id: '5', message_count: 5, ...extra });
const known = () => appStore.getState().threads['1'];

beforeEach(() => appStore.setState({ threads: {} }));

describe('rememberHitThreads', () => {
  it('adds a thread the store does not have, with its membership from the response', () => {
    rememberHitThreads({ threads: [thread()], members: [member({ flags: 2 })] });
    expect(known()?.name).toBe('t');
    expect(known()?.member?.flags).toBe(2);
  });

  it('keeps a known thread as is (a newer last_message_id and count win) and merges only the membership', () => {
    appStore.getState().upsertThread(thread({ last_message_id: '9', message_count: 9, name: 'renamed' }));
    rememberHitThreads({ threads: [thread()], members: [member({ flags: 2 })] });
    expect(known()).toMatchObject({ last_message_id: '9', message_count: 9, name: 'renamed' });
    expect(known()?.member?.flags).toBe(2);
  });

  it('leaves a known thread and its membership alone when the response has none', () => {
    appStore.getState().upsertThread(thread({ last_message_id: '9', member: member({ flags: 4 }) }));
    rememberHitThreads({ threads: [thread()] });
    expect(known()).toMatchObject({ last_message_id: '9' });
    expect(known()?.member?.flags).toBe(4);
  });

  it('does nothing for a response without threads', () => {
    rememberHitThreads({});
    expect(appStore.getState().threads).toEqual({});
  });
});
