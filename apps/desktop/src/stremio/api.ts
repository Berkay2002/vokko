// Stremio REST calls (docs/design/stremio-bot.md section 3). The client never talks to Stremio: the server proxies it, and the
// stream lists carry opaque ids, never URLs. Every change to a session comes back to everyone as STREMIO_UPDATE.

import { request } from "../api/rest";
import type {
  Snowflake,
  StremioAccountStatus,
  StremioContinueItem,
  StremioLinkStart,
  StremioMeta,
  StremioPatchRequest,
  StremioSearchItem,
  StremioStartRequest,
  StremioState,
  StremioStreams,
  StremioType,
  StremioViewerToken,
} from "../api/types";

export const getAccount = () => request<StremioAccountStatus>("GET", "/users/@me/stremio");
export const startLink = () => request<StremioLinkStart>("POST", "/users/@me/stremio/link");
export const pollLink = () => request<{ linked: boolean }>("POST", "/users/@me/stremio/link/poll");
export const loginWithEmail = (email: string, password: string) => request<void>("POST", "/users/@me/stremio/login", { email, password });
export const unlinkAccount = () => request<void>("DELETE", "/users/@me/stremio");

const q = (params: Record<string, string>) => new URLSearchParams(params).toString();
export const searchTitles = (type: StremioType, text: string) => request<StremioSearchItem[]>("GET", `/stremio/search?${q({ type, q: text })}`);
export const catalog = (type: StremioType) => request<StremioSearchItem[]>("GET", `/stremio/catalog?${q({ type })}`);
export const getMeta = (type: StremioType, id: string) => request<StremioMeta>("GET", `/stremio/meta/${type}/${id}`);
export const getStreams = (type: StremioType, videoId: string) => request<StremioStreams>("GET", `/stremio/streams/${type}/${videoId}`);

const path = (channelId: Snowflake) => `/channels/${channelId}/stremio`;
/** The caller's own Continue watching (their linked Stremio library, newest first, at most 20); `[]` when nothing is saved. */
export const getContinue = () => request<StremioContinueItem[]>("GET", "/stremio/continue");
/** Play the stream `sid` now (replacing what is playing; the queue stays), from `positionMs` when resuming. */
export const startStremio = (channelId: Snowflake, sid: string, positionMs = 0) =>
  request<StremioState>("PUT", path(channelId), { sid, ...(positionMs > 0 ? { position_ms: Math.round(positionMs) } : {}) } satisfies StremioStartRequest);
export const controlStremio = (channelId: Snowflake, patch: StremioPatchRequest) => request<StremioState | null>("PATCH", path(channelId), patch);
export const stopStremio = (channelId: Snowflake) => request<void>("DELETE", path(channelId));
export const viewerToken = (channelId: Snowflake) => request<StremioViewerToken>("POST", `${path(channelId)}/viewer-token`);
