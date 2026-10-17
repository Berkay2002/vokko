// The pure "should this message notify me" decision. No store, DOM or timers in here: the controller gathers the inputs
// (local mute/level state, prefs, focus, route) and acts on the result, so every rule is unit-testable.

import { MessageType, ThreadMemberFlags, type Message, type MessageReactionEvent, type PresenceStatus, type Snowflake, type ThreadMember } from "../api/types";

export type NotifyLevel = "default" | "all" | "unreads-mentions" | "mentions" | "none";
export type NotifyKind = "mention" | "message";

/** The slice of `useLocalState` the decision reads (ids are guild, category or channel snowflakes). */
export interface NotifyLocalState {
  /** Expiry timestamp in ms, or -1 for "until I turn it back on". */
  mutedUntil: Record<Snowflake, number>;
  notify: Record<Snowflake, NotifyLevel>;
  suppressEveryone: Record<Snowflake, boolean>;
  suppressRoles: Record<Snowflake, boolean>;
}

export interface NotifyPrefs {
  desktopNotifications: boolean;
  notificationSounds: boolean;
  soundCurrentChannel: boolean;
  streamerMode: boolean;
  streamerDisableSounds: boolean;
  streamerDisableNotifications: boolean;
  /** Settings > Data & Privacy: DMs from non-friends are message requests and stay silent. */
  messageRequests?: boolean;
}

export interface NotifyInput {
  message: Pick<Message, "author" | "mentions" | "mention_everyone" | "content" | "type">;
  meId: Snowflake;
  /** My role ids in the message's guild (empty for DMs). */
  myRoleIds: readonly Snowflake[];
  /** "dm" = 1:1 DM (every message is addressed to me), "group" = group DM, null = guild channel. */
  dm: "dm" | "group" | null;
  /** The author is an accepted friend (only read for 1:1 DMs; absent = unknown, treated as a friend). */
  friend?: boolean;
  /** Settings scopes nearest first: [channel, category?, guild?]. */
  scopes: readonly Snowflake[];
  local: NotifyLocalState;
  prefs: NotifyPrefs;
  /** My own presence status: do-not-disturb silences everything. */
  status: PresenceStatus | undefined;
  /** The window (or tab) has focus. */
  focused: boolean;
  /** This channel is the one on screen. */
  viewing: boolean;
  now: number;
}

export interface NotifyDecision {
  /** Show an OS / browser notification. */
  desktop: boolean;
  /** Which sound to play, if any. */
  sound: NotifyKind | null;
  /** Why the message is relevant to me (null: it isn't, nothing fires). */
  kind: NotifyKind | null;
  /** Short machine-readable reason, for tests and debugging. */
  reason: string;
}

const NONE = (reason: string): NotifyDecision => ({ desktop: false, sound: null, kind: null, reason });

export function isMutedAt(local: Pick<NotifyLocalState, "mutedUntil">, id: Snowflake | null | undefined, now: number): boolean {
  if (!id) return false;
  const until = local.mutedUntil[id];
  return until === -1 || (until !== undefined && until > now);
}

/** First explicit level on the way channel → category → guild, "all" when nothing is set (the shell shows the same default). */
export function effectiveLevel(local: Pick<NotifyLocalState, "notify">, scopes: readonly Snowflake[]): Exclude<NotifyLevel, "default"> {
  for (const id of scopes) {
    const level = local.notify[id];
    if (level && level !== "default") return level;
  }
  return "all";
}

/**
 * A thread's mute and level live on the viewer's thread member, not in the local prefs: overlay them on the thread's own id.
 * No notify bit means "Use Channel Default" (the parent's scopes decide); a member that is not muted lifts any stale local mute.
 */
export function withThreadMember(local: NotifyLocalState, threadId: Snowflake, member: Pick<ThreadMember, "flags" | "muted" | "mute_config"> | undefined): NotifyLocalState {
  if (!member) return local;
  const { [threadId]: _mute, ...mutedUntil } = local.mutedUntil;
  const { [threadId]: _level, ...notify } = local.notify;
  void _mute;
  void _level;
  if (member.muted) mutedUntil[threadId] = member.mute_config?.end_time ? Date.parse(member.mute_config.end_time) : -1;
  if (member.flags & ThreadMemberFlags.AllMessages) notify[threadId] = "all";
  else if (member.flags & ThreadMemberFlags.OnlyMentions) notify[threadId] = "mentions";
  else if (member.flags & ThreadMemberFlags.NoMessages) notify[threadId] = "none";
  return { ...local, mutedUntil, notify };
}

/** `<@&id>` role mention in the raw content that targets one of my roles. */
export function mentionsMyRole(content: string, roleIds: readonly Snowflake[]): boolean {
  if (roleIds.length === 0) return false;
  for (const match of content.matchAll(/<@&(\d+)>/g)) if (roleIds.includes(match[1] ?? "")) return true;
  return false;
}

export function decide(input: NotifyInput): NotifyDecision {
  const { message, meId, local, prefs } = input;
  if (message.author.id === meId) return NONE("own");
  if (message.type !== MessageType.Default && message.type !== MessageType.Reply) return NONE("system");
  if (input.status === "dnd") return NONE("dnd");
  if (input.scopes.some(id => isMutedAt(local, id, input.now))) return NONE("muted");
  if (input.dm === "dm" && prefs.messageRequests && input.friend === false) return NONE("message-request");

  const level = effectiveLevel(local, input.scopes);
  if (level === "none") return NONE("level-none");

  const direct = message.mentions.some(user => user.id === meId);
  const everyone = message.mention_everyone && !input.scopes.some(id => local.suppressEveryone[id]);
  const role = mentionsMyRole(message.content, input.myRoleIds) && !input.scopes.some(id => local.suppressRoles[id]);
  const mentioned = direct || everyone || role;
  // A 1:1 DM is addressed to me by definition; in a group DM or a guild the channel level decides.
  const addressed = mentioned || input.dm === "dm";
  if (level !== "all" && !addressed) return NONE("level-mentions");

  const kind: NotifyKind = addressed ? "mention" : "message";
  const reason = direct ? "mention" : everyone ? "everyone" : role ? "role" : input.dm === "dm" ? "dm" : "all";
  return deliver(input, kind, reason);
}

/** Sound and OS notification for something that is relevant: prefs, streamer mode and "already looking at it" apply. */
function deliver(input: Pick<NotifyInput, "prefs" | "focused" | "viewing">, kind: NotifyKind, reason: string): NotifyDecision {
  const { prefs } = input;
  const soundAllowed = prefs.notificationSounds && !(prefs.streamerMode && prefs.streamerDisableSounds) && !(input.focused && input.viewing && !prefs.soundCurrentChannel);
  const desktopAllowed = prefs.desktopNotifications && !(prefs.streamerMode && prefs.streamerDisableNotifications) && !(input.focused && input.viewing);
  return { desktop: desktopAllowed, sound: soundAllowed ? kind : null, kind, reason };
}

export type ReactionNotifyPref = "all" | "dm" | "never";

export interface ReactionNotifyInput extends Omit<NotifyInput, "message" | "myRoleIds" | "friend"> {
  reaction: Pick<MessageReactionEvent, "user_id" | "message_author_id">;
  /** Settings > Notifications > Reaction notifications. */
  pref: ReactionNotifyPref;
}

/**
 * Someone reacted to my message: "all" anywhere, "dm" only in DMs and group DMs, "never" off. Do-not-disturb and mutes
 * silence it like a message; the channel's notification level does not (Discord's behaviour).
 */
export function decideReaction(input: ReactionNotifyInput): NotifyDecision {
  const { reaction, meId } = input;
  if (reaction.user_id === meId || reaction.message_author_id !== meId) return NONE("not-mine");
  if (input.pref === "never") return NONE("pref-never");
  if (input.pref === "dm" && input.dm === null) return NONE("pref-dm");
  if (input.status === "dnd") return NONE("dnd");
  if (input.scopes.some(id => isMutedAt(input.local, id, input.now))) return NONE("muted");
  return deliver(input, "message", "reaction");
}

/**
 * Whether the Dock should bounce: something addressed to me (a mention or a DM) that would also raise an OS notification
 * (so DND, mutes, "nothing" levels, the desktop-notifications pref and streamer mode all apply), while the window is in the background.
 */
export function shouldBounce(decision: Pick<NotifyDecision, "kind" | "desktop">, focused: boolean): boolean {
  return decision.kind === "mention" && decision.desktop && !focused;
}
