import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pin } from 'lucide-react';
import type { Message, PinnedMessagesPage, Snowflake } from '../api/types';
import { ChatProvider, useChat, type ChatActions } from './ChatContext';
import { Avatar } from './Avatar';
import { Markdown } from './markdown';
import { Attachments } from './Attachments';
import { request } from './shell';
import { messageStore } from './messageStore';
import { formatMessageTimestamp } from './util';
import { rememberMessages } from './userCache';
import './chat.css';

const PAGE = 50;

/** Body of the header "Pinned Messages" popout. The shell supplies the popout chrome and anchors it to the header button. */
export function PinnedMessages({ channelId, onJump }: { channelId: Snowflake; onJump?: (messageId: Snowflake) => void }) {
  const actions = useMemo<ChatActions>(() => ({
    reply() {}, edit() {}, requestDelete() {}, togglePin() {}, react() {}, openImage() {}, viewAttachment() {}, deleteAttachment() {}, viewReactions() {},
    jumpTo: id => { void messageStore.jumpToMessage(channelId, id); onJump?.(id); },
    openLink: href => { window.open(href, '_blank', 'noopener,noreferrer'); },
  }), [channelId, onJump]);
  return <ChatProvider channelId={channelId} actions={actions}><PinnedList channelId={channelId} onJump={onJump} /></ChatProvider>;
}

function PinnedList({ channelId, onJump }: { channelId: Snowflake; onJump?: (id: Snowflake) => void }) {
  const chat = useChat();
  const [items, setItems] = useState<PinnedMessagesPage['items'] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const pins: Message[] | null = useMemo(() => items?.map(i => i.message) ?? null, [items]);

  // Newest pin first, 50 per page; `before` is the pinned_at of the last item shown.
  const fetchPage = useCallback((before?: string) => request<PinnedMessagesPage>(
    'GET', `/channels/${channelId}/messages/pins?limit=${PAGE}${before ? `&before=${encodeURIComponent(before)}` : ''}`,
  ), [channelId]);

  useEffect(() => {
    let live = true;
    setItems(null); setHasMore(false); setError(false);
    fetchPage()
      .then(page => { if (live) { rememberMessages(page.items.map(i => i.message)); setItems(page.items); setHasMore(page.has_more); } })
      .catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [fetchPage]);

  async function loadMore() {
    const last = items?.[items.length - 1];
    if (!last || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchPage(last.pinned_at);
      rememberMessages(page.items.map(i => i.message));
      setItems(cur => [...(cur ?? []), ...page.items.filter(n => !cur?.some(c => c.message.id === n.message.id))]);
      setHasMore(page.has_more);
    } catch { setError(true); } finally { setLoadingMore(false); }
  }

  return <div className="chat-pins" role="dialog" aria-label="Pinned Messages">
    <header className="chat-pins-header"><Pin size={20} aria-hidden="true" /><h2>Pinned Messages</h2></header>
    <div className="chat-pins-body">
      {pins === null && !error && <div className="chat-pins-empty">Loading…</div>}
      {error && <div className="chat-pins-empty">Couldn't load pinned messages.</div>}
      {pins?.length === 0 && <div className="chat-pins-empty">
        <Pin size={48} />
        <h3>This channel doesn't have any pinned messages… yet.</h3>
        <p>{chat.canManage || chat.isDm ? 'Pin important messages so everyone can find them here.' : 'Pins are chosen by people with permission to manage messages.'}</p>
      </div>}
      {pins?.map(m => <article className="chat-pin" key={m.id}>
        <header>
          <Avatar user={m.author} size={24} />
          <span className="chat-author" style={chat.colorOf(m) ? { color: chat.colorOf(m)! } : undefined}>{chat.nameOf(m.author, m.member)}</span>
          <time className="chat-timestamp" dateTime={m.timestamp}>{formatMessageTimestamp(new Date(m.timestamp))}</time>
          <button type="button" className="chat-pin-jump" onClick={() => chat.actions.jumpTo(m.id)}>Jump</button>
        </header>
        {m.content && <Markdown content={m.content} ctx={chat.md} className="chat-content" />}
        <Attachments message={m} />
      </article>)}
      {hasMore && <button type="button" className="chat-btn chat-pins-more" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? 'Loading…' : 'Load more'}</button>}
    </div>
  </div>;
}
