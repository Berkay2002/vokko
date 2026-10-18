// Search query model: what the search box holds (free text + filter chips) and how it maps onto GET .../messages/search.
import { timestampToSnowflake } from '../api/snowflake';
import type { Message, SearchHas } from '../api/types';

export type FilterKind = 'from' | 'mentions' | 'has' | 'in' | 'before' | 'during' | 'after' | 'pinned';

/** One applied filter chip. `value` is a user id (from, mentions), a channel id (in), a SearchHas, `YYYY-MM-DD` (dates) or `true`/`false`. */
export interface SearchFilter {
  kind: FilterKind;
  value: string;
  /** What the chip shows after the keyword (a name, a channel name, a date). */
  label: string;
}

export type SearchSort = 'newest' | 'oldest' | 'relevant';

export const PAGE_SIZE = 25;
/** The server serves offsets up to 9975. */
export const MAX_OFFSET = 9975;

export const FILTER_KINDS: readonly FilterKind[] = ['from', 'mentions', 'has', 'in', 'before', 'during', 'after', 'pinned'];
export const HAS_VALUES: readonly SearchHas[] = ['image', 'video', 'link', 'file', 'embed', 'sound', 'sticker'];
/** Kinds that may appear only once: a second one replaces the first. */
const SINGLE: ReadonlySet<FilterKind> = new Set(['before', 'during', 'after', 'pinned']);

export function addFilter(filters: SearchFilter[], next: SearchFilter): SearchFilter[] {
  const without = filters.filter(f => !(SINGLE.has(next.kind) && f.kind === next.kind) && !(f.kind === next.kind && f.value === next.value));
  return [...without, next];
}

/** `from:`, `has:`... typed at the end of the text: the keyword being completed and what was typed after it. */
export function pendingKeyword(text: string): { kind: FilterKind; query: string; start: number } | null {
  const match = /(^|\s)(from|mentions|has|in|before|during|after|pinned):(\S*)$/i.exec(text);
  if (!match) return null;
  const kind = (match[2] ?? '').toLowerCase() as FilterKind;
  return { kind, query: match[3] ?? '', start: match.index + (match[1]?.length ?? 0) };
}

const startOfDay = (iso: string): number => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).getTime();
};

/** Local-time date → `YYYY-MM-DD`. */
export function isoDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The id range a before/during/after filter stands for (both ends exclusive, local days). */
export function dateRange(kind: 'before' | 'during' | 'after', iso: string): { min_id?: string; max_id?: string } {
  const start = startOfDay(iso);
  const next = new Date(start);
  next.setDate(next.getDate() + 1);
  const nextStart = next.getTime();
  // min_id is exclusive: the largest id of the millisecond before the boundary.
  const justBefore = (ms: number) => timestampToSnowflake(ms - 1, 0xfff);
  if (kind === 'before') return { max_id: timestampToSnowflake(start, 0) };
  if (kind === 'after') return { min_id: justBefore(nextStart) };
  return { min_id: justBefore(start), max_id: timestampToSnowflake(nextStart, 0) };
}

/** Who and where typed filters can name: users by username or display name, channels by name. */
export interface TypedContext {
  users: readonly { id: string; name: string; username: string }[];
  channels: readonly { id: string; name: string }[];
  now?: Date;
}

/** A chip's label for a `YYYY-MM-DD` day. */
export function dateLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function resolveDate(value: string, now: Date): string | null {
  if (value === 'today') return isoDay(now);
  if (value === 'yesterday') return isoDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  if (!match) return null;
  const month = Number(match[2]) - 1;
  const date = new Date(Number(match[1]), month, Number(match[3]));
  return date.getMonth() === month ? isoDay(date) : null;
}

/** The chip a complete `kind:value` token stands for, or null when the value names nothing (it then stays search text, as in Discord). */
export function resolveToken(kind: FilterKind, value: string, ctx: TypedContext): SearchFilter | null {
  const v = value.toLowerCase();
  switch (kind) {
    case 'from':
    case 'mentions': {
      const name = v.replace(/^@/, '');
      const user = ctx.users.find(u => u.username.toLowerCase() === name) ?? ctx.users.find(u => u.name.toLowerCase() === name);
      return user ? { kind, value: user.id, label: user.name } : null;
    }
    case 'in': {
      const name = v.replace(/^#/, '');
      const channel = ctx.channels.find(c => c.name.toLowerCase() === name);
      return channel ? { kind, value: channel.id, label: channel.name } : null;
    }
    case 'has': return (HAS_VALUES as readonly string[]).includes(v) ? { kind, value: v, label: v } : null;
    case 'pinned': return v === 'true' || v === 'false' ? { kind, value: v, label: v } : null;
    default: {
      const iso = resolveDate(v, ctx.now ?? new Date());
      return iso ? { kind, value: iso, label: dateLabel(iso) } : null;
    }
  }
}

/**
 * Typed or pasted `from:alice docs`: every complete filter token that resolves becomes a chip and leaves the text.
 * Without `all`, a last token not yet followed by whitespace is still being typed and stays. Quoted phrases are never filters.
 */
export function resolveTyped(text: string, ctx: TypedContext, all: boolean): { text: string; filters: SearchFilter[] } {
  const filters: SearchFilter[] = [];
  const kept: string[] = [];
  const tokens = [...text.matchAll(/"[^"]*"?|\S+/g)];
  tokens.forEach((match, i) => {
    const token = match[0];
    const typing = !all && i === tokens.length - 1 && match.index + token.length === text.length;
    const parts = typing ? null : /^(from|mentions|has|in|before|during|after|pinned):(.+)$/i.exec(token);
    const filter = parts ? resolveToken((parts[1] ?? '').toLowerCase() as FilterKind, parts[2] ?? '', ctx) : null;
    if (filter) filters.push(filter);
    else kept.push(token);
  });
  if (filters.length === 0) return { text, filters };
  const rest = kept.join(' ');
  return { text: rest && /\s$/.test(text) ? `${rest} ` : rest, filters };
}

export interface BuildOptions {
  sort: SearchSort;
  page: number;
  /** Guild search only. */
  inGuild: boolean;
}

export function buildSearchParams(text: string, filters: readonly SearchFilter[], options: BuildOptions): URLSearchParams {
  const params = new URLSearchParams();
  const content = text.trim();
  if (content) params.set('content', content);
  let minId: string | undefined;
  let maxId: string | undefined;
  for (const filter of filters) {
    switch (filter.kind) {
      case 'from': params.append('author_id', filter.value); break;
      case 'mentions': params.append('mentions', filter.value); break;
      case 'has': params.append('has', filter.value); break;
      case 'in': if (options.inGuild) params.append('channel_id', filter.value); break;
      case 'pinned': params.set('pinned', filter.value); break;
      default: {
        const range = dateRange(filter.kind, filter.value);
        if (range.min_id && (!minId || BigInt(range.min_id) > BigInt(minId))) minId = range.min_id;
        if (range.max_id && (!maxId || BigInt(range.max_id) < BigInt(maxId))) maxId = range.max_id;
      }
    }
  }
  if (minId) params.set('min_id', minId);
  if (maxId) params.set('max_id', maxId);
  params.set('limit', String(PAGE_SIZE));
  if (options.page > 1) params.set('offset', String(Math.min((options.page - 1) * PAGE_SIZE, MAX_OFFSET)));
  if (options.sort === 'relevant' && content) params.set('sort_by', 'relevance');
  if (options.sort === 'oldest') params.set('sort_order', 'asc');
  return params;
}

/** Words to highlight in results: the positive words and phrases of a websearch-style query. */
export function highlightTerms(text: string): string[] {
  const terms: string[] = [];
  for (const match of text.matchAll(/(-?)(?:"([^"]*)"|(\S+))/g)) {
    if (match[1]) continue; // excluded
    const raw = match[2] ?? match[3] ?? '';
    for (const word of raw.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) if (!terms.includes(word)) terms.push(word);
  }
  return terms;
}

/** One regex matching any of the terms as whole words (search is word level), or null without terms. */
export function termPattern(terms: readonly string[]): RegExp | null {
  if (terms.length === 0) return null;
  const escaped = [...terms].sort((a, b) => b.length - a.length).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${escaped.join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
}

/** Page buttons: always the first and last page, a window around the current one, `null` for a gap. */
export function pageButtons(current: number, pages: number): (number | null)[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const wanted = new Set([1, pages, current - 1, current, current + 1].filter(p => p >= 1 && p <= pages));
  const sorted = [...wanted].sort((a, b) => a - b);
  const out: (number | null)[] = [];
  sorted.forEach((page, index) => {
    if (index > 0 && page - (sorted[index - 1] ?? 0) > 1) out.push(null);
    out.push(page);
  });
  return out;
}

export function groupByChannel(hits: readonly Message[]): { channelId: string; hits: Message[] }[] {
  const groups: { channelId: string; hits: Message[] }[] = [];
  for (const hit of hits) {
    const last = groups[groups.length - 1];
    if (last && last.channelId === hit.channel_id) last.hits.push(hit);
    else groups.push({ channelId: hit.channel_id, hits: [hit] });
  }
  return groups;
}
