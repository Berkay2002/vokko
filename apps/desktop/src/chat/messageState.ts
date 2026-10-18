// Pure state transitions for one channel's message window. No React, no I/O: unit-tested in messageState.test.ts.
import { MessageType } from '../api/types';
import type { CreateMessageRequest, Message, Reaction, ReactionEmoji, Snowflake, User } from '../api/types';
import { compareIds } from './util';

export interface PendingMessage {
  nonce: string;
  message: Message;
  state: 'sending' | 'failed';
  error?: string;
  /** API error code of the failed send (e.g. 50007: the recipient does not accept DMs from you). */
  errorCode?: number;
  request: CreateMessageRequest;
}

export interface ChannelState {
  /** Server messages, ascending by id. */
  messages: Message[];
  /** Optimistic sends, in send order; always rendered after `messages`. */
  pending: PendingMessage[];
  status: 'loading' | 'ready' | 'error';
  hasMoreBefore: boolean;
  /** True while the window is not anchored at the present (viewing older messages). */
  hasMoreAfter: boolean;
  loadingOlder: boolean;
  loadingNewer: boolean;
  /** Virtuoso `firstItemIndex`: decremented by the number of messages prepended. */
  firstItemIndex: number;
  /** Bumped whenever the window is replaced wholesale, so the list can remount. */
  windowId: number;
  /** Message to scroll to and flash after a jump, with a changing token so repeated jumps re-fire. */
  focus: { messageId: Snowflake; token: number } | null;
  /** Read pointer captured when the channel was opened; drives the "new messages" divider. */
  lastReadAtOpen: Snowflake | null;
  /** Set by "Mark Unread": the unread bar shows even though the list is at the bottom, until marked read. */
  markedUnread?: boolean;
  /** user id → client-side expiry (ms epoch). */
  typing: Record<Snowflake, number>;
}

export const PAGE_SIZE = 50;
export const FIRST_INDEX = 1_000_000;
export const TYPING_TTL_MS = 10_000;

export function emptyState(lastReadAtOpen: Snowflake | null = null): ChannelState {
  return {
    messages: [], pending: [], status: 'loading', hasMoreBefore: false, hasMoreAfter: false, loadingOlder: false, loadingNewer: false,
    firstItemIndex: FIRST_INDEX, windowId: 0, focus: null, lastReadAtOpen, typing: {},
  };
}

/** Index of the first message with id >= `id` (binary search), `messages.length` if none. */
export function lowerBound(messages: Message[], id: Snowflake): number {
  let lo = 0, hi = messages.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareIds(messages[mid]!.id, id) < 0) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export function indexOfId(messages: Message[], id: Snowflake): number {
  const i = lowerBound(messages, id);
  return messages[i]?.id === id ? i : -1;
}

/** A live window (a call chat left open for hours) is cut back to its newest LIVE_KEEP messages once it holds more than LIVE_MAX. */
export const LIVE_MAX = 300;
export const LIVE_KEEP = 200;

/**
 * Drops the oldest messages of a window anchored at the present; scrolling up loads them again (`hasMoreBefore`). Not while an
 * older page is in flight (it would land above the cut and leave a gap) or a jump is pending (its target could be cut away).
 */
export function trimOldest(s: ChannelState, max = LIVE_MAX, keep = LIVE_KEEP): ChannelState {
  if (s.hasMoreAfter || s.loadingOlder || s.focus || s.messages.length <= max) return s;
  const drop = s.messages.length - keep;
  // A new window (the list remounts at the bottom): Virtuoso stops following the output when rows leave from the top.
  return { ...s, messages: s.messages.slice(drop), hasMoreBefore: true, firstItemIndex: FIRST_INDEX, windowId: s.windowId + 1 };
}

/** Replace the whole window with `page` (any order). */
export function replaceWindow(s: ChannelState, page: Message[], opts: { hasMoreBefore: boolean; hasMoreAfter: boolean; focusId?: Snowflake }): ChannelState {
  const sorted = [...page].sort((a, b) => compareIds(a.id, b.id));
  const dedup = sorted.filter((m, i) => i === 0 || m.id !== sorted[i - 1]!.id);
  return {
    ...s,
    messages: dedup,
    status: 'ready',
    hasMoreBefore: opts.hasMoreBefore,
    hasMoreAfter: opts.hasMoreAfter,
    loadingOlder: false,
    loadingNewer: false,
    firstItemIndex: FIRST_INDEX,
    windowId: s.windowId + 1,
    focus: opts.focusId ? { messageId: opts.focusId, token: s.windowId + 1 } : null,
    pending: dedup.length ? s.pending.filter(p => !dedup.some(m => m.nonce && m.nonce === p.nonce)) : s.pending,
  };
}

/**
 * `page` is a fetch of the latest messages. Anything the gateway delivered while the request was in flight and that is newer
 * than the whole page would be dropped by replaceWindow, so carry it over.
 */
export function withLateArrivals(s: ChannelState, page: Message[]): Message[] {
  let newest: Snowflake | null = null;
  for (const m of page) if (!newest || compareIds(m.id, newest) > 0) newest = m.id;
  const late = s.messages.filter(m => !newest || compareIds(m.id, newest) > 0);
  return late.length ? [...page, ...late] : page;
}

export function prependPage(s: ChannelState, page: Message[], limit = PAGE_SIZE): ChannelState {
  const oldest = s.messages[0]?.id;
  const fresh = page.filter(m => !oldest || compareIds(m.id, oldest) < 0).sort((a, b) => compareIds(a.id, b.id));
  const dedup = fresh.filter((m, i) => i === 0 || m.id !== fresh[i - 1]!.id);
  return { ...s, messages: [...dedup, ...s.messages], hasMoreBefore: page.length >= limit, loadingOlder: false, firstItemIndex: s.firstItemIndex - dedup.length };
}

export function appendPage(s: ChannelState, page: Message[], limit = PAGE_SIZE): ChannelState {
  const newest = s.messages[s.messages.length - 1]?.id;
  const fresh = page.filter(m => !newest || compareIds(m.id, newest) > 0).sort((a, b) => compareIds(a.id, b.id));
  const dedup = fresh.filter((m, i) => i === 0 || m.id !== fresh[i - 1]!.id);
  return {
    ...s,
    messages: [...s.messages, ...dedup],
    hasMoreAfter: page.length >= limit,
    loadingNewer: false,
    pending: s.pending.filter(p => !dedup.some(m => m.nonce && m.nonce === p.nonce)),
  };
}

/** A reaction from a server without super reactions (no `count_details` / `me_burst`) reads as normal reactions only. */
export function normalizeReaction(r: Reaction): Reaction {
  if (r.count_details && r.burst_colors && typeof r.me_burst === 'boolean') return r;
  return { ...r, count_details: r.count_details ?? { normal: r.count, burst: 0 }, burst_colors: r.burst_colors ?? [], me_burst: r.me_burst ?? false };
}

/** Fills in what an older server leaves out, where messages enter the store (pages, gateway, REST responses). */
export function normalizeMessage(m: Message): Message {
  const reactions = m.reactions ?? [];
  return reactions.every(r => r === normalizeReaction(r)) && m.reactions ? m : { ...m, reactions: reactions.map(normalizeReaction) };
}

/** Insert or update a server message (REST response or MESSAGE_CREATE/UPDATE). Idempotent; resolves pending sends by nonce. */
export function upsertMessage(s: ChannelState, raw: Message): ChannelState {
  const m = normalizeMessage(raw);
  const pending = m.nonce ? s.pending.filter(p => p.nonce !== m.nonce) : s.pending;
  const i = indexOfId(s.messages, m.id);
  if (i >= 0) {
    const messages = s.messages.slice();
    messages[i] = m;
    return { ...s, messages, pending, typing: clearTyping(s.typing, m.author.id) };
  }
  if (s.hasMoreAfter) {
    // Viewing an older window: inserting at the tail would create a gap. Loading newer pages will pick it up.
    return pending === s.pending ? s : { ...s, pending };
  }
  const at = lowerBound(s.messages, m.id);
  const messages = s.messages.slice();
  messages.splice(at, 0, m);
  return { ...s, messages, pending, typing: clearTyping(s.typing, m.author.id) };
}

/** Apply an update only if the message is currently loaded (never inserts). */
export function updateIfPresent(s: ChannelState, raw: Message): ChannelState {
  const m = normalizeMessage(raw);
  const i = indexOfId(s.messages, m.id);
  if (i < 0) return s;
  const messages = s.messages.slice();
  messages[i] = m;
  return { ...s, messages };
}

export function deleteMessage(s: ChannelState, id: Snowflake): ChannelState {
  const i = indexOfId(s.messages, id);
  if (i < 0) return s;
  const messages = s.messages.slice();
  messages.splice(i, 1);
  for (let j = 0; j < messages.length; j++) {
    const m = messages[j]!;
    if (m.message_reference?.message_id === id && m.referenced_message) messages[j] = { ...m, referenced_message: null };
  }
  // Removing the head shifts every following item's virtual index.
  return { ...s, messages, firstItemIndex: i === 0 ? s.firstItemIndex + 1 : s.firstItemIndex };
}

export const emojiKey = (e: ReactionEmoji): string => (e.id ? `${e.name}:${e.id}` : e.name);

/** Adds or removes one normal or burst (super) reaction; normal and burst reactions of an emoji share one `Reaction` entry. */
export function applyReaction(s: ChannelState, messageId: Snowflake, emoji: ReactionEmoji, byMe: boolean, add: boolean, burst = false): ChannelState {
  const i = indexOfId(s.messages, messageId);
  if (i < 0) return s;
  const m = s.messages[i]!;
  const key = emojiKey(emoji);
  const ri = m.reactions.findIndex(r => emojiKey(r.emoji) === key);
  const kind = burst ? 'burst' : 'normal';
  const mine = (r: Reaction): boolean => (burst ? r.me_burst : r.me);
  let reactions = m.reactions;
  if (add) {
    if (ri < 0) {
      const fresh: Reaction = { emoji, count: 1, count_details: { normal: burst ? 0 : 1, burst: burst ? 1 : 0 }, burst_colors: [], me: byMe && !burst, me_burst: byMe && burst };
      reactions = [...m.reactions, fresh];
    } else {
      const r = m.reactions[ri]!;
      if (byMe && mine(r)) return s; // optimistic toggle already applied; the gateway echo is a no-op
      const next: Reaction = { ...r, count: r.count + 1, count_details: { ...r.count_details, [kind]: r.count_details[kind] + 1 } };
      if (byMe) { if (burst) next.me_burst = true; else next.me = true; }
      reactions = m.reactions.map((x, k) => (k === ri ? next : x));
    }
  } else {
    if (ri < 0) return s;
    const r = m.reactions[ri]!;
    if (byMe && !mine(r)) return s;
    if (r.count_details[kind] <= 0) return s;
    const next: Reaction = { ...r, count: r.count - 1, count_details: { ...r.count_details, [kind]: r.count_details[kind] - 1 } };
    if (byMe) { if (burst) next.me_burst = false; else next.me = false; }
    reactions = next.count <= 0 ? m.reactions.filter((_, k) => k !== ri) : m.reactions.map((x, k) => (k === ri ? next : x));
  }
  const messages = s.messages.slice();
  messages[i] = { ...m, reactions };
  return { ...s, messages };
}

/** Refresh a user's profile everywhere it is embedded in loaded messages (author, mentions, reply targets). */
export function applyUserUpdate(s: ChannelState, user: User): ChannelState {
  const touches = (m: Message): boolean =>
    m.author.id === user.id || m.mentions.some(u => u.id === user.id) || m.referenced_message?.author.id === user.id;
  if (!s.messages.some(touches) && !s.pending.some(p => p.message.author.id === user.id)) return s;
  const fix = (m: Message): Message => (!touches(m) ? m : {
    ...m,
    author: m.author.id === user.id ? user : m.author,
    mentions: m.mentions.map(u => (u.id === user.id ? user : u)),
    referenced_message: m.referenced_message && m.referenced_message.author.id === user.id ? { ...m.referenced_message, author: user } : m.referenced_message,
  });
  return {
    ...s,
    messages: s.messages.map(fix),
    pending: s.pending.map(p => (p.message.author.id === user.id ? { ...p, message: fix(p.message) } : p)),
  };
}

export function setTyping(s: ChannelState, userId: Snowflake, now: number): ChannelState {
  return { ...s, typing: { ...s.typing, [userId]: now + TYPING_TTL_MS } };
}
function clearTyping(t: Record<Snowflake, number>, userId: Snowflake): Record<Snowflake, number> {
  if (!(userId in t)) return t;
  const { [userId]: _gone, ...rest } = t;
  return rest;
}
export function activeTypers(s: ChannelState, now: number, exclude?: Snowflake | null): Snowflake[] {
  return Object.entries(s.typing).filter(([id, exp]) => exp > now && id !== exclude).map(([id]) => id);
}

// ---- Row model ----

export interface Row {
  key: string;
  message: Message;
  pending: PendingMessage | null;
  /** Continues the previous row's author group: no avatar/name header. */
  grouped: boolean;
  /** Full-width day divider rendered above this row. */
  dayLabel: string | null;
  /** "New" divider rendered above this row. */
  unreadDivider: boolean;
}

export const GROUP_WINDOW_MS = 7 * 60 * 1000;

const SYSTEM_TYPES = new Set<number>([MessageType.RecipientAdd, MessageType.RecipientRemove, MessageType.ChannelNameChange, MessageType.ChannelPinnedMessage, MessageType.UserJoin, MessageType.ThreadCreated, MessageType.Call, MessageType.PollResult, MessageType.AutoModerationAction]);
export const isSystemMessage = (m: Message): boolean => SYSTEM_TYPES.has(m.type);

/**
 * True when the raw content has an `<@&id>` mention of one of `roleIds`. The row highlight reads the content, the unread counter uses `mention_roles`
 * (the mention-of-me row highlight uses this for the viewer's own roles).
 */
export function mentionsRole(content: string, roleIds: readonly Snowflake[]): boolean {
  if (roleIds.length === 0) return false;
  // Code spans, code blocks and escaped mentions render as plain text, so they do not ping.
  const live = content.replace(/```[\s\S]*?```|``[\s\S]*?``|`[^`\n]*`/g, '');
  for (const m of live.matchAll(/(?<!\\)<@&(\d+)>/g)) if (roleIds.includes(m[1]!)) return true;
  return false;
}

export function buildRows(s: Pick<ChannelState, 'messages' | 'pending' | 'hasMoreAfter' | 'lastReadAtOpen'>, formatDay: (d: Date) => string, sameDay: (a: Date, b: Date) => boolean, myId: Snowflake | null): Row[] {
  const rows: Row[] = [];
  const all: { m: Message; p: PendingMessage | null }[] = s.messages.map(m => ({ m, p: null }));
  if (!s.hasMoreAfter) for (const p of s.pending) all.push({ m: p.message, p });
  let prev: Message | null = null;
  let prevDate: Date | null = null;
  let groupStartMs = 0;
  let dividerPlaced = false;
  for (const { m, p } of all) {
    const d = new Date(m.timestamp);
    const newDay = !prevDate || !sameDay(prevDate, d);
    let unread = false;
    if (!dividerPlaced && !p && s.lastReadAtOpen && compareIds(m.id, s.lastReadAtOpen) > 0 && prev && compareIds(prev.id, s.lastReadAtOpen) <= 0 && m.author.id !== myId) {
      unread = true;
      dividerPlaced = true;
    }
    const grouped = !!prev && !newDay && !unread &&
      !isSystemMessage(m) && !isSystemMessage(prev) &&
      m.type !== MessageType.ThreadStarterMessage && prev.type !== MessageType.ThreadStarterMessage && // a thread's starter stands on its own
      prev.author.id === m.author.id && m.type !== MessageType.Reply && !m.interaction_metadata && // a command response shows who used it
      d.getTime() - groupStartMs < GROUP_WINDOW_MS; // measured from the group's FIRST message, not the previous one
    if (!grouped) groupStartMs = d.getTime();
    rows.push({ key: m.nonce ?? m.id, message: m, pending: p, grouped, dayLabel: newDay ? formatDay(d) : null, unreadDivider: unread });
    prev = m;
    prevDate = d;
  }
  return rows;
}
