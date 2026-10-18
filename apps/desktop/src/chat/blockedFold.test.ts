import { describe, expect, it } from 'vitest';
import type { Message } from '../api/types';
import { foldBlocked, foldLabel } from './blockedFold';
import type { Row } from './messageState';

const row = (id: string, author: string, patch: Partial<Row> = {}): Row => ({
  key: id, message: { id, author: { id: author } } as unknown as Message, pending: null, grouped: false, dayLabel: null, unreadDivider: false, ...patch,
});
const blocked = (id: string) => id === 'nova';
const ids = (rows: Row[]) => rows.map(r => r.message.id);

describe('foldBlocked', () => {
  const rows = [row('1', 'bob'), row('2', 'nova'), row('3', 'nova'), row('4', 'nova'), row('5', 'bob')];

  it('turns a run into its first row carrying the fold', () => {
    const f = foldBlocked(rows, blocked, new Set());
    expect(ids(f.rows)).toEqual(['1', '2', '5']);
    expect(f.rows[1]!.fold).toEqual({ ids: ['2', '3', '4'], open: false });
    expect([...f.closed.keys()]).toEqual(['2', '3', '4']);
  });

  it('keeps every row of an open run, the fold bar on the first', () => {
    const f = foldBlocked(rows, blocked, new Set(['3']));
    expect(ids(f.rows)).toEqual(['1', '2', '3', '4', '5']);
    expect(f.rows[1]!.fold?.open).toBe(true);
    expect(f.rows[2]!.fold).toBeUndefined();
    expect(f.closed.size).toBe(0);
  });

  it('ends a run at a day divider or the NEW divider, so neither is swallowed', () => {
    const split = [row('1', 'nova'), row('2', 'nova', { dayLabel: 'Tuesday' }), row('3', 'nova', { unreadDivider: true })];
    const f = foldBlocked(split, blocked, new Set());
    expect(ids(f.rows)).toEqual(['1', '2', '3']);
    expect(f.rows.map(r => r.fold?.ids.length)).toEqual([1, 1, 1]);
  });

  it('never folds my pending sends and leaves other authors alone', () => {
    const pending = row('9', 'nova', { pending: {} as Row['pending'] });
    expect(ids(foldBlocked([pending], blocked, new Set()).rows)).toEqual(['9']);
    expect(foldBlocked([row('1', 'bob')], blocked, new Set()).rows[0]!.fold).toBeUndefined();
  });

  it('counts the hidden rows older than an anchor, for firstItemIndex', () => {
    const f = foldBlocked(rows, blocked, new Set());
    expect(f.hiddenBefore('5')).toBe(2);
    expect(f.hiddenBefore('3')).toBe(0); // 3 is hidden itself; only 4 follows it
    expect(f.hiddenBefore(null)).toBe(0);
    expect(foldBlocked(rows, blocked, new Set(['3'])).hiddenBefore('5')).toBe(2); // Show does not change it: it is not a prepend
  });
});

describe('foldLabel', () => {
  it('pluralises', () => {
    expect(foldLabel(1)).toBe('1 blocked message');
    expect(foldLabel(3)).toBe('3 blocked messages');
  });
});
