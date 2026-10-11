// Per-channel message store: fetches pages over REST, applies gateway events, owns optimistic sends. Lives outside React;
// components subscribe with useChannelState().
import { useSyncExternalStore } from 'react';
import { MessageType } from '../api/types';
import type { CreateMessageRequest, EditMessageRequest, Message, ReactionEmoji, Snowflake, User } from '../api/types';
import { gateway, request } from './shell';
import {
  PAGE_SIZE, TYPING_TTL_MS, appendPage, applyReaction, deleteMessage, emojiKey, emptyState, indexOfId, prependPage, replaceWindow, setTyping,
  applyUserUpdate, updateIfPresent, upsertMessage, type ChannelState, type PendingMessage,
} from './messageState';
import { rememberMessage, rememberMessages } from './userCache';
import { newNonce } from './util';

const MAX_LOADED_CHANNELS = 12;

type Listener = () => void;
const states = new Map<Snowflake, ChannelState>();
const touched = new Map<Snowflake, number>();
const listeners = new Map<Snowflake, Set<Listener>>();
const reactionChains = new Map<string, { tail: Promise<void>; pending: number; timer: ReturnType<typeof setTimeout> | null }>();
const reactionGuard = (messageId: Snowflake, emoji: ReactionEmoji): string => `${messageId}:${emojiKey(emoji)}`;
let currentUserId: Snowflake | null = null;
let bound = false;

const EMPTY: ChannelState = emptyState();

function notify(channelId: Snowflake): void {
  listeners.get(channelId)?.forEach(l => l());
}

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
  gateway.on('MESSAGE_CREATE', m => { rememberMessage(m); update(m.channel_id, s => upsertMessage(s, m)); });
  gateway.on('MESSAGE_UPDATE', m => { rememberMessage(m); update(m.channel_id, s => updateIfPresent(s, m)); });
  gateway.on('MESSAGE_DELETE', d => update(d.channel_id, s => deleteMessage(s, d.id)));
  // Our own reaction echoes are ignored while a local toggle for the same message+emoji is queued or just settled: the optimistic state wins.
  const onReaction = (add: boolean) => (d: { channel_id: Snowflake; message_id: Snowflake; user_id: Snowflake; emoji: ReactionEmoji }): void => {
    const byMe = d.user_id === currentUserId;
    if (byMe && reactionChains.has(reactionGuard(d.message_id, d.emoji))) return;
    update(d.channel_id, s => applyReaction(s, d.message_id, d.emoji, byMe, add));
  };
  gateway.on('MESSAGE_REACTION_ADD', onReaction(true));
  gateway.on('MESSAGE_REACTION_REMOVE', onReaction(false));
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
  const q = new URLSearchParams({ limit: String(PAGE_SIZE), ...params });
  const page = await request<Message[]>('GET', `/channels/${channelId}/messages?${q}`);
  rememberMessages(page);
  return page;
}

async function refreshLatest(channelId: Snowflake): Promise<void> {
  try {
    const page = await fetchPage(channelId, {});
    update(channelId, s => ({ ...replaceWindow(s, page, { hasMoreBefore: page.length >= PAGE_SIZE, hasMoreAfter: false }) }));
  } catch { /* the next open retries */ }
}

export const messageStore = {
  setCurrentUser(id: Snowflake | null): void { currentUserId = id; },

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
        update(channelId, s => replaceWindow(s, page, { hasMoreBefore: page.length >= PAGE_SIZE, hasMoreAfter: false }));
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
      const next = replaceWindow(s, page, { hasMoreBefore: page.length >= PAGE_SIZE, hasMoreAfter: false });
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

  send(channelId: Snowflake, me: User, input: { content: string; attachments?: Message['attachments']; reply?: Message | null; mention?: boolean }): void {
    const nonce = newNonce();
    const content = input.content.trim();
    const req: CreateMessageRequest = { content, nonce };
    if (input.attachments?.length) req.attachment_ids = input.attachments.map(a => a.id);
    if (input.reply) req.message_reference = { message_id: input.reply.id };
    const message: Message = {
      id: `pending:${nonce}`, channel_id: channelId, guild_id: input.reply?.guild_id ?? null, author: me, content, timestamp: new Date().toISOString(), edited_timestamp: null,
      type: input.reply ? MessageType.Reply : MessageType.Default, mentions: input.reply && input.mention !== false ? [input.reply.author] : [], mention_everyone: false,
      attachments: input.attachments ?? [], reactions: [], pinned: false,
      message_reference: input.reply ? { message_id: input.reply.id, channel_id: channelId, guild_id: input.reply.guild_id } : null,
      referenced_message: input.reply ?? null, nonce,
    };
    update(channelId, s => ({ ...s, pending: [...s.pending, { nonce, message, state: 'sending', request: req }] }));
    void this.dispatchPending(channelId, nonce);
  },

  async dispatchPending(channelId: Snowflake, nonce: string): Promise<void> {
    const p = states.get(channelId)?.pending.find(x => x.nonce === nonce);
    if (!p) return;
    update(channelId, s => ({ ...s, pending: s.pending.map(x => (x.nonce === nonce ? { ...x, state: 'sending', error: undefined } : x)) }));
    try {
      // `mention_replied_user` is not in the v1 contract yet (proposed to the orchestrator); servers that don't know it ignore it.
      const body: CreateMessageRequest & { mention_replied_user?: boolean } = { ...p.request };
      if (p.message.type === MessageType.Reply && p.message.mentions.length === 0) body.mention_replied_user = false;
      const m = await request<Message>('POST', `/channels/${channelId}/messages`, body);
      update(channelId, s => upsertMessage(s, m));
    } catch (e) {
      const error = e instanceof Error ? e.message : 'Failed to send';
      update(channelId, s => ({ ...s, pending: s.pending.map(x => (x.nonce === nonce ? { ...x, state: 'failed', error } : x)) }));
    }
  },

  retry(channelId: Snowflake, nonce: string): void { void this.dispatchPending(channelId, nonce); },

  discardPending(channelId: Snowflake, nonce: string): void {
    update(channelId, s => ({ ...s, pending: s.pending.filter(p => p.nonce !== nonce) }));
  },

  // ---- message actions ----

  async edit(channelId: Snowflake, messageId: Snowflake, content: string): Promise<void> {
    const body: EditMessageRequest = { content };
    const m = await request<Message>('PATCH', `/channels/${channelId}/messages/${messageId}`, body);
    update(channelId, s => updateIfPresent(s, m));
  },

  async remove(channelId: Snowflake, messageId: Snowflake): Promise<void> {
    await request<null>('DELETE', `/channels/${channelId}/messages/${messageId}`);
    update(channelId, s => deleteMessage(s, messageId));
  },

  async toggleReaction(channelId: Snowflake, messageId: Snowflake, emoji: ReactionEmoji): Promise<void> {
    const s = states.get(channelId);
    const m = s?.messages[s ? indexOfId(s.messages, messageId) : -1];
    if (!m) return;
    const key = emojiKey(emoji);
    const guard = reactionGuard(messageId, emoji);
    // Rapid toggles are applied optimistically right away and sent in order, one request at a time per message+emoji.
    const chain = reactionChains.get(guard) ?? { tail: Promise.resolve(), pending: 0, timer: null };
    if (chain.timer) { clearTimeout(chain.timer); chain.timer = null; }
    chain.pending++;
    reactionChains.set(guard, chain);
    const had = m.reactions.find(r => emojiKey(r.emoji) === key)?.me ?? false;
    update(channelId, x => applyReaction(x, messageId, emoji, true, !had));
    const run = chain.tail.then(async () => {
      try {
        await request<null>(had ? 'DELETE' : 'PUT', `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(key)}/@me`);
      } catch {
        update(channelId, x => applyReaction(x, messageId, emoji, true, had));
      }
    });
    chain.tail = run;
    await run;
    // Keep suppressing our own gateway echoes briefly after the last request settles.
    if (--chain.pending === 0) chain.timer = setTimeout(() => reactionChains.delete(guard), 1500);
  },

  async setPinned(channelId: Snowflake, messageId: Snowflake, pinned: boolean): Promise<void> {
    await request<null>(pinned ? 'PUT' : 'DELETE', `/channels/${channelId}/pins/${messageId}`);
    update(channelId, s => {
      const i = indexOfId(s.messages, messageId);
      const m = s.messages[i];
      return m ? updateIfPresent(s, { ...m, pinned }) : s;
    });
  },

  ack(channelId: Snowflake, messageId: Snowflake): void {
    void request<null>('POST', `/channels/${channelId}/messages/${messageId}/ack`).catch(() => undefined);
  },

  getState(channelId: Snowflake): ChannelState { return states.get(channelId) ?? EMPTY; },
};

export function useChannelState(channelId: Snowflake): ChannelState {
  return useSyncExternalStore(
    cb => {
      let set = listeners.get(channelId);
      if (!set) { set = new Set(); listeners.set(channelId, set); }
      const target = set;
      target.add(cb);
      return () => { target.delete(cb); };
    },
    () => states.get(channelId) ?? EMPTY,
  );
}

export type { ChannelState, PendingMessage };
