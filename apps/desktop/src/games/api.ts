// Games REST calls (docs/design/games-host.md sections 4 and 5). Session changes come back to everyone as GAME_UPDATE.

import { request } from "../api/rest";
import type { GameManifest, GameManifestRequest, GamePlayer, GameRelayRequest, GameSession, Snowflake } from "../api/types";

const session = (channelId: Snowflake) => `/channels/${channelId}/game`;
const catalog = (guildId: Snowflake) => `/guilds/${guildId}/games`;

export const startGame = (channelId: Snowflake, gameId: string) => request<GameSession>("PUT", session(channelId), { game_id: gameId });
export const stopGame = (channelId: Snowflake) => request<void>("DELETE", session(channelId));
export const gamePlayers = (channelId: Snowflake) => request<GamePlayer[]>("GET", `${session(channelId)}/players`);
export const shareGameRoom = (channelId: Snowflake, url: string | null) => request<GameSession>("PUT", `${session(channelId)}/room`, { url });
export const relayGame = (channelId: Snowflake, body: GameRelayRequest) => request<void>("POST", `${session(channelId)}/messages`, body);

export const listGuildGames = (guildId: Snowflake) => request<GameManifest[]>("GET", catalog(guildId));
export const addGuildGame = (guildId: Snowflake, body: GameManifestRequest) => request<GameManifest>("POST", catalog(guildId), body);
export const editGuildGame = (guildId: Snowflake, gameId: string, body: Partial<GameManifestRequest>) => request<GameManifest>("PATCH", `${catalog(guildId)}/${gameId}`, body);
export const removeGuildGame = (guildId: Snowflake, gameId: string) => request<void>("DELETE", `${catalog(guildId)}/${gameId}`);
