import { describe, expect, it } from 'vitest';
import type { Message } from '../api/types';
import { applyReaction, buildRows, type ChannelState, emptyState, mentionsRole, replaceWindow, upsertMessage, withLateArrivals } from './messageState';
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

describe('thread messages', () => {
  it('a thread starter (type 21) and a thread notice (type 18) are not grouped with their neighbours', () => {
    expect(rows([msg('1', 'a', 0, 21), msg('2', 'a', 1)]).map(r => r.grouped)).toEqual([false, false]);
    expect(rows([msg('1', 'a', 0), msg('2', 'a', 1, 18), msg('3', 'a', 2)]).map(r => r.grouped)).toEqual([false, false, false]);
  });
});

describe('mentionsRole', () => {
  it('matches a role mention of one of the viewer roles only', () => {
    expect(mentionsRole('hey <@&100> and <@&200>', ['200'])).toBe(true);
    expect(mentionsRole('hey <@&100>', ['200'])).toBe(false);
    expect(mentionsRole('<@200> <#200> @200', ['200'])).toBe(false);
    expect(mentionsRole('<@&100>', [])).toBe(false);
  });

  it('ignores mentions in inline code, fenced blocks and escaped ones', () => {
    expect(mentionsRole('`<@&100>`', ['100'])).toBe(false);
    expect(mentionsRole('see ``<@&100>`` here', ['100'])).toBe(false);
    expect(mentionsRole('```\n<@&100>\n```', ['100'])).toBe(false);
    expect(mentionsRole('\\<@&100>', ['100'])).toBe(false);
    expect(mentionsRole('`x` <@&100>', ['100'])).toBe(true);
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


describe('applyReaction with super reactions', () => {
  const fire = { id: null, name: '🔥' };
  const start = (): ChannelState => ({ ...emptyState(), status: 'ready', messages: [msg('1', 'a', 0)] });
  const reactionOf = (s: ChannelState) => s.messages[0]!.reactions[0];

  it('keeps normal and burst counts apart on one entry', () => {
    let s = start();
    s = applyReaction(s, '1', fire, true, true, true);
    expect(reactionOf(s)).toMatchObject({ count: 1, count_details: { normal: 0, burst: 1 }, me: false, me_burst: true });
    s = applyReaction(s, '1', fire, false, true);
    s = applyReaction(s, '1', fire, true, true, true); // our own echo after the optimistic add: no change
    expect(reactionOf(s)).toMatchObject({ count: 2, count_details: { normal: 1, burst: 1 }, me: false, me_burst: true });
    s = applyReaction(s, '1', fire, true, false, true);
    expect(reactionOf(s)).toMatchObject({ count: 1, count_details: { normal: 1, burst: 0 }, me_burst: false });
    s = applyReaction(s, '1', fire, false, false);
    expect(s.messages[0]!.reactions).toEqual([]);
  });
});

describe('reactions from a server without super reactions', () => {
  it('reads them as normal reactions, so the pills and later updates still work', () => {
    const legacy = { ...msg('1', 'a', 0), reactions: [{ emoji: { id: null, name: '🔥' }, count: 2, me: true }] } as unknown as Message;
    let s = upsertMessage({ ...emptyState(), status: 'ready' }, legacy);
    expect(s.messages[0]!.reactions[0]).toEqual({ emoji: { id: null, name: '🔥' }, count: 2, me: true, me_burst: false, count_details: { normal: 2, burst: 0 }, burst_colors: [] });
    s = applyReaction(s, '1', { id: null, name: '🔥' }, false, true);
    expect(s.messages[0]!.reactions[0]).toMatchObject({ count: 3, count_details: { normal: 3, burst: 0 } });
  });
});
