// In-memory backend used when VITE_VOKKO_API is unset (browser preview, screenshots, tests).
// REST goes through `mockRequest`, the gateway through `MockSocket`; both are wired in rest.ts / gateway.ts.

import { MOCK } from "../config";
import { MAX_UPLOAD_BYTES } from "../limits";
import { ApiRequestError, RateLimitedError } from "../errors";
import { snowflakeToTimestamp } from "../snowflake";
import type { Attachment, GifProvider, PresenceStatus, UserSettings, UserSettingsData } from "../types";
import { db, nextId } from "./db";
import { seedOnboardingGuild, type SeededGuild } from "./community";
import { addMessage, createAccount } from "./ops";
import { handleRoute } from "./routes";
import { apps, executeWebhook, installEchoBot, setInternalRouter } from "./apps";
import "./accounts";
import { setCurrentToken } from "./sessions";
import { seed } from "./seed";
import { seedBig } from "./seedBig";
import { setMockMaintenance } from "./status";
import { sweepArchivedThreads } from "./threads";
import { MockSocket, dropAllConnections, emit, setOffline, tokenFor, userIdFromToken } from "./socket";
import { setMockVoice } from "./voice";
import { patchSettings, settingsOf } from "./settings";

export { MockSocket };

// The mock Echo bot answers through the same token routes a real bot uses.
setInternalRouter((method, path, body) => handleRoute(method, path, body, null));

if (MOCK) {
  seed();
  // `?seed=big` adds the perf harness server (200 channels, 5,000 members, 20,000 messages in #firehose).
  try {
    if (new URLSearchParams(window.location.search).get("seed") === "big") seedBig();
  } catch {
    /* no window (tests) */
  }
  // Threads without a message for their auto-archive duration are archived (THREAD_UPDATE), like the server's minute sweep.
  setInterval(() => sweepArchivedThreads(), 30_000);
  // `?mockGifProvider=none` boots a mock whose GIF provider is not configured (the picker then shows favourites only).
  try {
    const provider = new URLSearchParams(window.location.search).get("mockGifProvider");
    if (provider === "none" || provider === "klipy" || provider === "giphy" || provider === "tenor") db.gifProvider = provider;
  } catch {
    /* no window (tests) */
  }
}

/** Simulated network latency in ms; `?mockLatency=0` in the URL (or localStorage `vokko.mock.latency`) overrides it. */
function latency(): number {
  try {
    const q = new URLSearchParams(window.location.search).get("mockLatency") ?? localStorage.getItem("vokko.mock.latency");
    if (q !== null && q !== "") return Math.max(0, Number(q) || 0);
  } catch {
    /* ignore */
  }
  return 25;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Fault injection: the next `count` REST calls answer 429 with this retry_after (seconds). */
let rateLimit = { count: 0, retryAfter: 1 };

export async function mockRequest(method: string, path: string, body: unknown, token: string | null): Promise<unknown> {
  await sleep(latency());
  if (rateLimit.count > 0) {
    rateLimit.count -= 1;
    throw new RateLimitedError(rateLimit.retryAfter, false);
  }
  try {
    // Round-trip through JSON so callers can never mutate the database through a returned object.
    setCurrentToken(token);
    const result = handleRoute(method, path, body, userIdFromToken(token));
    return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
  } catch (error) {
    if (error instanceof ApiRequestError) throw error;
    throw new ApiRequestError(500, { code: 0, message: error instanceof Error ? error.message : "Mock server error" });
  }
}

function imageSize(url: string): Promise<{ width: number; height: number } | null> {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

export async function mockUpload(channelId: string, file: File, onProgress: ((fraction: number) => void) | undefined, signal: AbortSignal | undefined, token: string | null): Promise<Attachment> {
  const userId = userIdFromToken(token);
  if (!userId) throw new ApiRequestError(401, { code: 0, message: "401: Unauthorized" });
  if (!db.channels.has(channelId)) throw new ApiRequestError(404, { code: 10003, message: "Unknown Channel" });
  if (file.size > MAX_UPLOAD_BYTES) throw new ApiRequestError(413, { code: 40005, message: "Request entity too large" });
  const steps = 8;
  for (let i = 1; i <= steps; i += 1) {
    if (signal?.aborted) throw new DOMException("Upload aborted", "AbortError");
    await sleep(60);
    onProgress?.(i / steps);
  }
  const url = URL.createObjectURL(file);
  const size = file.type.startsWith("image/") ? await imageSize(url) : null;
  const attachment: Attachment = {
    id: nextId(),
    filename: file.name,
    content_type: file.type || null,
    size: file.size,
    url,
    width: size?.width ?? null,
    height: size?.height ?? null,
  };
  db.pending.set(attachment.id, { attachment, owner: userId });
  return attachment;
}

// Dev/test hooks: `window.__vokkoMock` lets Playwright scripts and the console simulate other users and network faults.
interface MockHooks {
  tokenFor(username: string): string | null;
  /** Another user says something in a channel (emits MESSAGE_CREATE to everyone in it). */
  say(channelId: string, username: string, content: string, opts?: { replyTo?: string }): string;
  typing(channelId: string, username: string): void;
  presence(username: string, status: PresenceStatus): void;
  /** Close all open gateway connections abruptly; the client should reconnect and resume. */
  dropConnections(): void;
  /** true: drop every connection and refuse new ones (the client shows its reconnecting banner); false: let it back in. */
  offline(on: boolean): void;
  /** Make the next `count` REST calls fail with 429 and `retry_after` seconds. */
  rateLimit(count: number, retryAfterSeconds?: number): void;
  /** Make GET /gifs/* answer like a server with this VOKKO_GIF_PROVIDER ("none" = favourites only). */
  gifProvider(provider: GifProvider): void;
  /** Create a DM with `username` for the signed-in `as` user. */
  addUser(username: string, globalName?: string): string;
  channelIdByName(name: string): string | null;
  /** Another user joins (or with null leaves) a voice channel, optionally self-muted / deafened. */
  voice(username: string, channelId: string | null, opts?: { selfMute?: boolean; selfDeaf?: boolean; selfVideo?: boolean; selfStream?: boolean }): void;
  messageTimestamp(id: string): number;
  /** The account settings blob of a user (GET /users/@me/settings as them). */
  settingsOf(username: string): UserSettings;
  /** Another device of `username` saves settings: USER_SETTINGS_UPDATE reaches this client unless `silent` (then only the next PATCH learns of it, as a 409). */
  settingsFromOtherDevice(username: string, settings: UserSettingsData, opts?: { silent?: boolean }): UserSettings;
  /** Add the seeded Echo bot (/echo, /roll, /pick, Wave at, Quote) to a server, by name (default "Sam's server"). */
  installEchoBot(guildName?: string): string;
  /** Post through a channel's first webhook (as an external service would). */
  executeWebhook(channelId: string, content: string, username?: string): string;
  /** A guild owned by `owner` (default alice) with onboarding (a required question, rules, default channels), an invite code and a stranger member. */
  seedOnboardingGuild(owner?: string): SeededGuild;
  /** Show (or with null clear) the maintenance banner served by `GET /status`; the client re-reads it at once. */
  maintenance(message: string | null, startsAt?: string | null): void;
  reset(): void;
}

function userByName(username: string): string {
  const account = [...db.accounts.values()].find(a => a.user.username === username);
  if (!account) throw new Error(`unknown mock user ${username}`);
  return account.user.id;
}

const hooks: MockHooks = {
  tokenFor: username => {
    const account = [...db.accounts.values()].find(a => a.user.username === username);
    return account ? tokenFor(account.user.id) : null;
  },
  say: (channelId, username, content, opts) => {
    const channel = db.channels.get(channelId);
    if (!channel) throw new Error("unknown channel");
    return addMessage({ channel, author_id: userByName(username), content, reference_id: opts?.replyTo ?? null }).id;
  },
  typing: (channelId, username) => {
    const channel = db.channels.get(channelId);
    if (!channel) throw new Error("unknown channel");
    const members = channel.guild_id ? [...(db.guilds.get(channel.guild_id)?.members.keys() ?? [])] : (channel.participant_ids ?? []);
    const userId = userByName(username);
    emit(members.filter(id => id !== userId), "TYPING_START", { channel_id: channelId, user_id: userId, timestamp: Math.floor(Date.now() / 1000) });
  },
  presence: (username, status) => {
    const account = db.accounts.get(userByName(username));
    if (!account) return;
    account.presence = { ...account.presence, status };
    emit([...db.accounts.keys()], "PRESENCE_UPDATE", { ...account.presence });
  },
  dropConnections: () => dropAllConnections(),
  offline: on => setOffline(on),
  rateLimit: (count, retryAfterSeconds = 1) => {
    rateLimit = { count, retryAfter: retryAfterSeconds };
  },
  gifProvider: provider => {
    db.gifProvider = provider;
  },
  addUser: (username, globalName) => createAccount({ username, global_name: globalName ?? null }).user.id,
  channelIdByName: name => [...db.channels.values()].find(c => c.name === name)?.id ?? null,
  voice: (username, channelId, opts) => setMockVoice(userByName(username), channelId, emit, opts),
  messageTimestamp: id => snowflakeToTimestamp(id),
  settingsOf: username => settingsOf(userByName(username)),
  settingsFromOtherDevice: (username, settings, opts) => {
    const id = userByName(username);
    return patchSettings(id, settingsOf(id).version, settings, opts);
  },
  installEchoBot: (guildName = "Sam's server") => {
    const guild = [...db.guilds.values()].find(g => g.guild.name === guildName);
    if (!guild) throw new Error(`unknown mock guild ${guildName}`);
    return installEchoBot(guild.guild.id);
  },
  executeWebhook: (channelId, content, username) => {
    const hook = [...apps.webhooks.values()].find(w => w.channel_id === channelId);
    if (!hook) throw new Error("no webhook in that channel");
    return executeWebhook(hook, username ? { content, username } : { content }).id;
  },
  seedOnboardingGuild: owner => seedOnboardingGuild(owner),
  maintenance: (message, startsAt = null) => {
    setMockMaintenance(message ? { message, starts_at: startsAt } : null);
    window.dispatchEvent(new Event("vokko:status-changed"));
  },
  reset: () => {
    window.localStorage.removeItem("vokko.token");
    window.location.reload();
  },
};

if (MOCK && typeof window !== "undefined") (window as unknown as { __vokkoMock: MockHooks }).__vokkoMock = hooks;
