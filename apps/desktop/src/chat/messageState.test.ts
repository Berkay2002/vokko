import { describe, expect, it } from 'vitest';
import type { Message } from '../api/types';
import { buildRows, emptyState, replaceWindow, withLateArrivals } from './messageState';
import { sameDay } from './util';

const BASE = Date.UTC(2026, 9, 10, 12, 0, 0);
const msg = (id: string, author: string, minute: number, type = 0): Message => ({
  id, channel_id: 'c', author: { id: author, username: author }, content: id, timestamp: new Date(BASE + minute * 60_000).toISOString(),
  type, mentions: [], reactions: [], attachments: [], pinned: false,
} as unknown as Message);

const rows = (messages: Message[]) =>
  buildRows({ messages, pending: [], hasMoreAfter: false, lastReadAtOpen: null }, d => d.toISOString(), sameDay, 'me');

describe('buildRows grouping', () => {
  it('groups consecutive messages from one author within 7 minutes', () => {
    expect(rows([msg('1', 'a', 0), msg('2', 'a', 3), msg('3', 'a', 6)]).map(r => r.grouped)).toEqual([false, true, true]);
  });

  it('measures the window from the first message of the group, not the previous one', () => {
    // 0, 5, 10: each step is under 7 minutes, but the third is 10 minutes after the group's first.
    expect(rows([msg('1', 'a', 0), msg('2', 'a', 5), msg('3', 'a', 10)]).map(r => r.grouped)).toEqual([false, true, false]);
  });

  it('starts a new group on author change and on replies', () => {
    expect(rows([msg('1', 'a', 0), msg('2', 'b', 1), msg('3', 'b', 2, 19)]).map(r => r.grouped)).toEqual([false, false, false]);
  });
});

describe('withLateArrivals', () => {
  const state = (messages: Message[]) => ({ ...emptyState(), messages });

  it('keeps a gateway message that arrived while the latest page was in flight', () => {
    const page = [msg('10', 'a', 0), msg('11', 'a', 1)];
    const merged = replaceWindow(state([msg('12', 'b', 2)]), withLateArrivals(state([msg('12', 'b', 2)]), page), { hasMoreBefore: false, hasMoreAfter: false });
    expect(merged.messages.map(m => m.id)).toEqual(['10', '11', '12']);
  });

  it('does not duplicate messages the page already contains, and drops older stale ones', () => {
    const page = [msg('10', 'a', 0), msg('11', 'a', 1)];
    const merged = replaceWindow(state([msg('5', 'a', 0), msg('11', 'a', 1)]), withLateArrivals(state([msg('5', 'a', 0), msg('11', 'a', 1)]), page), { hasMoreBefore: false, hasMoreAfter: false });
    expect(merged.messages.map(m => m.id)).toEqual(['10', '11']);
  });

  it('keeps everything the gateway delivered when the page is empty', () => {
    expect(withLateArrivals(state([msg('7', 'a', 0)]), []).map(m => m.id)).toEqual(['7']);
  });
});

