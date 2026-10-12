// Speaks incoming /tts messages ("<name> said <text>", like Discord). `shouldSpeak` is the pure decision; `speakMessage` is the glue
// the notify controller calls for every MESSAGE_CREATE.

import { appStore, displayName } from "../api/store";
import { RelationshipType, type Message, type Snowflake } from "../api/types";
import { toDisplay } from "../chat/mentionText";
import { getPrefs } from "../ui/prefs";
import { enqueueSpeech, speechAvailable } from "../ui/speech";
import { useThreadUi } from "../threads/threadUi";

export interface TtsDecisionInput {
  message: Pick<Message, "id" | "channel_id" | "tts" | "author">;
  meId: Snowflake | null;
  /** Channels the viewer has open: the routed one, and the thread open in the side panel. */
  viewedChannelIds: readonly Snowflake[];
  /** The author is blocked. */
  blocked?: boolean;
  /** The window is visible and focused. */
  focused: boolean;
  /** "Allow playback and usage of /tts command". */
  playback: boolean;
  available: boolean;
  /** Replayed after a reconnect, long after it was sent. */
  stale?: boolean;
  /** Ids already spoken (or being spoken). */
  spoken: ReadonlySet<Snowflake>;
}

export function shouldSpeak(input: TtsDecisionInput): boolean {
  const { message } = input;
  if (message.tts !== true || !input.playback || !input.available || input.stale) return false;
  if (!input.meId || message.author.id === input.meId || input.blocked) return false;
  if (!input.focused || !input.viewedChannelIds.includes(message.channel_id)) return false;
  return !input.spoken.has(message.id);
}

export interface SpokenContext {
  authorName: string;
  userName(id: Snowflake): string | null;
  roleName(id: Snowflake): string | null;
  channelNameOf(id: Snowflake): string | null;
}

/** "<author> said <plain content>": mentions resolved, custom emoji spoken by name. Empty when there is nothing to read. */
export function spokenText(message: Pick<Message, "content">, ctx: SpokenContext): string {
  const { text } = toDisplay(message.content, { user: ctx.userName, role: ctx.roleName, channel: ctx.channelNameOf });
  const plain = text
    .replace(/<a?:(\w+):\d+>/g, "$1")
    .replace(/<@&\d+>/g, "a role")
    .replace(/<@!?\d+>/g, "someone")
    .replace(/<#\d+>/g, "a channel")
    .replace(/\|\|[\s\S]+?\|\|/g, "spoiler")
    .replace(/<?https?:\/\/[^\s>]+>?/gi, "a link")
    .replace(/```[a-z]*\n?/gi, " ")
    .replace(/^\s{0,3}(#{1,3}|>)\s+/gm, "")
    .replace(/(^|[^\w])_{1,2}([^_\n]+?)_{1,2}(?=[^\w]|$)/g, "$1$2")
    .replace(/[*~`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain ? `${ctx.authorName} said ${plain}` : "";
}

const STALE_MS = 2 * 60_000;
const MAX_REMEMBERED = 200;
const spokenIds = new Set<Snowflake>();

function windowFocused(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState === "visible" && document.hasFocus();
}

/** Reads a received tts message aloud when `shouldSpeak` allows it. */
/** `replaying`: right after a reconnect, when the server may resend what we missed (see controller.ts). */
export function speakMessage(message: Message, replaying = false, now = Date.now()): void {
  if (message.tts !== true) return;
  const state = appStore.getState();
  const sent = Date.parse(message.timestamp);
  const decided = shouldSpeak({
    message,
    meId: state.me?.id ?? null,
    viewedChannelIds: [state.route.channelId, useThreadUi.getState().openId].filter((id): id is Snowflake => !!id),
    blocked: state.relationships[message.author.id]?.type === RelationshipType.Blocked,
    focused: windowFocused(),
    playback: getPrefs().ttsPlayback,
    available: speechAvailable(),
    stale: replaying && Number.isFinite(sent) && now - sent > STALE_MS,
    spoken: spokenIds,
  });
  if (!decided) return;
  const guildId = state.channels[message.channel_id]?.guild_id ?? message.guild_id;
  const member = guildId ? (state.members[guildId]?.[message.author.id] ?? message.member ?? null) : null;
  const roles = guildId ? (state.guilds[guildId]?.roles ?? []) : [];
  const text = spokenText(message, {
    authorName: displayName(message.author, member),
    userName: id => {
      const user = message.mentions.find(u => u.id === id) ?? state.users[id];
      return user ? displayName(user, guildId ? state.members[guildId]?.[id] : null) : null;
    },
    roleName: id => roles.find(r => r.id === id)?.name ?? null,
    channelNameOf: id => state.channels[id]?.name ?? null,
  });
  if (!text) return;
  spokenIds.add(message.id);
  if (spokenIds.size > MAX_REMEMBERED) spokenIds.delete(spokenIds.values().next().value as Snowflake);
  enqueueSpeech(text, getPrefs().ttsRate);
}
