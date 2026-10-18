// Restart-surviving startup cache: the app reopens on the last channel with its last ~50 messages before the gateway's READY.
// One IndexedDB record per user id holds a trimmed READY (every guild for the rail, but channels, members and read states only
// for the open guild) plus the open channel's newest page. Message metadata only: attachments are URLs, never blobs. The store
// shows it with `stale` set (the composer waits for READY); the real READY replaces it, and the message store refetches every
// loaded channel on READY as it does after any reconnect. Signing out (or a dead token) deletes the user's record.
import { appStore } from "../api/store";
import type { Channel, Message, ReadyEvent, Snowflake } from "../api/types";
import { messageStore } from "../chat/messageStore";
import { guildLayoutStore } from "../rail/guildLayoutStore";

const DB_NAME = "vokko-startup-cache";
const STORE = "snapshots";
const OWNER_KEY = "vokko.cache.owner";
const VERSION = 1;
const MESSAGES = 50;
/** Serialized size cap; a bigger snapshot is not written (and the old one is dropped). */
export const MAX_BYTES = 2 * 1024 * 1024;
/** Startup never waits longer than this for IndexedDB. */
const RESTORE_TIMEOUT_MS = 400;
const SAVE_DELAY_MS = 3000;

export interface Snapshot {
  v: typeof VERSION;
  userId: Snowflake;
  savedAt: number;
  path: string;
  channelId: Snowflake;
  ready: ReadyEvent;
  messages: Message[];
}

/** Who the stored token belongs to: the user id and a hash of the token, so another account's token never sees this cache. */
interface Owner {
  id: Snowflake;
  tag: string;
}

function tokenTag(token: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) h = Math.imul(h ^ token.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

function readOwner(): Owner | null {
  try {
    const raw = localStorage.getItem(OWNER_KEY);
    return raw ? (JSON.parse(raw) as Owner) : null;
  } catch {
    return null;
  }
}

function writeOwner(owner: Owner | null): void {
  try {
    if (owner) localStorage.setItem(OWNER_KEY, JSON.stringify(owner));
    else localStorage.removeItem(OWNER_KEY);
  } catch {
    /* storage unavailable: no cache */
  }
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return (dbPromise ??= new Promise(resolve => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  }));
}

async function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const database = await db();
  if (!database) return null;
  return new Promise(resolve => {
    try {
      const req = fn(database.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** The snapshot of the current state, or null when there is nothing worth caching (no open channel, not signed in). */
export function buildSnapshot(): Snapshot | null {
  const s = appStore.getState();
  const channelId = s.route.channelId;
  if (!s.ready || !s.me || !channelId) return null;
  const channel = s.channels[channelId];
  if (!channel) return null;
  const guildId = s.route.guildId;
  const messages = messageStore.getState(channelId).messages;
  // the newest page only, and only when it is the present (not a window jumped back in history)
  const page = messageStore.getState(channelId).hasMoreAfter ? [] : messages.slice(-MESSAGES);
  const authors = new Set(page.map(m => m.author.id));
  authors.add(s.me.id);
  const guildChannels = (id: Snowflake): Channel[] => Object.values(s.channels).filter(c => c.guild_id === id);
  const ready: ReadyEvent = {
    v: 1,
    user: s.me,
    session_id: "",
    guilds: s.guildOrder.flatMap(id => {
      const guild = s.guilds[id];
      if (!guild) return [];
      const open = id === guildId;
      const members = open ? Object.values(s.members[id] ?? {}).filter(m => authors.has(m.user.id)) : [];
      return [{ ...guild, channels: open ? guildChannels(id) : [], members, member_count: s.memberCounts[id] ?? 0 }];
    }),
    private_channels: s.privateChannels.flatMap(id => (s.channels[id] ? [s.channels[id]] : [])),
    presences: [],
    read_states: Object.values(s.readStates).filter(r => r.channel_id === channelId || s.channels[r.channel_id]?.guild_id === guildId),
    relationships: [],
    guild_layout: guildLayoutStore.getState().settings,
  };
  const path = guildId ? `/channels/${guildId}/${channelId}` : `/channels/@me/${channelId}`;
  return { v: VERSION, userId: s.me.id, savedAt: Date.now(), path, channelId, ready, messages: page };
}

/** Writes the current state (at most MAX_BYTES serialized; a bigger one removes the old record instead). */
export async function saveNow(): Promise<void> {
  const snapshot = buildSnapshot();
  const token = appStore.getState().token;
  if (!snapshot || !token) return;
  writeOwner({ id: snapshot.userId, tag: tokenTag(token) });
  const size = JSON.stringify(snapshot).length;
  if (size > MAX_BYTES) await run("readwrite", store => store.delete(snapshot.userId));
  else await run("readwrite", store => store.put(snapshot, snapshot.userId));
}

/** Drops the cache of whoever owned it (sign-out, a rejected token). */
export async function clearStartupCache(): Promise<void> {
  const owner = readOwner();
  writeOwner(null);
  if (owner) await run("readwrite", store => store.delete(owner.id));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>(resolve => setTimeout(() => resolve(null), ms))]);
}

/**
 * Call once before the session starts and React mounts: when the stored token's owner has a snapshot, fills the store with it
 * (marked `stale`), seeds the channel's messages, and turns a start at `/` into the cached channel's path.
 */
export async function restoreStartupCache(token: string | null): Promise<boolean> {
  const owner = readOwner();
  if (!token || !owner || owner.tag !== tokenTag(token)) return false;
  const snapshot = await withTimeout(run<Snapshot | undefined>("readonly", store => store.get(owner.id) as IDBRequest<Snapshot | undefined>), RESTORE_TIMEOUT_MS);
  if (!snapshot || snapshot.v !== VERSION || snapshot.userId !== owner.id || appStore.getState().ready) return false;
  appStore.getState().applyReady(snapshot.ready);
  guildLayoutStore.setState({ settings: snapshot.ready.guild_layout });
  appStore.setState({ ready: false, stale: true });
  messageStore.setCurrentUser(owner.id);
  if (snapshot.messages.length > 0) messageStore.seed(snapshot.channelId, snapshot.messages);
  if (location.pathname === "/") history.replaceState(history.state, "", snapshot.path + location.search);
  return true;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;

function scheduleSave(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void saveNow();
  }, SAVE_DELAY_MS);
}

/** Keeps the snapshot current: after READY, a channel switch or new messages there (debounced), and when the window is hidden. */
export function startStartupCache(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  appStore.subscribe((state, prev) => {
    if (prev.token && !state.token) {
      if (timer) clearTimeout(timer);
      timer = null;
      void clearStartupCache();
      return;
    }
    if (!state.ready) return;
    if (state.ready !== prev.ready || state.route.channelId !== prev.route.channelId) scheduleSave();
  });
  let unsubscribe: (() => void) | null = null;
  let watching: Snowflake | null = null;
  appStore.subscribe(state => {
    const id = state.ready ? state.route.channelId : null;
    if (id === watching) return;
    unsubscribe?.();
    watching = id;
    unsubscribe = id ? messageStore.subscribe(id, scheduleSave) : null;
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && appStore.getState().ready) void saveNow();
  });
}
