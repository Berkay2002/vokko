import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownUp, ChevronLeft, ChevronRight, CornerUpRight, Folder, Hash, Loader2, MessageSquareText, SearchX, Search as SearchIcon, SlidersHorizontal } from 'lucide-react';
import type { Channel, Message } from '../api/types';
import { Attachments } from '../chat/Attachments';
import { Avatar } from '../chat/Avatar';
import { useAuthorProfile } from '../chat/authorProfile';
import { ChatProvider, useChat, type ChatActions } from '../chat/ChatContext';
import { LinkModal } from '../chat/ChatView';
import { Markdown } from '../chat/markdown';
import { formatMessageTimestamp } from '../chat/util';
import { clearHighlights, paintHighlights } from './highlight';
import { jumpToHit } from './jump';
import { NARROW_QUERY } from './shell';
import { groupByChannel, MAX_OFFSET, pageButtons, PAGE_SIZE, type SearchSort } from './query';
import { Popout, dmName, useBackClose, useStore } from './shell';
import { searchActions, searchStore } from './store';
import './search.css';

const SORTS: { sort: SearchSort; label: string }[] = [
  { sort: 'newest', label: 'Newest' },
  { sort: 'oldest', label: 'Oldest' },
  { sort: 'relevant', label: 'Most relevant' },
];

/** Right-hand panel with the results of the submitted search (replaces the member list / DM profile while open). */
export function SearchResultsPanel({ channel }: { channel: Channel }) {
  const [link, setLink] = useState<string | null>(null);
  // Links ask first ("Leaving Vokko"), like in the chat.
  const actions = useMemo<ChatActions>(() => ({
    reply() {}, edit() {}, requestDelete() {}, togglePin() {}, react() {}, openImage() {}, viewAttachment() {}, deleteAttachment() {}, viewReactions() {},
    jumpTo() {},
    openLink: setLink,
  }), []);
  return <ChatProvider channelId={channel.id} actions={actions}>
    <Panel channel={channel} />
    <LinkModal href={link} onClose={() => setLink(null)} />
  </ChatProvider>;
}

function Panel({ channel }: { channel: Channel }) {
  const { status, total, hits, terms, page, sort, submitted } = searchStore();
  const body = useRef<HTMLDivElement>(null);
  const [sortAnchor, setSortAnchor] = useState<HTMLElement | null>(null);
  const [sortOpen, setSortOpen] = useState(false);
  const channels = useStore(s => s.channels);
  const threads = useStore(s => s.threads);
  const groups = useMemo(() => groupByChannel(hits), [hits]);
  useBackClose(true, () => searchActions.closePanel());

  const reachable = Math.min(total, MAX_OFFSET + PAGE_SIZE);
  const pages = Math.max(1, Math.ceil(reachable / PAGE_SIZE));
  const hasContent = !!submitted?.text;
  const sorts = hasContent ? SORTS : SORTS.filter(s => s.sort !== 'relevant');

  // Highlight after the markdown (and late emoji data) has rendered: repaint on every DOM change inside the body.
  useLayoutEffect(() => {
    const root = body.current;
    paintHighlights(root, terms);
    if (!root) return;
    const observer = new MutationObserver(() => paintHighlights(root, terms));
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [hits, terms, status]);
  useEffect(() => clearHighlights, []);
  useEffect(() => { body.current?.scrollTo({ top: 0 }); }, [page, sort, submitted]);

  const labelOf = (channelId: string): { icon: boolean; thread?: boolean; name: string; category: string | null } => {
    const thread = threads[channelId];
    // a thread or forum post: its title, with the channel it sits in where the category goes
    if (thread) return { icon: true, thread: true, name: thread.name ?? 'thread', category: (thread.parent_id && channels[thread.parent_id]?.name) || null };
    const c = channels[channelId];
    if (!c) return { icon: false, name: 'Unknown channel', category: null };
    if (c.guild_id) return { icon: true, name: c.name ?? 'channel', category: (c.parent_id && channels[c.parent_id]?.name) || null };
    return { icon: false, name: dmName(c), category: null };
  };

  const loading = status === 'loading';
  const heading = status === 'error' ? 'Search failed' : loading && hits.length === 0 ? 'Searching…' : total === 0 ? 'No results' : `${total.toLocaleString()} ${total === 1 ? 'result' : 'results'}`;

  return <aside className="search-panel" aria-label="Search results" data-status={status}>
    <header className="search-panel-head">
      <button type="button" className="search-panel-back" aria-label="Close Search" onClick={() => searchActions.closePanel()}><ChevronLeft size={24} /></button>
      <h2 className="search-panel-count" aria-live="polite">{heading}{loading && hits.length > 0 && <Loader2 size={16} className="search-spin" aria-hidden="true" />}{loading && hits.length === 0 && <Loader2 size={16} className="search-spin" aria-hidden="true" />}</h2>
      <button type="button" className="search-panel-btn" onClick={() => searchActions.focusBox()}><SlidersHorizontal size={16} aria-hidden="true" />Filter</button>
      <button ref={setSortAnchor} type="button" className="search-panel-btn" aria-haspopup="listbox" aria-expanded={sortOpen} onClick={() => setSortOpen(o => !o)}>
        <ArrowDownUp size={16} aria-hidden="true" />Sort
      </button>
      <Popout anchor={sortAnchor} open={sortOpen} onClose={() => setSortOpen(false)} side="bottom" align="end" gap={4} className="search-sort-popout">
        <div role="listbox" aria-label="Sort results" className="search-sort-menu">
          {sorts.map(s => <button key={s.sort} type="button" role="option" aria-selected={s.sort === sort} className="search-sort-option"
            onClick={() => { setSortOpen(false); if (s.sort !== sort) searchActions.setSort(s.sort); }}>
            {s.label}<span className="search-radio" aria-hidden="true" />
          </button>)}
        </div>
      </Popout>
    </header>

    <div className="search-panel-body" ref={body}>
      {status === 'error' && <Empty icon={<SearchX size={64} />} text="We couldn't run that search. Check your connection and try again.">
        <button type="button" className="search-retry" onClick={() => searchActions.setPage(page)}>Try again</button>
      </Empty>}
      {status === 'loading' && hits.length === 0 && <Empty icon={<SearchIcon size={64} />} text="Hang on while we look through the messages." />}
      {status === 'ready' && hits.length === 0 && <Empty icon={<SearchX size={64} />} text="We searched far and wide and couldn't find what you're looking for." />}
      {hits.length > 0 && <div className={`search-groups${loading ? ' stale' : ''}`}>
        {groups.map((group, index) => {
          const label = labelOf(group.channelId);
          return <section className="search-group" key={`${group.channelId}:${index}`} aria-label={label.name}>
            <h3 className="search-group-title">
              {label.icon && (label.thread ? <MessageSquareText size={20} aria-hidden="true" /> : <Hash size={20} aria-hidden="true" />)}<span className="search-group-name">{label.name}</span>
              {label.category && <span className="search-group-category">{label.thread ? <Hash size={14} aria-hidden="true" /> : <Folder size={14} aria-hidden="true" />}{label.category}</span>}
            </h3>
            {group.hits.map(hit => <Hit key={hit.id} hit={hit} currentChannelId={channel.id} />)}
          </section>;
        })}
      </div>}
    </div>

    {hits.length > 0 && pages > 1 && <nav className="search-pager" aria-label="Result pages">
      <button type="button" className="search-page-btn" disabled={page <= 1 || loading} aria-label="Previous page" onClick={() => searchActions.setPage(page - 1)}><ChevronLeft size={16} /></button>
      {pageButtons(page, pages).map((p, i) => p === null
        ? <span key={`gap${i}`} className="search-page-gap" aria-hidden="true">…</span>
        : <button key={p} type="button" className={`search-page-btn${p === page ? ' current' : ''}`} aria-current={p === page ? 'page' : undefined} disabled={loading}
          onClick={() => p !== page && searchActions.setPage(p)}>{p}</button>)}
      <button type="button" className="search-page-btn" disabled={page >= pages || loading} aria-label="Next page" onClick={() => searchActions.setPage(page + 1)}><ChevronRight size={16} /></button>
    </nav>}
  </aside>;
}

function Empty({ icon, text, children }: { icon: React.ReactNode; text: string; children?: React.ReactNode }) {
  return <div className="search-empty" role="status">
    <div className="search-empty-art" aria-hidden="true">{icon}</div>
    <p className="search-empty-text">{text}</p>
    {children}
  </div>;
}

function Hit({ hit, currentChannelId }: { hit: Message; currentChannelId: string }) {
  const chat = useChat();
  const ref = hit.referenced_message;
  const color = chat.colorOf(hit);
  const author = useAuthorProfile(chat.guildId);
  // on a phone the results cover the chat: close them so the jump lands in view (the draft stays in the box)
  const jump = () => { if (matchMedia(NARROW_QUERY).matches) searchActions.closePanel(); void jumpToHit(hit, currentChannelId); };
  return <article className="search-hit" data-message-id={hit.id} tabIndex={0}
    onClick={e => { if (!(e.target as HTMLElement).closest('a, button, [role="button"]')) jump(); }}
    onKeyDown={e => { if (e.key === 'Enter' && e.target === e.currentTarget) jump(); }}>
    {ref && <div className="search-hit-reply">
      <CornerUpRight size={12} aria-hidden="true" />
      <span className="search-hit-reply-name">@{chat.nameOf(ref.author, ref.member)}</span>
      <span className="search-hit-reply-text">{ref.content || 'Click to see attachment'}</span>
    </div>}
    <div className="search-hit-main">
      <button type="button" className="chat-avatar-btn" aria-label={chat.nameOf(hit.author, hit.member)} {...author(hit.author)}><Avatar user={hit.author} size={40} /></button>
      <div className="search-hit-content">
        <header className="search-hit-header">
          <button type="button" className="chat-author search-hit-author" style={color ? { color } : undefined} {...author(hit.author)}>{chat.nameOf(hit.author, hit.member)}</button>
          <time className="chat-timestamp" dateTime={hit.timestamp}>{formatMessageTimestamp(new Date(hit.timestamp))}</time>
        </header>
        <div data-search-body>
          {hit.content && <Markdown content={hit.content} ctx={chat.md} className="chat-content" />}
        </div>
        <Attachments message={hit} />
      </div>
      <button type="button" className="search-hit-jump" onClick={jump}>Jump</button>
    </div>
  </article>;
}
