// Search session state, outside React: the box draft (text + chips), the submitted query and its results. One search at a time,
// scoped to a guild (guild-wide) or a DM; moving to another guild or DM resets it, moving between channels of the same guild keeps it.
import { create } from 'zustand';
import type { Channel, Message, MessageSearchResponse } from '../api/types';
import { rememberMessages } from '../chat/userCache';
import { addFilter, buildSearchParams, highlightTerms, type SearchFilter, type SearchSort } from './query';
import { appStore, closeThread, request, useStore } from './shell';

export type SearchStatus = 'idle' | 'loading' | 'ready' | 'error';

interface Submitted {
  text: string;
  filters: SearchFilter[];
}

export interface SearchState {
  /** Guild id, or the DM channel id. */
  scope: string | null;
  /** What the request goes to (resolved when submitting). */
  scopeKind: 'guild' | 'channel';
  scopePath: string;
  text: string;
  filters: SearchFilter[];
  /** The results panel is open. */
  active: boolean;
  sort: SearchSort;
  page: number;
  status: SearchStatus;
  total: number;
  hits: Message[];
  terms: string[];
  submitted: Submitted | null;
  /** Bumped by the panel's Filter button: the search box focuses itself and opens its suggestions. */
  focusToken: number;
  /** Free-text queries that were run, newest first, per guild / DM. */
  history: Record<string, string[]>;
}

const HISTORY_KEY = 'vokko.searchHistory';
const HISTORY_MAX = 8;

function loadHistory(): Record<string, string[]> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '{}');
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string[]>) : {};
  } catch {
    return {};
  }
}

function saveHistory(history: Record<string, string[]>): void {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch { /* private mode / quota: history is a convenience */ }
}

function rememberQuery(scope: string, text: string): void {
  const history = searchStore.getState().history;
  const next = { ...history, [scope]: [text, ...(history[scope] ?? []).filter(q => q !== text)].slice(0, HISTORY_MAX) };
  searchStore.setState({ history: next });
  saveHistory(next);
}

const blank = (): Omit<SearchState, 'scope' | 'scopeKind' | 'scopePath' | 'focusToken' | 'history'> => ({
  text: '', filters: [], active: false, sort: 'newest', page: 1, status: 'idle', total: 0, hits: [], terms: [], submitted: null,
});

export const searchStore = create<SearchState>()(() => ({ scope: null, scopeKind: 'channel', scopePath: '', focusToken: 0, history: loadHistory(), ...blank() }));

export const scopeOf = (channel: Pick<Channel, 'id' | 'guild_id'>): string => channel.guild_id ?? channel.id;

let ticket = 0;

export const searchActions = {
  /** Entering a channel: a different guild/DM than the search belongs to starts from scratch. */
  enter(channel: Pick<Channel, 'id' | 'guild_id'>): void {
    const scope = scopeOf(channel);
    const s = searchStore.getState();
    const path = channel.guild_id ? `/guilds/${channel.guild_id}/messages/search` : `/channels/${channel.id}/messages/search`;
    if (s.scope === scope) {
      if (s.scopePath !== path) searchStore.setState({ scopePath: path });
      return;
    }
    ticket++;
    searchStore.setState({ scope, scopeKind: channel.guild_id ? 'guild' : 'channel', scopePath: path, ...blank() });
  },

  setText(text: string): void {
    searchStore.setState({ text });
  },

  addFilter(filter: SearchFilter): void {
    searchStore.setState(s => ({ filters: addFilter(s.filters, filter) }));
  },

  removeFilter(index: number): void {
    searchStore.setState(s => ({ filters: s.filters.filter((_, i) => i !== index) }));
  },

  /** Runs the draft: opens the results panel on page 1. */
  submit(draft?: Submitted): void {
    const s = searchStore.getState();
    const text = (draft?.text ?? s.text).trim();
    const filters = draft?.filters ?? s.filters;
    if (!text && filters.length === 0) return;
    searchStore.setState({ text, filters, active: true, page: 1, submitted: { text, filters } });
    closeThread(); // an open thread panel would hide the results (it wins the right column)
    if (text && s.scope) rememberQuery(s.scope, text);
    void run();
  },

  clearHistory(): void {
    const scope = searchStore.getState().scope;
    if (!scope) return;
    searchStore.setState(s => ({ history: { ...s.history, [scope]: [] } }));
    saveHistory(searchStore.getState().history);
  },

  setPage(page: number): void {
    searchStore.setState({ page });
    void run();
  },

  setSort(sort: SearchSort): void {
    searchStore.setState({ sort, page: 1 });
    void run();
  },

  /** The ✕ in the box: forget the query and give the member list back. */
  clear(): void {
    ticket++;
    searchStore.setState({ ...blank() });
  },

  focusBox(): void {
    searchStore.setState(s => ({ focusToken: s.focusToken + 1 }));
  },

  /** Closes the panel but keeps the draft. */
  closePanel(): void {
    ticket++;
    searchStore.setState({ active: false });
  },
};

async function run(): Promise<void> {
  const s = searchStore.getState();
  if (!s.submitted) return;
  const mine = ++ticket;
  searchStore.setState({ status: 'loading' });
  const params = buildSearchParams(s.submitted.text, s.submitted.filters, { sort: s.sort, page: s.page, inGuild: s.scopeKind === 'guild' });
  try {
    const result = await request<MessageSearchResponse>('GET', `${s.scopePath}?${params}`);
    if (mine !== ticket) return;
    const hits = result.messages.map(group => group[0]).filter((m): m is Message => !!m);
    rememberMessages(hits);
    // Threads and forum posts are not in the store until opened: the hits' own come with the response, so the panel can name them and Jump can open them.
    for (const thread of result.threads ?? []) appStore.getState().upsertThread({ ...thread, member: result.members?.find(m => m.id === thread.id) ?? thread.member });
    searchStore.setState({ status: 'ready', total: result.total_results, hits, terms: highlightTerms(s.submitted.text) });
  } catch {
    if (mine !== ticket) return;
    searchStore.setState({ status: 'error', total: 0, hits: [] });
  }
}

/** Is the results panel showing for this channel? (Same guild or DM as the search.) */
export function useSearchPanelOpen(channelId: string): boolean {
  const guildId = useStore(s => s.channels[channelId]?.guild_id ?? null);
  const scope = guildId ?? channelId;
  return searchStore(s => s.active && s.scope === scope);
}
