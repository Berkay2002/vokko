// Mock of GET /guilds/{id}/messages/search and GET /channels/{id}/messages/search (docs/api.md "Message search"): same filters,
// pagination, permission filtering and error codes as the server. Text matching is word level, like the server's `simple` tsvector:
// every word must occur, "quoted phrases" must occur as consecutive words, -word excludes.

import { ChannelType, MessageType, type MessageSearchResponse } from "../types";
import { compareIds } from "../snowflake";
import { Perm, hasBit } from "../permissions";
import { channelPermsOf } from "./access";
import { db, sortedMessages, type MockChannel, type MockMessage } from "./db";
import { fail, requireChannel, requireGuildMember } from "./ops";
import { ID, route } from "./router";
import { messageFor } from "./views";

const HAS_VALUES = new Set(["link", "embed", "file", "image", "video", "sound", "sticker"]);
const MAX_LIMIT = 25;
const MAX_OFFSET = 9975;

interface Params {
  content: string;
  authors: string[];
  mentions: string[];
  has: string[];
  channels: string[];
  pinned: boolean | null;
  minId: string | null;
  maxId: string | null;
  offset: number;
  limit: number;
  relevance: boolean;
  ascending: boolean;
}

const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];

function invalid(field: string, message: string): never {
  return fail(400, 50035, "Invalid Form Body", { [field]: { code: "BASE_TYPE_BAD_FORMAT", message } });
}

function parse(query: URLSearchParams): Params {
  const snowflakes = (key: string): string[] => query.getAll(key).map(v => (/^\d+$/.test(v) ? v : invalid(key, "Value is not snowflake.")));
  const int = (key: string, min: number, max: number, fallback: number): number => {
    const raw = query.get(key);
    if (raw === null) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) invalid(key, `Must be between ${min} and ${max}.`);
    return n;
  };
  const content = query.get("content") ?? "";
  if (content.length > 1024) invalid("content", "Must be 1024 or fewer in length.");
  const has = query.getAll("has").map(v => (HAS_VALUES.has(v) ? v : invalid("has", "Value must be one of link, embed, file, image, video, sound, sticker.")));
  const pinnedRaw = query.get("pinned");
  if (pinnedRaw !== null && pinnedRaw !== "true" && pinnedRaw !== "false") invalid("pinned", "Must be true or false.");
  const sortBy = query.get("sort_by") ?? "timestamp";
  if (sortBy !== "timestamp" && sortBy !== "relevance") invalid("sort_by", "Must be timestamp or relevance.");
  const sortOrder = query.get("sort_order") ?? "desc";
  if (sortOrder !== "asc" && sortOrder !== "desc") invalid("sort_order", "Must be asc or desc.");
  const minId = query.get("min_id");
  const maxId = query.get("max_id");
  if ((minId !== null && !/^\d+$/.test(minId)) || (maxId !== null && !/^\d+$/.test(maxId))) invalid("min_id", "Value is not snowflake.");
  return {
    content: content.trim(),
    authors: snowflakes("author_id"),
    mentions: snowflakes("mentions"),
    has,
    channels: snowflakes("channel_id"),
    pinned: pinnedRaw === null ? null : pinnedRaw === "true",
    minId,
    maxId,
    offset: int("offset", 0, MAX_OFFSET, 0),
    limit: int("limit", 1, MAX_LIMIT, MAX_LIMIT),
    relevance: sortBy === "relevance",
    ascending: sortOrder === "asc",
  };
}

/** `foo "bar baz" -qux` → positive word sequences and negative word sequences. */
function parseText(content: string): { include: string[][]; exclude: string[][] } {
  const include: string[][] = [];
  const exclude: string[][] = [];
  for (const match of content.matchAll(/(-?)(?:"([^"]*)"|(\S+))/g)) {
    const sequence = words(match[2] ?? match[3] ?? "");
    if (sequence.length === 0) continue;
    (match[1] ? exclude : include).push(sequence);
  }
  return { include, exclude };
}

function occurrences(tokens: string[], sequence: string[]): number {
  let count = 0;
  for (let i = 0; i + sequence.length <= tokens.length; i++) if (sequence.every((w, j) => tokens[i + j] === w)) count++;
  return count;
}

function matchesHas(m: MockMessage, kind: string): boolean {
  switch (kind) {
    case "link": return /https?:\/\/\S+/i.test(m.content);
    case "file": return m.attachments.length > 0;
    case "image": return m.attachments.some(a => a.content_type?.startsWith("image/"));
    case "video": return m.attachments.some(a => a.content_type?.startsWith("video/"));
    case "sound": return m.attachments.some(a => a.content_type?.startsWith("audio/"));
    case "sticker": return (m.stickers?.length ?? 0) > 0;
    default: return false; // embeds are only generated for mock GIF links
  }
}

const READABLE = Perm.VIEW_CHANNEL | Perm.READ_MESSAGE_HISTORY;
const canRead = (channel: MockChannel, userId: string): boolean => (channelPermsOf(channel, userId) & READABLE) === READABLE;

function search(channels: MockChannel[], params: Params, viewerId: string): MessageSearchResponse {
  const text = parseText(params.content);
  const hasText = params.content !== "";
  const scored: { message: MockMessage; score: number }[] = [];
  for (const channel of channels) {
    for (const m of sortedMessages(channel.id)) {
      if (m.type !== MessageType.Default && m.type !== MessageType.Reply) continue;
      if (params.authors.length > 0 && !params.authors.includes(m.author_id)) continue;
      if (params.mentions.length > 0 && !params.mentions.some(id => m.mention_ids.includes(id))) continue;
      if (params.pinned !== null && m.pinned !== params.pinned) continue;
      if (params.minId !== null && compareIds(m.id, params.minId) <= 0) continue;
      if (params.maxId !== null && compareIds(m.id, params.maxId) >= 0) continue;
      if (!params.has.every(kind => matchesHas(m, kind))) continue;
      let score = 0;
      if (hasText) {
        if (text.include.length === 0 && text.exclude.length === 0) continue; // only punctuation: matches nothing, like an empty tsquery
        const tokens = words(m.content);
        if (text.exclude.some(seq => occurrences(tokens, seq) > 0)) continue;
        const counts = text.include.map(seq => occurrences(tokens, seq));
        if (counts.some(n => n === 0)) continue;
        score = counts.reduce((a, b) => a + b, 0);
      }
      scored.push({ message: m, score });
    }
  }
  const byRelevance = params.relevance && hasText;
  scored.sort((a, b) => {
    if (byRelevance && a.score !== b.score) return b.score - a.score;
    return params.ascending && !byRelevance ? compareIds(a.message.id, b.message.id) : compareIds(b.message.id, a.message.id);
  });
  const page = scored.slice(params.offset, params.offset + params.limit);
  return { total_results: scored.length, messages: page.map(({ message }) => [messageFor(message, viewerId)]) };
}

route("GET", `/guilds/${ID}/messages/search`, ({ viewer, params, query }) => {
  const guildId = params[0] ?? "";
  requireGuildMember(guildId, viewer.user.id);
  const parsed = parse(query);
  const channels = [...db.channels.values()].filter(c => c.guild_id === guildId && c.type !== ChannelType.GuildCategory && c.type !== ChannelType.GuildVoice)
    .filter(c => canRead(c, viewer.user.id) && (parsed.channels.length === 0 || parsed.channels.includes(c.id)));
  return search(channels, parsed, viewer.user.id);
});

route("GET", `/channels/${ID}/messages/search`, ({ viewer, params, query }) => {
  const channel = requireChannel(params[0] ?? "", viewer.user.id);
  const parsed = parse(query);
  if (!hasBit(channelPermsOf(channel, viewer.user.id), Perm.READ_MESSAGE_HISTORY)) return { total_results: 0, messages: [] } satisfies MessageSearchResponse;
  return search([channel], parsed, viewer.user.id);
});
