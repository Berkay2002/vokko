// The games part of the call's Activities menu: built-ins plus the server's allow-list (GET /guilds/{id}/games, refetched on
// GUILD_GAMES_UPDATE). DM calls get built-ins only. Starting a game focuses its tile; a running one is just focused.

import { useEffect, useState } from "react";
import { gateway } from "../api/gateway";
import { ApiRequestError } from "../api/rest";
import type { Channel, GameManifest, Snowflake } from "../api/types";
import type { MenuItem } from "../ui/ContextMenu";
import { useVoice } from "../voice/store";
import { openModal } from "../shell/modalStore";
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

/** Menu rows for the Activities menu, one per game. */
export function useGameMenuItems(channel: Pick<Channel, "id" | "guild_id">): MenuItem[] {
  const games = useGameCatalog(channel.guild_id ?? null);
  const running = useVoice(s => s.games[channel.id]);
  const focus = () => useVoiceUi.getState().setFocusedTile(GAME_TILE_ID);
  const rows = games.map((game): MenuItem => {
    const current = running?.game.id === game.id;
    return {
      id: `game-${game.id}`,
      label: game.name,
      icon: <GameIcon game={game} size={18} />,
      iconStart: true,
      sub: current ? "Running in this call" : running ? "Another game is running" : `Game, ${playerRange(game)}`,
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
  return [...rows, { id: "game-credits", label: "Credits and licenses", sub: "The games' sources, licenses and sites", onSelect: () => openModal({ type: "gameCredits" }) }];
}
