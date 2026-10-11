import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import type { Message, Snowflake } from '../api/types';
import { ApiRequestError, Modal, markGuildRead, useMe, useReadState } from './shell';
import { ChatProvider, useChat, type ChatActions } from './ChatContext';
import { Composer } from './Composer';
import { MessageList, type MessageListHandle } from './MessageList';
import { TypingIndicator } from './TypingIndicator';
import { Lightbox } from './Attachments';
import { ReactionsModal } from './ReactionsModal';
import { Markdown } from './markdown';
import { Avatar } from './Avatar';
import { MAX_ATTACHMENTS, MAX_UPLOAD_BYTES, addFiles, onUploadNotice } from './draftStore';
import { messageStore, useChannelState } from './messageStore';
import { compareIds, formatMessageTimestamp } from './util';
import './chat.css';

const ACK_DEBOUNCE_MS = 3000;

interface DeleteRequest { message: Message }
interface ImageView { message: Message; index: number }

export function ChatView({ channelId }: { channelId: Snowflake }) {
  const me = useMe();
  const readState = useReadState(channelId);
  const lastRead = readState?.last_message_id ?? null;

  // Reply / edit / modal state is per channel: remount on channel change.
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [mentionReply, setMentionReply] = useState(true);
  const [editingId, setEditingId] = useState<Snowflake | null>(null);
  const [deleting, setDeleting] = useState<DeleteRequest | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [image, setImage] = useState<ImageView | null>(null);
  const [reactionsOf, setReactionsOf] = useState<Message | null>(null);
  const [focusToken, setFocusToken] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const list = useRef<MessageListHandle>(null);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => { messageStore.setCurrentUser(me?.id ?? null); }, [me?.id]);

  const [notice, setNotice] = useState<{ title: string; body: string } | null>(null);
  useEffect(() => onUploadNotice(n => setNotice(n.kind === 'too-large'
    ? { title: 'Your files are too powerful', body: `Max file size is ${MAX_UPLOAD_BYTES / (1024 * 1024)} MiB. Please upload something smaller.` }
    : { title: 'Too many uploads', body: `You can only upload ${MAX_ATTACHMENTS} files at a time.` })), []);

  // Open the channel once per mount; the read pointer is captured at that moment for the "new" divider.
  const lastReadRef = useRef(lastRead);
  lastReadRef.current = lastRead;
  useEffect(() => {
    setReplyTo(null); setEditingId(null); setDeleting(null); setImage(null); setReactionsOf(null);
    messageStore.open(channelId, lastReadRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  const requestDelete = useCallback((m: Message, skipConfirm: boolean) => {
    if (skipConfirm) { void messageStore.remove(m.channel_id, m.id); return; }
    setDeleting({ message: m });
  }, []);

  const actions = useMemo<ChatActions>(() => ({
    reply: m => { setReplyTo(m); setMentionReply(true); setEditingId(null); setFocusToken(n => n + 1); },
    edit: m => setEditingId(m.id),
    requestDelete,
    togglePin: m => {
      messageStore.setPinned(m.channel_id, m.id, !m.pinned).catch((e: unknown) => {
        if (e instanceof ApiRequestError && e.code === 30003) {
          setNotice({ title: 'Pin limit reached', body: 'This channel already has 250 pinned messages. Unpin one to make room for another.' });
        }
      });
    },
    react: (m, emoji) => { void messageStore.toggleReaction(m.channel_id, m.id, emoji); },
    jumpTo: id => { void messageStore.jumpToMessage(channelId, id); },
    openLink: href => setLink(href),
    openImage: (message, index) => setImage({ message, index }),
    viewReactions: m => setReactionsOf(m),
  }), [channelId, requestDelete]);

  const stopEditing = useCallback(() => { setEditingId(null); setFocusToken(n => n + 1); }, []);

  if (!me) return null;

  return <ChatProvider channelId={channelId} actions={actions} replyingId={replyTo?.id ?? null}>
    <ChatBody
      channelId={channelId}
      replyTo={replyTo} mentionReply={mentionReply} setMentionReply={setMentionReply} setReplyTo={setReplyTo}
      editingId={editingId} setEditingId={setEditingId} stopEditing={stopEditing}
      focusToken={focusToken} list={list} atBottom={atBottom} setAtBottom={setAtBottom}
      dragging={dragging} setDragging={setDragging} dragDepth={dragDepth}
    />
    <DeleteModal request={deleting} onClose={() => { setDeleting(null); setFocusToken(n => n + 1); }} />
    <LinkModal href={link} onClose={() => setLink(null)} />
    <Modal open={!!notice} onClose={() => setNotice(null)} title={notice?.title ?? ''}
      footer={<button type="button" className="chat-btn primary" onClick={() => setNotice(null)}>Okay</button>}>
      <p className="chat-modal-text">{notice?.body}</p>
    </Modal>
    <ReactionsModal message={reactionsOf} onClose={() => setReactionsOf(null)} />
    {image && <Lightbox message={image.message} index={image.index} onClose={() => setImage(null)} />}
  </ChatProvider>;
}

interface BodyProps {
  channelId: Snowflake;
  replyTo: Message | null;
  setReplyTo(m: Message | null): void;
  mentionReply: boolean;
  setMentionReply(fn: (v: boolean) => boolean): void;
  editingId: Snowflake | null;
  setEditingId(id: Snowflake | null): void;
  stopEditing(): void;
  focusToken: number;
  list: React.RefObject<MessageListHandle | null>;
  atBottom: boolean;
  setAtBottom(v: boolean): void;
  dragging: boolean;
  setDragging(v: boolean): void;
  dragDepth: React.MutableRefObject<number>;
}

function ChatBody(p: BodyProps) {
  const chat = useChat();
  const state = useChannelState(p.channelId);
  const readState = useReadState(p.channelId);

  // Ack on view: newest server message, only while the window is at the present, scrolled to the bottom, and focused.
  const newest = state.messages[state.messages.length - 1]?.id;
  const read = readState?.last_message_id ?? null;
  const mentionCount = readState?.mention_count ?? 0;
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const on = () => setFocused(true), off = () => setFocused(false);
    window.addEventListener('focus', on); window.addEventListener('blur', off);
    return () => { window.removeEventListener('focus', on); window.removeEventListener('blur', off); };
  }, []);
  useEffect(() => {
    if (!newest || state.hasMoreAfter || !p.atBottom || !focused) return;
    if (read && compareIds(newest, read) <= 0) return;
    // Discord debounces the ack by 3 s, immediately when the channel has mentions.
    const t = setTimeout(() => messageStore.ack(p.channelId, newest), mentionCount > 0 ? 0 : ACK_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [newest, read, state.hasMoreAfter, p.atBottom, focused, p.channelId, mentionCount]);

  // Escape (outside editing/dialogs): mark the channel read and jump to the present. Shift+Escape: mark the whole server read.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="menu"], .chat-edit, .chat-autocomplete')) return;
      if (e.shiftKey) {
        if (chat.guildId) void markGuildRead(chat.guildId).catch(() => undefined);
        return;
      }
      const last = state.messages[state.messages.length - 1];
      if (state.hasMoreAfter) void messageStore.jumpToPresent(p.channelId);
      else p.list.current?.scrollToBottom();
      if (last) messageStore.ack(p.channelId, last.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [p.channelId, p.list, state.messages, state.hasMoreAfter, chat.guildId]);

  const editLast = useCallback(() => {
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const m = state.messages[i]!;
      if (m.author.id === chat.me.id && m.type === 0) { p.setEditingId(m.id); return; }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.messages, chat.me.id]);

  function hasFiles(e: React.DragEvent): boolean { return [...e.dataTransfer.types].includes('Files'); }

  return <div className="chat-view"
    onDragEnter={e => { if (!hasFiles(e)) return; e.preventDefault(); p.dragDepth.current += 1; p.setDragging(true); }}
    onDragOver={e => { if (hasFiles(e)) e.preventDefault(); }}
    onDragLeave={e => { if (!hasFiles(e)) return; p.dragDepth.current = Math.max(0, p.dragDepth.current - 1); if (p.dragDepth.current === 0) p.setDragging(false); }}
    onDrop={e => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      p.dragDepth.current = 0; p.setDragging(false);
      addFiles(p.channelId, [...e.dataTransfer.files]);
    }}>
    <MessageList ref={p.list} channelId={p.channelId} editingId={p.editingId} onStopEditing={p.stopEditing} onAtBottomChange={p.setAtBottom} />
    <Composer
      channelId={p.channelId}
      replyTo={p.replyTo}
      mentionReply={p.mentionReply}
      onToggleMention={() => p.setMentionReply(v => !v)}
      onCancelReply={() => p.setReplyTo(null)}
      onSent={() => {
        if (state.hasMoreAfter) void messageStore.jumpToPresent(p.channelId);
        requestAnimationFrame(() => p.list.current?.scrollToBottom());
      }}
      onEditLast={editLast}
      focusToken={p.focusToken}
    />
    <TypingIndicator channelId={p.channelId} />
    {p.dragging && <div className="chat-drop-overlay" aria-hidden="true">
      <div className="chat-drop-card">
        <Upload size={48} />
        <h2>Upload to {chat.channel?.name ? `#${chat.channel.name}` : 'this conversation'}</h2>
        <p>You can add comments before uploading.</p>
      </div>
    </div>}
  </div>;
}

function DeleteModal({ request, onClose }: { request: DeleteRequest | null; onClose(): void }) {
  const chat = useChat();
  const m = request?.message;
  const [busy, setBusy] = useState(false);
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (request) confirm.current?.focus(); }, [request]);
  async function run() {
    if (!m || busy) return;
    setBusy(true);
    try { await messageStore.remove(m.channel_id, m.id); } catch { /* the message list keeps it; the server said no */ }
    setBusy(false);
    onClose();
  }
  return <Modal open={!!m} onClose={onClose} title="Delete Message"
    footer={<>
      <button type="button" className="chat-btn link" onClick={onClose}>Cancel</button>
      <button ref={confirm} type="button" className="chat-btn danger" disabled={busy} onClick={() => void run()}>Delete</button>
    </>}>
    {m && <>
      <p className="chat-modal-text">Are you sure you want to delete this message?</p>
      <div className="chat-delete-preview">
        <Avatar user={m.author} size={40} />
        <div>
          <div className="chat-msg-header"><span className="chat-author">{chat.nameOf(m.author, m.member)}</span> <span className="chat-timestamp">{formatMessageTimestamp(new Date(m.timestamp))}</span></div>
          <Markdown content={m.content || '(attachment)'} ctx={chat.md} className="chat-content" />
        </div>
      </div>
    </>}
  </Modal>;
}

function LinkModal({ href, onClose }: { href: string | null; onClose(): void }) {
  return <Modal open={!!href} onClose={onClose} title="Leaving Vokko"
    footer={<>
      <button type="button" className="chat-btn link" onClick={onClose}>Cancel</button>
      <a className="chat-btn primary" href={href ?? '#'} target="_blank" rel="noopener noreferrer" onClick={onClose}>Visit Site</a>
    </>}>
    <p className="chat-modal-text">This link is taking you to the following website:</p>
    <p className="chat-modal-url">{href}</p>
    <p className="chat-modal-text">Only open links from people and places you trust.</p>
  </Modal>;
}
