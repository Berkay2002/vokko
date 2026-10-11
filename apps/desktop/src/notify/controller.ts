// Glue: listens to gateway MESSAGE_CREATE, asks `decide` what to do, then plays the sound / shows the notification.
// Also keeps the title, favicon and window badge in step with the unread state.

import { gateway } from "../api/gateway";
import { avatarUrl, appStore, displayName, dmName } from "../api/store";
import { ChannelType, type Message, type Snowflake } from "../api/types";
import { messageStore } from "../chat/messageStore";
import { dmPath, go, guildPath } from "../shell/nav";
import { useLocalState } from "../shell/localState";
import { getPrefs, usePrefs } from "../ui/prefs";
import { applyUnread, pageLabel, summarizeUnread } from "./badge";
import { requestAttention } from "../desktop/attention";
import { decide, shouldBounce, type NotifyInput } from "./decide";
import { notificationAdapter } from "./desktop";
import { playSound, wireAudioUnlock } from "./sounds";
import { notificationTitle, plainBody } from "./text";

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

export function buildInput(message: Message, now = Date.now()): NotifyInput | null {
  const state = appStore.getState();
  const meId = state.me?.id;
  if (!meId) return null;
  const channel = state.channels[message.channel_id];
  // A DM we have not seen yet: the store is fetching it. Treat it as a 1:1 DM (it can only be addressed to me).
  const guildId = channel?.guild_id ?? message.guild_id;
  const dm = guildId ? null : channel?.type === ChannelType.GroupDM ? "group" : "dm";
  const scopes: Snowflake[] = [message.channel_id];
  if (channel?.parent_id) scopes.push(channel.parent_id);
  if (guildId) scopes.push(guildId);
  const local = useLocalState.getState();
  const prefs = getPrefs();
  return {
    message,
    meId,
    myRoleIds: guildId ? (state.members[guildId]?.[meId]?.roles ?? []) : [],
    dm,
    scopes,
    local,
    prefs,
    status: state.presences[meId]?.status,
    focused: windowFocused(),
    viewing: state.route.channelId === message.channel_id,
    now,
  };
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
  const input = buildInput(message);
  if (!input) return;
  const sent = Date.parse(message.timestamp);
  const stale = Date.now() < replayUntil && Number.isFinite(sent) && Date.now() - sent > STALE_MS;
  const decision = decide(input);
  if (!decision.kind || stale) return;
  if (decision.sound) playSound(decision.sound === "mention" ? "mention" : "message");
  if (shouldBounce(decision, input.focused)) void requestAttention();
  if (decision.desktop && (await notificationAdapter().permission()) === "granted") show(message);
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
