import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Forward, Pencil, Pin, SmilePlus, MoreHorizontal, Reply, UserPlus, UserMinus, PenLine, Image as ImageIcon, CircleAlert, ArrowRightFromLine, MessageSquareText, Megaphone } from 'lucide-react';
import { MessageFlags, MessageReferenceType, MessageType } from '../api/types';
import type { Message } from '../api/types';
import { Markdown } from './markdown';
import { Tooltip } from './shell';
import { useChat } from './ChatContext';
import { Avatar } from './Avatar';
import { ServerTag } from './ServerTag';
import { Attachments, PendingUpload } from './Attachments';
import { Embeds } from './Embeds';
import { Reactions } from './Reactions';
import { EmojiPickerPopout } from './EmojiPicker';
import { MessageMenu } from './MessageMenu';
import { ForwardedBlock, GifMessage, StickerItems, gifMessageMedia } from '../media/MessageParts';
import { openForward } from '../media/store';
import { ThreadChip } from '../threads/ThreadChip';
import { ThreadCreatedNotice } from '../threads/ThreadNotice';
import { ThreadStarter } from '../threads/ThreadStarter';
import { useMessageThreadActions } from '../threads/useMessageActions';
import { quickReactions } from './emojiData';
import { messageStore } from './messageStore';
import { isSystemMessage, type PendingMessage } from './messageState';
import { fromDisplay, toDisplay, type MentionToken } from './mentionText';
import { formatFullDate, formatMessageTimestamp, formatTime } from './util';

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
    case MessageType.ThreadCreated:
      return <ThreadCreatedNotice message={message} name={name} />;
    default:
      return <span className="chat-system-text">{message.content}</span>;
  }
}

/**
 * The line above a reply: curved connector from the avatar column, 16 px avatar, "@name" in the author's role colour, one-line preview.
 * `referenced_message` null = the original was deleted (contract), undefined = it was not part of the payload (could not be loaded).
 */
function ReplyPreview({ message }: { message: Message }) {
  const chat = useChat();
  const ref = message.referenced_message;
  if (!message.message_reference || message.message_reference.type === MessageReferenceType.Forward || ((message.flags ?? 0) & MessageFlags.IsCrosspost) !== 0) return null; // a forward has its own block; a published copy points at its source, it is not a reply
  if (!ref) {
    const text = ref === null ? 'Original message was deleted' : 'Message could not be loaded';
    return <div className="chat-reply missing"><span className="chat-reply-spine" /><span className="chat-reply-text"><Reply size={14} className="chat-reply-missing-icon" aria-hidden="true" />{text}</span></div>;
  }
  const text = toDisplay(ref.content, { user: id => chat.md.userName(id), role: id => chat.md.roleInfo(id)?.name ?? null, channel: id => chat.md.channelName(id) }).text.replace(/\s+/g, ' ').trim();
  const color = chat.colorOf(ref);
  const author = chat.userById(ref.author.id) ?? ref.author;
  return <div className="chat-reply" role="button" tabIndex={0} aria-label={`Jump to the message by ${chat.nameOf(ref.author, ref.member)}`} onClick={() => chat.actions.jumpTo(ref.id)}
    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chat.actions.jumpTo(ref.id); } }}>
    <span className="chat-reply-spine" />
    <Avatar user={ref.author} size={16} className="chat-reply-avatar" guildId={chat.guildId} />
    <span className="chat-reply-name" style={color ? { color } : undefined}>@{chat.nameOf(ref.author, ref.member)}</span>
    <ServerTag user={author} className="small" />
    <span className="chat-reply-text">
      {text || (ref.attachments.length ? <><i>Click to see attachment</i><ImageIcon size={20} aria-hidden="true" /></> : <i>Click to see attachment</i>)}
    </span>
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
  const threadActions = useMessageThreadActions(message, !!pending);
  const crosspost = ((message.flags ?? 0) & MessageFlags.IsCrosspost) !== 0;
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuPickerOpen, setMenuPickerOpen] = useState(false);
  const addBtn = useRef<HTMLButtonElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const date = useMemo(() => new Date(message.timestamp), [message.timestamp]);
  const isMine = message.author.id === chat.me.id;
  const system = isSystemMessage(message);
  const name = chat.nameOf(message.author, message.member);
  const color = chat.colorOf(message);
  const dot = chat.roleDotOf(message);
  const compact = chat.compact;
  const mentionsMe = !isMine && (message.mentions.some(u => u.id === chat.me.id) || message.mention_everyone);
  const failed = pending?.state === 'failed';
  const gif = system ? null : gifMessageMedia(message);

  const canEdit = isMine && !system && !pending && message.message_reference?.type !== 1; // a forward has no text to edit
  const canDelete = !pending && (isMine || chat.canManage) && message.type !== MessageType.RecipientAdd;

  const quick = useMemo(() => quickReactions().slice(0, 3), []);
  const [shift, setShift] = useState(false);

  const showToolbar = !pending && !editing;
  const cls = ['chat-msg'];
  if (grouped) cls.push('grouped');
  if (compact && !system) cls.push('compact');
  if (mentionsMe) cls.push('mentioned');
  if (pending) cls.push('pending');
  if (failed) cls.push('failed');
  if (editing) cls.push('editing');
  if (highlighted) cls.push('flash');
  if (message.message_reference && message.message_reference.type !== MessageReferenceType.Forward && !system && !crosspost) cls.push('has-reply');
  if (system) cls.push('system');
  if (chat.replyingId === message.id) cls.push('replying');

  if (system) {
    return <div className={cls.join(' ')} id={`message-${message.id}`} data-message-id={message.id} onContextMenu={e => { e.preventDefault(); setMenuAt({ x: e.clientX, y: e.clientY }); }}>
      <div className="chat-msg-gutter"><span /></div>
      <div className="chat-msg-body system">
        <SystemBody message={message} name={name} />
        <Tooltip content={formatFullDate(date)}><time className="chat-timestamp inline" dateTime={message.timestamp}>{formatMessageTimestamp(date)}</time></Tooltip>
      </div>
      {menuAt && <MessageMenu target={{ message, pending, ...menuAt }} onClose={() => setMenuAt(null)} onMoreEmoji={() => setMenuPickerOpen(true)} />}
    </div>;
  }

  return <div ref={rowRef} className={cls.join(' ')} id={`message-${message.id}`} data-message-id={message.id}
    onMouseMove={e => { if (e.shiftKey !== shift) setShift(e.shiftKey); }} onMouseLeave={() => shift && setShift(false)}
    onContextMenu={e => { if (pending || e.target instanceof HTMLAnchorElement) return; e.preventDefault(); setMenuAt({ x: e.clientX, y: e.clientY }); }}>
    {!grouped && <ReplyPreview message={message} />}
    <div className="chat-msg-gutter">
      {grouped || compact
        ? <Tooltip content={formatFullDate(date)}><time className="chat-timestamp compact" dateTime={message.timestamp}>{formatTime(date)}</time></Tooltip>
        : <Avatar user={message.author} size={40} guildId={chat.guildId} />}
    </div>
    <div className="chat-msg-body">
      {(!grouped || compact) && <h3 className="chat-msg-header">
        {dot && <span className="chat-role-dot" style={{ background: dot }} aria-hidden="true" />}
        {compact && chat.display.showCompactAvatars && <Avatar user={message.author} size={16} className="chat-compact-avatar" guildId={chat.guildId} />}
        <span className="chat-author" style={color ? { color } : undefined}>{name}</span>
        <ServerTag user={chat.userById(message.author.id) ?? message.author} />
        {message.author.bot && <span className="chat-bot-tag">BOT</span>}
        {!compact && <Tooltip content={formatFullDate(date)}><time className="chat-timestamp" dateTime={message.timestamp}>{formatMessageTimestamp(date)}</time></Tooltip>}
      </h3>}
      {crosspost && <div className="chat-crosspost-tag"><Megaphone size={14} aria-hidden="true" /> Published from an announcement channel</div>}
      {editing ? <InlineEdit message={message} onDone={onStopEditing} /> : <>
        {message.content && !gif && <Markdown content={message.content} ctx={chat.md} className="chat-content" suffix={message.edited_timestamp
          ? <Tooltip content={formatFullDate(new Date(message.edited_timestamp))}><span className="chat-edited">(edited)</span></Tooltip> : undefined} />}
        {pending && !failed && message.attachments.length > 0
          ? <PendingUpload files={message.attachments} onCancel={() => messageStore.discardPending(message.channel_id, pending.nonce)} />
          : <Attachments message={message} />}
        {gif && <GifMessage message={message} media={gif} />}
        <StickerItems items={message.sticker_items} />
        {message.message_snapshots?.length ? <ForwardedBlock message={message} /> : null}
        {!gif && <Embeds message={message} />}
        <Reactions message={message} />
        {message.thread && <ThreadChip message={message} />}
        {threadActions.published && <div className="chat-crosspost-tag published"><Megaphone size={14} aria-hidden="true" /> Published</div>}
      </>}
      {failed && <div className="chat-failed" role="alert">
        <CircleAlert size={14} /> Your message could not be delivered.
        <button type="button" onClick={() => messageStore.retry(message.channel_id, pending.nonce)}>Retry</button>
        <button type="button" onClick={() => messageStore.discardPending(message.channel_id, pending.nonce)}>Delete</button>
      </div>}
    </div>
    {menuAt && <MessageMenu target={{ message, pending, ...menuAt }} onClose={() => setMenuAt(null)} onMoreEmoji={() => setMenuPickerOpen(true)} />}
    <EmojiPickerPopout anchor={rowRef} open={menuPickerOpen} onClose={() => setMenuPickerOpen(false)} onPick={e => { setMenuPickerOpen(false); chat.actions.react(message, e); }} />
    {showToolbar && <div className={`chat-toolbar${pickerOpen ? ' open' : ''}`} role="toolbar" aria-label="Message actions">
      {quick.map(e => <Tooltip key={e} content="React" side="top"><button type="button" className="chat-toolbar-btn emoji" aria-label={`React with ${e}`} onClick={() => chat.actions.react(message, { id: null, name: e })}>{e}</button></Tooltip>)}
      <span className="chat-toolbar-sep" role="separator" />
      <Tooltip content="Add Reaction" side="top"><button ref={addBtn} type="button" className="chat-toolbar-btn" aria-label="Add Reaction" onClick={() => setPickerOpen(true)}><SmilePlus size={20} /></button></Tooltip>
      {canEdit && <Tooltip content="Edit" side="top"><button type="button" className="chat-toolbar-btn" aria-label="Edit" onClick={() => chat.actions.edit(message)}><Pencil size={20} /></button></Tooltip>}
      {!isMine && <Tooltip content="Reply" side="top"><button type="button" className="chat-toolbar-btn" aria-label="Reply" onClick={() => chat.actions.reply(message)}><Reply size={20} /></button></Tooltip>}
      {canDelete && shift && <Tooltip content="Delete" side="top"><button type="button" className="chat-toolbar-btn danger" aria-label="Delete" onClick={e => chat.actions.requestDelete(message, e.shiftKey)}><Trash /></button></Tooltip>}
      {threadActions.canCreateThread && <Tooltip content="Create Thread" side="top"><button type="button" className="chat-toolbar-btn" aria-label="Create Thread" onClick={threadActions.createThread}><MessageSquareText size={20} /></button></Tooltip>}
      {threadActions.canPublish && !threadActions.published && <Tooltip content="Publish" side="top"><button type="button" className="chat-toolbar-btn" aria-label="Publish" onClick={threadActions.publish}><Megaphone size={20} /></button></Tooltip>}
      <Tooltip content="Forward" side="top"><button type="button" className="chat-toolbar-btn" aria-label="Forward" onClick={() => openForward(message)}><Forward size={20} /></button></Tooltip>
      <Tooltip content="More" side="top"><button type="button" className="chat-toolbar-btn" aria-label="More" onClick={e => {
        const r = e.currentTarget.getBoundingClientRect();
        setMenuAt({ x: r.left, y: r.bottom + 4 });
      }}><MoreHorizontal size={20} /></button></Tooltip>
      <EmojiPickerPopout anchor={addBtn} open={pickerOpen} onClose={() => setPickerOpen(false)} onPick={e => { setPickerOpen(false); chat.actions.react(message, e); }} />
    </div>}
  </div>;
}

function Trash() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14" /></svg>;
}

/** A thread's first message (type 21) is the message the thread started from, drawn as that message; everything else is a regular row. */
function MessageItemRow(props: MessageItemProps) {
  if (props.message.type === MessageType.ThreadStarterMessage) return <ThreadStarter message={props.message} />;
  return <MessageItemImpl {...props} />;
}

export const MessageItem = memo(MessageItemRow);
