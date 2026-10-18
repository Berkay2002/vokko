// The games part of the call's Activities shelf: built-ins plus the server's allow-list (GET /guilds/{id}/games, refetched on
// GUILD_GAMES_UPDATE). DM calls get built-ins only. Starting a game focuses its tile; a running one is just focused.

import { useEffect, useState } from "react";
import { gateway } from "../api/gateway";
import { ApiRequestError } from "../api/rest";
import type { Channel, GameManifest, Snowflake } from "../api/types";
import { useVoice } from "../voice/store";
import { useVoiceUi } from "../voice/uiStore";
import { listGuildGames, startGame } from "./api";
import { BUILTIN_GAMES } from "./builtin";
import { GameIcon } from "./GameIcon";

export const GAME_TILE_ID = "game";

/** Built-ins first, then the guild's games (empty until loaded, and when the list can't be read). */
export function useGameCatalog(guildId: Snowflake | null): GameManifest[] {
  const [guildGames, setGuildGames] = useState<{ guildId: Snowflake; games: GameManifest[] } | null>(null);
  useEffect(() => {
    if (!guildId) return;
    let alive = true;
    const load = () =>
      void listGuildGames(guildId)
        .then(games => alive && setGuildGames({ guildId, games }))
        .catch(() => undefined);
    load();
    const off = gateway.on("GUILD_GAMES_UPDATE", d => d.guild_id === guildId && load());
    return () => {
      alive = false;
      off();
    };
  }, [guildId]);
  return guildId && guildGames?.guildId === guildId ? [...BUILTIN_GAMES, ...guildGames.games] : [...BUILTIN_GAMES];
}

function playerRange(game: GameManifest): string {
  return game.min_players === game.max_players ? `${game.min_players} players` : `${game.min_players}-${game.max_players} players`;
}

/** One shelf card per game, for the call's Activities shelf. */
export interface GameActivity {
  game: GameManifest;
  /** "2-8 players", or why it can't be started. */
  sub: string;
  current: boolean;
  disabled: boolean;
  onSelect: () => void;
}

/** The games for the Activities shelf: starting one focuses its tile, the running one is just focused, others wait until it ends. */
export function useGameActivities(channel: Pick<Channel, "id" | "guild_id">): GameActivity[] {
  const games = useGameCatalog(channel.guild_id ?? null);
  const running = useVoice(s => s.games[channel.id]);
  const focus = () => useVoiceUi.getState().setFocusedTile(GAME_TILE_ID);
  return games.map(game => {
    const current = running?.game.id === game.id;
    return {
      game,
      sub: current ? "Running in this call" : running ? "Another game is running" : playerRange(game),
      current,
      disabled: !!running && !current,
      onSelect: () => {
        if (current) return focus();
        startGame(channel.id, game.id).then(focus, (e: unknown) => {
          // A race with someone else's start: the running game's tile is what they want to see.
          if (e instanceof ApiRequestError && e.status === 409) focus();
        });
      },
    };
  });
}
