import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { AtSign, CircleAlert, Eye, FileUp, Hash, LayoutGrid, Pencil, Plus, Smile, Sticker, Trash2, X } from 'lucide-react';
import { ChannelType } from '../api/types';
import type { Gif, Message, Snowflake, Sticker as StickerData } from '../api/types';
import { request, Popout, Tooltip, useConvertEmoticons, useLegacyChatInput } from './shell';
import { useChat } from './ChatContext';
import { Avatar } from './Avatar';
import { ExpressionPickerPopout, type ExpressionTab } from './ExpressionPicker';
import { AppLauncherPopout, AppsGlyph, useCommandComposer } from '../apps/CommandComposer';
import { useEmojiDb, pushRecentEmoji } from './emojiData';
import { addDraftToken, addFiles, clearDraft, removeUpload, setDraftText, updateUpload, useDraft } from './draftStore';
import { ModifyAttachmentModal } from './AttachmentModals';
import { fromDisplay, type MentionToken } from './mentionText';
import { convertEmoticons } from './emoticons';
import { messageStore } from './messageStore';
import { TypingIndicator } from './TypingIndicator';
import { activeTypers } from './messageState';
import { isSpoilerName, stripSpoiler } from './util';
import { ComposerInput, type ComposerField } from './composer/ComposerInput';
import { useShortcut } from '../keyboard';

const MAX_LEN = 2000;
// Discord client timings: POST at most every 8 s; the first one waits 1.5 s unless the previous was 16+ s ago;
// nothing is sent while 5+ other people are typing.
const TYPING_INTERVAL_MS = 8000;
const TYPING_FIRST_DELAY_MS = 1500;
const TYPING_IMMEDIATE_AFTER_MS = 16000;
const MANY_TYPERS = 5;
const lastTyping = new Map<Snowflake, number>();
const typingTimers = new Map<Snowflake, ReturnType<typeof setTimeout>>();

function postTyping(channelId: Snowflake): void {
  typingTimers.delete(channelId);
  lastTyping.set(channelId, Date.now());
  void request<null>('POST', `/channels/${channelId}/typing`).catch(() => undefined);
}

function notifyTyping(channelId: Snowflake, myId: Snowflake): void {
  const now = Date.now();
  const since = now - (lastTyping.get(channelId) ?? 0);
  if (since < TYPING_INTERVAL_MS || typingTimers.has(channelId)) return;
  if (activeTypers(messageStore.getState(channelId), now, myId).length >= MANY_TYPERS) return;
  if (since >= TYPING_IMMEDIATE_AFTER_MS) postTyping(channelId);
  else typingTimers.set(channelId, setTimeout(() => postTyping(channelId), TYPING_FIRST_DELAY_MS));
}

interface Suggestion {
  key: string;
  label: string;
  hint?: string;
  insert: string;
  token?: MentionToken;
  lead: 'avatar' | 'hash' | 'at' | 'emoji';
  user?: { id: string; avatar: string | null };
  emoji?: string;
  color?: string | null;
}

interface Trigger { kind: 'user' | 'channel' | 'emoji'; query: string; start: number }

export function detectTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)([@#:])([^\s@#:]*)$/.exec(before);
  if (!m) return null;
  const sym = m[2]!, query = m[3]!;
  if (sym === ':' && query.length < 2) return null;
  const start = caret - query.length - 1;
  return { kind: sym === '@' ? 'user' : sym === '#' ? 'channel' : 'emoji', query, start };
}

export interface ComposerProps {
  channelId: Snowflake;
  replyTo: Message | null;
  mentionReply: boolean;
  onToggleMention(): void;
  onCancelReply(): void;
  onSent(): void;
  onEditLast(): void;
  /** Incremented by the parent to pull focus (after reply, closing modals, ...). */
  focusToken: number;
}

export function Composer({ channelId, replyTo, mentionReply, onToggleMention, onCancelReply, onSent, onEditLast, focusToken }: ComposerProps) {
  const chat = useChat();
  const draft = useDraft(channelId);
  const area = useRef<ComposerField>(null);
  const plusBtn = useRef<HTMLButtonElement>(null);
  const gifBtn = useRef<HTMLButtonElement>(null);
  const stickerBtn = useRef<HTMLButtonElement>(null);
  const emojiBtn = useRef<HTMLButtonElement>(null);
  const appsBtn = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState(0);
  const [plusOpen, setPlusOpen] = useState(false);
  const [expr, setExpr] = useState<ExpressionTab | null>(null);
  const [appsOpen, setAppsOpen] = useState(false);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [modifying, setModifying] = useState<string | null>(null); // localId of the tray card whose "Modify Attachment" dialog is open
  const legacyInput = useLegacyChatInput(); // Settings > Accessibility > "Use legacy chat input": plain text box
  const emojiDb = useEmojiDb();
  const convert = useConvertEmoticons() && !legacyInput;
  const { text, uploads } = draft;
  const name = chat.channel?.name ? (chat.channel.type === ChannelType.GuildVoice ? chat.channel.name : `#${chat.channel.name}`) :chat.channel?.recipients?.map(u => chat.nameOf(u)).join(', ') ?? '';
  const placeholder = chat.isDm ? `Message @${chat.channel?.recipients?.[0] ? chat.nameOf(chat.channel.recipients[0]) : ''}` : `Message ${name}`;

  useEffect(() => { area.current?.focus(); }, [channelId, focusToken]);

  // Shortcuts go to the composer holding focus, else to the newest mounted one (a thread panel's over the channel's).
  const root = useRef<HTMLDivElement>(null);
  const mine = () => { const f = document.activeElement?.closest('.chat-composer'); return !f || f === root.current; };
  const toggleExpr = (tab: ExpressionTab) => () => { if (!mine()) return false; setExpr(v => (v === tab ? null : tab)); };
  useShortcut('emoji', toggleExpr('emoji'));
  useShortcut('gif', toggleExpr('gif'));
  useShortcut('sticker', toggleExpr('sticker'));
  useShortcut('upload', () => { if (!mine()) return false; fileInput.current?.click(); });
  useShortcut('editLast', (_, e) => {
    if (!(e?.target instanceof Node) || !root.current?.contains(e.target) || text !== '' || uploads.length > 0) return false;
    onEditLast();
  });
  // ---- slash commands (src/apps) ----
  const setTextAt = useCallback((next: string, pos: number) => {
    setDraftText(channelId, next);
    requestAnimationFrame(() => { area.current?.focus(); area.current?.setSelectionRange(pos, pos); setCaret(pos); });
  }, [channelId]);
  const commands = useCommandComposer({ channelId, text, caret, setText: setTextAt });

  // ---- autocomplete ----
  const trigger = useMemo(() => (commands.active ? null : detectTrigger(text, caret)), [text, caret, commands.active]);
  const triggerKey = trigger ? `${trigger.kind}:${trigger.start}:${trigger.query}` : null;

  const suggestions = useMemo<Suggestion[]>(() => {
    if (!trigger || dismissed === triggerKey) return [];
    const q = trigger.query.toLowerCase();
    if (trigger.kind === 'user') {
      const people = new Map<string, { id: string; avatar: string | null; username: string; name: string; color: string | null }>();
      const add = (u: { id: string; avatar: string | null; username: string; global_name: string | null }, member?: { nick: string | null; roles: string[] }) => {
        if (people.has(u.id)) return;
        people.set(u.id, { id: u.id, avatar: u.avatar, username: u.username, name: member?.nick || u.global_name || u.username, color: null });
      };
      if (chat.guildId) for (const m of Object.values(chat.members)) add(m.user, m);
      else { add(chat.me); for (const u of chat.channel?.recipients ?? []) add(u); }
      const list = [...people.values()]
        .filter(p => !q || p.name.toLowerCase().includes(q) || p.username.toLowerCase().includes(q))
        .sort((a, b) => Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name))
        .slice(0, 10);
      const out: Suggestion[] = list.map(p => ({
        key: `u${p.id}`, label: p.name, hint: p.username, insert: `@${p.name}`, token: { display: `@${p.name}`, raw: `<@${p.id}>` }, lead: 'avatar', user: { id: p.id, avatar: p.avatar },
      }));
      if (chat.guildId) {
        for (const r of chat.roles) {
          if (r.id === chat.guildId || !r.mentionable || !r.name.toLowerCase().includes(q)) continue;
          out.push({ key: `r${r.id}`, label: r.name, insert: `@${r.name}`, token: { display: `@${r.name}`, raw: `<@&${r.id}>` }, lead: 'at', color: r.color ? `#${r.color.toString(16).padStart(6, '0')}` : null });
        }
        for (const special of ['everyone', 'here']) if (special.startsWith(q)) out.push({ key: special, label: `@${special}`, hint: special === 'everyone' ? 'Notify everyone in this channel' : 'Notify online members', insert: `@${special}`, lead: 'at' });
      }
      return out.slice(0, 12);
    }
    if (trigger.kind === 'channel') {
      if (!chat.guildId) return [];
      return chat.channels.filter(c => c.type === ChannelType.GuildText && (c.name ?? '').toLowerCase().includes(q)).slice(0, 10)
        .map(c => ({ key: `c${c.id}`, label: c.name ?? '', insert: `#${c.name}`, token: { display: `#${c.name}`, raw: `<#${c.id}>` }, lead: 'hash' as const }));
    }
    if (!emojiDb) return [];
    return emojiDb.search(q, 10).map(e => ({ key: `e${e.order}`, label: `:${e.shortcodes[0] ?? e.label}:`, insert: e.emoji, lead: 'emoji' as const, emoji: e.emoji }));
  }, [trigger, triggerKey, dismissed, chat, emojiDb]);

  useEffect(() => { setSelected(0); }, [triggerKey]);

  const apply = useCallback((s: Suggestion) => {
    if (!trigger) return;
    const el = area.current;
    const end = el?.selectionStart ?? caret;
    const insert = s.insert + (s.lead === 'emoji' ? ' ' : ' ');
    const next = text.slice(0, trigger.start) + insert + text.slice(end);
    if (s.token) addDraftToken(channelId, s.token);
    if (s.emoji) pushRecentEmoji(s.emoji);
    setDraftText(channelId, next);
    const pos = trigger.start + insert.length;
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(pos, pos); setCaret(pos); });
  }, [trigger, caret, text, channelId]);

  // ---- sending ----
  const anyUploading = uploads.some(u => u.status === 'uploading');
  const rawContent = fromDisplay(text, draft.tokens).trim();
  const tooLong = rawContent.length > MAX_LEN;
  const readyUploads = uploads.filter(u => u.status === 'done' && u.attachment);
  const canSend = !tooLong && !anyUploading && (rawContent.length > 0 || readyUploads.length > 0);

  function send() {
    if (tooLong) return;
    const command = uploads.length === 0 ? commands.submit(rawContent) : 'none';
    if (command === 'blocked') return;
    if (command === 'sent') { finishSend(); return; }
    if (anyUploading) {
      // Enter while a file is still uploading: the message waits (as the "Uploading N files" card) and posts when the uploads settle.
      messageStore.sendAfterUploads(channelId, chat.me, {
        content: convert ? convertEmoticons(rawContent) : rawContent,
        uploads: uploads.filter(u => u.status !== 'error'),
        reply: replyTo,
        mention: mentionReply,
      });
      finishSend();
      return;
    }
    if (!canSend) return;
    // Renamed / alt-texted / spoiler files go as CreateMessageRequest.attachments[]; untouched ones keep the plain id list.
    const modified = readyUploads.some(u => u.filename !== undefined || u.description !== undefined);
    messageStore.send(channelId, chat.me, {
      content: convert ? convertEmoticons(rawContent) : rawContent,
      attachments: readyUploads.map(u => ({
        ...u.attachment!,
        ...(u.filename !== undefined ? { filename: u.filename } : {}),
        ...(u.description !== undefined ? { description: u.description || null } : {}),
      })),
      meta: modified ? readyUploads.map(u => ({
        id: u.attachment!.id,
        ...(u.filename !== undefined ? { filename: u.filename } : {}),
        ...(u.description !== undefined ? { description: u.description } : {}),
      })) : undefined,
      reply: replyTo,
      mention: mentionReply,
    });
    finishSend();
  }

  function finishSend() {
    clearDraft(channelId);
    clearTimeout(typingTimers.get(channelId));
    typingTimers.delete(channelId);
    lastTyping.delete(channelId);
    setCaret(0);
    onCancelReply();
    onSent();
  }

  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (e.nativeEvent.isComposing) return;
    if (commands.onKeyDown(e)) return;
    if (suggestions.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(s => (s + 1) % suggestions.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(s => (s - 1 + suggestions.length) % suggestions.length); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); const s = suggestions[selected]; if (s) apply(s); return; }
      if (e.key === 'Escape') { e.preventDefault(); setDismissed(triggerKey); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); return; }
    if (e.key === 'Escape' && replyTo) { e.preventDefault(); onCancelReply(); return; }
  }

  function onChange(value: string) {
    setDraftText(channelId, value);
    const pos = area.current?.selectionStart ?? value.length;
    setCaret(pos);
    if (value.trim()) notifyTyping(channelId, chat.me.id);
  }

  function onPaste(e: ClipboardEvent<HTMLElement>) {
    const files = [...e.clipboardData.files];
    if (files.length) { e.preventDefault(); addFiles(channelId, files); }
  }

  function insertEmoji(ch: string) {
    const el = area.current;
    const start = el?.selectionStart ?? text.length, end = el?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + ch + text.slice(end);
    setDraftText(channelId, next);
    const pos = start + ch.length;
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(pos, pos); setCaret(pos); });
  }

  /** A GIF (its URL is the message) or a sticker is sent at once, like Discord; the draft text stays. */
  function sendMedia(input: { content: string; stickers?: StickerData[] }) {
    setExpr(null);
    messageStore.send(channelId, chat.me, {
      content: input.content,
      stickers: input.stickers?.map(s => ({ id: s.id, name: s.name, format_type: s.format_type, url: s.url })),
      reply: replyTo,
      mention: mentionReply,
    });
    onCancelReply();
    onSent();
  }

  const remaining = MAX_LEN - rawContent.length;
  const replyName = replyTo ? chat.nameOf(replyTo.author, replyTo.member) : '';
  const hasText = text.length > 0;

  return <div className="chat-composer" ref={root}>
    <TypingIndicator channelId={channelId} />
    {replyTo && <div className="chat-reply-bar">
      <span className="chat-reply-bar-text">Replying to <b>{replyName}</b></span>
      {!chat.isDm && <button type="button" className={`chat-reply-mention${mentionReply ? ' on' : ''}`} aria-pressed={mentionReply} onClick={onToggleMention}><AtSign size={14} /> {mentionReply ? 'ON' : 'OFF'}</button>}
      <button type="button" className="chat-reply-close" aria-label="Cancel reply" onClick={onCancelReply}><X size={16} /></button>
    </div>}
    <div className={`chat-composer-box${replyTo ? ' has-reply' : ''}`}>
      <ModifyAttachmentModal
        target={(() => { const u = uploads.find(x => x.localId === modifying); return u ? { details: { filename: u.filename ?? u.file.name, description: u.description ?? '' }, thumbUrl: u.previewUrl } : null; })()}
        onSave={d => { if (modifying) updateUpload(channelId, modifying, d); }}
        onClose={() => { setModifying(null); area.current?.focus(); }} />
      {uploads.length > 0 && <div className="chat-tray" aria-label="Attachments to upload">
        {uploads.map(u => <div key={u.localId} className={`chat-tray-item ${u.status}`}>
          <div className="chat-tray-actions">
            <Tooltip content="Preview" side="top"><button type="button" className="chat-tray-btn" aria-label={`Preview ${u.file.name}`} disabled={!u.previewUrl}
              onClick={() => { if (u.previewUrl) window.open(u.previewUrl, '_blank', 'noopener'); }}><Eye size={20} /></button></Tooltip>
            <Tooltip content="Edit" side="top"><button type="button" className="chat-tray-btn" aria-label={`Edit ${u.file.name}`} onClick={() => setModifying(u.localId)}><Pencil size={20} /></button></Tooltip>
            <Tooltip content="Remove Attachment" side="top"><button type="button" className="chat-tray-btn chat-tray-remove" aria-label={`Remove ${u.file.name}`} onClick={() => removeUpload(channelId, u.localId)}><Trash2 size={20} /></button></Tooltip>
          </div>
          <div className="chat-tray-thumb">
            {u.previewUrl ? <img src={u.previewUrl} alt={u.description ?? ''} draggable={false} /> : <FileUp size={40} />}
            {u.filename && isSpoilerName(u.filename) && <span className="chat-tray-spoiler">SPOILER</span>}
          </div>
          <div className="chat-tray-name" title={u.filename ?? u.file.name}>{stripSpoiler(u.filename ?? u.file.name)}</div>
          {u.status === 'error' && <div className="chat-tray-size"><span className="chat-tray-error"><CircleAlert size={12} /> {u.error}</span></div>}
          {u.status === 'uploading' && <div className="chat-tray-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(u.progress * 100)}><div style={{ width: `${Math.round(u.progress * 100)}%` }} /></div>}
        </div>)}
      </div>}
      <div className="chat-composer-row">
        <Tooltip content="Attach" side="top"><button ref={plusBtn} type="button" className="chat-composer-btn plus" aria-label="Attach a file" onClick={() => setPlusOpen(v => !v)}><Plus size={20} /></button></Tooltip>
        <Popout anchor={plusBtn} open={plusOpen} onClose={() => setPlusOpen(false)} side="top">
          <div className="chat-attach-menu" role="menu">
            <button type="button" role="menuitem" onClick={() => { setPlusOpen(false); fileInput.current?.click(); }}><FileUp size={20} /> Upload a File</button>
            <button type="button" role="menuitem" onClick={() => { setPlusOpen(false); setAppsOpen(true); }}><AppsGlyph size={20} /> Use Apps</button>
          </div>
        </Popout>
        <input ref={fileInput} type="file" multiple hidden onChange={e => { addFiles(channelId, [...(e.target.files ?? [])]); e.target.value = ''; }} />
        <ComposerInput fieldRef={area} value={text} placeholder={placeholder} mentions={draft.tokens.map(t => t.display)} resetKey={channelId}
          onChange={onChange} onKeyDown={onKeyDown} onPaste={onPaste} onCaret={setCaret} />
        <div className="chat-composer-actions">
          {remaining <= 200 && hasText && <span className={`chat-counter${remaining < 0 ? ' over' : ''}`} aria-live="polite">{remaining}</span>}
          <Tooltip content="Open GIF picker" side="top"><button ref={gifBtn} type="button" className="chat-composer-btn" aria-label="Open GIF picker" aria-expanded={expr === 'gif'} onClick={() => setExpr(v => (v === 'gif' ? null : 'gif'))}><span className="chat-gif-glyph" aria-hidden="true">GIF</span></button></Tooltip>
          <Tooltip content="Open sticker picker" side="top"><button ref={stickerBtn} type="button" className="chat-composer-btn" aria-label="Open sticker picker" aria-expanded={expr === 'sticker'} onClick={() => setExpr(v => (v === 'sticker' ? null : 'sticker'))}><Sticker size={24} /></button></Tooltip>
          <Tooltip content="Select Emoji" side="top"><button ref={emojiBtn} type="button" className="chat-composer-btn" aria-label="Select emoji" aria-expanded={expr === 'emoji'} onClick={() => setExpr(v => (v === 'emoji' ? null : 'emoji'))}><Smile size={24} /></button></Tooltip>
          <Tooltip content="Apps" side="top"><button ref={appsBtn} type="button" className="chat-composer-btn" aria-label="Apps" aria-expanded={appsOpen} onClick={() => setAppsOpen(v => !v)}><LayoutGrid size={24} /></button></Tooltip>
        </div>
        <ExpressionPickerPopout anchor={expr === 'gif' ? gifBtn : expr === 'sticker' ? stickerBtn : emojiBtn} open={expr !== null} initialTab={expr ?? 'emoji'}
          onClose={() => setExpr(null)} onPickEmoji={e => { setExpr(null); insertEmoji(e.name); }}
          channelId={channelId} onPickGif={(gif: Gif) => sendMedia({ content: gif.url })} onPickSticker={s => sendMedia({ content: '', stickers: [s] })} />
        <AppLauncherPopout anchor={appsBtn} open={appsOpen} onClose={() => setAppsOpen(false)} channelId={channelId} onPick={next => setTextAt(next, next.length)} />
      </div>
      {commands.panel}
      {suggestions.length > 0 && <div className="chat-autocomplete" role="listbox" aria-label="Suggestions">
        <div className="chat-autocomplete-title">{trigger?.kind === 'user' ? 'Members' : trigger?.kind === 'channel' ? 'Text Channels' : `Emoji matching :${trigger?.query}`}</div>
        {suggestions.map((s, i) => <div key={s.key} role="option" aria-selected={i === selected} className={`chat-autocomplete-item${i === selected ? ' selected' : ''}`}
          onMouseEnter={() => setSelected(i)} onMouseDown={e => { e.preventDefault(); apply(s); }}>
          {s.lead === 'avatar' && s.user && <Avatar user={s.user} size={24} />}
          {s.lead === 'hash' && <Hash size={20} className="chat-autocomplete-icon" />}
          {s.lead === 'at' && <AtSign size={20} className="chat-autocomplete-icon" style={s.color ? { color: s.color } : undefined} />}
          {s.lead === 'emoji' && <span className="chat-autocomplete-emoji">{s.emoji}</span>}
          <span className="chat-autocomplete-label" style={s.color ? { color: s.color } : undefined}>{s.label}</span>
          {s.hint && <span className="chat-autocomplete-hint">{s.hint}</span>}
        </div>)}
        {trigger?.kind === 'emoji' && suggestions[selected]?.emoji && <div className="chat-autocomplete-preview" aria-hidden="true"><span className="chat-autocomplete-preview-emoji">{suggestions[selected]?.emoji}</span><span>{suggestions[selected]?.label}</span></div>}
      </div>}
    </div>
  </div>;
}
