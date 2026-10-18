import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  AppWindow, Bell, ChartBarBig, Bookmark, ChevronLeft, ChevronRight, Copy, CornerUpLeft, Fingerprint, Flag, Forward, Link2, MailOpen, Megaphone, MessageSquareText, Pencil, Pin, PinOff, SmilePlus, Trash2, Volume2,
} from 'lucide-react';
import { MessageType } from '../api/types';
import type { Message } from '../api/types';
import { useChat } from './ChatContext';
import { emojiShortcodeLabel, frequentEmoji, quickReactions, useEmojiDb } from './emojiData';
import { messageStore } from './messageStore';
import { isSystemMessage, type PendingMessage } from './messageState';
import { toDisplay } from './mentionText';
import { BottomSheet, isDeveloperMode, openModal, useLayer, useOutsideClose, usePhone } from './shell';
import { comingSoon } from './toast';
import { ReminderMenu } from '../media/ReminderMenu';
import { openForward, toggleBookmark, useIsBookmarked } from '../media/store';
import { isShiftDown } from './util';
import { useMessageThreadActions } from '../threads/useMessageActions';
import { MessageAppsMenu } from '../apps/menus';
import { canEndPoll, endPollNow } from '../polls/usePollActions';
import { rovingKey } from '../ui';

export interface MessageMenuTarget {
  message: Message;
  pending: PendingMessage | null;
  x: number;
  y: number;
}

interface Row {
  id: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  children?: ReactNode | ((close: () => void) => ReactNode);
}
type Entry = Row | 'separator';

const ICON = 20;
const EDGE = 8;

/**
 * The menu's corner sits on the pointer. It flips to the left of the pointer when it would leave the window on the right and to above
 * it when it would leave at the bottom (the menu is tall, so pinning it to the window edge would lose the link with the click).
 */
function placeAtPointer(x: number, y: number, width: number, height: number): { left: number; top: number } {
  const left = x + width + EDGE > window.innerWidth ? Math.max(EDGE, x - width) : x;
  let top = y;
  if (y + height + EDGE > window.innerHeight) top = y - height >= EDGE ? y - height : Math.max(EDGE, window.innerHeight - height - EDGE);
  return { left, top };
}

/**
 * Right-click / "More" menu of a message, in the reference order: four quick-reaction tiles, Add Reaction ›, | Edit, Reply, Forward,
 * Create Thread, | Copy Text, Pin, Bookmark, Create Reminder ›, Apps ›, Mark Unread, Copy Message Link, Read Aloud, | Delete, Report (others'), | Copy Message ID.
 * Chat-local because the shared context menu has no tile row and puts icons on the right.
 */
export function MessageMenu({ target, onClose, onMoreEmoji }: { target: MessageMenuTarget; onClose(): void; onMoreEmoji(message: Message): void }) {
  const chat = useChat();
  const { message, pending } = target;
  const threadActions = useMessageThreadActions(message, !!pending);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  /** The open submenu was opened from the keyboard: it takes focus so arrow keys move through its rows. */
  const [subByKey, setSubByKey] = useState(false);
  // At phone widths the menu is a BottomSheet (its own layer and outside close); the positioned menu below is the desktop one.
  const phone = usePhone();
  const layer = useLayer(!phone, onClose);
  useOutsideClose(!phone, () => [box.current], onClose, layer.isTop);

  const isMine = message.author.id === chat.me.id;
  const system = isSystemMessage(message);
  const canEdit = isMine && !system && !pending && !message.poll && message.message_reference?.type !== 1; // a forward has no text to edit
  const canDelete = !pending && (isMine || chat.canManage) && message.type !== MessageType.RecipientAdd;
  const canPin = !pending && !system && (chat.isDm || chat.canManage);
  const bookmarked = useIsBookmarked(message.channel_id, message.id);
  const quick = useMemo(() => quickReactions().slice(0, 4), []);
  const react = (name: string) => chat.actions.react(message, { id: null, name });

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    const sep = () => { if (out.length > 0 && out[out.length - 1] !== 'separator') out.push('separator'); };
    if (!pending && !system) {
      out.push({
        id: 'add-reaction', label: 'Add Reaction', icon: <SmilePlus size={ICON} />,
        children: close => <ReactionMenu onPick={ch => { close(); react(ch); }} onMore={() => { close(); onMoreEmoji(message); }} />,
      });
      if (message.reactions.length > 0) out.push({ id: 'view-reactions', label: 'View Reactions', icon: <SmilePlus size={ICON} />, onSelect: () => chat.actions.viewReactions(message) });
      sep();
    }
    if (canEdit) out.push({ id: 'edit', label: 'Edit Message', icon: <Pencil size={ICON} />, onSelect: () => chat.actions.edit(message) });
    if (!pending && canEndPoll(message, chat.me.id)) out.push({ id: 'end-poll', label: 'End Poll Now', icon: <ChartBarBig size={ICON} />, onSelect: () => endPollNow(message) });
    if (!system) {
      if (chat.canSend) out.push({ id: 'reply', label: 'Reply', icon: <CornerUpLeft size={ICON} />, onSelect: () => chat.actions.reply(message) });
      if (!pending && !message.poll) out.push({ id: 'forward', label: 'Forward', icon: <Forward size={ICON} />, onSelect: () => openForward(message) });
      if (!pending && chat.guildId) {
        if (threadActions.thread) out.push({ id: 'thread', label: 'Open Thread', icon: <MessageSquareText size={ICON} />, onSelect: threadActions.openThread });
        else if (threadActions.canCreateThread) out.push({ id: 'thread', label: 'Create Thread', icon: <MessageSquareText size={ICON} />, onSelect: threadActions.createThread });
      }
      if (!pending && threadActions.announcement && (threadActions.published || threadActions.canPublish)) {
        out.push({ id: 'publish', label: threadActions.published ? 'Published' : 'Publish', icon: <Megaphone size={ICON} />, disabled: threadActions.published, onSelect: threadActions.publish });
      }
    }
    sep();
    if (message.content) out.push({ id: 'copy-text', label: 'Copy Text', icon: <Copy size={ICON} />, onSelect: () => void navigator.clipboard?.writeText(message.content) });
    if (canPin) out.push({ id: 'pin', label: message.pinned ? 'Unpin Message' : 'Pin Message', icon: message.pinned ? <PinOff size={ICON} /> : <Pin size={ICON} />, onSelect: () => chat.actions.togglePin(message) });
    if (!pending && !system) {
      out.push({ id: 'bookmark', label: bookmarked ? 'Remove Bookmark' : 'Bookmark Message', icon: <Bookmark size={ICON} fill={bookmarked ? 'currentColor' : 'none'} />, onSelect: () => void toggleBookmark(message) });
      out.push({
        id: 'reminder', label: 'Create Reminder', icon: <Bell size={ICON} />,
        children: close => <ReminderMenu message={message} close={close} />,
      });
      out.push({
        id: 'apps', label: 'Apps', icon: <AppWindow size={ICON} />,
        children: close => <MessageAppsMenu message={message} close={close} />,
      });
    }
    if (!pending) out.push({ id: 'mark-unread', label: 'Mark Unread', icon: <MailOpen size={ICON} />, onSelect: () => messageStore.markUnread(message.channel_id, message.id) });
    out.push({
      id: 'copy-link', label: 'Copy Message Link', icon: <Link2 size={ICON} />,
      onSelect: () => void navigator.clipboard?.writeText(`${window.location.origin}/channels/${chat.guildId ?? '@me'}/${message.channel_id}/${message.id}`),
    });
    if (message.content) {
      out.push({
        id: 'read-aloud', label: 'Read Aloud', icon: <Volume2 size={ICON} />,
        onSelect: () => {
          if (typeof speechSynthesis === 'undefined') { comingSoon('Read aloud on this device'); return; }
          const plain = toDisplay(message.content, { user: id => chat.md.userName(id), role: id => chat.md.roleInfo(id)?.name ?? null, channel: id => chat.md.channelName(id) }).text;
          speechSynthesis.cancel();
          speechSynthesis.speak(new SpeechSynthesisUtterance(plain));
        },
      });
    }
    const canReport = !isMine && !system && !pending;
    if (canDelete || canReport) sep();
    if (canDelete) out.push({ id: 'delete', label: 'Delete Message', icon: <Trash2 size={ICON} />, danger: true, onSelect: () => chat.actions.requestDelete(message, isShiftDown()) });
    if (canReport) out.push({ id: 'report', label: 'Report Message', icon: <Flag size={ICON} />, danger: true, onSelect: () => openModal({ type: 'report', target: { kind: 'message', channelId: message.channel_id, messageId: message.id, dm: chat.isDm } }) });
    if (isDeveloperMode()) {
      sep();
      out.push({ id: 'copy-id', label: 'Copy Message ID', icon: <Fingerprint size={ICON} />, onSelect: () => void navigator.clipboard?.writeText(message.id) });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message, pending, bookmarked, chat.guildId, chat.canManage, chat.canSend, chat.isDm, chat.me.id, threadActions.thread?.id, threadActions.canCreateThread, threadActions.canPublish, threadActions.published, threadActions.announcement]);

  useLayoutEffect(() => {
    const el = box.current;
    if (el) setPos(placeAtPointer(target.x, target.y, el.offsetWidth, el.offsetHeight));
  }, [target.x, target.y]);

  const rows = entries.filter((e): e is Row => e !== 'separator');
  useEffect(() => {
    if (phone) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setActive(a => { const next = (a + step + rows.length) % rows.length; return next; });
      } else if ((e.key === 'Enter' || e.key === ' ') && active >= 0) {
        const row = rows[active];
        if (!row) return;
        e.preventDefault();
        if (row.children) { setOpen(row.id); setSubByKey(true); }
        else if (!row.disabled) { onClose(); row.onSelect?.(); }
      } else if (e.key === 'Tab') {
        // no focusable rows: let Tab move on and close the menu behind it, unless focus is on a control inside the menu
        if (!document.activeElement?.closest('.context-menu')) onClose();
      }
      else if (e.key === 'ArrowLeft') setOpen(null);
      else if (e.key === 'ArrowRight' && active >= 0 && rows[active]?.children) { e.preventDefault(); setOpen(rows[active]!.id); setSubByKey(true); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  if (phone) {
    // Spec 04: quick reactions on top, then the actions as grouped rows; a row with a submenu drills down inside the sheet.
    const groups: Row[][] = [[]];
    for (const e of entries) {
      if (e === 'separator') groups.push([]);
      else if (e.id !== 'add-reaction') groups[groups.length - 1]!.push(e); // the "more" tile of the reaction row opens the full picker
    }
    const sub = rows.find(r => r.id === open && r.children);
    return <BottomSheet open onClose={onClose} label="Message actions" className="sheet-message">
      {sub ? <>
        <button type="button" className="sheet-back" onClick={() => setOpen(null)}><ChevronLeft size={20} aria-hidden="true" /> {sub.label}</button>
        <div className="chat-menu chat-menu-inline">{typeof sub.children === 'function' ? sub.children(onClose) : sub.children}</div>
      </> : <>
        {!pending && !system && <div className="sheet-reactions" role="group" aria-label="Quick reactions">
          {quick.map(e => <button key={e} type="button" className="sheet-reaction" aria-label={`React with ${e}`} onClick={() => { onClose(); react(e); }}>{e}</button>)}
          <button type="button" className="sheet-reaction" aria-label="More reactions" onClick={() => { onClose(); onMoreEmoji(message); }}><SmilePlus size={22} aria-hidden="true" /></button>
        </div>}
        {groups.filter(g => g.length > 0).map((g, i) => <div key={i} className="sheet-group" role="menu">
          {g.map(row => <button key={row.id} type="button" role="menuitem" className={`sheet-row${row.danger ? ' danger' : ''}`} disabled={row.disabled} aria-haspopup={row.children ? true : undefined}
            onClick={() => { if (row.children) { setOpen(row.id); return; } onClose(); row.onSelect?.(); }}>
            <span className="sheet-row-icon" aria-hidden="true">{row.icon}</span>
            <span className="sheet-row-label">{row.label}</span>
            {row.children && <span className="sheet-row-trailing"><ChevronRight size={18} aria-hidden="true" /></span>}
          </button>)}
        </div>)}
      </>}
    </BottomSheet>;
  }

  return createPortal(<div className="chat-menu-layer context-menu-layer" onContextMenu={e => { e.preventDefault(); e.stopPropagation(); }}>
    <div ref={box} className="chat-menu context-menu" role="menu" aria-label="Message actions" style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}>
      {!pending && !system && <div className="chat-menu-tiles" role="group" aria-label="Quick reactions">
        {quick.map(e => <button key={e} type="button" role="menuitem" className="chat-menu-tile" aria-label={`React with ${e}`} onClick={() => { onClose(); react(e); }}>{e}</button>)}
      </div>}
      {entries.map((entry, i) => {
        if (entry === 'separator') return <div key={`sep-${i}`} className="chat-menu-sep" role="separator" />;
        const index = rows.indexOf(entry);
        const hasSub = !!entry.children;
        return <div key={entry.id} className="chat-menu-row-wrap" onMouseEnter={() => { setActive(index); setOpen(hasSub ? entry.id : null); setSubByKey(false); }}>
          <div role="menuitem" tabIndex={hasSub ? -1 : undefined} aria-disabled={entry.disabled || undefined} aria-haspopup={hasSub || undefined} aria-expanded={hasSub ? open === entry.id : undefined}
            className={`chat-menu-item context-menu-item${entry.danger ? ' danger' : ''}${entry.disabled ? ' disabled' : ''}${active === index || open === entry.id ? ' focused' : ''}`}
            onClick={() => { if (hasSub) { setOpen(entry.id); return; } if (entry.disabled) return; onClose(); entry.onSelect?.(); }}>
            <span className="chat-menu-icon" aria-hidden="true">{entry.icon}</span>
            <span className="chat-menu-label">{entry.label}</span>
            {hasSub && <ChevronRight size={16} className="chat-menu-chevron" />}
          </div>
          {hasSub && open === entry.id && <SubMenu label={entry.label} focusFirst={subByKey}>{typeof entry.children === 'function' ? entry.children(onClose) : entry.children}</SubMenu>}
        </div>;
      })}
    </div>
  </div>, document.body);
}

/**
 * "Add Reaction" submenu: the frequent emoji as a scrolling list of rows (glyph and :shortcode:, like Discord), then "View More" for the
 * full picker. Subscribes to the emoji database so the shortcodes fill in once it has loaded.
 */
function ReactionMenu({ onPick, onMore }: { onPick(ch: string): void; onMore(): void }) {
  useEmojiDb();
  const list = useMemo(() => frequentEmoji(20), []);
  return <div className="chat-menu-list chat-menu-reactions">
    <div className="chat-menu-reaction-scroll">
      {list.map(ch => {
        const code = emojiShortcodeLabel(ch);
        return <button key={ch} type="button" role="menuitem" className="chat-menu-reaction" aria-label={code} onClick={() => onPick(ch)}>
          <span className="chat-menu-reaction-emoji" aria-hidden="true">{ch}</span>
          {code !== ch && <span className="chat-menu-reaction-code">{code}</span>}
        </button>;
      })}
    </div>
    <div className="chat-menu-sep" role="separator" />
    <button type="button" role="menuitem" onClick={onMore}>View More</button>
  </div>;
}

const subItems = (root: HTMLElement): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')];

/**
 * Opens to the right of its row, flips left when the viewport edge is in the way. Opened from the keyboard it focuses its first row; while
 * focus is inside, Up/Down/Home/End move through its rows (DOM focus, so a scrolling list follows) and Enter/Space activate the focused
 * control natively instead of reaching the parent menu's handler. Left closes it (the parent's handler) and puts focus back on its row.
 */
function SubMenu({ label, children, focusFirst }: { label: string; children: ReactNode; focusFirst: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [flip, setFlip] = useState(false);
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (r && r.right + 8 > window.innerWidth) setFlip(true);
  }, []);
  useEffect(() => {
    if (focusFirst && ref.current) subItems(ref.current)[0]?.focus();
  }, [focusFirst]);
  return <div ref={ref} className={`chat-menu chat-submenu${flip ? ' flip' : ''}`} role="menu" aria-label={label}
    onKeyDown={e => {
      const root = ref.current;
      if (!root) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
        if ((e.target as HTMLElement).matches('input, textarea, select')) { e.stopPropagation(); return; }
        if (rovingKey(e, subItems(root))) e.stopPropagation();
      } else if (e.key === 'ArrowLeft') {
        if ((e.target as HTMLElement).matches('input, textarea, select')) { e.stopPropagation(); return; }
        // the parent's handler unmounts this submenu; focus its row first so focus does not fall to <body>
        root.parentElement?.querySelector<HTMLElement>(':scope > [role="menuitem"]')?.focus();
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.stopPropagation();
      }
    }}>{children}</div>;
}
