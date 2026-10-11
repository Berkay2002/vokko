import { describe, expect, it } from 'vitest';
import type { Message } from '../api/types';
import { buildRows } from './messageState';
import { formatMessageTimestamp, sameDay } from './util';

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

describe('formatMessageTimestamp', () => {
  const now = new Date(2026, 9, 10, 15, 0);
  it('shows only the time today', () => {
    expect(formatMessageTimestamp(new Date(2026, 9, 10, 9, 5), now)).not.toMatch(/Today|Yesterday|2026/);
  });
  it('prefixes yesterday', () => {
    expect(formatMessageTimestamp(new Date(2026, 9, 9, 9, 5), now)).toMatch(/^Yesterday at /);
  });
  it('shows the date for older messages', () => {
    expect(formatMessageTimestamp(new Date(2026, 8, 1, 9, 5), now)).toMatch(/2026/);
  });
});
