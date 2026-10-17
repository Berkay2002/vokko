// Glue: listens to gateway MESSAGE_CREATE, asks `decide` what to do, then plays the sound / shows the notification.
// Also keeps the title, favicon and window badge in step with the unread state.

import { gateway } from "../api/gateway";
import { avatarUrl, appStore, displayName, dmName } from "../api/store";
import { ChannelType, RelationshipType, type Message, type MessageReactionEvent, type Snowflake } from "../api/types";
import { messageStore } from "../chat/messageStore";
import { dmPath, go, guildPath } from "../shell/nav";
import { useLocalState } from "../shell/localState";
import { getPrefs, usePrefs } from "../ui/prefs";
import { applyUnread, pageLabel, summarizeUnread } from "./badge";
import { requestAttention } from "../desktop/attention";
import { IS_MAC } from "../desktop/tauri";
import { decide, decideReaction, guildDefaultLevel, shouldBounce, withThreadMember, type NotifyInput, type ReactionNotifyInput } from "./decide";
import { flashTaskbar, notificationAdapter } from "./desktop";
import { playSound, wireAudioUnlock } from "./sounds";
import { notificationTitle, plainBody } from "./text";
import { speakMessage } from "./tts";

/**
 * Right after a (re)connect the server may replay what we missed. Replayed messages older than STALE_MS don't ping (they
 * still count as unread). Outside this window live messages are never dropped by age, so a skewed client clock can't mute them.
 */
const STALE_MS = 2 * 60_000;
const REPLAY_WINDOW_MS = 3000;
let replayUntil = 0;

function windowFocused(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState === "visible" && document.hasFocus();
}

/** Where a channel sits for the notification rules: DM kind, settings scopes and the viewer's state. */
function channelContext(channelId: Snowflake, guildHint: Snowflake | null | undefined, now: number) {
  const state = appStore.getState();
  const meId = state.me?.id;
  if (!meId) return null;
  const channel = state.channels[channelId];
  // A thread message follows the thread, then its parent channel and that channel's category.
  const thread = channel ? undefined : state.threads[channelId];
  const parent = thread?.parent_id ? state.channels[thread.parent_id] : undefined;
  // A DM we have not seen yet: the store is fetching it. Treat it as a 1:1 DM (it can only be addressed to me).
  const guildId = channel?.guild_id ?? thread?.guild_id ?? guildHint;
  const dm: NotifyInput["dm"] = guildId ? null : channel?.type === ChannelType.GroupDM ? "group" : "dm";
  const scopes: Snowflake[] = [channelId];
  if (parent) scopes.push(parent.id);
  const category = (parent ?? channel)?.parent_id;
  if (category) scopes.push(category);
  if (guildId) scopes.push(guildId);
  const local = thread ? withThreadMember(useLocalState.getState(), thread.id, thread.member) : useLocalState.getState();
  return {
    meId,
    guildId: guildId ?? null,
    dm,
    scopes,
    guildDefault: guildDefaultLevel(guildId ? state.guilds[guildId]?.default_message_notifications : undefined),
    local,
    prefs: getPrefs(),
    status: state.presences[meId]?.status,
    focused: windowFocused(),
    viewing: state.route.channelId === channelId,
    now,
  };
}

export function buildInput(message: Message, now = Date.now()): NotifyInput | null {
  const context = channelContext(message.channel_id, message.guild_id, now);
  if (!context) return null;
  const { guildId, ...rest } = context;
  const state = appStore.getState();
  return {
    ...rest,
    message,
    myRoleIds: guildId ? (state.members[guildId]?.[context.meId]?.roles ?? []) : [],
    friend: state.relationships[message.author.id]?.type === RelationshipType.Friend,
  };
}

export function buildReactionInput(reaction: MessageReactionEvent, now = Date.now()): ReactionNotifyInput | null {
  const context = channelContext(reaction.channel_id, null, now);
  if (!context) return null;
  const { guildId: _guildId, ...rest } = context;
  void _guildId;
  return { ...rest, reaction, pref: getPrefs().reactionNotifications };
}

/** Navigates to the message's channel and scrolls to it once the channel has loaded. */
export function openMessage(channelId: Snowflake, guildId: Snowflake | null, messageId: Snowflake): void {
  go(guildId ? guildPath(guildId, channelId) : dmPath(channelId));
  const started = Date.now();
  const poll = () => {
    const there = appStore.getState().route.channelId === channelId;
    if (there && messageStore.getState(channelId).status === "ready") {
      void messageStore.jumpToMessage(channelId, messageId);
    } else if (Date.now() - started < 4000) {
      setTimeout(poll, 60);
    }
  };
  setTimeout(poll, 0);
}

function show(message: Message): void {
  const state = appStore.getState();
  const channel = state.channels[message.channel_id];
  const guildId = channel?.guild_id ?? message.guild_id;
  const guild = guildId ? state.guilds[guildId] : undefined;
  const member = guildId ? (state.members[guildId]?.[message.author.id] ?? message.member ?? null) : null;
  const roles = guild?.roles ?? [];
  const adapter = notificationAdapter();
  adapter.show({
    title: notificationTitle({
      authorName: displayName(message.author, member),
      channelName: guildId ? (channel?.name ?? "channel") : channel ? dmName(channel) : displayName(message.author),
      guildName: guild?.name ?? null,
      group: channel?.type === ChannelType.GroupDM,
    }),
    body: plainBody(message, {
      userName: id => {
        const user = message.mentions.find(u => u.id === id) ?? state.users[id];
        return user ? displayName(user, guildId ? state.members[guildId]?.[id] : null) : null;
      },
      roleName: id => roles.find(r => r.id === id)?.name ?? null,
      channelNameOf: id => state.channels[id]?.name ?? null,
    }),
    icon: avatarUrl(message.author),
    tag: message.channel_id,
    onClick: () => openMessage(message.channel_id, guildId ?? null, message.id),
  });
}

async function onMessage(message: Message): Promise<void> {
  speakMessage(message, Date.now() < replayUntil);
  const input = buildInput(message);
  if (!input) return;
  const sent = Date.parse(message.timestamp);
  const stale = Date.now() < replayUntil && Number.isFinite(sent) && Date.now() - sent > STALE_MS;
  const decision = decide(input);
  if (!decision.kind || stale) return;
  if (decision.sound) playSound(decision.sound === "mention" ? "mention" : "message");
  if (shouldBounce(decision, input.focused)) void requestAttention();
  // Windows and Linux: a mention or DM in the background flashes the taskbar (desktop app, Settings > Notifications); macOS bounces the Dock above.
  if (!IS_MAC && decision.kind === "mention" && !input.focused && getPrefs().taskbarFlash) void flashTaskbar();
  if (decision.desktop && (await notificationAdapter().permission()) === "granted") show(message);
}

async function onReaction(reaction: MessageReactionEvent): Promise<void> {
  // A replay after a reconnect may carry old reactions: nothing pings in the replay window.
  if (Date.now() < replayUntil) return;
  const input = buildReactionInput(reaction);
  if (!input) return;
  const decision = decideReaction(input);
  if (!decision.kind) return;
  if (decision.sound) playSound("message");
  if (!decision.desktop || (await notificationAdapter().permission()) !== "granted") return;
  const state = appStore.getState();
  const dmChannel = state.channels[reaction.channel_id];
  const channel = dmChannel ?? state.threads[reaction.channel_id];
  const guildId = channel?.guild_id ?? null;
  const guild = guildId ? state.guilds[guildId] : undefined;
  const user = state.users[reaction.user_id];
  const name = user ? displayName(user, guildId ? state.members[guildId]?.[user.id] : null) : "Someone";
  const emoji = reaction.emoji.id ? `:${reaction.emoji.name}:` : reaction.emoji.name;
  notificationAdapter().show({
    title: notificationTitle({
      authorName: name,
      channelName: guildId ? (channel?.name ?? "channel") : dmChannel ? dmName(dmChannel) : name,
      guildName: guild?.name ?? null,
      group: channel?.type === ChannelType.GroupDM,
    }),
    body: `Reacted ${emoji} to your message`,
    icon: user ? avatarUrl(user) : undefined,
    tag: `reaction:${reaction.message_id}`,
    onClick: () => openMessage(reaction.channel_id, guildId, reaction.message_id),
  });
}

function refreshUnread(): void {
  const state = appStore.getState();
  applyUnread(summarizeUnread(state, useLocalState.getState(), Date.now()), getPrefs().unreadBadge, pageLabel(state));
}

let started = false;

/** Call once at startup (main.tsx). */
export function startNotify(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  wireAudioUnlock();
  gateway.on("MESSAGE_CREATE", message => void onMessage(message));
  gateway.on("MESSAGE_REACTION_ADD", reaction => void onReaction(reaction));
  let previous = gateway.status;
  gateway.onStatus(status => {
    if (status === "ready" && previous !== "ready") replayUntil = Date.now() + REPLAY_WINDOW_MS;
    previous = status;
  });

  // Recompute the badge only when the inputs it reads actually changed (the store also churns on typing and presence).
  let { channels, readStates, route, guilds, me } = appStore.getState();
  let mutedUntil = useLocalState.getState().mutedUntil;
  let notify = useLocalState.getState().notify;
  let badgePref = getPrefs().unreadBadge;
  appStore.subscribe(s => {
    if (s.channels === channels && s.readStates === readStates && s.route === route && s.guilds === guilds && s.me === me) return;
    ({ channels, readStates, route, guilds, me } = s);
    refreshUnread();
  });
  useLocalState.subscribe(s => {
    if (s.mutedUntil === mutedUntil && s.notify === notify) return;
    mutedUntil = s.mutedUntil;
    notify = s.notify;
    refreshUnread();
  });
  usePrefs.subscribe(p => {
    if (p.unreadBadge === badgePref) return;
    badgePref = p.unreadBadge;
    refreshUnread();
  });
  // A timed mute expiring changes the summary without any store event.
  window.setInterval(refreshUnread, 30_000);
  refreshUnread();
}
