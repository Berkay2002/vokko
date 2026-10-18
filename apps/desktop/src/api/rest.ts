import { API_ORIGIN, MOCK, REST_BASE, getToken } from "./config";
import { ApiRequestError, RateLimitedError } from "./errors";
import { loadedMockBackend, loadMockBackend } from "./mockBackend";
import type {
  ApiError,
  Attachment,
  Channel,
  ChannelFollower,
  CreateBugReportRequest,
  CreateCrashReportRequest,
  BugReportCreated,
  CreateReportRequest,
  EditChannelRequest,
  FollowChannelRequest,
  FollowedChannel,
  ForumPost,
  GuildPrivacySettings,
  Message,
  Report,
  Snowflake,
  StartForumPostRequest,
  StartThreadFromMessageRequest,
  StartThreadRequest,
  ThreadListResponse,
  ThreadMember,
  ThreadSearchQuery,
  ThreadSearchResponse,
  UpdateThreadMemberRequest,
  User,
} from "./types";

export { ApiRequestError, RateLimitedError };

type Unauthorized = () => void;
let onUnauthorized: Unauthorized | null = null;

/** The auth module registers a handler that drops the session when any non-auth call returns 401. */
export function setUnauthorizedHandler(fn: Unauthorized | null): void {
  onUnauthorized = fn;
}

/** Shown for every request that never got an answer (offline, DNS, refused, CORS). */
export const OFFLINE_MESSAGE = "Can't reach Vokko. Check your connection.";

/** The server's JSON error, or a short message: a proxy in front of it (Cloudflare tunnel, Caddy) answers with an HTML page
 *  while the server is down or restarting, and that page must not become the error text. */
export function toApiError(status: number, text: string): ApiError {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "code" in parsed && "message" in parsed) return parsed as ApiError;
  } catch {
    /* not JSON */
  }
  if (status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 530)) return { code: 0, message: "Vokko is restarting, try again in a moment." };
  const plain = text.trim();
  if (plain && plain.length <= 200 && !plain.startsWith("<")) return { code: 0, message: plain };
  return { code: 0, message: `Vokko had a problem (HTTP ${status}). Try again.` };
}

function failIfUnauthorized(status: number, path: string): void {
  if (status === 401 && !path.startsWith("/auth/")) onUnauthorized?.();
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** Longest 429 wait a GET is willing to sit out before giving the error to the caller. */
const MAX_RETRY_WAIT_SECONDS = 10;

function rateLimited(response: Response, text: string): RateLimitedError {
  let retryAfter = Number(response.headers.get("Retry-After"));
  let global = false;
  let message: string | undefined;
  let code: number | undefined;
  try {
    const parsed = JSON.parse(text) as { retry_after?: number; global?: boolean; message?: string; code?: number };
    if (typeof parsed.retry_after === "number") retryAfter = parsed.retry_after;
    global = parsed.global === true;
    message = parsed.message;
    if (typeof parsed.code === "number") code = parsed.code;
  } catch {
    /* header only */
  }
  return new RateLimitedError(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 1, global, message, code);
}

export interface RequestOptions {
  /** Sent as `X-Audit-Log-Reason` (URL-encoded); the server records it on the audit log entry. */
  reason?: string;
}

/** GETs wait out one 429 (when the wait is reasonable) and retry once; everything else surfaces the RateLimitedError. */
export async function request<T>(method: Method, path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
  try {
    return await send<T>(method, path, body, options);
  } catch (error) {
    if (method === "GET" && error instanceof RateLimitedError && error.retryAfter <= MAX_RETRY_WAIT_SECONDS) {
      await new Promise(resolve => setTimeout(resolve, error.retryAfter * 1000));
      return send<T>(method, path, body, options);
    }
    throw error;
  }
}

async function send<T>(method: Method, path: string, body: unknown, options: RequestOptions): Promise<T> {
  const token = getToken();
  const reason = options.reason?.trim() || null;
  if (MOCK) {
    try {
      // Loaded before bootstrap, so this is as direct as before the backend became a lazy chunk (no extra await).
      const mock = loadedMockBackend() ?? (await loadMockBackend());
      return (await mock.mockRequest(method, path, body, token, reason)) as T;
    } catch (error) {
      if (error instanceof ApiRequestError) failIfUnauthorized(error.status, path);
      throw error;
    }
  }
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = token;
  if (reason) headers["X-Audit-Log-Reason"] = encodeURIComponent(Array.from(reason).slice(0, 512).join(""));
  let response: Response;
  try {
    response = await fetch(`${REST_BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiRequestError(0, { code: 0, message: OFFLINE_MESSAGE });
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (response.status === 429) throw rateLimited(response, text);
  if (!response.ok) {
    failIfUnauthorized(response.status, path);
    throw new ApiRequestError(response.status, toApiError(response.status, text));
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Resolve a server-relative attachment/avatar URL (absolute, blob: and data: URLs pass through). */
export function resolveUrl(url: string): string {
  return url.startsWith("/") ? `${API_ORIGIN}${url}` : url;
}

export function uploadAttachment(channelId: string, file: File, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<Attachment> {
  if (MOCK) return loadMockBackend().then(m => m.mockUpload(channelId, file, onProgress, signal, getToken()));
  return new Promise<Attachment>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${REST_BASE}/channels/${channelId}/attachments`);
    const token = getToken();
    if (token) xhr.setRequestHeader("Authorization", token);
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    xhr.onerror = () => reject(new ApiRequestError(0, { code: 0, message: OFFLINE_MESSAGE }));
    xhr.onabort = () => reject(new DOMException("Upload aborted", "AbortError"));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1);
        try {
          resolve(JSON.parse(xhr.responseText) as Attachment);
        } catch {
          reject(new ApiRequestError(xhr.status, { code: 0, message: "Invalid server response" }));
        }
      } else if (xhr.status === 429) {
        const retry = Number(xhr.getResponseHeader("Retry-After"));
        reject(new RateLimitedError(Number.isFinite(retry) && retry > 0 ? retry : 1, false));
      } else {
        failIfUnauthorized(xhr.status, "/channels");
        reject(new ApiRequestError(xhr.status, toApiError(xhr.status, xhr.responseText)));
      }
    };
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    const form = new FormData();
    form.append("file", file, file.name);
    xhr.send(form);
  });
}

// ---- Threads, forums and announcements (docs/api.md) ----

/** `?a=1&b=2` from a flat object; array values repeat the key (`tag=1&tag=2`), undefined entries are left out. */
function queryString(params: Record<string, string | number | boolean | readonly string[] | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (typeof value === "object") for (const item of value) q.append(key, item);
    else q.set(key, String(value));
  }
  const text = q.toString();
  return text ? `?${text}` : "";
}

/** Friends the caller and `userId` share (GET /users/{id}/relationships). */
export const getMutualFriends = (userId: Snowflake): Promise<User[]> => request("GET", `/users/${userId}/relationships`);

export const startThreadFromMessage = (channelId: Snowflake, messageId: Snowflake, body: StartThreadFromMessageRequest): Promise<Channel> => request("POST", `/channels/${channelId}/messages/${messageId}/threads`, body);
export const startThread = (channelId: Snowflake, body: StartThreadRequest): Promise<Channel> => request("POST", `/channels/${channelId}/threads`, body);
export const startForumPost = (forumId: Snowflake, body: StartForumPostRequest): Promise<ForumPost> => request("POST", `/channels/${forumId}/threads`, body);
export const createBugReport = (body: CreateBugReportRequest): Promise<BugReportCreated> => request("POST", "/bug-reports", body);
export const createCrashReport = (body: CreateCrashReportRequest): Promise<void> => request("POST", "/crash-reports", body);
export const reportMessage = (channelId: Snowflake, messageId: Snowflake, body: CreateReportRequest): Promise<Report> => request("POST", `/channels/${channelId}/messages/${messageId}/report`, body);
export const reportMember = (guildId: Snowflake, userId: Snowflake, body: CreateReportRequest): Promise<Report> => request("POST", `/guilds/${guildId}/members/${userId}/report`, body);
export const getGuildPrivacy = (guildId: Snowflake): Promise<GuildPrivacySettings> => request("GET", `/users/@me/guilds/${guildId}/privacy`);
export const updateGuildPrivacy = (guildId: Snowflake, body: GuildPrivacySettings): Promise<GuildPrivacySettings> => request("PATCH", `/users/@me/guilds/${guildId}/privacy`, body);
export const joinThread = (threadId: Snowflake): Promise<void> => request("PUT", `/channels/${threadId}/thread-members/@me`);
export const leaveThread = (threadId: Snowflake): Promise<void> => request("DELETE", `/channels/${threadId}/thread-members/@me`);
export const addThreadMember = (threadId: Snowflake, userId: Snowflake): Promise<void> => request("PUT", `/channels/${threadId}/thread-members/${userId}`);
export const removeThreadMember = (threadId: Snowflake, userId: Snowflake): Promise<void> => request("DELETE", `/channels/${threadId}/thread-members/${userId}`);
export const listThreadMembers = (threadId: Snowflake): Promise<ThreadMember[]> => request("GET", `/channels/${threadId}/thread-members`);
export const getThreadMember = (threadId: Snowflake, userId: Snowflake): Promise<ThreadMember> => request("GET", `/channels/${threadId}/thread-members/${userId}`);
export const updateThreadMember = (threadId: Snowflake, body: UpdateThreadMemberRequest): Promise<ThreadMember> => request("PATCH", `/channels/${threadId}/thread-members/@me`, body);
export const listActiveThreads = (guildId: Snowflake): Promise<ThreadListResponse> => request("GET", `/guilds/${guildId}/threads/active`);
/** Archived threads, newest archive first; `before` is the ISO `archive_timestamp` of the last row of the previous page. */
export const listArchivedThreads = (channelId: Snowflake, kind: "public" | "private" | "joined-private", page: { before?: string; limit?: number } = {}): Promise<ThreadListResponse> =>
  request("GET", `${kind === "joined-private" ? `/channels/${channelId}/users/@me/threads/archived/private` : `/channels/${channelId}/threads/archived/${kind}`}${queryString(page)}`);
export const searchThreads = (channelId: Snowflake, query: ThreadSearchQuery = {}): Promise<ThreadSearchResponse> => request("GET", `/channels/${channelId}/threads/search${queryString({ ...query })}`);
/** Rename, archive, lock, tags, pin: any thread field of EditChannelRequest. Forum channel fields go through the same call. */
export const editChannel = (channelId: Snowflake, body: EditChannelRequest): Promise<Channel> => request("PATCH", `/channels/${channelId}`, body);
export const deleteThread = (threadId: Snowflake): Promise<Channel> => request("DELETE", `/channels/${threadId}`);
export const followChannel = (channelId: Snowflake, body: FollowChannelRequest): Promise<FollowedChannel> => request("POST", `/channels/${channelId}/followers`, body);
export const listFollowers = (channelId: Snowflake): Promise<ChannelFollower[]> => request("GET", `/channels/${channelId}/followers`);
export const unfollowChannel = (channelId: Snowflake, followId: Snowflake): Promise<void> => request("DELETE", `/channels/${channelId}/followers/${followId}`);
/** Publish an announcement message to every follower. */
export const crosspostMessage = (channelId: Snowflake, messageId: Snowflake): Promise<Message> => request("POST", `/channels/${channelId}/messages/${messageId}/crosspost`);
