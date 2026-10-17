// Spotify REST calls (docs/api.md "Spotify in calls"). The server proxies the public catalog; the client never talks to Spotify and
// only loads art from https://i.scdn.co. Every change to a session comes back to everyone as SPOTIFY_UPDATE.

import { request } from "../api/rest";
import type {
  Snowflake,
  SpotifyAlbum,
  SpotifyArtist,
  SpotifyListenerToken,
  SpotifyPatchRequest,
  SpotifyPlaylist,
  SpotifyReply,
  SpotifySearchResults,
  SpotifySearchType,
} from "../api/types";

export const search = (q: string, type: SpotifySearchType) => request<SpotifySearchResults>("GET", `/spotify/search?${new URLSearchParams({ q, type })}`);
export const getAlbum = (id: string) => request<SpotifyAlbum>("GET", `/spotify/albums/${id}`);
export const getPlaylist = (id: string) => request<SpotifyPlaylist>("GET", `/spotify/playlists/${id}`);
export const getArtist = (id: string) => request<SpotifyArtist>("GET", `/spotify/artists/${id}`);

const path = (channelId: Snowflake) => `/channels/${channelId}/spotify`;
/** Play a track now, or an album / playlist from its first track (the rest goes to the front of the queue). */
export const playSpotify = (channelId: Snowflake, uri: string) => request<SpotifyReply>("PUT", path(channelId), { uri });
export const controlSpotify = (channelId: Snowflake, patch: SpotifyPatchRequest) => request<SpotifyReply>("PATCH", path(channelId), patch);
export const stopSpotify = (channelId: Snowflake) => request<void>("DELETE", path(channelId));
export const listenerToken = (channelId: Snowflake) => request<SpotifyListenerToken>("POST", `${path(channelId)}/listener-token`);
