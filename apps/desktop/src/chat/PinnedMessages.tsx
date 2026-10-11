import { useEffect, useMemo, useState } from 'react';
import { Pin } from 'lucide-react';
import type { Message, Snowflake } from '../api/types';
import { ChatProvider, useChat, type ChatActions } from './ChatContext';
import { Avatar } from './Avatar';
import { Markdown } from './markdown';
import { Attachments } from './Attachments';
import { request } from './shell';
import { messageStore } from './messageStore';
import { formatMessageTimestamp } from './util';
import { rememberMessages } from './userCache';
import './chat.css';

/** Body of the header "Pinned Messages" popout. The shell supplies the popout chrome and anchors it to the header button. */
export function PinnedMessages({ channelId, onJump }: { channelId: Snowflake; onJump?: (messageId: Snowflake) => void }) {
  const actions = useMemo<ChatActions>(() => ({
    reply() {}, edit() {}, requestDelete() {}, togglePin() {}, react() {}, openImage() {},
    jumpTo: id => { void messageStore.jumpToMessage(channelId, id); onJump?.(id); },
    openLink: href => { window.open(href, '_blank', 'noopener,noreferrer'); },
  }), [channelId, onJump]);
  return <ChatProvider channelId={channelId} actions={actions}><PinnedList channelId={channelId} onJump={onJump} /></ChatProvider>;
}

function PinnedList({ channelId, onJump }: { channelId: Snowflake; onJump?: (id: Snowflake) => void }) {
  const chat = useChat();
  const [pins, setPins] = useState<Message[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let live = true;
    setPins(null); setError(false);
    request<Message[]>('GET', `/channels/${channelId}/pins`)
      .then(list => { if (live) { rememberMessages(list); setPins(list); } })
      .catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [channelId]);

  return <div className="chat-pins" role="dialog" aria-label="Pinned Messages">
    <header className="chat-pins-header"><h2>Pinned Messages</h2></header>
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
    </div>
    {onJump === undefined && null}
  </div>;
}
