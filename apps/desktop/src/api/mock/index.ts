// In-memory backend used when VITE_VOKKO_API is unset (browser preview, screenshots, tests).
// REST goes through `mockRequest`, the gateway through `MockSocket`; both are wired in rest.ts / gateway.ts.

import { MOCK } from "../config";
import { MAX_UPLOAD_BYTES } from "../limits";
import { ApiRequestError, RateLimitedError } from "../errors";
import { snowflakeToTimestamp } from "../snowflake";
import type { Attachment, PresenceStatus } from "../types";
import { db, nextId } from "./db";
import { addMessage, createAccount } from "./ops";
import { handleRoute } from "./routes";
import { seed } from "./seed";
import { MockSocket, dropAllConnections, emit, tokenFor, userIdFromToken } from "./socket";

export { MockSocket };

if (MOCK) seed();

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
  /** Make the next `count` REST calls fail with 429 and `retry_after` seconds. */
  rateLimit(count: number, retryAfterSeconds?: number): void;
  /** Create a DM with `username` for the signed-in `as` user. */
  addUser(username: string, globalName?: string): string;
  channelIdByName(name: string): string | null;
  messageTimestamp(id: string): number;
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
  rateLimit: (count, retryAfterSeconds = 1) => {
    rateLimit = { count, retryAfter: retryAfterSeconds };
  },
  addUser: (username, globalName) => createAccount({ username, global_name: globalName ?? null }).user.id,
  channelIdByName: name => [...db.channels.values()].find(c => c.name === name)?.id ?? null,
  messageTimestamp: id => snowflakeToTimestamp(id),
  reset: () => {
    window.localStorage.removeItem("vokko.token");
    window.location.reload();
  },
};

if (MOCK && typeof window !== "undefined") (window as unknown as { __vokkoMock: MockHooks }).__vokkoMock = hooks;
