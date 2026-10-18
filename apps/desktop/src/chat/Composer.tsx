import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { AtSign, ChartBarBig, CircleAlert, Eye, FileUp, LayoutGrid, Lock, Pencil, Plus, Smile, Sticker, Timer, Trash2, X } from 'lucide-react';
import { Perm, channelPermissions, hasBit, memberLike } from '../api/permissions';
import { ChannelType } from '../api/types';
import type { Gif, Message, Snowflake, Sticker as StickerData } from '../api/types';
import { request, sharesTyping, useStale, BottomSheet, Popout, Tooltip, usePhone, resolveUrl, useComposerOptions, useConvertEmoticons, useGuild, useGuildMembers, useLegacyChatInput } from './shell';
import { useMedia } from '../media/store';
import { useChat } from './ChatContext';
import { Avatar } from './Avatar';
import { ChannelTypeIcon } from './ChannelTypeIcon';
import { mentionableChannels, userSuggestions } from './suggest';
import { ExpressionPickerPopout, type ExpressionTab } from './ExpressionPicker';
import { AppLauncherPopout, AppsGlyph, useCommandComposer } from '../apps/CommandComposer';
import { frecencyRank, useEmojiDb } from './emojiData';
import { emojiMarkup, searchCustomEmoji } from '../emoji/store';
import { usePickerSections } from '../emoji/PickerSections';
import { addDraftToken, addFiles, clearDraft, removeUpload, setDraftText, updateUpload, useDraft } from './draftStore';
import { ModifyAttachmentModal } from './AttachmentModals';
import { resumeOnboarding, useRulesPending } from '../community';
import { fromDisplay, type MentionToken } from './mentionText';
import { convertEmoticons } from './emoticons';
import { messageStore } from './messageStore';
import { TypingIndicator } from './TypingIndicator';
import { activeTypers } from './messageState';
import { composerPlaceholder, isSpoilerName, stripSpoiler } from './util';
import { CreatePollModal } from '../polls/CreatePollModal';
import { ComposerInput, type ComposerField } from './composer/ComposerInput';
import { useShortcut } from '../keyboard';
import { useKeyToken, useKeyedState } from './keyedState';
import { MicButton, VoiceHoldOverlay, VoiceRecorderBar, canRecordVoice, sendVoiceMessage, useHoldToRecord, useVoiceRecorder } from './VoiceMessage';
import { formatCooldown, slowmodeLong, startCooldown, useCooldown } from './slowmode';

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
  // the server drops it anyway; not sending saves the request
  if (!sharesTyping(myId)) return;
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
  lead: 'avatar' | 'hash' | 'at' | 'emoji' | 'sticker';
  user?: { id: string; avatar: string | null };
  emoji?: string;
  /** custom emoji image */
  image?: string;
  sticker?: StickerData;
  color?: string | null;
  channelType?: ChannelType;
  /** names the query is ranked against: a custom emoji's name, every shortcode of a unicode one */
  names?: string[];
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
  const rulesPending = useRulesPending(chat.guildId);
  const stale = useStale();
  const draft = useDraft(channelId);
  const area = useRef<ComposerField>(null);
  const plusBtn = useRef<HTMLButtonElement>(null);
  // The GIF, sticker and emoji buttons share one anchor, so the picker opens in the same place whichever tab it starts on.
  const exprButtons = useRef<HTMLDivElement>(null);
  const appsBtn = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState(0);
  const [plusOpen, setPlusOpen] = useState(false);
  const phone = usePhone();
  const [pollOpen, setPollOpen] = useState(false);
  const pollGuild = useGuild(chat.guildId);
  const pollMembers = useGuildMembers(chat.guildId);
  // A DM needs nothing extra; in a server the Create Poll item is offered only with SEND_POLLS.
  const canPoll = useMemo(() => {
    const member = pollMembers[chat.me.id];
    if (!pollGuild || !chat.channel || !member) return true;
    return hasBit(channelPermissions(pollGuild, memberLike(member), chat.channel), Perm.SEND_POLLS);
  }, [pollGuild, pollMembers, chat.channel, chat.me.id]);
  // @everyone/@here are offered only in servers, to members with MENTION_EVERYONE.
  const canMentionEveryone = useMemo(() => {
    if (!chat.guildId) return false;
    const member = pollMembers[chat.me.id];
    if (!pollGuild || !chat.channel || !member) return true;
    return hasBit(channelPermissions(pollGuild, memberLike(member), chat.channel), Perm.MENTION_EVERYONE);
  }, [pollGuild, pollMembers, chat.channel, chat.me.id, chat.guildId]);
  // Slowmode: the server limits members to one message per rate_limit_per_user seconds; moderators are immune (like the server's check).
  const slowmode = chat.channel?.rate_limit_per_user ?? 0;
  const slowmodeImmune = useMemo(() => {
    const member = pollMembers[chat.me.id];
    if (!pollGuild || !chat.channel || !member) return false;
    const bits = channelPermissions(pollGuild, memberLike(member), chat.channel);
    return hasBit(bits, Perm.BYPASS_SLOWMODE) || hasBit(bits, Perm.MANAGE_MESSAGES) || hasBit(bits, Perm.MANAGE_CHANNELS);
  }, [pollGuild, pollMembers, chat.channel, chat.me.id]);
  const cooldown = useCooldown(channelId);
  const coolingDown = slowmode > 0 && !slowmodeImmune && cooldown > 0;
  const armSlowmode = () => { if (slowmode > 0 && !slowmodeImmune) startCooldown(channelId, slowmode * 1000); };
  // Voice messages: DMs always, servers with SEND_VOICE_MESSAGES and ATTACH_FILES; the browser must be able to record.
  const canVoice = useMemo(() => {
    if (!canRecordVoice()) return false;
    const member = pollMembers[chat.me.id];
    if (!pollGuild || !chat.channel || !member) return !chat.guildId;
    const perms = channelPermissions(pollGuild, memberLike(member), chat.channel);
    return hasBit(perms, Perm.SEND_VOICE_MESSAGES) && hasBit(perms, Perm.ATTACH_FILES);
  }, [pollGuild, pollMembers, chat.channel, chat.me.id, chat.guildId]);
  const sendClip = (clip: Parameters<typeof sendVoiceMessage>[2]) => {
    void sendVoiceMessage(channelId, chat.me, clip, replyTo, mentionReply);
    armSlowmode();
    onCancelReply();
    onSent();
  };
  const recorder = useVoiceRecorder(clip => { if (clip) sendClip(clip); });
  const hold = useHoldToRecord(recorder, sendClip);
  const cancelRecording = recorder.cancel;
  useEffect(() => cancelRecording, [channelId, cancelRecording]); // a recording never follows the user into another channel
  const [expr, setExpr] = useState<ExpressionTab | null>(null);
  const [appsOpen, setAppsOpen] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [modifying, setModifying] = useState<string | null>(null); // localId of the tray card whose "Modify Attachment" dialog is open
  const legacyInput = useLegacyChatInput(); // Settings > Accessibility > "Use legacy chat input": plain text box
  const emojiDb = useEmojiDb();
  const emojiSections = usePickerSections();
  const convert = useConvertEmoticons() && !legacyInput;
  const options = useComposerOptions();
  const allStickers = useMedia(s => s.stickers);
  // Stickers this channel can take without extra permission checks: the server's own, or everything in DMs.
  const stickers = useMemo(() => (chat.guildId ? allStickers[chat.guildId] ?? [] : Object.values(allStickers).flat()), [allStickers, chat.guildId]);
  const { text, uploads } = draft;
  const placeholder = composerPlaceholder(chat.channel, u => chat.nameOf(u));

  useEffect(() => { area.current?.focus(); }, [channelId, focusToken]);

  // Shortcuts go to the composer holding focus, else to the newest mounted one (a thread panel's over the channel's).
  const root = useRef<HTMLDivElement>(null);
  const mine = () => { if (!chat.canSend) return false; const f = document.activeElement?.closest('.chat-composer'); return !f || f === root.current; };
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
  // The caret goes with the text, so the picker never parses the new text at the old caret. The editor's selection follows next frame,
  // but only if nothing was typed meanwhile: a stale frame would move the caret back into the user's typing.
  const setTextAt = useCallback((next: string, pos: number) => {
    setDraftText(channelId, next);
    setCaret(pos);
    requestAnimationFrame(() => {
      const el = area.current;
      el?.focus();
      if (el?.value === next) { el.setSelectionRange(pos, pos); setCaret(pos); }
    });
  }, [channelId]);
  const commands = useCommandComposer({ channelId, text, caret, setText: setTextAt });

  // ---- autocomplete ----
  const trigger = useMemo(() => (commands.active ? null : detectTrigger(text, caret)), [text, caret, commands.active]);
  const triggerKey = trigger ? `${trigger.kind}:${trigger.start}:${trigger.query}` : null;
  // The highlight goes back to the first row when the query changes (keyed, not reset from an effect: see keyedState.ts).
  const [selected, setSelected] = useKeyedState(useKeyToken(triggerKey), 0);

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
      const roles = chat.guildId ? chat.roles.filter(r => r.id !== chat.guildId && r.mentionable) : [];
      return userSuggestions([...people.values()], roles, q, canMentionEveryone).map((s): Suggestion => {
        if (s.kind === 'user') {
          const p = s.person;
          return { key: `u${p.id}`, label: p.name, hint: p.username, insert: `@${p.name}`, token: { display: `@${p.name}`, raw: `<@${p.id}>` }, lead: 'avatar', user: { id: p.id, avatar: p.avatar } };
        }
        if (s.kind === 'role') {
          const r = s.role;
          return { key: `r${r.id}`, label: r.name, insert: `@${r.name}`, token: { display: `@${r.name}`, raw: `<@&${r.id}>` }, lead: 'at', color: r.color ? `#${r.color.toString(16).padStart(6, '0')}` : null };
        }
        return { key: s.name, label: `@${s.name}`, hint: s.name === 'everyone' ? 'Notify everyone in this channel' : 'Notify online members', insert: `@${s.name}`, lead: 'at' };
      });
    }
    if (trigger.kind === 'channel') {
      if (!chat.guildId) return [];
      return mentionableChannels(chat.channels, q, 10)
        .map(c => ({ key: `c${c.id}`, label: c.name ?? '', insert: `#${c.name}`, token: { display: `#${c.name}`, raw: `<#${c.id}>` }, lead: 'hash' as const, channelType: c.type }));
    }
    // Settings > Chat: ":emoji: autocomplete" and "sticker autocomplete" decide what a `:` query lists.
    const custom: Suggestion[] = options.emojiAutocomplete
      ? searchCustomEmoji(emojiSections, q, 40).map(({ emoji, guild }) => ({
        key: `x${emoji.id}`, label: `:${emoji.name}:`, hint: guild.name, insert: emojiMarkup(emoji), lead: 'emoji' as const, image: emoji.url, names: [emoji.name],
      }))
      : [];
    const unicode: Suggestion[] = options.emojiAutocomplete && emojiDb
      ? emojiDb.search(q, 40).map(e => ({ key: `e${e.order}`, label: `:${e.shortcodes[0] ?? e.label}:`, insert: e.emoji, lead: 'emoji' as const, emoji: e.emoji, names: e.shortcodes.length ? e.shortcodes : [e.label] }))
      : [];
    // Exact names first, then prefix matches (on any shortcode), then the rest (so `:smile` leads with 😄, not :vokko_smile:); within a rank Frequently Used order, then custom before unicode.
    const rank = (s: Suggestion) => Math.min(2, ...(s.names ?? []).map(n => { const name = n.toLowerCase(); return name === q ? 0 : name.startsWith(q) ? 1 : 2; }));
    const used = frecencyRank();
    const out: Suggestion[] = [...custom, ...unicode].map((s, i) => ({ s, i, r: rank(s), u: used(s.emoji ?? s.insert) })).sort((a, b) => a.r - b.r || a.u - b.u || a.i - b.i).map(x => x.s).slice(0, 10);
    if (options.stickerAutocomplete) {
      for (const s of stickers.filter(s => s.name.toLowerCase().includes(q)).slice(0, 4)) out.push({ key: `s${s.id}`, label: s.name, hint: 'Sticker', insert: '', lead: 'sticker', sticker: s });
    }
    return out;
  }, [trigger, triggerKey, dismissed, chat, canMentionEveryone, emojiDb, emojiSections, options.emojiAutocomplete, options.stickerAutocomplete, stickers]);

  // Settings > Chat > "sticker suggestions": a single typed word that names a sticker (or one of its tags) offers it.
  const stickerHits = useMemo(() => {
    const word = text.trim().toLowerCase();
    if (!options.stickerSuggestions || trigger || word.length < 2 || /\s/.test(word)) return [];
    return stickers.filter(s => s.name.toLowerCase() === word || s.tags.split(',').some(t => t.trim().toLowerCase() === word)).slice(0, 5);
  }, [options.stickerSuggestions, trigger, text, stickers]);

  const apply = useCallback((s: Suggestion) => {
    if (!trigger) return;
    const el = area.current;
    const end = el?.selectionStart ?? caret;
    if (s.sticker) {
      // A sticker is sent at once; the `:query` that found it is removed from the draft.
      setDraftText(channelId, text.slice(0, trigger.start) + text.slice(end));
      sendMedia({ content: '', stickers: [s.sticker] });
      return;
    }
    const insert = s.insert + (s.lead === 'emoji' ? ' ' : ' ');
    const next = text.slice(0, trigger.start) + insert + text.slice(end);
    if (s.token) addDraftToken(channelId, s.token);
    setTextAt(next, trigger.start + insert.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger, caret, text, channelId]);

  // ---- sending ----
  const anyUploading = uploads.some(u => u.status === 'uploading');
  const rawContent = fromDisplay(text, draft.tokens).trim();
  const tooLong = rawContent.length > MAX_LEN;
  const readyUploads = uploads.filter(u => u.status === 'done' && u.attachment);
  const canSend = !tooLong && !anyUploading && (rawContent.length > 0 || readyUploads.length > 0);

  function send() {
    if (tooLong || coolingDown) return; // the draft stays until the slowmode countdown runs out
    const command = commands.submit(rawContent, uploads.length > 0); // app commands are not run with files attached
    const sendText = typeof command === 'object' ? command.content : rawContent; // a built-in command sends its text like a typed message, files included
    const tts = typeof command === 'object' && command.tts === true; // /tts
    if (command === 'blocked') return;
    if (command === 'sent') { finishSend(); return; }
    if (anyUploading) {
      // Enter while a file is still uploading: the message waits (as the "Uploading N files" card) and posts when the uploads settle.
      messageStore.sendAfterUploads(channelId, chat.me, {
        content: convert ? convertEmoticons(sendText) : sendText,
        uploads: uploads.filter(u => u.status !== 'error'),
        reply: replyTo,
        mention: mentionReply,
        tts,
      });
      armSlowmode();
      finishSend();
      return;
    }
    if (!canSend) return;
    // Renamed / alt-texted / spoiler files go as CreateMessageRequest.attachments[]; untouched ones keep the plain id list.
    const modified = readyUploads.some(u => u.filename !== undefined || u.description !== undefined);
    messageStore.send(channelId, chat.me, {
      content: convert ? convertEmoticons(sendText) : sendText,
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
      tts,
    });
    armSlowmode();
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
    if (suggestions.length === 0 && commands.onKeyDown(e)) return; // an open @mention / :emoji / #channel picker wins inside built-ins
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
    setTextAt(next, start + ch.length);
  }

  /** A GIF (its URL is the message) or a sticker is sent at once, like Discord; the draft text stays. */
  function sendMedia(input: { content: string; stickers?: StickerData[] }) {
    setExpr(null);
    if (coolingDown) return;
    armSlowmode();
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

  if (stale) return <div className="chat-composer" ref={root}>
    <div className="chat-composer-box chat-composer-locked" role="status">
      <span>Connecting… You can send messages once Vokko is back online.</span>
    </div>
  </div>;

  // The server refuses sends and reactions until the rules are accepted (403 150010); the bar takes the composer place.
  if (rulesPending && chat.guildId) return <div className="chat-composer" ref={root}>
    <TypingIndicator channelId={channelId} />
    <div className="chat-composer-box chat-composer-locked chat-composer-rules" role="note">
      <Lock size={20} aria-hidden="true" />
      <span>Accept the server rules to talk here</span>
      <button type="button" className="btn btn-sm" onClick={() => resumeOnboarding(chat.guildId!)}>Review Rules</button>
    </div>
  </div>;

  if (!chat.canSend) return <div className="chat-composer" ref={root}>
    <TypingIndicator channelId={channelId} />
    <div className="chat-composer-box chat-composer-locked" role="note">
      <Lock size={20} aria-hidden="true" />
      <span>You do not have permission to send messages in this channel.</span>
    </div>
  </div>;

  return <div className="chat-composer" ref={root}>
    <TypingIndicator channelId={channelId} />
    {slowmode > 0 && <div className="chat-slowmode-wrap"><Tooltip side="top"
      content={slowmodeImmune ? 'Slowmode is enabled, but you are immune.' : `Slowmode is enabled. Members can send one message every ${slowmodeLong(slowmode)}.`}>
      <span className="chat-slowmode" role="status" tabIndex={0}>
        <Timer size={14} aria-hidden="true" />
        {coolingDown && <span className="chat-slowmode-time">{formatCooldown(cooldown)}</span>}
        <span>Slowmode is enabled</span>
      </span>
    </Tooltip></div>}
    {replyTo &&<div className="chat-reply-bar">
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
        {recorder.recording && !phone
          ? <VoiceRecorderBar elapsed={recorder.elapsed} live={recorder.live} onCancel={() => { recorder.cancel(); area.current?.focus(); }}
            onSend={() => { void recorder.stop().then(clip => { if (clip) sendClip(clip); }); }} />
          : recorder.recording ? <VoiceHoldOverlay elapsed={recorder.elapsed} live={recorder.live} cancelling={hold.cancelling} /> : <>
        <Tooltip content="Attach" side="top"><button ref={plusBtn} type="button" className="chat-composer-btn plus" aria-label="Attach a file" onClick={() => setPlusOpen(v => !v)}><Plus size={20} /></button></Tooltip>
        {phone
          ? <BottomSheet open={plusOpen} onClose={() => setPlusOpen(false)} label="Attach">
            <div className="sheet-group" role="menu">
              <button type="button" role="menuitem" className="sheet-row" onClick={() => { setPlusOpen(false); fileInput.current?.click(); }}><span className="sheet-row-icon"><FileUp size={22} /></span><span className="sheet-row-label">Upload a File</span></button>
              <button type="button" role="menuitem" className="sheet-row" onClick={() => { setPlusOpen(false); setAppsOpen(true); }}><span className="sheet-row-icon"><AppsGlyph size={22} /></span><span className="sheet-row-label">Use Apps</span></button>
              {canPoll && <button type="button" role="menuitem" className="sheet-row" onClick={() => { setPlusOpen(false); setPollOpen(true); }}><span className="sheet-row-icon"><ChartBarBig size={22} /></span><span className="sheet-row-label">Create Poll</span></button>}
            </div>
          </BottomSheet>
          : <Popout anchor={plusBtn} open={plusOpen} onClose={() => setPlusOpen(false)} side="top">
          <div className="chat-attach-menu" role="menu">
            <button type="button" role="menuitem" onClick={() => { setPlusOpen(false); fileInput.current?.click(); }}><FileUp size={20} /> Upload a File</button>
            <button type="button" role="menuitem" onClick={() => { setPlusOpen(false); setAppsOpen(true); }}><AppsGlyph size={20} /> Use Apps</button>
            {canPoll && <button type="button" role="menuitem" onClick={() => { setPlusOpen(false); setPollOpen(true); }}><ChartBarBig size={20} /> Create Poll</button>}
          </div>
        </Popout>}
        {pollOpen && <CreatePollModal channelId={channelId} onClose={() => { setPollOpen(false); area.current?.focus(); }} />}
        <input ref={fileInput} type="file" multiple hidden onChange={e => { addFiles(channelId, [...(e.target.files ?? [])]); e.target.value = ''; }} />
        <ComposerInput fieldRef={area} value={text} placeholder={placeholder} mentions={draft.tokens.map(t => t.display)} resetKey={channelId}
          onChange={onChange} onKeyDown={onKeyDown} onPaste={onPaste} onCaret={setCaret} />
        <div ref={exprButtons} className="chat-composer-actions">
          {remaining <= 200 && hasText && <span className={`chat-counter${remaining < 0 ? ' over' : ''}`} aria-live="polite">{remaining}</span>}
          <Tooltip content="Open GIF picker" side="top"><button type="button" className="chat-composer-btn" aria-label="Open GIF picker" aria-expanded={expr === 'gif'} onClick={() => setExpr(v => (v === 'gif' ? null : 'gif'))}><span className="chat-gif-glyph" aria-hidden="true">GIF</span></button></Tooltip>
          <Tooltip content="Open sticker picker" side="top"><button type="button" className="chat-composer-btn" aria-label="Open sticker picker" aria-expanded={expr === 'sticker'} onClick={() => setExpr(v => (v === 'sticker' ? null : 'sticker'))}><Sticker size={24} /></button></Tooltip>
          <Tooltip content="Select Emoji" side="top"><button type="button" className="chat-composer-btn" aria-label="Select emoji" aria-expanded={expr === 'emoji'} onClick={() => setExpr(v => (v === 'emoji' ? null : 'emoji'))}><Smile size={24} /></button></Tooltip>
          <Tooltip content="Apps" side="top"><button ref={appsBtn} type="button" className="chat-composer-btn" aria-label="Apps" aria-expanded={appsOpen} onClick={() => { setExpr(null); setAppsOpen(v => !v); }}><LayoutGrid size={24} /></button></Tooltip>
        </div>
        <ExpressionPickerPopout anchor={exprButtons} open={expr !== null} initialTab={expr ?? 'emoji'}
          onClose={() => setExpr(null)} onPickEmoji={e => { setExpr(null); insertEmoji(e.id ? emojiMarkup({ id: e.id, name: e.name, animated: !!e.animated }) : e.name); }}
          channelId={channelId} onPickGif={(gif: Gif) => sendMedia({ content: gif.url })} onPickSticker={s => sendMedia({ content: '', stickers: [s] })} />
        <AppLauncherPopout anchor={appsBtn} open={appsOpen} onClose={() => setAppsOpen(false)} channelId={channelId} onPick={next => setTextAt(next, next.length)} />
        </>}
        {/* Same slot while recording, so a phone's held press keeps its pointer capture. */}
        {canVoice && !hasText && uploads.length === 0 && (!coolingDown || recorder.recording) && !(recorder.recording && !phone) && (phone
          ? <MicButton recording={recorder.recording} {...hold.handlers} />
          : <MicButton onClick={() => { setExpr(null); void recorder.start(); }} />)}
      </div>
      {stickerHits.length > 0 && <div className="chat-sticker-suggest" role="listbox" aria-label="Sticker suggestions">
        {stickerHits.map(s => <button key={s.id} type="button" role="option" aria-selected={false} className="chat-sticker-suggest-item" title={s.name}
          onMouseDown={e => { e.preventDefault(); clearDraft(channelId); sendMedia({ content: '', stickers: [s] }); }}>
          <img src={resolveUrl(s.url)} alt={`Sticker: ${s.name}`} width={64} height={64} draggable={false} />
        </button>)}
      </div>}
      {commands.panel}
      {suggestions.length > 0 && <div className="chat-autocomplete" role="listbox" aria-label="Suggestions">
        <div className="chat-autocomplete-title">{trigger?.kind === 'user' ? 'Members' : trigger?.kind === 'channel' ? 'Text Channels' : `Emoji matching :${trigger?.query}`}</div>
        {suggestions.map((s, i) => <div key={s.key} role="option" aria-selected={i === selected} className={`chat-autocomplete-item${i === selected ? ' selected' : ''}`}
          onMouseEnter={() => setSelected(i)} onMouseDown={e => { e.preventDefault(); apply(s); }}>
          {s.lead === 'avatar' && s.user && <Avatar user={s.user} size={24} />}
          {s.lead === 'hash' && <ChannelTypeIcon type={s.channelType ?? ChannelType.GuildText} className="chat-autocomplete-icon" />}
          {s.lead === 'at' && <AtSign size={20} className="chat-autocomplete-icon" style={s.color ? { color: s.color } : undefined} />}
          {s.lead === 'emoji' && (s.image ? <img className="chat-autocomplete-emoji emoji-autocomplete-img" src={s.image} alt="" /> : <span className="chat-autocomplete-emoji">{s.emoji}</span>)}
          {s.lead === 'sticker' && s.sticker && <img className="chat-autocomplete-sticker" src={resolveUrl(s.sticker.url)} alt="" width={24} height={24} draggable={false} />}
          <span className="chat-autocomplete-label" style={s.color ? { color: s.color } : undefined}>{s.label}</span>
          {s.hint && <span className="chat-autocomplete-hint">{s.hint}</span>}
        </div>)}
        {trigger?.kind === 'emoji' && (() => {
          const s = suggestions[selected];
          if (!s || s.lead !== 'emoji') return null;
          return <div className="chat-autocomplete-preview" aria-hidden="true">
            <span className="chat-autocomplete-preview-emoji">{s.image ? <img src={s.image} alt="" width={32} height={32} draggable={false} /> : s.emoji}</span><span>{s.label}</span>
          </div>;
        })()}
      </div>}
    </div>
  </div>;
}
