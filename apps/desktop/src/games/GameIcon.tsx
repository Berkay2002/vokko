import type { GameManifest } from "../api/types";

/** A game's emoji, or its first letter on a tinted square (design section 2 item 8: no remote icon URLs). */
export function GameIcon({ game, size }: { game: Pick<GameManifest, "name" | "icon">; size: number }) {
  if (game.icon) {
    return (
      <span className="game-icon emoji" style={{ fontSize: size * 0.85, width: size, height: size }} aria-hidden="true">
        {game.icon}
      </span>
    );
  }
  return (
    <span className="game-icon letter" style={{ fontSize: size * 0.55, width: size, height: size }} aria-hidden="true">
      {[...game.name.trim()][0]?.toUpperCase() ?? "?"}
    </span>
  );
}
