import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../api/types';
import { LIVE_KEEP, LIVE_MAX } from './messageState';

const handlers = new Map<string, (d: unknown) => void>();
vi.mock('./shell', () => ({
  gateway: { on: (event: string, fn: (d: unknown) => void) => { handlers.set(event, fn); return () => {}; } },
  request: vi.fn(),
  setLocalReadPointer: vi.fn(),
}));
const { messageStore } = await import('./messageStore');

const msg = (channel: string, n: number): Message => ({
  id: String(1_000_000 + n), channel_id: channel, author: { id: 'a', username: 'a' }, content: String(n), timestamp: new Date(n * 1000).toISOString(),
  type: 0, mentions: [], reactions: [], attachments: [], pinned: false,
} as unknown as Message);

/** An open channel holding LIVE_MAX messages, whose list reports `canTrim`; returns a function that delivers one more. */
function openFull(channel: string, canTrim: () => boolean): () => number {
  messageStore.seed(channel, Array.from({ length: LIVE_MAX }, (_, i) => msg(channel, i)));
  messageStore.subscribe(channel, () => {});
  messageStore.setFollowing(channel, canTrim);
  let n = LIVE_MAX;
  return () => { handlers.get('MESSAGE_CREATE')!(msg(channel, n++)); return messageStore.getState(channel).messages.length; };
}

describe('live trim of an open channel', () => {
  it('trims while the list follows the bottom', () => {
    expect(openFull('c1', () => true)()).toBe(LIVE_KEEP);
  });

  it('keeps every message while the list says the user is interacting (an edit draft, a picker, a selection)', () => {
    let editing = true;
    const deliver = openFull('c2', () => !editing);
    expect(deliver()).toBe(LIVE_MAX + 1);
    expect(deliver()).toBe(LIVE_MAX + 2);
    editing = false;
    expect(deliver()).toBe(LIVE_KEEP);
  });

  it('keeps every message when the list closed its report (not following)', () => {
    const deliver = openFull('c3', () => true);
    messageStore.setFollowing('c3', null);
    expect(deliver()).toBe(LIVE_MAX + 1);
  });
});
