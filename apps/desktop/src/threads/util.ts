import { ChannelFlags, ChannelType, THREAD_AUTO_ARCHIVE_DURATIONS, type Channel, type ThreadAutoArchiveDuration } from "../api/types";
import { snowflakeToTimestamp } from "../api/snowflake";

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

/** A one-line plain-text preview of message content (mentions and markdown stay as typed; nothing is parsed or rendered as HTML). */
export function previewText(content: string, max = 140): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
