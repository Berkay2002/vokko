// Per-channel message store: fetches pages over REST, applies gateway events, owns optimistic sends. Lives outside React;
// components subscribe with useChannelState().
import { useSyncExternalStore } from 'react';
import { ApiRequestError, RateLimitedError, SLOWMODE_CODE } from '../api/errors';
import { startCooldown } from './slowmode';
import { MessageFlags, MessageType } from '../api/types';
import { ReactionType } from '../api/types';
import { announceBurst } from '../perks/SuperReactions';
import type { CreateMessageRequest, EditMessageRequest, Message, MessageReactionEvent, PendingAttachmentMeta, ReactionEmoji, Snowflake, StickerItem, User } from '../api/types';
import { gateway, onSessionEnd, onUserChange, request, setLocalReadPointer } from './shell';
import {
  PAGE_SIZE, TYPING_TTL_MS, appendPage, applyReaction, deleteMessage, emojiKey, emptyState, indexOfId, prependPage, replaceWindow, setTyping,
  applyUserUpdate, normalizeMessage, trimOldest, updateIfPresent, upsertMessage, withLateArrivals, type ChannelState, type PendingMessage,
} from './messageState';
import { rememberMessage, rememberMessages } from './userCache';
import { pushRecentEmoji, recordEmojiUse, sameUnicodeEmoji } from './emojiData';
import { newNonce } from './util';
import { applyPollVote } from '../polls/pollState';
import { RULES_NOT_ACCEPTED, noteRulesRefused } from '../community';

const MAX_LOADED_CHANNELS = 12;

type Listener = () => void;
const states = new Map<Snowflake, ChannelState>();
const touched = new Map<Snowflake, number>();
const listeners = new Map<Snowflake, Set<Listener>>();
const AROUND_LIMIT = 30;
/** Nonces of sends cancelled while the POST was in flight: the created message is deleted again when the response arrives. */
const cancelled = new Set<string>();
/** Sends queued behind in-flight uploads, by nonce: calling the entry aborts those uploads (the card's cancel X). */
const waiting = new Map<string, () => void>();
const reactionChains =new Map<string, { tail: Promise<void>; pending: number; timer: ReturnType<typeof setTimeout> | null }>();
const reactionGuard = (messageId: Snowflake, emoji: ReactionEmoji, burst: boolean): string => `${messageId}:${emojiKey(emoji)}:${burst ? 1 : 0}`;
/** Channels the user marked unread by hand: the automatic ack stays off until they read it again on purpose, send, or leave. */
const heldUnread = new Set<Snowflake>();
/** Open lists (MessageList registers one): true while it follows the bottom and the user is not interacting with it. */
const following = new Map<Snowflake, () => boolean>();
/** Nobody looks at the channel, or its list follows the bottom untouched: trimming the top is invisible. */
const trimmable = (channelId: Snowflake): boolean => !listeners.get(channelId)?.size || !!following.get(channelId)?.();
let currentUserId: Snowflake | null = null;
let bound = false;

const EMPTY: ChannelState = emptyState();

function notify(channelId: Snowflake): void {
  listeners.get(channelId)?.forEach(l => l());
}

/** Drops everything the signed-in account left behind (history, unsent and failed sends, in-flight uploads) so the next
 *  account never sees it or retries it as its own. Listeners stay: mounted lists re-render empty. */
function reset(): void {
  waiting.forEach(abort => abort());
  waiting.clear();
  reactionChains.forEach(c => { if (c.timer) clearTimeout(c.timer); });
  reactionChains.clear();
  states.clear();
  touched.clear();
  cancelled.clear();
  heldUnread.clear();
  currentUserId = null;
  listeners.forEach((_, id) => notify(id));
}
onSessionEnd(reset);
let owner: Snowflake | null = null;
onUserChange(id => {
  if (owner && id && id !== owner) reset();
  if (id) owner = id;
});

function update(channelId: Snowflake, fn: (s: ChannelState) => ChannelState): void {
  const s = states.get(channelId);
  if (!s) return;
  const next = fn(s);
  if (next !== s) { states.set(channelId, next); notify(channelId); }
}

function evict(keep: Snowflake): void {
  if (states.size <= MAX_LOADED_CHANNELS) return;
  const victims = [...states.keys()].filter(id => id !== keep).sort((a, b) => (touched.get(a) ?? 0) - (touched.get(b) ?? 0));
  for (const id of victims.slice(0, states.size - MAX_LOADED_CHANNELS)) {
    if (listeners.get(id)?.size) continue;
    states.delete(id);
    touched.delete(id);
  }
}

function bindGateway(): void {
  if (bound) return;
  bound = true;
  gateway.on('MESSAGE_CREATE', m => {
    rememberMessage(m);
    update(m.channel_id, s => {
      const next = upsertMessage(s, m);
      return trimmable(m.channel_id) ? trimOldest(next) : next;
    });
  });
  gateway.on('MESSAGE_UPDATE', m => { rememberMessage(m); update(m.channel_id, s => updateIfPresent(s, m)); });
  gateway.on('MESSAGE_DELETE', d => update(d.channel_id, s => deleteMessage(s, d.id)));
  gateway.on('MESSAGE_DELETE_BULK', d => update(d.channel_id, s => d.ids.reduce((acc, id) => deleteMessage(acc, id), s)));
  // Our own reaction echoes are ignored while a local toggle for the same message+emoji is queued or just settled: the optimistic state wins.
  const onReaction = (add: boolean) => (d: MessageReactionEvent): void => {
    const byMe = d.user_id === currentUserId;
    const burst = d.type === ReactionType.Burst;
    if (byMe && reactionChains.has(reactionGuard(d.message_id, d.emoji, burst))) return;
    if (add && burst) announceBurst(d.message_id, emojiKey(d.emoji));
    update(d.channel_id, s => applyReaction(s, d.message_id, d.emoji, byMe, add, burst));
  };
  gateway.on('MESSAGE_REACTION_ADD', onReaction(true));
  gateway.on('MESSAGE_REACTION_REMOVE', onReaction(false));
  const onPollVote = (add: boolean) => (d: { channel_id: Snowflake; message_id: Snowflake; user_id: Snowflake; answer_id: number }): void =>
    update(d.channel_id, s => {
      const m = s.messages[indexOfId(s.messages, d.message_id)];
      return m ? updateIfPresent(s, applyPollVote(m, d.answer_id, add, d.user_id === currentUserId)) : s;
    });
  gateway.on('MESSAGE_POLL_VOTE_ADD', onPollVote(true));
  gateway.on('MESSAGE_POLL_VOTE_REMOVE', onPollVote(false));
  gateway.on('TYPING_START', d => {
    if (d.user_id === currentUserId) return;
    update(d.channel_id, s => setTyping(s, d.user_id, Date.now()));
    setTimeout(() => notify(d.channel_id), TYPING_TTL_MS + 50);
  });
  gateway.on('USER_UPDATE', user => { for (const id of states.keys()) update(id, s => applyUserUpdate(s, user)); });
  // A fresh READY means events may have been missed: refetch the latest page of every loaded channel.
  gateway.on('READY', () => {
    for (const [id, s] of states) if (s.status === 'ready') void refreshLatest(id);
  });
}

async function fetchPage(channelId: Snowflake, params: Record<string, string>): Promise<Message[]> {
  // The jump-to-message window is 30 (contract); paging is PAGE_SIZE.
  const q = new URLSearchParams({ limit: String('around' in params ? AROUND_LIMIT : PAGE_SIZE), ...params });
  const page = (await request<Message[]>('GET', `/channels/${channelId}/messages?${q}`)).map(normalizeMessage);
  rememberMessages(page);
  return page;
}

async function refreshLatest(channelId: Snowflake): Promise<void> {
  try {
    const page = await fetchPage(channelId, {});
    update(channelId, s => ({ ...replaceWindow(s, withLateArrivals(s, page), { hasMoreBefore: page.length >= PAGE_SIZE, hasMoreAfter: false }) }));
  } catch { /* the next open retries */ }
}

export interface SendInput { content: string; attachments?: Message['attachments']; meta?: PendingAttachmentMeta[]; reply?: Message | null; mention?: boolean; stickers?: StickerItem[]; tts?: boolean; flags?: number }
/** The part of a composer upload a queued send needs (see `Upload` in draftStore). */
export interface QueuedUpload {
  localId: string;
  file: File;
  abort: AbortController;
  done: Promise<Message['attachments'][number]>;
  filename?: string;
  description?: string;
}

function buildRequest(nonce: string, content: string, input: SendInput): CreateMessageRequest {
  const req: CreateMessageRequest = { content, nonce };
  if (input.meta?.length) req.attachments = input.meta;
  else if (input.attachments?.length) req.attachment_ids = input.attachments.map(a => a.id);
  if (input.stickers?.length) req.sticker_ids = input.stickers.map(s => s.id);
  if (input.tts) req.tts = true;
  if (input.flags) req.flags = input.flags;
  if (input.reply) req.message_reference = { message_id: input.reply.id };
  if (input.reply && input.mention === false) req.allowed_mentions = { replied_user: false };
  return req;
}

export const messageStore = {
  setCurrentUser(id: Snowflake | null): void { currentUserId = id; },

  /** The open list of `channelId` tells whether a trim is invisible right now (`null`: the list closed). */
  setFollowing(channelId: Snowflake, canTrim: (() => boolean) | null): void {
    if (canTrim) following.set(channelId, canTrim); else following.delete(channelId);
  },

  /** Ensure the channel has state and a loaded window. Safe to call repeatedly. */
  open(channelId: Snowflake, lastReadId: Snowflake | null): void {
    bindGateway();
    touched.set(channelId, Date.now());
    const existing = states.get(channelId);
    if (existing && existing.status !== 'error') {
      if (existing.lastReadAtOpen !== lastReadId) { states.set(channelId, { ...existing, lastReadAtOpen: lastReadId }); notify(channelId); }
      return;
    }
    states.set(channelId, emptyState(lastReadId));
    notify(channelId);
    evict(channelId);
    void (async () => {
      try {
        const page = await fetchPage(channelId, {});
        update(channelId, s => replaceWindow(s, withLateArrivals(s, page), { hasMoreBefore: page.length >= PAGE_SIZE, hasMoreAfter: false }));
      } catch {
        update(channelId, s => ({ ...s, status: 'error' }));
      }
    })();
  },

  retryLoad(channelId: Snowflake): void {
    const s = states.get(channelId);
    const read = s?.lastReadAtOpen ?? null;
    states.delete(channelId);
    this.open(channelId, read);
  },

  async loadOlder(channelId: Snowflake): Promise<void> {
    const s = states.get(channelId);
    const oldest = s?.messages[0];
    if (!s || !oldest || s.loadingOlder || !s.hasMoreBefore) return;
    update(channelId, x => ({ ...x, loadingOlder: true }));
    try {
      const page = await fetchPage(channelId, { before: oldest.id });
      update(channelId, x => prependPage(x, page));
    } catch {
      update(channelId, x => ({ ...x, loadingOlder: false }));
    }
  },

  async loadNewer(channelId: Snowflake): Promise<void> {
    const s = states.get(channelId);
    const newest = s?.messages[s.messages.length - 1];
    if (!s || !newest || s.loadingNewer || !s.hasMoreAfter) return;
    update(channelId, x => ({ ...x, loadingNewer: true }));
    try {
      const page = await fetchPage(channelId, { after: newest.id });
      update(channelId, x => appendPage(x, page));
    } catch {
      update(channelId, x => ({ ...x, loadingNewer: false }));
    }
  },

  async jumpToPresent(channelId: Snowflake): Promise<void> {
    const page = await fetchPage(channelId, {});
    update(channelId, s => {
      const next = replaceWindow(s, withLateArrivals(s, page), { hasMoreBefore: page.length >= PAGE_SIZE, hasMoreAfter: false });
      return { ...next, focus: null };
    });
  },

  /** Scroll target: in-window → just focus it; otherwise load a window around it. */
  async jumpToMessage(channelId: Snowflake, messageId: Snowflake): Promise<void> {
    const s = states.get(channelId);
    if (s && indexOfId(s.messages, messageId) >= 0) {
      update(channelId, x => ({ ...x, focus: { messageId, token: (x.focus?.token ?? 0) + 1 } }));
      return;
    }
    const page = await fetchPage(channelId, { around: messageId });
    update(channelId, x => replaceWindow(x, page, { hasMoreBefore: true, hasMoreAfter: true, focusId: messageId }));
  },

  clearFocus(channelId: Snowflake): void {
    update(channelId, s => (s.focus ? { ...s, focus: null } : s));
  },

  // ---- sending ----

  send(channelId: Snowflake, me: User, input: SendInput): void {
    const nonce = this.enqueue(channelId, me, input);
    void this.dispatchPending(channelId, nonce);
  },

  /**
   * Enter pressed while uploads are still in flight: the message is shown at once as pending ("Uploading N files") and posted when every
   * upload has settled. Uploads that failed are left out; nothing is posted when that leaves the message empty. Cancelling the pending
   * message (the card's X) aborts the uploads too.
   */
  sendAfterUploads(channelId: Snowflake, me: User, input: Omit<SendInput, 'attachments' | 'meta'> & { uploads: QueuedUpload[] }): void {
    const { uploads, ...rest } = input;
    const placeholders: Message['attachments'] = uploads.map(u => ({ id: u.localId, filename: u.filename ?? u.file.name, content_type: u.file.type || null, size: u.file.size, url: '', width: null, height: null }));
    const nonce = this.enqueue(channelId, me, { ...rest, attachments: placeholders });
    waiting.set(nonce, () => uploads.forEach(u => u.abort.abort()));
    void Promise.allSettled(uploads.map(u => u.done)).then(results => {
      waiting.delete(nonce);
      if (!states.get(channelId)?.pending.some(p => p.nonce === nonce)) return; // cancelled meanwhile
      const ready = uploads.flatMap((u, i) => {
        const r = results[i];
        return r?.status === 'fulfilled' ? [{ u, attachment: r.value }] : [];
      });
      if (rest.content.trim() === '' && ready.length === 0) { update(channelId, s => ({ ...s, pending: s.pending.filter(p => p.nonce !== nonce) })); return; }
      const attachments = ready.map(({ u, attachment }) => ({
        ...attachment,
        ...(u.filename !== undefined ? { filename: u.filename } : {}),
        ...(u.description !== undefined ? { description: u.description || null } : {}),
      }));
      const meta = ready.some(({ u }) => u.filename !== undefined || u.description !== undefined)
        ? ready.map(({ u, attachment }) => ({
          id: attachment.id,
          ...(u.filename !== undefined ? { filename: u.filename } : {}),
          ...(u.description !== undefined ? { description: u.description } : {}),
        }))
        : undefined;
      const req = buildRequest(nonce, rest.content.trim(), { ...rest, attachments, meta });
      update(channelId, s => ({
        ...s,
        pending: s.pending.map(p => (p.nonce === nonce ? { ...p, request: req, message: { ...p.message, attachments } } : p)),
      }));
      void this.dispatchPending(channelId, nonce);
    });
  },

  /** Adds the optimistic message to the channel (state 'sending', not yet dispatched) and returns its nonce. */
  enqueue(channelId: Snowflake, me: User, input: SendInput): string {
    const nonce = newNonce();
    const content = input.content.trim();
    recordEmojiUse(content); // Frequently Used counts emoji in sent messages
    const req = buildRequest(nonce, content, input);
    const message: Message = {
      id: `pending:${nonce}`, channel_id: channelId, guild_id: input.reply?.guild_id ?? null, author: me, content, timestamp: new Date().toISOString(), edited_timestamp: null,
      type: input.reply ? MessageType.Reply : MessageType.Default, mentions: input.reply && input.mention !== false ? [input.reply.author] : [], mention_roles: [], mention_everyone: false,
      attachments: input.attachments ?? [], embeds: [], reactions: [], pinned: false, tts: input.tts === true,
      message_reference: input.reply ? { message_id: input.reply.id, channel_id: channelId, guild_id: input.reply.guild_id } : null,
      referenced_message: input.reply ?? null, nonce,
      ...(input.stickers?.length ? { sticker_items: input.stickers } : {}),
      ...(input.flags ? { flags: input.flags } : {}),
    };
    // Sending is an ack of everything above: the new-messages divider and the unread banner go away at once.
    update(channelId, s => ({ ...s, lastReadAtOpen: null, markedUnread: false, pending: [...s.pending, { nonce, message, state: 'sending', request: req }] }));
    return nonce;
  },

  async dispatchPending(channelId: Snowflake, nonce: string): Promise<void> {
    const p = states.get(channelId)?.pending.find(x => x.nonce === nonce);
    if (!p) return;
    update(channelId, s => ({ ...s, pending: s.pending.map(x => (x.nonce === nonce ? { ...x, state: 'sending', error: undefined, errorCode: undefined } : x)) }));
    try {
      const m = await request<Message>('POST', `/channels/${channelId}/messages`, p.request);
      if (cancelled.delete(nonce)) { // cancelled while in flight: the server has it already, so take it back
        void request<null>('DELETE', `/channels/${channelId}/messages/${m.id}`).catch(() => undefined);
        return;
      }
      update(channelId, s => upsertMessage(s, m));
      this.ack(channelId, m.id);
    } catch (e) {
      const error = e instanceof Error ? e.message : 'Failed to send';
      const errorCode = e instanceof ApiRequestError ? e.code : undefined;
      if (e instanceof RateLimitedError && e.code === SLOWMODE_CODE) startCooldown(channelId, e.retryAfter * 1000);
      if (errorCode === RULES_NOT_ACCEPTED) noteRulesRefused(channelId); // the composer turns into the rules bar
      update(channelId, s => ({ ...s, pending: s.pending.map(x => (x.nonce === nonce ? { ...x, state: 'failed', error, errorCode } : x)) }));
    }
  },

  retry(channelId: Snowflake, nonce: string): void { void this.dispatchPending(channelId, nonce); },

  discardPending(channelId: Snowflake, nonce: string): void {
    const inFlight = states.get(channelId)?.pending.find(p => p.nonce === nonce)?.state === 'sending';
    if (inFlight && !waiting.has(nonce)) cancelled.add(nonce);
    waiting.get(nonce)?.();
    waiting.delete(nonce);
    update(channelId, s => ({ ...s, pending: s.pending.filter(p => p.nonce !== nonce) }));
  },

  // ---- message actions ----

  async edit(channelId: Snowflake, messageId: Snowflake, content: string): Promise<void> {
    const body: EditMessageRequest = { content };
    const m = await request<Message>('PATCH', `/channels/${channelId}/messages/${messageId}`, body);
    update(channelId, s => updateIfPresent(s, m));
  },

  /** Switches off the message's link previews: the server keeps just the SUPPRESS_EMBEDS bit and drops the cards. */
  async suppressEmbeds(channelId: Snowflake, message: Message): Promise<void> {
    const body: EditMessageRequest = { flags: (message.flags ?? 0) | MessageFlags.SuppressEmbeds };
    const m = await request<Message>('PATCH', `/channels/${channelId}/messages/${message.id}`, body);
    update(channelId, s => updateIfPresent(s, m));
  },

  async remove(channelId: Snowflake, messageId: Snowflake): Promise<void> {
    await request<null>('DELETE', `/channels/${channelId}/messages/${messageId}`);
    update(channelId, s => deleteMessage(s, messageId));
  },

  /** Toggles the viewer's normal reaction, or with `burst` their super reaction (`?type=1`). */
  async toggleReaction(channelId: Snowflake, messageId: Snowflake, emoji: ReactionEmoji, burst = false): Promise<void> {
    const s = states.get(channelId);
    const m = s?.messages[s ? indexOfId(s.messages, messageId) : -1];
    if (!m) return;
    // 👍 and 👍️ (with U+FE0F) are one emoji: react with the spelling already on the message, so both land on the same pill.
    if (!emoji.id) emoji = m.reactions.find(r => !r.emoji.id && sameUnicodeEmoji(r.emoji.name, emoji.name))?.emoji ?? emoji;
    const key = emojiKey(emoji);
    const guard = reactionGuard(messageId, emoji, burst);
    // Rapid toggles are applied optimistically right away and sent in order, one request at a time per message+emoji.
    const chain = reactionChains.get(guard) ?? { tail: Promise.resolve(), pending: 0, timer: null };
    if (chain.timer) { clearTimeout(chain.timer); chain.timer = null; }
    chain.pending++;
    reactionChains.set(guard, chain);
    const current = m.reactions.find(r => emojiKey(r.emoji) === key);
    const had = (burst ? current?.me_burst : current?.me) ?? false;
    if (burst && !had) announceBurst(messageId, key);
    if (!had) pushRecentEmoji(emoji.id ? `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>` : emoji.name); // every reaction added counts as use, quick and custom ones included
    update(channelId, x => applyReaction(x, messageId, emoji, true, !had, burst));
    const run = chain.tail.then(async () => {
      try {
        await request<null>(had ? 'DELETE' : 'PUT', `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(key)}/@me${burst ? '?type=1' : ''}`);
      } catch {
        update(channelId, x => applyReaction(x, messageId, emoji, true, had, burst));
      }
    });
    chain.tail = run;
    await run;
    // Keep suppressing our own gateway echoes briefly after the last request settles.
    if (--chain.pending === 0) chain.timer = setTimeout(() => reactionChains.delete(guard), 1500);
  },

  async setPinned(channelId: Snowflake, messageId: Snowflake, pinned: boolean): Promise<void> {
    await request<null>(pinned ? 'PUT' : 'DELETE', `/channels/${channelId}/messages/pins/${messageId}`);
    update(channelId, s => {
      const i = indexOfId(s.messages, messageId);
      const m = s.messages[i];
      return m ? updateIfPresent(s, { ...m, pinned }) : s;
    });
  },

  /** Automatic ack (viewing the present). Does nothing while the channel is held unread. */
  ack(channelId: Snowflake, messageId: Snowflake): void {
    if (heldUnread.has(channelId)) return;
    void request<null>('POST', `/channels/${channelId}/messages/${messageId}/ack`).catch(() => undefined);
  },

  /** Remove one attachment from a sent message (PATCH with the ones to keep); the last one of a text-less message deletes the message. */
  async removeAttachment(channelId: Snowflake, message: Message, attachmentId: Snowflake): Promise<void> {
    const keep = message.attachments.filter(a => a.id !== attachmentId);
    if (keep.length === 0 && message.content.trim() === '') { await this.remove(channelId, message.id); return; }
    const body: EditMessageRequest = { attachments: keep.map(a => ({ id: a.id })) };
    const m = await request<Message>('PATCH', `/channels/${channelId}/messages/${message.id}`, body);
    update(channelId, s => updateIfPresent(s, m));
  },

  /** A deliberate "mark as read" (Escape, the unread bar): releases the hold, then acks. */
  markRead(channelId: Snowflake, messageId: Snowflake): void {
    heldUnread.delete(channelId);
    update(channelId, s => (s.markedUnread ? { ...s, markedUnread: false } : s));
    this.ack(channelId, messageId);
  },

  /** Mark Unread (client only, no server contract): everything from this message on becomes unread and the auto-ack is held. */
  markUnread(channelId: Snowflake, messageId: Snowflake): void {
    let before: Snowflake;
    try { before = (BigInt(messageId) - 1n).toString(); } catch { return; }
    heldUnread.add(channelId);
    setLocalReadPointer(channelId, before);
    update(channelId, s => ({ ...s, lastReadAtOpen: before, markedUnread: true }));
  },

  /**
   * Sending a message or leaving the channel ends a manual "unread" hold and the banner that goes with it. The new-messages divider
   * (lastReadAtOpen) stays for the rest of the visit and is recomputed from the acked pointer at the next open.
   */
  releaseHold(channelId: Snowflake): void {
    heldUnread.delete(channelId);
    update(channelId, s => (s.markedUnread ? { ...s, markedUnread: false } : s));
  },

  getState(channelId: Snowflake): ChannelState { return states.get(channelId) ?? EMPTY; },

  subscribe(channelId: Snowflake, cb: Listener): () => void {
    let set = listeners.get(channelId);
    if (!set) { set = new Set(); listeners.set(channelId, set); }
    const target = set;
    target.add(cb);
    return () => { target.delete(cb); };
  },

  /** Startup cache (cache/startupCache.ts): a channel's saved newest page, shown before READY; READY refetches it like any loaded channel. */
  seed(channelId: Snowflake, page: Message[]): void {
    bindGateway();
    if (states.has(channelId)) return;
    const messages = page.map(normalizeMessage);
    rememberMessages(messages);
    states.set(channelId, replaceWindow(emptyState(), messages, { hasMoreBefore: messages.length >= PAGE_SIZE, hasMoreAfter: false }));
    touched.set(channelId, Date.now());
  },
};

export function useChannelState(channelId: Snowflake): ChannelState {
  return useSyncExternalStore(cb => messageStore.subscribe(channelId, cb), () => states.get(channelId) ?? EMPTY);
}

export type { ChannelState, PendingMessage };
