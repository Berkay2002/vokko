import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Virtuoso, type ItemProps, type ListProps, type VirtuosoHandle } from 'react-virtuoso';
import { CheckCheck, Loader2 } from 'lucide-react';
import { RelationshipType, type Message, type Snowflake } from '../api/types';
import { plainBody } from '../notify/text';
import { announce } from '../ui/announce';
import { useChat } from './ChatContext';
import { foldBlocked, foldLabel, type DisplayRow, type Fold } from './blockedFold';
import { scrollBehavior, useRelationships } from './shell';
import { ChannelStart } from './ChannelStart';
import { MessageItem } from './MessageItem';
import { messageStore, useChannelState } from './messageStore';
import { buildRows, type Row } from './messageState';
import { navIndex } from './messageKeys';
import { compareIds, formatDivider, formatTime, sameDay } from './util';

export interface MessageListHandle {
  scrollToBottom(): void;
  /** Notes the focused message row (and its neighbours, for a delete) before an edit or delete takes the focus; clears it otherwise. */
  rememberFocus(): void;
  /** Focuses the remembered row, or the next then previous one when it is gone. False when no row was remembered. */
  restoreFocus(): boolean;
}

interface Props {
  channelId: Snowflake;
  editingId: Snowflake | null;
  onStopEditing(): void;
  onAtBottomChange(atBottom: boolean): void;
}

// Runs of blocked authors the viewer opened with Show, by message id, for the session (a channel switch keeps them).
const revealed = new Set<Snowflake>();

// The start-of-channel intro is not the list header: it is rendered inside the first row, directly above the oldest message, so
// short conversations stay anchored to the bottom with no gap between the intro and the first message.
const Header = memo(function Header({ context }: { context?: { hasMoreBefore: boolean; loading: boolean } }) {
  if (!context?.hasMoreBefore) return null;
  return <div className="chat-list-spinner" role="status" aria-label="Loading older messages">{context.loading && <Loader2 className="spin" size={24} />}</div>;
});
const Footer = memo(function Footer({ context }: { context?: { hasMoreAfter: boolean; loading: boolean } }) {
  return <div className="chat-list-footer">{context?.hasMoreAfter && context.loading && <Loader2 className="spin" size={24} />}</div>;
});

// Virtuoso puts its own wrapper divs between the scroller and the rows: they carry the list roles, so each row has a list parent.
const List = forwardRef<HTMLDivElement, ListProps<HTMLDivElement> & { context?: { label?: string } }>(function List({ context, ...props }, ref) {
  return <div ref={ref} {...props} role="list" aria-label={context?.label} />;
});
function Item({ context: _context, item: _item, ...props }: ItemProps<DisplayRow> & { context?: unknown }) {
  return <div {...props} role="listitem" />;
}

export const MessageList = forwardRef<MessageListHandle, Props>(function MessageList({ channelId, editingId, onStopEditing, onAtBottomChange }, ref) {
  const chat = useChat();
  const state = useChannelState(channelId);
  const virtuoso = useRef<VirtuosoHandle>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [highlightId, setHighlightId] = useState<Snowflake | null>(null);
  const [seenBottom, setSeenBottom] = useState(false);
  const [farFromBottom, setFarFromBottom] = useState(false);
  // Roving tabindex: the message that holds the list's one tab stop, by id so it survives new messages and pagination.
  const [activeId, setActiveId] = useState<Snowflake | null>(null);
  const returnTo = useRef<Snowflake[] | null>(null);

  const relationships = useRelationships();
  const [revealVersion, setRevealVersion] = useState(0);
  const blockedAuthor = (m: Message) => relationships[m.author.id]?.type === RelationshipType.Blocked;
  const built = useMemo<Row[]>(
    () => buildRows(state, formatDivider, sameDay, chat.me.id),
    [state.messages, state.pending, state.hasMoreAfter, state.lastReadAtOpen, chat.me.id],
  );
  const folded = useMemo(
    () => foldBlocked(built, id => relationships[id]?.type === RelationshipType.Blocked, revealed),
    [built, relationships, revealVersion],
  );
  const rows = folded.rows;
  const toggleFold = (fold: Fold) => {
    for (const id of fold.ids) { if (fold.open) revealed.delete(id); else revealed.add(id); }
    setRevealVersion(v => v + 1);
  };
  // Virtuoso counts firstItemIndex down by the rows an older page adds; the store counts messages, and a folded run is fewer rows.
  // The newest message when the window was made stays put, so the rows hidden above it are what to add.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const anchor = useMemo(() => state.messages[state.messages.length - 1]?.id ?? null, [channelId, state.windowId]);
  const firstIndex = state.firstItemIndex + folded.hiddenBefore(anchor);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useImperativeHandle(ref, () => ({
    scrollToBottom() {
      virtuoso.current?.scrollToIndex({ index: Math.max(0, rowsRef.current.length - 1), align: 'end', behavior: 'auto' });
      // scrollToIndex aligns the last row (not the footer) and row heights settle after the jump: finish at the real end.
      stick.current = true;
      const toEnd = () => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; };
      requestAnimationFrame(() => { toEnd(); requestAnimationFrame(toEnd); });
    },
    rememberFocus() {
      const id = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.chat-msg[data-message-id]')?.dataset.messageId;
      const i = id ? rowsRef.current.findIndex(r => r.message.id === id) : -1;
      returnTo.current = i < 0 ? null : [i, i + 1, i - 1].flatMap(j => rowsRef.current[j]?.message.id ?? []);
    },
    restoreFocus() {
      const ids = returnTo.current;
      returnTo.current = null;
      if (!ids) return false;
      const index = ids.map(id => rowsRef.current.findIndex(r => r.message.id === id)).find(i => i >= 0);
      if (index === undefined) return false;
      focusRow(index);
      return true;
    },
  }), []);

  // Jump-to-message (reply click, pinned "Jump"): scroll then flash.
  const focusToken = state.focus?.token;
  const focusId = state.focus?.messageId;
  // A jump into a folded run opens the run first, then scrolls.
  const hiddenFocus = focusId ? folded.closed.get(focusId) : undefined;
  useEffect(() => {
    if (!hiddenFocus) return;
    for (const id of hiddenFocus.ids) revealed.add(id);
    setRevealVersion(v => v + 1);
  }, [hiddenFocus]);
  useEffect(() => {
    if (!focusId || hiddenFocus) return;
    stick.current = false; // a programmatic jump is not "at the bottom"; don't let list growth drag us back down
    const index = rowsRef.current.findIndex(r => r.message.id === focusId);
    if (index >= 0) virtuoso.current?.scrollToIndex({ index, align: 'center', behavior: 'auto' });
    setHighlightId(focusId);
    const t = setTimeout(() => { setHighlightId(null); messageStore.clearFocus(channelId); }, 2200);
    return () => clearTimeout(t);
  }, [focusToken, focusId, channelId, !!hiddenFocus]);

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
  // A trim remounts the list (new windowId): only while it follows the bottom, and never under an edit draft, an open picker or
  // menu, or a text selection in the list.
  const following = useRef(false);
  const editing = useRef(editingId);
  useEffect(() => { editing.current = editingId; }, [editingId]);
  useEffect(() => {
    messageStore.setFollowing(channelId, () => following.current && !editing.current && !interacting(scroller.current));
    return () => { following.current = false; messageStore.setFollowing(channelId, null); };
  }, [channelId]);
  const onBottom = useCallback((value: boolean) => {
    if (value) stick.current = true;
    else if (pointerDown.current || performance.now() - lastGesture.current < 500) stick.current = false;
    setAtBottom(value);
    if (value) setSeenBottom(true);
    onAtBottomChange(value);
    following.current = value;
  }, [onAtBottomChange]);

  useEffect(() => { stick.current = true; setSeenBottom(false); setAtBottom(true); setActiveId(null); }, [channelId]);

  // Up/Down/PageUp/PageDown/Home/End on a focused message (or on the scroller, which enters at the tab stop); Escape goes back to the
  // composer. The message's own hotkeys are in MessageItem.
  const tabStop = (activeId && rows.some(r => r.message.id === activeId) ? activeId : rows[rows.length - 1]?.message.id) ?? null;
  const focusRow = (index: number) => {
    const id = rowsRef.current[index]?.message.id;
    if (!id) return;
    setActiveId(id);
    virtuoso.current?.scrollIntoView({ index, behavior: 'auto' });
    // The row may mount only after the scroll: try for a few frames.
    let frames = 0;
    const tryFocus = () => {
      const el = scroller.current?.querySelector<HTMLElement>(`.chat-msg[data-message-id="${id}"]`);
      if (el) el.focus({ preventScroll: true });
      else if (frames++ < 10) requestAnimationFrame(tryFocus);
    };
    tryFocus();
  };
  const onListKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    gesture();
    const t = e.target as HTMLElement;
    const onRow = t.classList.contains('chat-msg') && !!t.dataset.messageId;
    if (!onRow && t !== scroller.current) return;
    if (e.key === 'Escape' && onRow && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const box = e.currentTarget.closest('.chat-view')?.querySelector<HTMLElement>('.chat-textarea');
      if (box) { e.preventDefault(); box.focus(); }
      return;
    }
    if (!onRow && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return; // the scroller keeps PageUp/PageDown/Home/End scrolling
    const from = rows.findIndex(r => r.message.id === (onRow ? t.dataset.messageId : tabStop));
    const page = Math.max(1, Math.floor((scroller.current?.clientHeight ?? 560) / 56));
    const next = navIndex(e.nativeEvent, from, rows.length, page);
    if (next === null || from < 0) return;
    e.preventDefault();
    focusRow(onRow ? next : from); // from the scroller, Up/Down enter the list at the tab stop
  };
  const onListFocus = (e: React.FocusEvent<HTMLDivElement>) => {
    const id = (e.target as HTMLElement).classList.contains('chat-msg') ? (e.target as HTMLElement).dataset.messageId : undefined;
    if (id) setActiveId(id);
  };

  // Opening at the bottom, the first frame with rows can place them from estimated heights (newest row below the fold) before the
  // measured layout lands a frame later. The scroller mounts with .settling (hidden) and shows once the newest row ends inside the
  // viewport, at most 10 frames. The class is removed on the element, so it stays fixed for the mount. No unmount cleanup: StrictMode's
  // effect replay would cancel the check and leave the list hidden; the check stops by itself.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const settling = useMemo(() => !state.focus, [channelId, state.windowId]);
  const unsettle = useRef<() => void>(() => {});
  const settle = useCallback((el: HTMLElement) => {
    unsettle.current();
    let frames = 0;
    let raf = 0;
    const done = () => { cancelAnimationFrame(raf); ro.disconnect(); el.classList.remove('settling'); };
    const ok = () => {
      const items = el.querySelectorAll('[data-index]');
      const last = items[items.length - 1];
      // data-index counts from the window's first row, not from firstItemIndex.
      return !!last && Number(last.getAttribute('data-index')) === rowsRef.current.length - 1 && last.getBoundingClientRect().bottom <= el.getBoundingClientRect().bottom + 1;
    };
    // Checked after layout (ResizeObserver, before paint) and once per frame as the fallback that gives up after 10.
    const ro = new ResizeObserver(() => { if (ok()) done(); });
    for (const box of [el.firstElementChild, el.querySelector('[data-testid="virtuoso-item-list"]')]) if (box) ro.observe(box, { box: 'border-box' }); // the list moves rows with padding
    const tick = () => { if (ok() || frames++ >= 10) done(); else raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    unsettle.current = () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);
  // Virtuoso calls this with null and the node again whenever the callback changes, hence stable, and settle once per node.
  const settled = useRef<HTMLElement | null>(null);
  const scrollerRef = useCallback((el: HTMLElement | Window | null) => {
    const node = el instanceof HTMLElement ? el : null;
    if (node && node !== settled.current && node.classList.contains('settling')) { settled.current = node; settle(node); }
    scroller.current = node;
  }, [settle]);

  // Screen readers hear messages from others that arrive in the open channel. Not role=log on the list: Virtuoso mounts and unmounts
  // rows while scrolling, and a log would read each of them out again.
  const lastSeen = useRef<string | null>(null);
  const newest = state.messages[state.messages.length - 1];
  useEffect(() => {
    const key = newest ? `${channelId}:${newest.id}` : null;
    const prev = lastSeen.current;
    lastSeen.current = key;
    if (!newest || !prev || prev === key || !prev.startsWith(`${channelId}:`) || state.hasMoreAfter || newest.author.id === chat.me.id || blockedAuthor(newest)) return;
    if (compareIds(newest.id, prev.slice(channelId.length + 1)) <= 0) return; // older history loaded, or the newest was deleted
    announce(`${chat.nameOf(newest.author, newest.member)}: ${plainBody(newest, { userName: id => chat.md.userName(id), roleName: id => chat.md.roleInfo(id)?.name ?? null, channelNameOf: id => chat.md.channelName(id) }) || 'sent an attachment'}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, newest?.id]);

  const unreadCount = useMemo(() => {
    if (!state.lastReadAtOpen) return 0;
    return state.messages.filter(m => compareIds(m.id, state.lastReadAtOpen!) > 0 && m.author.id !== chat.me.id && !blockedAuthor(m)).length;
  }, [state.messages, state.lastReadAtOpen, chat.me.id, relationships]);
  const firstUnread = useMemo(() => state.messages.find(m => state.lastReadAtOpen && compareIds(m.id, state.lastReadAtOpen) > 0 && !blockedAuthor(m)), [state.messages, state.lastReadAtOpen, relationships]);

  if (state.status === 'loading' && state.messages.length === 0) {
    return <div className="chat-list chat-list-loading" aria-busy="true">{Array.from({ length: 8 }, (_, i) => <div key={i} className="chat-skeleton"><span className="a" /><span className="l1" style={{ width: `${30 + ((i * 37) % 40)}%` }} /><span className="l2" style={{ width: `${40 + ((i * 53) % 50)}%` }} /></div>)}</div>;
  }
  if (state.status === 'error') {
    return <div className="chat-list chat-list-error" role="alert">
      <p>We couldn't load the messages in this channel.</p>
      <button type="button" className="chat-btn" onClick={() => messageStore.retryLoad(channelId)}>Try again</button>
    </div>;
  }

  if (rows.length === 0 && !state.hasMoreBefore) {
    return <div className="chat-list chat-list-empty"><ChannelStart /></div>;
  }

  // The pill is for "scrolled up a lot" (more than a screen from the bottom) or a window that is not anchored at the present.
  const showJump = state.hasMoreAfter || (!atBottom && farFromBottom);
  const showUnread = unreadCount > 0 && (!seenBottom || !!state.markedUnread) && !!firstUnread;
  // "since 11:13" for today, else the date (the reference banner shows the time of the first unread message).
  const unreadSince = firstUnread ? (sameDay(new Date(firstUnread.timestamp), new Date()) ? formatTime(new Date(firstUnread.timestamp)) : formatDivider(new Date(firstUnread.timestamp))) : '';

  const listLabel = `Messages in ${chat.channel?.name ? `#${chat.channel.name}` : 'this conversation'}`;
  return <div className="chat-list" onWheel={gesture} onTouchMove={gesture} onKeyDown={onListKey} onFocus={onListFocus} onPointerDown={() => { pointerDown.current = true; gesture(); }}>
    {/* Gives the authors' <h3>s a level-2 parent under the channel's <h1> (axe heading-order), at any scroll position. */}
    <h2 className="sr-only">{listLabel}</h2>
    {showUnread && <div className="chat-unread-bar" role="status">
      <button type="button" className="chat-unread-bar-main" onClick={() => {
        const i = rows.findIndex(r => r.message.id === firstUnread!.id);
        if (i >= 0) virtuoso.current?.scrollToIndex({ index: i, align: 'start', behavior: scrollBehavior() });
      }}>{unreadCount}{state.hasMoreBefore ? '+' : ''} new message{unreadCount === 1 ? '' : 's'} since {unreadSince}</button>
      <button type="button" className="chat-unread-bar-mark" onClick={() => { const last = state.messages[state.messages.length - 1]; if (last) messageStore.markRead(channelId, last.id); setSeenBottom(true); }}>Mark As Read <CheckCheck size={18} aria-hidden="true" /></button>
    </div>}
    <Virtuoso<DisplayRow, { hasMoreBefore: boolean; hasMoreAfter: boolean; loading: boolean; label: string }>
      key={`${channelId}:${state.windowId}`}
      ref={virtuoso}
      className={settling ? 'chat-scroller settling' : 'chat-scroller'}
      aria-label={listLabel}
      data={rows}
      context={{ hasMoreBefore: state.hasMoreBefore, hasMoreAfter: state.hasMoreAfter, loading: state.loadingOlder || state.loadingNewer, label: listLabel }}
      firstItemIndex={firstIndex}
      // Opening at the bottom: initialScrollTop (clamped to the end) paints 2 frames sooner than initialTopMostItemIndex, which waits 4
      // frames before its first scroll. Measuring in the ResizeObserver callback itself (no extra rAF) saves another frame; its
      // "ResizeObserver loop" errors are benign and the crash reporter ignores them.
      {...(state.focus ? { initialTopMostItemIndex: { index: initialIndex, align: 'center' as const } } : { initialScrollTop: 1e9 })}
      skipAnimationFrameInResizeObserver
      alignToBottom
      defaultItemHeight={56}
      increaseViewportBy={{ top: 600, bottom: 400 }}
      atBottomThreshold={160}
      atBottomStateChange={onBottom}
      onScroll={e => { const el = e.currentTarget; setFarFromBottom(el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight); }}
      scrollerRef={scrollerRef}
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
      components={{ Header, Footer, List, Item }}
      itemContent={(index, row) => <div className="chat-row">
        {index === firstIndex && !state.hasMoreBefore && <ChannelStart />}
        {/* The new-messages divider on a day boundary is the day divider itself, in red with the pill at its right end. */}
        {row.dayLabel && <div className={`chat-day-divider${row.unreadDivider ? ' unread' : ''}`} role="separator"><span>{row.dayLabel}</span>{row.unreadDivider && <b className="chat-new-pill">NEW</b>}</div>}
        {row.unreadDivider && !row.dayLabel && <div className="chat-new-divider" role="separator"><b className="chat-new-pill">NEW</b></div>}
        {row.fold && !row.fold.open ? (
          // Stands in for the run as a row of its own: the list's keyboard navigation and focus restore find it by data-message-id.
          <div
            className="chat-msg chat-blocked"
            data-message-id={row.message.id}
            tabIndex={tabStop === row.message.id ? 0 : -1}
            onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); toggleFold(row.fold!); } }}
          >
            {foldLabel(row.fold.ids.length)} · <button type="button" className="chat-blocked-toggle" tabIndex={-1} aria-label={`Show ${foldLabel(row.fold.ids.length)}`} onClick={() => toggleFold(row.fold!)}>Show</button>
          </div>
        ) : (
          <>
            {row.fold && <div className="chat-blocked-bar">{foldLabel(row.fold.ids.length)} · <button type="button" className="chat-blocked-toggle" onClick={() => toggleFold(row.fold!)}>Hide</button></div>}
            <MessageItem
              message={row.message}
              pending={row.pending}
              grouped={row.grouped}
              editing={editingId === row.message.id}
              highlighted={highlightId === row.message.id}
              tabStop={tabStop === row.message.id}
              onStopEditing={onStopEditing}
            />
          </>
        )}
      </div>}
    />
    {showJump && <div className="chat-jump-bar" role="status">
      <span>You're viewing older messages</span>
      <button type="button" onClick={() => {
        if (state.hasMoreAfter) void messageStore.jumpToPresent(channelId);
        else virtuoso.current?.scrollToIndex({ index: Math.max(0, rows.length - 1), align: 'end', behavior: scrollBehavior() });
      }}>Jump To Present</button>
    </div>}
  </div>;
});

/** A text selection inside the list, or a popout, menu or sheet open anywhere (a row may own it). */
function interacting(list: HTMLElement | null): boolean {
  const sel = document.getSelection();
  if (list && sel && !sel.isCollapsed && list.contains(sel.anchorNode)) return true;
  return !!document.querySelector('.popout, .context-menu, .sheet-layer');
}
