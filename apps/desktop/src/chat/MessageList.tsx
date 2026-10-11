import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { ArrowDown, Hash, Loader2 } from 'lucide-react';
import { ChannelType } from '../api/types';
import type { Snowflake } from '../api/types';
import { useChat } from './ChatContext';
import { Avatar } from './Avatar';
import { MessageItem } from './MessageItem';
import { messageStore, useChannelState } from './messageStore';
import { buildRows, type Row } from './messageState';
import { compareIds, formatDivider, formatFullDate, sameDay } from './util';

export interface MessageListHandle {
  scrollToBottom(): void;
}

interface Props {
  channelId: Snowflake;
  editingId: Snowflake | null;
  onStopEditing(): void;
  onAtBottomChange(atBottom: boolean): void;
}

function ChannelStart() {
  const chat = useChat();
  const ch = chat.channel;
  if (ch && (ch.type === ChannelType.DM)) {
    const other = ch.recipients?.[0];
    const name = other ? chat.nameOf(other) : 'this user';
    return <div className="chat-start">
      {other && <Avatar user={other} size={80} className="chat-start-avatar" />}
      <h1>{name}</h1>
      <h2>{other?.username}</h2>
      <p>This is the beginning of your direct message history with <b>{name}</b>.</p>
    </div>;
  }
  if (ch && ch.type === ChannelType.GroupDM) {
    const names = (ch.recipients ?? []).map(u => chat.nameOf(u)).join(', ');
    return <div className="chat-start"><h1>{names}</h1><p>Welcome to the beginning of the group.</p></div>;
  }
  return <div className="chat-start">
    <div className="chat-start-icon"><Hash size={42} /></div>
    <h1>Welcome to #{ch?.name}!</h1>
    <p>This is the start of the #{ch?.name} channel.{ch?.topic ? ` ${ch.topic}` : ''}</p>
  </div>;
}

const Header = memo(function Header({ context }: { context?: { hasMoreBefore: boolean; loading: boolean } }) {
  if (context?.hasMoreBefore) return <div className="chat-list-spinner" role="status" aria-label="Loading older messages">{context.loading && <Loader2 className="spin" size={24} />}</div>;
  return <ChannelStart />;
});
const Footer = memo(function Footer({ context }: { context?: { hasMoreAfter: boolean; loading: boolean } }) {
  return <div className="chat-list-footer">{context?.hasMoreAfter && context.loading && <Loader2 className="spin" size={24} />}</div>;
});

export const MessageList = forwardRef<MessageListHandle, Props>(function MessageList({ channelId, editingId, onStopEditing, onAtBottomChange }, ref) {
  const chat = useChat();
  const state = useChannelState(channelId);
  const virtuoso = useRef<VirtuosoHandle>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [highlightId, setHighlightId] = useState<Snowflake | null>(null);
  const [seenBottom, setSeenBottom] = useState(false);

  const rows = useMemo<Row[]>(
    () => buildRows(state, formatDivider, sameDay, chat.me.id),
    [state.messages, state.pending, state.hasMoreAfter, state.lastReadAtOpen, chat.me.id],
  );
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useImperativeHandle(ref, () => ({
    scrollToBottom() { virtuoso.current?.scrollToIndex({ index: Math.max(0, rowsRef.current.length - 1), align: 'end', behavior: 'auto' }); },
  }), []);

  // Jump-to-message (reply click, pinned "Jump"): scroll then flash.
  const focusToken = state.focus?.token;
  const focusId = state.focus?.messageId;
  useEffect(() => {
    if (!focusId) return;
    stick.current = false; // a programmatic jump is not "at the bottom"; don't let list growth drag us back down
    const index = rowsRef.current.findIndex(r => r.message.id === focusId);
    if (index >= 0) virtuoso.current?.scrollToIndex({ index, align: 'center', behavior: 'auto' });
    setHighlightId(focusId);
    const t = setTimeout(() => { setHighlightId(null); messageStore.clearFocus(channelId); }, 2200);
    return () => clearTimeout(t);
  }, [focusToken, focusId, channelId]);

  const initialIndex = useMemo(() => {
    const i = state.focus ? rows.findIndex(r => r.message.id === state.focus!.messageId) : -1;
    return i >= 0 ? i : Math.max(0, rows.length - 1);
    // Only meaningful when the list (re)mounts for a new window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.windowId]);

  // `stick`: the user has not scrolled away from the bottom, so content growing under us (image load, pending to confirmed swap) keeps the
  // list pinned. At-bottom flipping to false without a scroll gesture is growth, not intent.
  const stick = useRef(true);
  const scroller = useRef<HTMLElement | null>(null);
  const lastGesture = useRef(0);
  const pointerDown = useRef(false);
  const gesture = useCallback(() => { lastGesture.current = performance.now(); }, []);
  useEffect(() => {
    const up = () => { pointerDown.current = false; };
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  }, []);
  const onBottom = useCallback((value: boolean) => {
    if (value) stick.current = true;
    else if (pointerDown.current || performance.now() - lastGesture.current < 500) stick.current = false;
    setAtBottom(value);
    if (value) setSeenBottom(true);
    onAtBottomChange(value);
  }, [onAtBottomChange]);

  useEffect(() => { stick.current = true; setSeenBottom(false); setAtBottom(true); }, [channelId]);

  const unreadCount = useMemo(() => {
    if (!state.lastReadAtOpen) return 0;
    return state.messages.filter(m => compareIds(m.id, state.lastReadAtOpen!) > 0 && m.author.id !== chat.me.id).length;
  }, [state.messages, state.lastReadAtOpen, chat.me.id]);
  const firstUnread = useMemo(() => state.messages.find(m => state.lastReadAtOpen && compareIds(m.id, state.lastReadAtOpen) > 0), [state.messages, state.lastReadAtOpen]);

  if (state.status === 'loading' && state.messages.length === 0) {
    return <div className="chat-list chat-list-loading" aria-busy="true">{Array.from({ length: 8 }, (_, i) => <div key={i} className="chat-skeleton"><span className="a" /><span className="l1" style={{ width: `${30 + ((i * 37) % 40)}%` }} /><span className="l2" style={{ width: `${40 + ((i * 53) % 50)}%` }} /></div>)}</div>;
  }
  if (state.status === 'error') {
    return <div className="chat-list chat-list-error" role="alert">
      <p>We couldn't load the messages in this channel.</p>
      <button type="button" className="chat-btn" onClick={() => messageStore.retryLoad(channelId)}>Try again</button>
    </div>;
  }

  const showJump = state.hasMoreAfter || !atBottom;
  const showUnread = unreadCount > 0 && !seenBottom && !!firstUnread;

  return <div className="chat-list" onWheel={gesture} onTouchMove={gesture} onKeyDown={gesture} onPointerDown={() => { pointerDown.current = true; gesture(); }}>
    {showUnread && <div className="chat-unread-bar" role="status">
      <button type="button" className="chat-unread-bar-main" onClick={() => {
        const i = rows.findIndex(r => r.message.id === firstUnread!.id);
        if (i >= 0) virtuoso.current?.scrollToIndex({ index: i, align: 'start', behavior: 'smooth' });
      }}>{unreadCount}{state.hasMoreBefore ? '+' : ''} new message{unreadCount === 1 ? '' : 's'} since {formatFullDate(new Date(firstUnread!.timestamp))}</button>
      <button type="button" className="chat-unread-bar-mark" onClick={() => { const last = state.messages[state.messages.length - 1]; if (last) messageStore.ack(channelId, last.id); setSeenBottom(true); }}>Mark As Read</button>
    </div>}
    <Virtuoso<Row, { hasMoreBefore: boolean; hasMoreAfter: boolean; loading: boolean }>
      key={`${channelId}:${state.windowId}`}
      ref={virtuoso}
      className="chat-scroller"
      data={rows}
      context={{ hasMoreBefore: state.hasMoreBefore, hasMoreAfter: state.hasMoreAfter, loading: state.loadingOlder || state.loadingNewer }}
      firstItemIndex={state.firstItemIndex}
      initialTopMostItemIndex={{ index: initialIndex, align: state.focus ? 'center' : 'end' }}
      alignToBottom
      defaultItemHeight={56}
      increaseViewportBy={{ top: 600, bottom: 400 }}
      atBottomThreshold={160}
      atBottomStateChange={onBottom}
      scrollerRef={el => { scroller.current = el instanceof HTMLElement ? el : null; }}
      totalListHeightChanged={() => {
        if (!stick.current || state.hasMoreAfter) return;
        // Item sizes are measured after layout, so scroll again once the new height has settled.
        const toEnd = () => {
          const el = scroller.current;
          if (stick.current && el) el.scrollTop = el.scrollHeight;
        };
        toEnd();
        requestAnimationFrame(() => requestAnimationFrame(toEnd));
      }}
      followOutput={isAtBottom => (isAtBottom && !state.hasMoreAfter ? 'auto' : false)}
      startReached={() => { void messageStore.loadOlder(channelId); }}
      endReached={() => { void messageStore.loadNewer(channelId); }}
      computeItemKey={(_, row) => row.key}
      components={{ Header, Footer }}
      itemContent={(_, row) => <div className="chat-row" role="listitem">
        {row.dayLabel && <div className="chat-day-divider" role="separator"><span>{row.dayLabel}</span></div>}
        {row.unreadDivider && <div className="chat-new-divider" role="separator"><span>NEW</span></div>}
        <MessageItem
          message={row.message}
          pending={row.pending}
          grouped={row.grouped}
          editing={editingId === row.message.id}
          highlighted={highlightId === row.message.id}
          onStopEditing={onStopEditing}
        />
      </div>}
    />
    {showJump && <div className="chat-jump-bar" role="status">
      <span>You're viewing older messages</span>
      <button type="button" onClick={() => {
        if (state.hasMoreAfter) void messageStore.jumpToPresent(channelId);
        else virtuoso.current?.scrollToIndex({ index: Math.max(0, rows.length - 1), align: 'end', behavior: 'smooth' });
      }}>Jump To Present <ArrowDown size={16} /></button>
    </div>}
  </div>;
});
