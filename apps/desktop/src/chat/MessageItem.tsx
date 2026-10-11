import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CornerUpLeft, Pencil, Pin, SmilePlus, MoreHorizontal, Reply, UserPlus, UserMinus, PenLine, Image as ImageIcon, CircleAlert, ArrowRightFromLine } from 'lucide-react';
import { MessageType } from '../api/types';
import type { Message } from '../api/types';
import { Markdown } from './markdown';
import { Tooltip, useContextMenu, type MenuItem } from './shell';
import { useChat } from './ChatContext';
import { Avatar } from './Avatar';
import { Attachments } from './Attachments';
import { Reactions } from './Reactions';
import { EmojiPickerPopout } from './EmojiPicker';
import { quickReactions } from './emojiData';
import { messageStore } from './messageStore';
import { isSystemMessage, type PendingMessage } from './messageState';
import { fromDisplay, toDisplay, type MentionToken } from './mentionText';
import { formatFullDate, formatMessageTimestamp, formatTime, isShiftDown } from './util';

export interface MessageItemProps {
  message: Message;
  pending: PendingMessage | null;
  grouped: boolean;
  editing: boolean;
  highlighted: boolean;
  onStopEditing(): void;
}

function SystemBody({ message, name }: { message: Message; name: string }) {
  const chat = useChat();
  const first = message.mentions[0];
  const other = first ? chat.nameOf(first) : 'someone';
  switch (message.type) {
    case MessageType.ChannelPinnedMessage:
      return <><Pin size={18} className="chat-system-icon pin" /><span className="chat-system-text"><b>{name}</b> pinned <button type="button" className="chat-system-link" onClick={() => message.message_reference && chat.actions.jumpTo(message.message_reference.message_id)}>a message</button> to this channel. See all <span className="chat-system-link-static">pinned messages</span>.</span></>;
    case MessageType.UserJoin:
      return <><ArrowRightFromLine size={18} className="chat-system-icon join" /><span className="chat-system-text"><b>{name}</b> joined the party.</span></>;
    case MessageType.RecipientAdd:
      return <><UserPlus size={18} className="chat-system-icon join" /><span className="chat-system-text"><b>{name}</b> added <b>{other}</b> to the group.</span></>;
    case MessageType.RecipientRemove:
      return <><UserMinus size={18} className="chat-system-icon leave" /><span className="chat-system-text"><b>{name}</b> removed <b>{other}</b> from the group.</span></>;
    case MessageType.ChannelNameChange:
      return <><PenLine size={18} className="chat-system-icon" /><span className="chat-system-text"><b>{name}</b> changed the channel name: <b>{message.content}</b></span></>;
    default:
      return <span className="chat-system-text">{message.content}</span>;
  }
}

function ReplyPreview({ message }: { message: Message }) {
  const chat = useChat();
  const ref = message.referenced_message;
  const hasRef = !!message.message_reference;
  if (!hasRef) return null;
  if (!ref) {
    return <div className="chat-reply deleted"><span className="chat-reply-spine" /><span className="chat-reply-text"><CircleAlert size={14} /> Original message was deleted</span></div>;
  }
  const text = toDisplay(ref.content, { user: id => chat.md.userName(id), role: id => chat.md.roleInfo(id)?.name ?? null, channel: id => chat.md.channelName(id) }).text.replace(/\s+/g, ' ').trim();
  const color = chat.colorOf(ref);
  const mentioned = message.mentions.some(u => u.id === ref.author.id);
  return <div className="chat-reply">
    <span className="chat-reply-spine" />
    <Avatar user={ref.author} size={16} className="chat-reply-avatar" />
    <span className="chat-reply-name" style={color ? { color } : undefined}>{mentioned ? '@' : ''}{chat.nameOf(ref.author)}</span>
    <button type="button" className="chat-reply-text" onClick={() => chat.actions.jumpTo(ref.id)} aria-label="Jump to replied message">
      {text || (ref.attachments.length ? <><ImageIcon size={14} /> Click to see attachment</> : '')}
      {!text && ref.attachments.length === 0 && <i>Click to see attachment</i>}
    </button>
  </div>;
}

function InlineEdit({ message, onDone }: { message: Message; onDone(): void }) {
  const chat = useChat();
  const init = useMemo(() => toDisplay(message.content, { user: id => chat.md.userName(id), role: id => chat.md.roleInfo(id)?.name ?? null, channel: id => chat.md.channelName(id) }), [message.content, chat.md]);
  const [text, setText] = useState(init.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const tokens = useRef<MentionToken[]>(init.tokens);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [text]);
  useEffect(() => {
    const el = area.current;
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  }, []);

  async function save() {
    if (busy) return;
    const raw = fromDisplay(text, tokens.current).trim();
    if (raw === '') { chat.actions.requestDelete(message, false); return; }
    if (raw === message.content) { onDone(); return; }
    if (raw.length > 2000) { setError('Message is too long.'); return; }
    setBusy(true);
    try { await messageStore.edit(message.channel_id, message.id, raw); onDone(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not edit message.'); setBusy(false); }
  }

  return <div className="chat-edit">
    <div className="chat-edit-box">
      <textarea ref={area} value={text} aria-label="Edit message" rows={1} disabled={busy} spellCheck onChange={e => { setText(e.target.value); setError(null); }}
        onKeyDown={e => {
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onDone(); }
          else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void save(); }
        }} />
    </div>
    <div className="chat-edit-hint">
      {error ? <span className="chat-edit-error">{error}</span> : <>escape to <button type="button" onClick={onDone}>cancel</button> • enter to <button type="button" onClick={() => void save()}>save</button></>}
    </div>
  </div>;
}

function MessageItemImpl({ message, pending, grouped, editing, highlighted, onStopEditing }: MessageItemProps) {
  const chat = useChat();
  const menu = useContextMenu();
  const [pickerOpen, setPickerOpen] = useState(false);
  const addBtn = useRef<HTMLButtonElement>(null);
  const date = useMemo(() => new Date(message.timestamp), [message.timestamp]);
  const isMine = message.author.id === chat.me.id;
  const system = isSystemMessage(message);
  const name = chat.nameOf(message.author, message.member);
  const color = chat.colorOf(message);
  const mentionsMe = !isMine && (message.mentions.some(u => u.id === chat.me.id) || message.mention_everyone);
  const failed = pending?.state === 'failed';

  const canEdit = isMine && !system && !pending;
  const canDelete = !pending && (isMine || chat.canManage) && message.type !== MessageType.RecipientAdd;
  const canPin = !pending && !system && (chat.isDm || chat.canManage);

  function items(): MenuItem[] {
    const out: MenuItem[] = [];
    if (!system) {
      out.push({ id: 'reply', label: 'Reply', icon: <CornerUpLeft size={16} />, onSelect: () => chat.actions.reply(message) });
    }
    if (canEdit) out.push({ id: 'edit', label: 'Edit Message', icon: <Pencil size={16} />, onSelect: () => chat.actions.edit(message) });
    if (canPin) out.push({ id: 'pin', label: message.pinned ? 'Unpin Message' : 'Pin Message', icon: <Pin size={16} />, onSelect: () => chat.actions.togglePin(message) });
    out.push({ type: 'separator' });
    if (message.content) out.push({ id: 'copy-text', label: 'Copy Text', onSelect: () => void navigator.clipboard?.writeText(message.content) });
    out.push({
      id: 'copy-link', label: 'Copy Message Link',
      onSelect: () => void navigator.clipboard?.writeText(`${window.location.origin}/channels/${chat.guildId ?? '@me'}/${message.channel_id}/${message.id}`),
    });
    out.push({ id: 'copy-id', label: 'Copy Message ID', onSelect: () => void navigator.clipboard?.writeText(message.id) });
    if (canDelete) {
      out.push({ type: 'separator' });
      out.push({ id: 'delete', label: 'Delete Message', danger: true, icon: <Trash />, onSelect: () => chat.actions.requestDelete(message, isShiftDown()) });
    }
    return out;
  }

  const quick = useMemo(() => quickReactions().slice(0, 2), []);
  const [shift, setShift] = useState(false);

  const showToolbar = !pending && !editing;
  const cls = ['chat-msg'];
  if (grouped) cls.push('grouped');
  if (mentionsMe) cls.push('mentioned');
  if (pending) cls.push('pending');
  if (failed) cls.push('failed');
  if (editing) cls.push('editing');
  if (highlighted) cls.push('flash');
  if (message.message_reference && !system) cls.push('has-reply');
  if (system) cls.push('system');

  if (system) {
    return <div className={cls.join(' ')} id={`message-${message.id}`} data-message-id={message.id} onContextMenu={e => items().length && menu.open(e, items())}>
      <div className="chat-msg-gutter"><span /></div>
      <div className="chat-msg-body system">
        <SystemBody message={message} name={name} />
        <Tooltip content={formatFullDate(date)}><time className="chat-timestamp inline" dateTime={message.timestamp}>{formatMessageTimestamp(date)}</time></Tooltip>
      </div>
    </div>;
  }

  return <div className={cls.join(' ')} id={`message-${message.id}`} data-message-id={message.id}
    onMouseMove={e => { if (e.shiftKey !== shift) setShift(e.shiftKey); }} onMouseLeave={() => shift && setShift(false)}
    onContextMenu={e => { if (!pending && !(e.target instanceof HTMLAnchorElement)) menu.open(e, items()); }}>
    {!grouped && <ReplyPreview message={message} />}
    <div className="chat-msg-gutter">
      {grouped
        ? <Tooltip content={formatFullDate(date)}><time className="chat-timestamp compact" dateTime={message.timestamp}>{formatTime(date)}</time></Tooltip>
        : <Avatar user={message.author} size={40} />}
    </div>
    <div className="chat-msg-body">
      {!grouped && <h3 className="chat-msg-header">
        <span className="chat-author" style={color ? { color } : undefined}>{name}</span>
        {message.author.bot && <span className="chat-bot-tag">BOT</span>}
        <Tooltip content={formatFullDate(date)}><time className="chat-timestamp" dateTime={message.timestamp}>{formatMessageTimestamp(date)}</time></Tooltip>
      </h3>}
      {editing ? <InlineEdit message={message} onDone={onStopEditing} /> : <>
        {message.content && <Markdown content={message.content} ctx={chat.md} className="chat-content" suffix={message.edited_timestamp
          ? <Tooltip content={formatFullDate(new Date(message.edited_timestamp))}><span className="chat-edited">(edited)</span></Tooltip> : undefined} />}
        <Attachments message={message} />
        <Reactions message={message} />
      </>}
      {failed && <div className="chat-failed" role="alert">
        <CircleAlert size={14} /> Your message could not be delivered.
        <button type="button" onClick={() => messageStore.retry(message.channel_id, pending.nonce)}>Retry</button>
        <button type="button" onClick={() => messageStore.discardPending(message.channel_id, pending.nonce)}>Delete</button>
      </div>}
    </div>
    {showToolbar && <div className={`chat-toolbar${pickerOpen ? ' open' : ''}`} role="toolbar" aria-label="Message actions">
      {quick.map(e => <Tooltip key={e} content="React" side="top"><button type="button" className="chat-toolbar-btn emoji" aria-label={`React with ${e}`} onClick={() => chat.actions.react(message, { id: null, name: e })}>{e}</button></Tooltip>)}
      <Tooltip content="Add Reaction" side="top"><button ref={addBtn} type="button" className="chat-toolbar-btn" aria-label="Add Reaction" onClick={() => setPickerOpen(true)}><SmilePlus size={20} /></button></Tooltip>
      {canEdit && <Tooltip content="Edit" side="top"><button type="button" className="chat-toolbar-btn" aria-label="Edit" onClick={() => chat.actions.edit(message)}><Pencil size={20} /></button></Tooltip>}
      <Tooltip content="Reply" side="top"><button type="button" className="chat-toolbar-btn" aria-label="Reply" onClick={() => chat.actions.reply(message)}><Reply size={20} /></button></Tooltip>
      {canDelete && shift && <Tooltip content="Delete" side="top"><button type="button" className="chat-toolbar-btn danger" aria-label="Delete" onClick={e => chat.actions.requestDelete(message, e.shiftKey)}><Trash /></button></Tooltip>}
      <Tooltip content="More" side="top"><button type="button" className="chat-toolbar-btn" aria-label="More" onClick={e => {
        const r = e.currentTarget.getBoundingClientRect();
        menu.open({ clientX: r.left, clientY: r.bottom + 4, preventDefault() { e.preventDefault(); } }, items());
      }}><MoreHorizontal size={20} /></button></Tooltip>
      <EmojiPickerPopout anchor={addBtn} open={pickerOpen} onClose={() => setPickerOpen(false)} onPick={e => { setPickerOpen(false); chat.actions.react(message, e); }} />
    </div>}
  </div>;
}

function Trash() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14" /></svg>;
}

export const MessageItem = memo(MessageItemImpl);
