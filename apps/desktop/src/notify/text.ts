// Plain-text title and body for a notification. Never HTML: the OS / browser shows these strings as-is.

import { toDisplay } from "../chat/mentionText";
import type { Message, Snowflake } from "../api/types";

const MAX_BODY = 200;

export interface TextContext {
  /** Channel name for guild channels, the DM / group name for private ones. */
  channelName: string;
  guildName: string | null;
  /** Group DMs: the title names the group. */
  group: boolean;
  authorName: string;
  userName(id: Snowflake): string | null;
  roleName(id: Snowflake): string | null;
  channelNameOf(id: Snowflake): string | null;
}

/** Raw markdown → one short plain line: mentions resolved, custom emoji as :name:, spoilers hidden. */
export function plainBody(message: Pick<Message, "content" | "attachments" | "embeds">, ctx: Pick<TextContext, "userName" | "roleName" | "channelNameOf">): string {
  const { text } = toDisplay(message.content, { user: ctx.userName, role: ctx.roleName, channel: ctx.channelNameOf });
  const cleaned = text
    .replace(/<a?:(\w+):\d+>/g, ":$1:")
    .replace(/\|\|[\s\S]+?\|\|/g, "[spoiler]")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned) return cleaned.length > MAX_BODY ? `${cleaned.slice(0, MAX_BODY - 1)}…` : cleaned;
  const files = message.attachments.length;
  if (files === 1) return "Sent an attachment";
  if (files > 1) return `Sent ${files} attachments`;
  if (message.embeds.length > 0) return "Sent an embed";
  return "";
}

/** "alice" in a DM, "alice (#general, Vokko Lab)" in a server, "alice (Movie night)" in a group DM. */
export function notificationTitle(ctx: Pick<TextContext, "authorName" | "channelName" | "guildName" | "group">): string {
  if (ctx.guildName) return `${ctx.authorName} (#${ctx.channelName}, ${ctx.guildName})`;
  if (ctx.group) return `${ctx.authorName} (${ctx.channelName})`;
  return ctx.authorName;
}
