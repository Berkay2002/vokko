// Stremio REST calls (docs/design/stremio-bot.md section 3). The client never talks to Stremio: the server proxies it, and the
// stream lists carry opaque ids, never URLs. Every change to a session comes back to everyone as STREMIO_UPDATE.

import { request } from "../api/rest";
import type {
  Snowflake,
  StremioAccountStatus,
  StremioLinkStart,
  StremioMeta,
  StremioPatchRequest,
  StremioSearchItem,
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
/** Play the stream `sid` now (replacing what is playing; the queue stays). */
export const startStremio = (channelId: Snowflake, sid: string) => request<StremioState>("PUT", path(channelId), { sid });
export const controlStremio = (channelId: Snowflake, patch: StremioPatchRequest) => request<StremioState | null>("PATCH", path(channelId), patch);
export const stopStremio = (channelId: Snowflake) => request<void>("DELETE", path(channelId));
export const viewerToken = (channelId: Snowflake) => request<StremioViewerToken>("POST", `${path(channelId)}/viewer-token`);
