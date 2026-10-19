// The single client-side app store. Filled from READY and kept current by gateway events.
// Field names are a contract with src/chat (see the orchestrator's message): me, guilds, channels, privateChannels,
// presences, readStates, members, relationships, users.

import { useRef, useSyncExternalStore } from "react";
import { create } from "zustand";
import { shallow } from "zustand/shallow";
import { gateway, type GatewayStatus } from "./gateway";
import { setMaxUploadBytes } from "./limits";
import { setSpotifyOwner } from "../spotify/availability";
import { go, guildPath } from "../shell/nav";
import { openModal } from "../shell/modalStore";
import { channelPermissions, hasBit, Perm } from "./permissions";
import { listActiveThreads, request, resolveUrl } from "./rest";
import { compareIds, maxId } from "./snowflake";
import { isThreadUnread } from "../threads/util";
import { mentionKinds } from "../notify/decide";
import { useLocalState } from "../shell/localState";
import {
  ChannelType,
  MessageFlags,
  MessageType,
  RelationshipType,
  type Channel,
  type Guild,
  type GuildMember,
  type Message,
  type Presence,
  type ReadState,
  type ReadyEvent,
  type Role,
  type Relationship,
  type Snowflake,
  type User,
} from "./types";

export interface Route {
  /** null on the @me side (DM home, friends, DMs). */
  guildId: Snowflake | null;
  channelId: Snowflake | null;
}

export interface AppState {
  token: string | null;
  /** True once READY has been applied for the current session. */
  ready: boolean;
  /** The startup cache (cache/startupCache.ts) is on screen and READY has not arrived: show it, but nothing can be sent. */
  stale: boolean;
  connection: GatewayStatus;
  me: User | null;
  guilds: Record<Snowflake, Guild>;
  /** Server rail order. */
  guildOrder: Snowflake[];
  /** Guild channels and DMs together. */
  channels: Record<Snowflake, Channel>;
  /**
   * Threads (types 10-12) by id: the active ones from READY / GUILD_CREATE / THREAD_* events plus any archived thread the UI opened.
   * They are kept apart from `channels` so the channel list, unread dots and the quick switcher never see them.
   * `thread.member` is the current user's membership.
   */
  threads: Record<Snowflake, Channel>;
  /** DM / group DM ids ordered by last_message_id (newest first). */
  privateChannels: Snowflake[];
  presences: Record<Snowflake, Presence>;
  readStates: Record<Snowflake, ReadState>;
  members: Record<Snowflake, Record<Snowflake, GuildMember>>;
  memberCounts: Record<Snowflake, number>;
  relationships: Record<Snowflake, Relationship>;
  users: Record<Snowflake, User>;
  /** channelId → userId → expiry (ms). Use `useTypingUsers`. */
  typing: Record<Snowflake, Record<Snowflake, number>>;
  route: Route;
  lastChannelByGuild: Record<Snowflake, Snowflake>;

  setRoute(route: Route): void;
  cacheUsers(users: (User | null | undefined)[]): void;
  applyReady(ready: ReadyEvent): void;
  upsertChannel(channel: Channel): void;
  removeChannel(id: Snowflake): void;
  upsertThread(thread: Channel): void;
  removeThread(id: Snowflake): void;
  removeGuild(id: Snowflake): void;
  setReadState(state: ReadState): void;
  setMe(user: User): void;
  reset(): void;
}

const LAST_CHANNEL_KEY = "vokko.lastChannels";

function loadLastChannels(): Record<Snowflake, Snowflake> {
  try {
    const raw = localStorage.getItem(LAST_CHANNEL_KEY);
    return raw ? (JSON.parse(raw) as Record<Snowflake, Snowflake>) : {};
  } catch {
    return {};
  }
}

function sortPrivate(channels: Record<Snowflake, Channel>, ids: Iterable<Snowflake>): Snowflake[] {
  const key = (id: Snowflake) => channels[id]?.last_message_id ?? id;
  return [...ids].sort((a, b) => compareIds(key(b), key(a)));
}

const initial = {
  token: null,
  ready: false,
  stale: false,
  connection: "disconnected" as GatewayStatus,
  me: null,
  guilds: {},
  guildOrder: [],
  channels: {},
  threads: {},
  privateChannels: [],
  presences: {},
  readStates: {},
  members: {},
  memberCounts: {},
  relationships: {},
  users: {},
  typing: {},
  route: { guildId: null, channelId: null } as Route,
};

export const appStore = create<AppState>()((set, get) => ({
  ...initial,
  lastChannelByGuild: loadLastChannels(),

  setRoute(route) {
    const next: Partial<AppState> = { route };
    if (route.guildId && route.channelId) {
      const last = { ...get().lastChannelByGuild, [route.guildId]: route.channelId };
      next.lastChannelByGuild = last;
      try {
        localStorage.setItem(LAST_CHANNEL_KEY, JSON.stringify(last));
      } catch {
        /* ignore */
      }
    }
    set(next);
  },

  cacheUsers(list) {
    const known = get().users;
    let changed: Record<Snowflake, User> | null = null;
    for (const user of list) {
      if (!user) continue;
      const prev = known[user.id];
      if (prev && prev.username === user.username && prev.global_name === user.global_name && prev.avatar === user.avatar && prev.bio === user.bio && prev.banner_color === user.banner_color) continue;
      (changed ??= {})[user.id] = user;
    }
    if (changed) set({ users: { ...known, ...changed } });
  },

  applyReady(ready) {
    const users: Record<Snowflake, User> = { [ready.user.id]: ready.user };
    const guilds: Record<Snowflake, Guild> = {};
    const guildOrder: Snowflake[] = [];
    const channels: Record<Snowflake, Channel> = {};
    const threads: Record<Snowflake, Channel> = {};
    const members: Record<Snowflake, Record<Snowflake, GuildMember>> = {};
    const memberCounts: Record<Snowflake, number> = {};
    for (const entry of ready.guilds) {
      const { channels: guildChannels, members: guildMembers, member_count, threads: guildThreads, ...guild } = entry;
      guilds[guild.id] = guild;
      guildOrder.push(guild.id);
      memberCounts[guild.id] = member_count;
      for (const channel of guildChannels) channels[channel.id] = channel;
      for (const thread of guildThreads ?? []) threads[thread.id] = thread;
      members[guild.id] = {};
      for (const member of guildMembers) {
        members[guild.id]![member.user.id] = member;
        users[member.user.id] = member.user;
      }
    }
    const privateIds: Snowflake[] = [];
    for (const channel of ready.private_channels) {
      channels[channel.id] = channel;
      privateIds.push(channel.id);
      for (const user of channel.recipients ?? []) users[user.id] = user;
    }
    const presences: Record<Snowflake, Presence> = {};
    for (const presence of ready.presences) presences[presence.user_id] = presence;
    const readStates: Record<Snowflake, ReadState> = {};
    for (const state of ready.read_states) readStates[state.channel_id] = state;
    const relationships: Record<Snowflake, Relationship> = {};
    for (const relationship of ready.relationships) {
      relationships[relationship.id] = relationship;
      users[relationship.user.id] = relationship.user;
    }
    // Archived threads are not in READY: keep the ones the UI opened (a reconnect must not close the panel).
    for (const [id, thread] of Object.entries(get().threads)) if (thread.thread_metadata?.archived && thread.guild_id && guilds[thread.guild_id] && !threads[id]) threads[id] = thread;
    set({
      ready: true,
      stale: false,
      me: ready.user,
      guilds,
      guildOrder,
      channels,
      threads,
      privateChannels: sortPrivate(channels, privateIds),
      presences,
      readStates,
      members,
      memberCounts,
      relationships,
      users: { ...get().users, ...users },
      typing: {},
    });
  },

  upsertChannel(channel) {
    const state = get();
    const channels = { ...state.channels, [channel.id]: channel };
    const patch: Partial<AppState> = { channels };
    if (channel.type === ChannelType.DM || channel.type === ChannelType.GroupDM) {
      const ids = state.privateChannels.includes(channel.id) ? state.privateChannels : [...state.privateChannels, channel.id];
      patch.privateChannels = sortPrivate(channels, ids);
      if (channel.recipients) get().cacheUsers(channel.recipients);
    }
    set(patch);
  },

  removeChannel(id) {
    const state = get();
    if (!state.channels[id]) return;
    const { [id]: _removed, ...channels } = state.channels;
    void _removed;
    set({ channels, privateChannels: state.privateChannels.filter(c => c !== id) });
  },

  upsertThread(thread) {
    const state = get();
    const prev = state.threads[thread.id];
    // Updates for other members may omit the viewer's own membership: keep what we know.
    const next = prev?.member && !thread.member ? { ...thread, member: prev.member } : thread;
    set({ threads: { ...state.threads, [thread.id]: next } });
  },

  removeThread(id) {
    const state = get();
    if (!state.threads[id]) return;
    const { [id]: _removed, ...threads } = state.threads;
    void _removed;
    set({ threads });
  },

  removeGuild(id) {
    const state = get();
    if (!state.guilds[id]) return;
    const { [id]: _g, ...guilds } = state.guilds;
    const { [id]: _m, ...members } = state.members;
    void _g;
    void _m;
    const channels: Record<Snowflake, Channel> = {};
    for (const [cid, channel] of Object.entries(state.channels)) if (channel.guild_id !== id) channels[cid] = channel;
    const threads: Record<Snowflake, Channel> = {};
    for (const [tid, thread] of Object.entries(state.threads)) if (thread.guild_id !== id) threads[tid] = thread;
    set({ guilds, members, channels, threads, guildOrder: state.guildOrder.filter(g => g !== id) });
  },

  setReadState(readState) {
    set({ readStates: { ...get().readStates, [readState.channel_id]: readState } });
  },

  setMe(user) {
    set({ me: user, users: { ...get().users, [user.id]: user } });
  },

  reset() {
    set({ ...initial, lastChannelByGuild: get().lastChannelByGuild });
  },
}));

/** Subscribe to the store. Uses shallow equality so selectors may return fresh arrays/objects without re-render loops. */
export function useStore<T>(selector: (s: AppState) => T): T {
  const previous = useRef<{ value: T } | null>(null);
  const snapshot = (): T => {
    const next = selector(appStore.getState());
    if (previous.current && shallow(previous.current.value, next)) return previous.current.value;
    previous.current = { value: next };
    return next;
  };
  return useSyncExternalStore(appStore.subscribe, snapshot, snapshot);
}

// ---- gateway wiring (once, at module load) ----

const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
const TYPING_MS = 10_000;

function clearTyping(channelId: Snowflake, userId: Snowflake): void {
  const state = appStore.getState();
  const channel = state.typing[channelId];
  if (!channel || !(userId in channel)) return;
  const { [userId]: _gone, ...rest } = channel;
  void _gone;
  appStore.setState({ typing: { ...state.typing, [channelId]: rest } });
}

/** Does this message raise my unread mention counter? The server's rule: only ordinary messages, by name, @everyone or one of my roles in `mention_roles`; the Suppress toggles are per server there. */
function mentionsMe(message: Message): boolean {
  if (appStore.getState().relationships[message.author.id]?.type === RelationshipType.Blocked) return false;
  if (message.type !== MessageType.Default && message.type !== MessageType.Reply) return false;
  const state = appStore.getState();
  const meId = state.me?.id;
  if (!meId) return false;
  const roles = message.guild_id ? (state.members[message.guild_id]?.[meId]?.roles ?? []) : [];
  const kinds = mentionKinds(message, meId, roles, message.guild_id ? [message.guild_id] : [], useLocalState.getState());
  return kinds.direct || kinds.everyone || kinds.role;
}

/** A message in a thread: keep its counters and read state current (threads are not in `channels`). */
function onThreadMessage(thread: Channel, message: Message): void {
  const state = appStore.getState();
  const counted = message.type !== MessageType.ThreadStarterMessage && message.id !== thread.id;
  state.upsertThread({ ...thread, last_message_id: message.id, message_count: (thread.message_count ?? 0) + (counted ? 1 : 0) });
  const read = state.readStates[thread.id] ?? { channel_id: thread.id, last_message_id: thread.last_message_id, mention_count: 0 };
  if (state.me?.id === message.author.id) state.setReadState({ ...read, last_message_id: message.id, mention_count: 0 });
  else if (mentionsMe(message)) state.setReadState({ ...read, mention_count: read.mention_count + 1 });
}

function onMessageCreate(message: Message): void {
  const state = appStore.getState();
  // Ephemeral interaction responses are not part of the channel: they move neither last_message_id nor read states.
  if (((message.flags ?? 0) & MessageFlags.Ephemeral) !== 0) return;
  const channel = state.channels[message.channel_id];
  state.cacheUsers([message.author, ...message.mentions]);
  clearTyping(message.channel_id, message.author.id);
  const thread = channel ? undefined : state.threads[message.channel_id];
  if (thread) {
    onThreadMessage(thread, message);
    return;
  }
  if (!channel) {
    // A DM we have not seen yet (or a guild we have not joined locally): refresh the DM list.
    if (!message.guild_id) void refreshPrivateChannels();
    return;
  }
  const mine = state.me?.id === message.author.id;
  const previousLast = channel.last_message_id;
  state.upsertChannel({ ...channel, last_message_id: !previousLast || compareIds(message.id, previousLast) > 0 ? message.id : previousLast });
  const read = appStore.getState().readStates[channel.id] ?? { channel_id: channel.id, last_message_id: previousLast, mention_count: 0 };
  if (mine) {
    state.setReadState({ ...read, last_message_id: message.id, mention_count: 0 });
  } else {
    // In DMs and group DMs every ordinary message counts as a mention (the server's counter does the same).
    const dm = !channel.guild_id && (message.type === MessageType.Default || message.type === MessageType.Reply) && state.relationships[message.author.id]?.type !== RelationshipType.Blocked;
    const mentioned = dm || mentionsMe(message);
    state.setReadState({ ...read, mention_count: read.mention_count + (mentioned ? 1 : 0) });
  }
}

async function refreshPrivateChannels(): Promise<void> {
  try {
    const channels = await request<Channel[]>("GET", "/users/@me/channels");
    for (const channel of channels) appStore.getState().upsertChannel(channel);
  } catch {
    /* next READY will fix it */
  }
}

/** The connection banner waits this long before appearing, and others' presences stay shown, so a quick resume never flashes either. */
export const BANNER_GRACE_MS = 1500;

/** Servers this client is leaving or deleting itself: their GUILD_DELETE (which can arrive before the HTTP answer) gets no "you're no longer in" notice. */
export const selfRemoving = new Set<Snowflake>();

// Others' presence is unknown while the gateway is down: shown as offline until RESUMED brings the kept map back
// (under anything replayed) or READY replaces it. Like the banner, this waits BANNER_GRACE_MS, so a blip that resumes
// inside it changes nothing. The user's own presence stays.
let hiddenPresences: Record<Snowflake, Presence> = {};
let hideTimer: ReturnType<typeof setTimeout> | undefined;
export function applyConnection(connection: GatewayStatus): void {
  const previous = appStore.getState().connection;
  if (previous === "ready" && connection !== "ready") {
    hideTimer = setTimeout(() => {
      hideTimer = undefined;
      const { presences, me } = appStore.getState();
      hiddenPresences = presences;
      const own = me ? presences[me.id] : undefined;
      appStore.setState({ presences: own ? { [own.user_id]: own } : {} });
    }, BANNER_GRACE_MS);
    appStore.setState({ connection });
  } else if (previous !== "ready" && connection === "ready") {
    clearTimeout(hideTimer);
    hideTimer = undefined;
    appStore.setState({ connection, presences: { ...hiddenPresences, ...appStore.getState().presences } });
    hiddenPresences = {};
  } else appStore.setState({ connection });
}

let wired = false;
export function wireStoreToGateway(): void {
  if (wired) return;
  wired = true;
  const s = () => appStore.getState();
  gateway.onStatus(applyConnection);
  gateway.on("READY", ready => { setMaxUploadBytes(ready.max_upload_bytes); setSpotifyOwner(ready.spotify_owner_id); s().applyReady(ready); });
  gateway.on("MESSAGE_CREATE", onMessageCreate);
  // Also how a read on another device reaches this one (and its Dock badge). Like the server, the mention counter only
  // resets once the ack has caught up with the newest message: a stale ack must not hide a mention that arrived after it.
  gateway.on("MESSAGE_ACK", ({ channel_id, message_id }) => {
    const state = s();
    const read = state.readStates[channel_id];
    const newest = (state.channels[channel_id] ?? state.threads[channel_id])?.last_message_id;
    const caughtUp = !newest || compareIds(message_id, newest) >= 0;
    state.setReadState({ channel_id, last_message_id: maxId(read?.last_message_id, message_id), mention_count: caughtUp ? 0 : (read?.mention_count ?? 0) });
  });
  gateway.on("TYPING_START", ({ channel_id, user_id }) => {
    if (user_id === s().me?.id) return;
    const expiry = Date.now() + TYPING_MS;
    const state = s();
    appStore.setState({ typing: { ...state.typing, [channel_id]: { ...state.typing[channel_id], [user_id]: expiry } } });
    const key = `${channel_id}:${user_id}`;
    const existing = typingTimers.get(key);
    if (existing) clearTimeout(existing);
    typingTimers.set(
      key,
      setTimeout(() => {
        typingTimers.delete(key);
        const current = s().typing[channel_id]?.[user_id];
        if (current !== undefined && current <= Date.now()) clearTyping(channel_id, user_id);
      }, TYPING_MS + 50),
    );
  });
  gateway.on("CHANNEL_CREATE", c => s().upsertChannel(c));
  gateway.on("CHANNEL_UPDATE", c => s().upsertChannel(c));
  gateway.on("CHANNEL_RECIPIENT_ADD", ({ channel_id, user }) => {
    const channel = s().channels[channel_id];
    if (!channel) return;
    const recipients = channel.recipients ?? [];
    if (!recipients.some(r => r.id === user.id)) s().upsertChannel({ ...channel, recipients: [...recipients, user] });
  });
  gateway.on("CHANNEL_RECIPIENT_REMOVE", ({ channel_id, user }) => {
    const channel = s().channels[channel_id];
    if (channel?.recipients) s().upsertChannel({ ...channel, recipients: channel.recipients.filter(r => r.id !== user.id) });
  });
  gateway.on("CHANNEL_DELETE", c => {
    const open = s().route.channelId === c.id;
    s().removeChannel(c.id);
    if (open && c.guild_id) go(guildPath(c.guild_id), { replace: true });
  });
  gateway.on("GUILD_CREATE", entry => {
    const { channels, members, member_count, presences, threads, ...guild } = entry;
    const state = s();
    const nextPresences = { ...state.presences };
    for (const p of presences ?? []) nextPresences[p.user_id] = p;
    const nextChannels = { ...state.channels };
    for (const channel of channels) nextChannels[channel.id] = channel;
    const nextThreads = { ...state.threads };
    for (const thread of threads ?? []) nextThreads[thread.id] = thread;
    const memberMap: Record<Snowflake, GuildMember> = {};
    for (const member of members) memberMap[member.user.id] = member;
    appStore.setState({
      guilds: { ...state.guilds, [guild.id]: guild },
      guildOrder: state.guildOrder.includes(guild.id) ? state.guildOrder : [...state.guildOrder, guild.id],
      channels: nextChannels,
      threads: nextThreads,
      members: { ...state.members, [guild.id]: memberMap },
      memberCounts: { ...state.memberCounts, [guild.id]: member_count },
      presences: nextPresences,
    });
    state.cacheUsers(members.map(m => m.user));
  });
  gateway.on("GUILD_UPDATE", guild => {
    const state = s();
    appStore.setState({ guilds: { ...state.guilds, [guild.id]: { ...state.guilds[guild.id], ...guild } } });
  });
  gateway.on("GUILD_DELETE", ({ id }) => {
    // Kicked, banned or deleted while the guild is open: leave its (now dead) route.
    const open = s().route.guildId === id;
    // The event carries no reason (kick, ban and deletion look the same, and the server never sends `unavailable`), so the notice is
    // neutral. Not for our own leave or delete, nor for a repeat event or a resync that already dropped the guild.
    const lost = selfRemoving.has(id) ? undefined : s().guilds[id];
    s().removeGuild(id);
    if (open) go("/channels/@me", { replace: true });
    if (lost) openModal({ type: "guildGone", name: lost.name });
  });
  gateway.on("GUILD_MEMBER_UPDATE", ({ guild_id, ...member }) => {
    // The event carries the full member and omits false/0 defaults (mute, deaf, flags), so replace the entry: a merge would keep a stale `true`.
    const state = s();
    const known = state.members[guild_id] ?? {};
    appStore.setState({ members: { ...state.members, [guild_id]: { ...known, [member.user.id]: member } } });
    state.cacheUsers([member.user]);
  });
  // The Bans page refetches on open; nothing to keep in the store.
  gateway.on("GUILD_BAN_ADD", () => undefined);
  gateway.on("GUILD_BAN_REMOVE", () => undefined);
  const patchRoles = (guildId: Snowflake, change: (roles: Role[]) => Role[]) => {
    const state = s();
    const guild = state.guilds[guildId];
    if (!guild) return;
    const roles = sortRoles(change(guild.roles));
    appStore.setState({ guilds: { ...state.guilds, [guildId]: { ...guild, roles } } });
  };
  const upsertRole = (guildId: Snowflake, role: Role) => patchRoles(guildId, roles => [...roles.filter(r => r.id !== role.id), role]);
  gateway.on("GUILD_ROLE_CREATE", ({ guild_id, role }) => upsertRole(guild_id, role));
  gateway.on("GUILD_ROLE_UPDATE", ({ guild_id, role }) => upsertRole(guild_id, role));
  gateway.on("GUILD_ROLE_DELETE", ({ guild_id, role_id }) => {
    patchRoles(guild_id, roles => roles.filter(r => r.id !== role_id));
    const state = s();
    const known = state.members[guild_id];
    if (!known) return;
    const members: Record<Snowflake, GuildMember> = {};
    for (const [id, member] of Object.entries(known)) members[id] = member.roles.includes(role_id) ? { ...member, roles: member.roles.filter(r => r !== role_id) } : member;
    appStore.setState({ members: { ...state.members, [guild_id]: members } });
  });
  gateway.on("GUILD_MEMBER_ADD", ({ guild_id, ...member }) => {
    const state = s();
    const known = state.members[guild_id] ?? {};
    appStore.setState({
      members: { ...state.members, [guild_id]: { ...known, [member.user.id]: member } },
      memberCounts: { ...state.memberCounts, [guild_id]: (state.memberCounts[guild_id] ?? Object.keys(known).length) + (known[member.user.id] ? 0 : 1) },
    });
    state.cacheUsers([member.user]);
  });
  gateway.on("GUILD_MEMBER_REMOVE", ({ guild_id, user }) => {
    const state = s();
    const known = state.members[guild_id];
    if (!known?.[user.id]) return;
    const { [user.id]: _gone, ...rest } = known;
    void _gone;
    appStore.setState({
      members: { ...state.members, [guild_id]: rest },
      memberCounts: { ...state.memberCounts, [guild_id]: Math.max(0, (state.memberCounts[guild_id] ?? 1) - 1) },
    });
  });
  gateway.on("USER_UPDATE", user => {
    const state = s();
    if (state.me?.id === user.id) state.setMe(user);
    // Member / recipient / relationship copies embed the user: refresh them so every view shows the new profile.
    const members = { ...state.members };
    for (const [guildId, map] of Object.entries(members)) {
      const member = map[user.id];
      if (member) members[guildId] = { ...map, [user.id]: { ...member, user } };
    }
    const channels = { ...state.channels };
    for (const [id, channel] of Object.entries(channels)) {
      if (channel.recipients?.some(r => r.id === user.id)) channels[id] = { ...channel, recipients: channel.recipients.map(r => (r.id === user.id ? user : r)) };
    }
    const relationships = state.relationships[user.id] ? { ...state.relationships, [user.id]: { ...state.relationships[user.id]!, user } } : state.relationships;
    // The server sends the full User: replace the cached copy outright (cacheUsers only diffs a few fields).
    appStore.setState({ users: { ...state.users, [user.id]: user }, members, channels, relationships });
  });
  gateway.on("PRESENCE_UPDATE", presence => appStore.setState({ presences: { ...s().presences, [presence.user_id]: presence } }));
  gateway.on("RELATIONSHIP_ADD", relationship => {
    appStore.setState({ relationships: { ...s().relationships, [relationship.id]: relationship } });
    s().cacheUsers([relationship.user]);
  });
  gateway.on("RELATIONSHIP_REMOVE", ({ id }) => {
    const { [id]: _gone, ...rest } = s().relationships;
    void _gone;
    appStore.setState({ relationships: rest });
  });
}

wireStoreToGateway();

// ---- threads ----

const threadRefresh = new Map<Snowflake, ReturnType<typeof setTimeout>>();

/**
 * The server sends no thread list sync: after something that can change which threads the user sees (own roles, a role or a channel's
 * overwrites) the active list of the guild is fetched again and replaces the unarchived threads the store holds for it.
 */
export function refreshActiveThreads(guildId: Snowflake): void {
  const pending = threadRefresh.get(guildId);
  if (pending) clearTimeout(pending);
  threadRefresh.set(
    guildId,
    setTimeout(() => {
      threadRefresh.delete(guildId);
      listActiveThreads(guildId)
        .then(({ threads }) => {
          const state = appStore.getState();
          if (!state.guilds[guildId]) return;
          const next: Record<Snowflake, Channel> = {};
          for (const [id, thread] of Object.entries(state.threads)) if (thread.guild_id !== guildId || thread.thread_metadata?.archived) next[id] = thread;
          for (const thread of threads) next[thread.id] = state.threads[thread.id]?.member && !thread.member ? { ...thread, member: state.threads[thread.id]!.member } : thread;
          appStore.setState({ threads: next });
        })
        .catch(error => console.warn("active threads refetch failed", error));
    }, 150),
  );
}

/** Whether the current user may manage threads of this thread's parent (MANAGE_THREADS, owner and administrators included). */
export function canManageThreadsIn(thread: Channel): boolean {
  const state = appStore.getState();
  const guild = thread.guild_id ? state.guilds[thread.guild_id] : undefined;
  const me = state.me;
  if (!guild || !me) return false;
  const member = state.members[guild.id]?.[me.id];
  const parent = thread.parent_id ? state.channels[thread.parent_id] : undefined;
  return hasBit(channelPermissions(guild, { id: me.id, roles: member?.roles ?? [] }, parent), Perm.MANAGE_THREADS);
}

function wireThreadEvents(): void {
  const s = () => appStore.getState();
  // A thread that shows up after READY gets the empty read state READY would have carried for it, so it can read as unread: a new
  // thread someone else started, or one that was unarchived. A read state we already have is kept.
  const emptyReadState = (thread: Channel) => {
    if (!s().readStates[thread.id]) s().setReadState({ channel_id: thread.id, last_message_id: null, mention_count: 0 });
  };
  gateway.on("THREAD_CREATE", thread => {
    s().upsertThread(thread);
    if (thread.owner_id !== s().me?.id) emptyReadState(thread);
  });
  gateway.on("THREAD_UPDATE", thread => {
    const before = s().threads[thread.id];
    s().upsertThread(thread);
    if ((!before || before.thread_metadata?.archived) && !thread.thread_metadata?.archived) emptyReadState(thread);
  });
  gateway.on("THREAD_DELETE", ({ id }) => s().removeThread(id));
  gateway.on("THREAD_MEMBER_UPDATE", ({ guild_id: _guild, ...member }) => {
    void _guild;
    const thread = s().threads[member.id];
    if (thread) s().upsertThread({ ...thread, member });
  });
  gateway.on("THREAD_MEMBERS_UPDATE", ({ id, guild_id, member_count, added_members, removed_member_ids }) => {
    const thread = s().threads[id];
    if (!thread) return;
    const meId = s().me?.id;
    const mine = added_members?.find(m => m.user_id === meId);
    let next: Channel = { ...thread, member_count };
    if (mine) next = { ...next, member: mine };
    if (meId && removed_member_ids?.includes(meId)) {
      const { member: _member, ...rest } = next;
      void _member;
      next = rest;
      // A private thread is gone for a member who left it (unless they can manage threads: the refetch brings it back).
      if (thread.type === ChannelType.PrivateThread) {
        s().removeThread(id);
        refreshActiveThreads(guild_id);
        return;
      }
      // Not upsertThread: that keeps the membership it knew about.
      appStore.setState({ threads: { ...s().threads, [id]: next } });
      return;
    }
    s().upsertThread(next);
  });
  const refreshMine = (guildId: Snowflake) => refreshActiveThreads(guildId);
  gateway.on("GUILD_MEMBER_UPDATE", ({ guild_id, user }) => {
    if (user.id === s().me?.id) refreshMine(guild_id);
  });
  gateway.on("GUILD_ROLE_UPDATE", ({ guild_id }) => refreshMine(guild_id));
  gateway.on("GUILD_ROLE_DELETE", ({ guild_id }) => refreshMine(guild_id));
  gateway.on("CHANNEL_UPDATE", channel => {
    if (channel.guild_id && channel.permission_overwrites) refreshMine(channel.guild_id);
  });
  // The server deletes a channel's threads first (THREAD_DELETE each); drop any stragglers.
  gateway.on("CHANNEL_DELETE", channel => {
    for (const thread of Object.values(s().threads)) if (thread.parent_id === channel.id) s().removeThread(thread.id);
  });
}

wireThreadEvents();

// ---- helpers ----

/** Server nickname, then display name, then username. */
export function displayName(user: Pick<User, "username" | "global_name">, member?: { nick: string | null } | null): string {
  return member?.nick || user.global_name || user.username;
}

/** Roles by position descending, ties by id ascending (numeric). Never relies on the order the server sent. */
export function sortRoles(roles: readonly Role[]): Role[] {
  return [...roles].sort((a, b) => {
    if (a.position !== b.position) return b.position - a.position;
    const x = BigInt(a.id);
    const y = BigInt(b.id);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

/** CSS colour of the highest role with a colour, or null (use the default text colour). */
export function roleColor(guildId: Snowflake | null | undefined, member: { roles: Snowflake[] } | null | undefined): string | null {
  if (!guildId || !member) return null;
  const guild = appStore.getState().guilds[guildId];
  if (!guild) return null;
  let best: { position: number; color: number } | null = null;
  for (const role of guild.roles) {
    if (role.color === 0 || !member.roles.includes(role.id)) continue;
    if (!best || role.position > best.position) best = role;
  }
  return best ? `#${best.color.toString(16).padStart(6, "0")}` : null;
}

/** The highest role with an icon (`unicode_emoji`), shown next to the name like Discord's role icon; null when none has one. */
export function roleIcon(guildId: Snowflake | null | undefined, member: { roles: Snowflake[] } | null | undefined): Role | null {
  if (!guildId || !member) return null;
  let best: Role | null = null;
  for (const role of appStore.getState().guilds[guildId]?.roles ?? []) {
    if (!role.unicode_emoji || !member.roles.includes(role.id)) continue;
    if (!best || role.position > best.position) best = role;
  }
  return best;
}

const DEFAULT_AVATAR_COLORS = ["#5865f2", "#6d7380", "#3ba55d", "#e0a23a", "#c45bd0", "#e5484d"];
const avatarCache = new Map<number, string>();

/** Our own simple coloured blob; colour is derived from the user id. */
export function defaultAvatarUrl(userId: Snowflake): string {
  let index = 0;
  try {
    index = Number(BigInt(userId) % BigInt(DEFAULT_AVATAR_COLORS.length));
  } catch {
    index = userId.length % DEFAULT_AVATAR_COLORS.length;
  }
  let url = avatarCache.get(index);
  if (!url) {
    const color = DEFAULT_AVATAR_COLORS[index] ?? "#5865f2";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" fill="${color}"/><path d="M64 28c18 0 34 12 34 30 0 10-5 17-5 26 0 11-12 18-29 18-17 0-29-8-29-19 0-9-5-15-5-25 0-18 16-30 34-30z" fill="#fff" fill-opacity=".92"/><circle cx="50" cy="62" r="5" fill="${color}"/><circle cx="78" cy="62" r="5" fill="${color}"/></svg>`;
    url = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
    avatarCache.set(index, url);
  }
  return url;
}

export function avatarUrl(user: Pick<User, "id" | "avatar">): string {
  return user.avatar ? resolveUrl(user.avatar) : defaultAvatarUrl(user.id);
}

export function guildIconUrl(guild: Pick<Guild, "icon">): string | null {
  return guild.icon ? resolveUrl(guild.icon) : null;
}

/** "Sam's server" → "Ss" (first letter of each word, max 3), like Discord's acronym. */
export function guildInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map(word => word[0] ?? "")
    .join("")
    .slice(0, 3);
}

/** Name shown for a DM / group DM: the other person, or the recipients joined with ", ". */
export function dmName(channel: Channel): string {
  if (channel.name) return channel.name;
  return (channel.recipients ?? []).map(u => displayName(u)).join(", ") || "Unknown";
}

// ---- unread selectors (pass to useStore) ----

export function isChannelUnread(s: AppState, channelId: Snowflake): boolean {
  const channel = s.channels[channelId];
  if (!channel?.last_message_id) return false;
  // Voice channels count: their text-in-voice chat can be unread.
  if (channel.type === ChannelType.GuildCategory) return false;
  const read = s.readStates[channelId]?.last_message_id;
  return !read || compareIds(channel.last_message_id, read) > 0;
}

export function channelMentionCount(s: AppState, channelId: Snowflake): number {
  return s.readStates[channelId]?.mention_count ?? 0;
}

/** A channel, DM or thread by id (threads are not in `channels`). */
export function channelOrThread(s: Pick<AppState, "channels" | "threads">, id: Snowflake): Channel | undefined {
  return s.channels[id] ?? s.threads[id];
}

/** Threads that take part in unread state: active ones the viewer joined (archived ones and ones only looked at have no read state worth a dot). */
export function joinedThreads(s: Pick<AppState, "threads">): Channel[] {
  return Object.values(s.threads).filter(t => t.member && !t.thread_metadata?.archived);
}

/**
 * Muted like a channel row: the thread's own member mute (a timed one lapses at its end), then `isMuted` on the thread, its parent
 * channel and that channel's category.
 */
export function isThreadQuiet(s: Pick<AppState, "channels">, thread: Channel, isMuted: (id: Snowflake) => boolean = () => false): boolean {
  const end = thread.member?.mute_config?.end_time;
  if (thread.member?.muted && (!end || Date.parse(end) > Date.now())) return true;
  const parent = thread.parent_id ? s.channels[thread.parent_id] : undefined;
  return [thread.id, thread.parent_id, parent?.parent_id].some(id => id != null && isMuted(id));
}

/** `isMuted` (a channel or category id): muted channels drop out of the unread half, their mentions still count (as in Discord). Joined threads count like channels, muted through their member, parent channel or category. */
export function guildUnread(s: AppState, guildId: Snowflake, isMuted?: (id: Snowflake) => boolean): { unread: boolean; mentions: number } {
  let unread = false;
  let mentions = 0;
  for (const channel of Object.values(s.channels)) {
    if (channel.guild_id !== guildId) continue;
    if (!unread && isChannelUnread(s, channel.id) && !(isMuted && (isMuted(channel.id) || (channel.parent_id != null && isMuted(channel.parent_id))))) unread = true;
    mentions += channelMentionCount(s, channel.id);
  }
  for (const thread of joinedThreads(s)) {
    if (thread.guild_id !== guildId) continue;
    if (!unread && isThreadUnread(thread, s.readStates[thread.id]) && !isThreadQuiet(s, thread, isMuted)) unread = true;
    mentions += channelMentionCount(s, thread.id);
  }
  return { unread, mentions };
}

/** Users currently typing in a channel (excluding me). */
export function typingUserIds(s: AppState, channelId: Snowflake): Snowflake[] {
  const now = Date.now();
  return Object.entries(s.typing[channelId] ?? {})
    .filter(([, expiry]) => expiry > now)
    .map(([id]) => id);
}

export function useUser(userId: Snowflake | null | undefined): User | undefined {
  return useStore(s => (userId ? s.users[userId] : undefined));
}
