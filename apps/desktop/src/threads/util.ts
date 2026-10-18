import { ChannelFlags, ChannelType, THREAD_AUTO_ARCHIVE_DURATIONS, type Channel, type ThreadAutoArchiveDuration } from "../api/types";
import { compareIds, snowflakeToTimestamp } from "../api/snowflake";
import type { ReactionEmoji, ReadState, Reaction } from "../api/types";

export const ARCHIVE_LABELS: Record<ThreadAutoArchiveDuration, string> = { 60: "1 Hour", 1440: "24 Hours", 4320: "3 Days", 10080: "1 Week" };
export const ARCHIVE_OPTIONS = THREAD_AUTO_ARCHIVE_DURATIONS.map(value => ({ value: String(value), label: ARCHIVE_LABELS[value] }));

export const NAME_MAX = 100;

/** Channels whose messages can grow threads (and whose type 18 / 21 messages point at them). */
export const hasThreadsType = (channel: Pick<Channel, "type"> | undefined): boolean => channel?.type === ChannelType.GuildText || channel?.type === ChannelType.GuildAnnouncement;

export const isPinned = (thread: Pick<Channel, "flags">): boolean => ((thread.flags ?? 0) & ChannelFlags.Pinned) !== 0;

/** "just now", "5m ago", "3h ago", "2d ago", else a date. */
export function timeAgo(ms: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

/** Time of the latest activity: the last message when there is one, else when the thread was created. */
export function lastActivityMs(thread: Channel): number {
  if (thread.last_message_id) return snowflakeToTimestamp(thread.last_message_id);
  const created = Date.parse(thread.thread_metadata?.create_timestamp ?? "");
  return Number.isFinite(created) ? created : snowflakeToTimestamp(thread.id);
}

export const messageCountLabel = (count: number | undefined): string => `${count ?? 0} ${count === 1 ? "Message" : "Messages"}`;

const ESCAPED = 0xe000;

export interface PreviewNames {
  user?(id: string): string | null | undefined;
  role?(id: string): string | null | undefined;
  channel?(id: string): string | null | undefined;
}

/**
 * A one-line plain-text preview of message content: markdown markers stripped, `<@id>` / `<@&id>` / `<#id>` / `<:name:id>` turned into
 * @name / @role / #name / :name:, spoilers hidden, then cut at `max`. Nothing is parsed or rendered as HTML. Unresolved ids read "@user", "@role", "#channel".
 */
export function plainPreview(content: string, max = 140, names: PreviewNames = {}): string {
  const flat = content
    // Backslash-escaped markers stay literal: parked in the private use area, restored at the end.
    .replace(/\\([*_~|`\\])/g, (_, c: string) => String.fromCharCode(ESCAPED + c.charCodeAt(0)))
    .replace(/```(?:[\w+-]*\n)?([\s\S]*?)```/g, "$1")
    // Before mentions are resolved: a name containing "||" must not close the spoiler early.
    .replace(/\|\|[\s\S]+?\|\|/g, "[spoiler]")
    .replace(/<(@&|@!?|#)(\d+)>/g, (_, kind: string, id: string) => (kind === "@&" ? `@${names.role?.(id) ?? "role"}` : kind === "#" ? `#${names.channel?.(id) ?? "channel"}` : `@${names.user?.(id) ?? "user"}`))
    .replace(/<a?:(\w+):\d+>/g, ":$1:")
    .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
    .replace(/\[([^\]\n]+)\]\([^)\s]+(?:\s+"[^"]*")?\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,3}|-#)\s+/gm, "")
    .replace(/^\s{0,3}>{1,3}\s?/gm, "")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(?<![\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1")
    .replace(/(?<!\w)_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/[\ue000-\ue0ff]/g, c => String.fromCharCode(c.charCodeAt(0) - ESCAPED))
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

export type ThreadSort = "activity" | "created";

const createdMs = (thread: Channel): number => Date.parse(thread.thread_metadata?.create_timestamp ?? "") || snowflakeToTimestamp(thread.id);

/** Newest first, by last activity or by creation. Returns a new array. */
export function sortThreads(threads: readonly Channel[], sort: ThreadSort): Channel[] {
  const key = sort === "created" ? createdMs : lastActivityMs;
  return [...threads].sort((a, b) => key(b) - key(a) || compareIds(b.id, a.id));
}

/** Threads popout "Active" view: name search, then the threads the viewer joined and the other active ones, each sorted. */
export function groupActiveThreads(threads: readonly Channel[], needle: string, sort: ThreadSort): { joined: Channel[]; other: Channel[] } {
  const q = needle.trim().toLowerCase();
  const shown = sortThreads(
    threads.filter(t => !q || (t.name ?? "").toLowerCase().includes(q)),
    sort,
  );
  return { joined: shown.filter(t => !!t.member), other: shown.filter(t => !t.member) };
}

/**
 * A thread is unread when the viewer has a read state for it that is behind its last message. Threads without a read state (archived
 * ones from search, which READY does not cover) count as read, so an old archive does not light up.
 */
export function isThreadUnread(thread: Pick<Channel, "last_message_id">, read: ReadState | undefined): boolean {
  if (!thread.last_message_id || !read) return false;
  return !read.last_message_id || compareIds(thread.last_message_id, read.last_message_id) > 0;
}

/** Reaction shown on a forum card: the most used one of the starter message (first wins a tie), else none. */
export function topReaction(reactions: readonly Reaction[] | undefined): Reaction | undefined {
  return (reactions ?? []).reduce<Reaction | undefined>((best, r) => (!best || r.count > best.count ? r : best), undefined);
}

export const PANEL_MIN = 360;
export const PANEL_DEFAULT = 420;
/** The chat column next to the thread panel never gets narrower than this (unless the panel is already at PANEL_MIN). */
export const CHAT_MIN = 440;

/** Widest the panel may be inside a channel body `available` px wide. */
export const panelMax = (available: number): number => Math.max(PANEL_MIN, Math.floor(available - CHAT_MIN));

/** Thread panel width inside a channel body `available` px wide: at least PANEL_MIN, and the chat column keeps CHAT_MIN. */
export function clampPanelWidth(width: number, available: number): number {
  return Math.round(Math.max(PANEL_MIN, Math.min(width, panelMax(available))));
}

const sameEmoji = (a: ReactionEmoji, b: ReactionEmoji): boolean => (a.id ?? a.name) === (b.id ?? b.name);

/**
 * Reactions after a MESSAGE_REACTION_ADD (+1) or _REMOVE (-1) event; `mine` sets the viewer's flag (`me`, or `me_burst` for a super
 * reaction). Returns a new array.
 */
export function applyReactionEvent(reactions: readonly Reaction[], emoji: ReactionEmoji, delta: 1 | -1, mine: boolean, burst = false): Reaction[] {
  const kind = burst ? "burst" : "normal";
  const found = reactions.find(r => sameEmoji(r.emoji, emoji));
  if (!found) {
    if (delta < 0) return [...reactions];
    return [...reactions, { emoji, count: 1, count_details: { normal: burst ? 0 : 1, burst: burst ? 1 : 0 }, burst_colors: [], me: mine && !burst, me_burst: mine && burst }];
  }
  return reactions.flatMap(r => {
    if (r !== found) return [r];
    const count = r.count + delta;
    const details = r.count_details ?? { normal: r.count, burst: 0 };
    const next: Reaction = { ...r, count, count_details: { ...details, [kind]: Math.max(0, details[kind] + delta) } };
    if (mine) {
      if (burst) next.me_burst = delta > 0;
      else next.me = delta > 0;
    }
    return count > 0 ? [next] : [];
  });
}
