import { describe, expect, it } from 'vitest';
import { snowflakeToTimestamp } from '../api/snowflake';
import { addFilter, buildSearchParams, dateRange, groupByChannel, highlightTerms, pageButtons, pendingKeyword, resolveTyped, termPattern, type SearchFilter } from './query';
import type { Message } from '../api/types';

const chip = (kind: SearchFilter['kind'], value: string): SearchFilter => ({ kind, value, label: value });

describe('pendingKeyword', () => {
  it('finds the keyword being completed at the end of the text', () => {
    expect(pendingKeyword('from:')).toEqual({ kind: 'from', query: '', start: 0 });
    expect(pendingKeyword('hello FROM:ali')).toEqual({ kind: 'from', query: 'ali', start: 6 });
    expect(pendingKeyword('has:im')?.kind).toBe('has');
  });
  it('ignores keywords in the middle, inside words, and unknown keywords', () => {
    expect(pendingKeyword('from:x hello')).toBeNull();
    expect(pendingKeyword('xfrom:')).toBeNull();
    expect(pendingKeyword('foo:bar')).toBeNull();
  });
});

describe('addFilter', () => {
  it('keeps several from/has chips but only one date and pinned', () => {
    let filters: SearchFilter[] = [];
    filters = addFilter(filters, chip('from', '1'));
    filters = addFilter(filters, chip('from', '2'));
    filters = addFilter(filters, chip('from', '1'));
    filters = addFilter(filters, chip('before', '2026-10-01'));
    filters = addFilter(filters, chip('before', '2026-10-05'));
    expect(filters.map(f => `${f.kind}:${f.value}`)).toEqual(['from:2', 'from:1', 'before:2026-10-05']);
  });
});

describe('dateRange', () => {
  it('before is exclusive of the day, after starts the next day, during covers one local day', () => {
    const before = dateRange('before', '2026-10-05');
    expect(new Date(snowflakeToTimestamp(before.max_id!)).getTime()).toBe(new Date(2026, 9, 5).getTime());
    const after = dateRange('after', '2026-10-05');
    expect(snowflakeToTimestamp(after.min_id!)).toBe(new Date(2026, 9, 6).getTime() - 1);
    const during = dateRange('during', '2026-10-05');
    expect(snowflakeToTimestamp(during.min_id!)).toBe(new Date(2026, 9, 5).getTime() - 1);
    expect(snowflakeToTimestamp(during.max_id!)).toBe(new Date(2026, 9, 6).getTime());
  });
});

describe('buildSearchParams', () => {
  it('repeats array keys and maps sort and page', () => {
    const params = buildSearchParams('hello world', [chip('from', '1'), chip('from', '2'), chip('has', 'image'), chip('in', '9'), chip('pinned', 'true')], {
      sort: 'oldest',
      page: 3,
      inGuild: true,
    });
    expect(params.getAll('author_id')).toEqual(['1', '2']);
    expect(params.getAll('has')).toEqual(['image']);
    expect(params.getAll('channel_id')).toEqual(['9']);
    expect(params.get('content')).toBe('hello world');
    expect(params.get('pinned')).toBe('true');
    expect(params.get('offset')).toBe('50');
    expect(params.get('sort_order')).toBe('asc');
    expect(params.get('limit')).toBe('25');
  });
  it('drops channel filters for DM scope and relevance sort without text', () => {
    const params = buildSearchParams('', [chip('in', '9')], { sort: 'relevant', page: 1, inGuild: false });
    expect(params.has('channel_id')).toBe(false);
    expect(params.has('sort_by')).toBe(false);
    expect(params.has('offset')).toBe(false);
  });
  it('combines date chips into one id range', () => {
    const params = buildSearchParams('', [chip('after', '2026-10-01'), chip('before', '2026-10-10')], { sort: 'newest', page: 1, inGuild: true });
    expect(params.has('min_id') && params.has('max_id')).toBe(true);
  });
});

describe('highlighting', () => {
  it('takes words from phrases and skips exclusions', () => {
    expect(highlightTerms('Hello "big World" -nope Räksmörgås')).toEqual(['hello', 'big', 'world', 'räksmörgås']);
  });
  it('matches whole words only, case-insensitively, with Swedish letters', () => {
    const pattern = termPattern(['åäö', 'hello'])!;
    expect('Hello wonderful ÅÄÖ helloo'.match(pattern)).toEqual(['Hello', 'ÅÄÖ']);
    expect(termPattern([])).toBeNull();
  });
});

describe('paging and grouping', () => {
  it('builds a compact page strip', () => {
    expect(pageButtons(1, 3)).toEqual([1, 2, 3]);
    expect(pageButtons(1, 20)).toEqual([1, 2, null, 20]);
    expect(pageButtons(10, 20)).toEqual([1, null, 9, 10, 11, null, 20]);
  });
  it('groups consecutive hits of one channel', () => {
    const hit = (id: string, channel: string) => ({ id, channel_id: channel }) as Message;
    const groups = groupByChannel([hit('1', 'a'), hit('2', 'a'), hit('3', 'b'), hit('4', 'a')]);
    expect(groups.map(g => `${g.channelId}:${g.hits.length}`)).toEqual(['a:2', 'b:1', 'a:1']);
  });
});

describe('resolveTyped', () => {
  const ctx = {
    users: [{ id: '1', name: 'Alice', username: 'alice' }, { id: '2', name: 'Bobby B', username: 'bob' }],
    channels: [{ id: '9', name: 'announcements' }],
    now: new Date(2026, 9, 18),
  };
  const kinds = (filters: SearchFilter[]) => filters.map(f => `${f.kind}:${f.value}`);

  it('turns a pasted from:alice docs into a chip and the rest stays text', () => {
    const typed = resolveTyped('from:alice docs', ctx, true);
    expect(kinds(typed.filters)).toEqual(['from:1']);
    expect(typed.text).toBe('docs');
  });
  it('waits for the space while a token is still being typed', () => {
    expect(resolveTyped('docs from:alice', ctx, false)).toEqual({ text: 'docs from:alice', filters: [] });
    const typed = resolveTyped('docs from:alice ', ctx, false);
    expect(kinds(typed.filters)).toEqual(['from:1']);
    expect(typed.text).toBe('docs ');
    expect(resolveTyped('from:alice ', ctx, false).text).toBe('');
  });
  it('resolves users by username or display name, channels, has, pinned and dates', () => {
    const typed = resolveTyped('mentions:@BOB in:#Announcements has:image pinned:true before:2026-10-05 after:yesterday x', ctx, true);
    expect(kinds(typed.filters)).toEqual(['mentions:2', 'in:9', 'has:image', 'pinned:true', 'before:2026-10-05', 'after:2026-10-17']);
    expect(typed.filters[0]?.label).toBe('Bobby B');
    expect(typed.text).toBe('x');
    expect(kinds(resolveTyped('from:Alice during:today', ctx, true).filters)).toEqual(['from:1', 'during:2026-10-18']);
  });
  it('keeps unknown values, bad dates, unknown keywords and quoted phrases as text', () => {
    const text = 'from:nosuch has:pdf before:2026-02-30 foo:bar "from:alice" in:general';
    expect(resolveTyped(text, ctx, true)).toEqual({ text, filters: [] });
  });
});
