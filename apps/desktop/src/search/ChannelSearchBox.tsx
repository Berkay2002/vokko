import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  AtSign, ChevronLeft, ChevronRight, File, Hash, Image as ImageIcon, Link as LinkIcon, Music, Paperclip, Pin, Search, SlidersHorizontal, StickyNote, Trash2, User as UserIcon, Video, X,
  Globe,
} from 'lucide-react';
import type { Channel, User } from '../api/types';
import { Avatar } from '../chat/Avatar';
import { ChannelTypeIcon } from '../chat/ChannelTypeIcon';
import { mentionableChannels } from '../chat/suggest';
import { HAS_VALUES, dateLabel, isoDay, pendingKeyword, resolveTyped, type FilterKind, type SearchFilter, type TypedContext } from './query';
import { Popout, displayName, useStore } from './shell';
import { scopeOf, searchActions, searchStore } from './store';

const DATE_KINDS: readonly FilterKind[] = ['before', 'during', 'after'];

interface Option {
  key: string;
  section?: 'search' | 'filter' | 'history';
  icon?: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  onPick(): void;
}

const HAS_ICONS: Record<string, ReactNode> = {
  image: <ImageIcon size={20} />, video: <Video size={20} />, link: <LinkIcon size={20} />, file: <File size={20} />,
  embed: <Globe size={20} />, sound: <Music size={20} />, sticker: <StickyNote size={20} />,
};

function Calendar({ onPick }: { onPick(iso: string): void }) {
  const [month, setMonth] = useState(() => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), 1); });
  const today = new Date();
  const todayIso = isoDay(today);
  const atCurrent = month.getFullYear() === today.getFullYear() && month.getMonth() === today.getMonth();
  const offset = (month.getDay() + 6) % 7; // Monday first
  const cells = Array.from({ length: 42 }, (_, i) => new Date(month.getFullYear(), month.getMonth(), 1 - offset + i));
  const weekdays = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 2).toUpperCase());
  const title = `${month.toLocaleDateString(undefined, { month: 'long' }).toUpperCase()} ${month.getFullYear()}`;
  return <div className="search-calendar" role="group" aria-label="Pick a date">
    <div className="search-calendar-head">
      <button type="button" className="search-calendar-nav" aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><ChevronLeft size={16} /></button>
      <span>{title}</span>
      {atCurrent ? <span className="search-calendar-nav" aria-hidden="true" /> : <button type="button" className="search-calendar-nav" aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><ChevronRight size={16} /></button>}
    </div>
    <div className="search-calendar-grid">
      {weekdays.map((w, i) => <span key={i} className="search-calendar-weekday">{w}</span>)}
      {cells.map(date => {
        const iso = isoDay(date);
        const future = iso > todayIso;
        const outside = date.getMonth() !== month.getMonth();
        return <button key={iso} type="button" disabled={future} data-date={iso} aria-label={dateLabel(iso)}
          className={`search-calendar-day${outside ? ' outside' : ''}${iso === todayIso ? ' today' : ''}`} onClick={() => onPick(iso)}>{date.getDate()}</button>;
      })}
    </div>
  </div>;
}

export function ChannelSearchBox({ channel }: { channel: Channel }) {
  const scope = scopeOf(channel);
  const mine = searchStore(s => s.scope === scope);
  const text = searchStore(s => (s.scope === scope ? s.text : ''));
  const filters = searchStore(s => (s.scope === scope ? s.filters : EMPTY_FILTERS));
  const active = searchStore(s => s.scope === scope && s.active);
  const me = useStore(s => s.me);
  const guild = useStore(s => (channel.guild_id ? s.guilds[channel.guild_id] : undefined));
  const members = useStore(s => (channel.guild_id ? s.members[channel.guild_id] : undefined));
  const channels = useStore(s => s.channels);

  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const history = searchStore(s => s.history[scope] ?? NO_HISTORY);

  useEffect(() => { searchActions.enter(channel); }, [channel.id, channel.guild_id]); // eslint-disable-line react-hooks/exhaustive-deps

  // The results panel's Filter button asks for the box.
  const focusToken = searchStore(s => s.focusToken);
  useEffect(() => {
    if (focusToken === 0) return;
    input.current?.focus();
    setOpen(true);
  }, [focusToken]);

  const keyword = useMemo(() => pendingKeyword(text), [text]);
  const query = keyword?.query.toLowerCase() ?? '';

  const commit = (kind: FilterKind, value: string, label: string) => {
    const before = keyword ? text.slice(0, keyword.start).trimEnd() : text;
    searchActions.addFilter({ kind, value, label });
    searchActions.setText(before);
    setMore(false);
    input.current?.focus();
  };
  const startKeyword = (kind: FilterKind) => {
    const base = keyword ? text.slice(0, keyword.start) : text;
    searchActions.setText(`${base}${base && !base.endsWith(' ') ? ' ' : ''}${kind}:`);
    setMore(false);
    input.current?.focus();
  };

  const people = useMemo<{ user: User; name: string }[]>(() => {
    const list: { user: User; name: string }[] = [];
    if (channel.guild_id) {
      for (const member of Object.values(members ?? {})) list.push({ user: member.user, name: displayName(member.user, member) });
    } else {
      for (const user of [...(channel.recipients ?? []), ...(me ? [me] : [])]) list.push({ user, name: displayName(user) });
    }
    return list;
  }, [channel, members, me]);
  const inChannels = useMemo(() => mentionableChannels(Object.values(channels).filter(c => c.guild_id === channel.guild_id), '', Infinity), [channels, channel.guild_id]);

  /** Turns complete typed or pasted `kind:value` tokens into chips; returns whether any did. */
  const applyTyped = (value: string, all: boolean): boolean => {
    const ctx: TypedContext = {
      users: people.map(p => ({ id: p.user.id, name: p.name, username: p.user.username })),
      channels: channel.guild_id ? inChannels.map(c => ({ id: c.id, name: c.name ?? '' })) : [],
    };
    const typed = resolveTyped(value, ctx, all);
    for (const filter of typed.filters) searchActions.addFilter(filter);
    searchActions.setText(typed.text);
    return typed.filters.length > 0;
  };

  const options: Option[] = useMemo(() => {
    const out: Option[] = [];
    if (!keyword) return out;
    const { kind } = keyword;
    if (kind === 'from' || kind === 'mentions') {
      const rank = (p: { user: User; name: string }): number => {
        const hay = [p.name, p.user.username, p.user.global_name ?? ''].map(v => v.toLowerCase());
        if (!query) return 1;
        if (hay.some(v => v.startsWith(query))) return 0;
        return hay.some(v => v.includes(query)) ? 1 : 2;
      };
      people.filter(p => rank(p) < 2).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)).slice(0, 10).forEach(p => out.push({
        key: p.user.id,
        icon: <Avatar user={p.user} size={20} />,
        title: <><b>{p.name}</b>{p.name !== p.user.username && <span className="search-opt-muted"> {p.user.username}</span>}</>,
        onPick: () => commit(kind, p.user.id, p.name),
      }));
    } else if (kind === 'has') {
      HAS_VALUES.filter(v => v.startsWith(query)).forEach(v => out.push({ key: v, icon: HAS_ICONS[v], title: <b>{v}</b>, onPick: () => commit('has', v, v) }));
    } else if (kind === 'in') {
      // The current channel leads, the rest in sidebar order with better name matches first.
      const inGuild = [...inChannels].sort((a, b) => (a.id === channel.id ? -1 : b.id === channel.id ? 1 : a.position - b.position));
      mentionableChannels(inGuild, query, 15).forEach(c => out.push({ key: c.id, icon: <ChannelTypeIcon type={c.type} />, title: <b>{c.name}</b>, onPick: () => commit('in', c.id, c.name ?? '') }));
    } else if (kind === 'pinned') {
      for (const v of ['true', 'false']) if (v.startsWith(query)) out.push({ key: v, icon: <Pin size={20} />, title: <b>{v}</b>, onPick: () => commit('pinned', v, v) });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword, query, people, inChannels, channel.id]);

  const rootRows: Option[] = [
    { key: 'from', icon: <UserIcon size={20} />, title: 'From a specific user', hint: 'from: user', onPick: () => startKeyword('from') },
    { key: 'in', icon: <Hash size={20} />, title: 'Sent in a specific channel', hint: 'in: channel', onPick: () => startKeyword('in') },
    { key: 'has', icon: <Paperclip size={20} />, title: 'Includes a specific type of data', hint: 'has: link, embed or file', onPick: () => startKeyword('has') },
    { key: 'mentions', icon: <AtSign size={20} />, title: 'Mentions a specific user', hint: 'mentions: user', onPick: () => startKeyword('mentions') },
    { key: 'more', icon: <SlidersHorizontal size={20} />, title: 'More filters', hint: 'date and pinned', onPick: () => setMore(true) },
  ];
  const moreRows: Option[] = [
    { key: 'before', icon: <SlidersHorizontal size={20} />, title: 'Sent before a date', hint: 'before: date', onPick: () => startKeyword('before') },
    { key: 'during', icon: <SlidersHorizontal size={20} />, title: 'Sent on a date', hint: 'during: date', onPick: () => startKeyword('during') },
    { key: 'after', icon: <SlidersHorizontal size={20} />, title: 'Sent after a date', hint: 'after: date', onPick: () => startKeyword('after') },
    { key: 'pinned', icon: <Pin size={20} />, title: 'Pinned or not', hint: 'pinned: true or false', onPick: () => startKeyword('pinned') },
  ];
  const dateMode = keyword && DATE_KINDS.includes(keyword.kind);
  const listMode = keyword && !dateMode;
  const freeText = text.trim();
  const showHistory = !keyword && !more && freeText === '' && history.length > 0;
  const rows: Option[] = listMode ? options : dateMode ? [] : [
    ...(freeText ? [{ key: 'search', section: 'search' as const, icon: <Search size={20} />, title: <>Search for <b>{freeText}</b></>, onPick: () => submit() }] : []),
    ...(more ? moreRows : rootRows),
    ...(showHistory ? history.map((q): Option => ({
      key: `history:${q}`, section: 'history', icon: <Search size={20} />, title: <b>{q}</b>, onPick: () => { searchActions.setText(q); submit(); },
    })) : []),
  ];

  useEffect(() => { setCursor(0); }, [keyword?.kind, query, more, freeText === '']);

  function submit() {
    searchActions.submit();
    setOpen(false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (rows.length === 0) return;
      e.preventDefault();
      setOpen(true);
      setCursor(c => (c + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // An exact typed value (`from:alice`) wins over the highlighted suggestion; an unknown one is searched as text, like Discord.
      if (keyword && applyTyped(text, true)) return;
      if (listMode && open && rows[cursor]) { rows[cursor].onPick(); return; }
      if (dateMode && open) return;
      applyTyped(text, true);
      submit();
    } else if (e.key === 'Backspace' && text === '' && filters.length > 0) {
      searchActions.removeFilter(filters.length - 1);
    } else if (e.key === 'Escape') {
      // With the results showing and the suggestions closed, Escape drops the search and brings the suggestions back (Discord does the same).
      if (active && !open) { searchActions.clear(); setOpen(true); }
      else if (open) setOpen(false);
      else input.current?.blur();
    }
  }

  const placeholder = !text && filters.length === 0 ? (guild ? `Search ${guild.name}` : 'Search') : '';
  const hasContent = !!text || filters.length > 0 || active;
  const header = keyword?.kind === 'from' ? 'From user' : keyword?.kind === 'mentions' ? 'Mentions user' : keyword?.kind === 'has' ? 'Message includes' : keyword?.kind === 'in' ? 'In channel'
    : keyword?.kind === 'pinned' ? 'Pinned' : dateMode ? `${keyword!.kind[0]!.toUpperCase()}${keyword!.kind.slice(1)} date` : more ? 'More filters' : 'Filter';

  return <div className="header-search search-box" ref={setAnchor} role="search" aria-label="Search messages" data-search-active={active || undefined}>
    {mine && filters.map((f, i) => <FilterChip key={`${f.kind}:${f.value}`} filter={f} onRemove={() => searchActions.removeFilter(i)} />)}
    <input ref={input} className="header-search-input" placeholder={placeholder} aria-label="Search" role="combobox" aria-expanded={open} aria-autocomplete="list" value={text}
      autoComplete="off" spellCheck={false}
      onChange={e => { if (!/\s$/.test(e.target.value) || !applyTyped(e.target.value, false)) searchActions.setText(e.target.value); setOpen(true); }}
      onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onKeyDown={onKeyDown} />
    {hasContent
      ? <button type="button" className="search-box-clear" aria-label="Clear search" onMouseDown={e => e.preventDefault()} onClick={() => { searchActions.clear(); input.current?.focus(); }}><X size={16} /></button>
      : <Search size={16} />}
    <Popout anchor={anchor} open={open} onClose={() => { setOpen(false); setMore(false); }} side="bottom" align="end" gap={8} className="search-popout" trapFocus={false}>
      <div className="search-suggest" role="listbox" aria-label="Search suggestions" onMouseDown={e => e.preventDefault()}>
        {rows.map((row, i) => {
          const section = row.section ?? 'filter';
          const first = rows.findIndex(r => (r.section ?? 'filter') === section) === i;
          return <Fragment key={row.key}>
            {first && section === 'filter' && <div className="search-suggest-head">{header}</div>}
            {first && section === 'history' && <div className="search-suggest-head history">
              <span>History</span>
              <button type="button" className="search-suggest-trash" aria-label="Clear search history" onClick={() => searchActions.clearHistory()}><Trash2 size={16} /></button>
            </div>}
            <button type="button" role="option" aria-selected={i === cursor} data-suggest={row.key}
              className={`search-suggest-row${i === cursor ? ' active' : ''}${listMode || section === 'history' ? ' compact' : ''}`} onMouseEnter={() => setCursor(i)} onClick={row.onPick}>
              {row.icon && <span className="search-suggest-icon">{row.icon}</span>}
              <span className="search-suggest-text"><span className="search-suggest-title">{row.title}</span>{row.hint && <span className="search-suggest-hint">{row.hint}</span>}</span>
            </button>
          </Fragment>;
        })}
        {dateMode && <><div className="search-suggest-head">{header}</div><Calendar onPick={iso => commit(keyword!.kind, iso, dateLabel(iso))} /></>}
        {!dateMode && rows.length === 0 && <><div className="search-suggest-head">{header}</div><div className="search-suggest-empty">No matches</div></>}
      </div>
    </Popout>
  </div>;
}

const EMPTY_FILTERS: SearchFilter[] = [];
const NO_HISTORY: string[] = [];

function FilterChip({ filter, onRemove }: { filter: SearchFilter; onRemove(): void }) {
  return <span className="search-chip" data-kind={filter.kind}>
    <span className="search-chip-key">{filter.kind}:</span>
    <span className="search-chip-value">{filter.label}</span>
    <button type="button" className="search-chip-remove" aria-label={`Remove ${filter.kind} filter`} onClick={onRemove}><X size={12} /></button>
  </span>;
}
