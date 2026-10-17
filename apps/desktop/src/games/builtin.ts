// Built-in games (docs/design/games-host.md section 4): SDK games shipped inside the app under /games/<name>/ and framed with an
// opaque origin, and website games (kind "web") that run on their own servers with their own lobbies. The server keeps the same
// ids in voice/games.rs; the client takes the URL from here, never from the server.

import { MOCK } from "../api/config";
import type { GameManifest } from "../api/types";

export const BUILTIN_PREFIX = "builtin:";

const SKETCH: GameManifest = { id: "builtin:sketch", name: "Sketch", url: "/games/sketch/index.html", icon: "✏️", min_players: 2, max_players: 12, aspect: "16:9" };
/** The e2e game (public/games/mock/): only in the mock build, so it never shows up against a real server. */
const MOCK_GAME: GameManifest = { id: "builtin:mock", name: "Mock Game", url: "/games/mock/index.html", icon: "🧪", min_players: 1, max_players: 16, aspect: "16:9" };

const web = (name: string, label: string, url: string, icon: string, min_players: number, max_players: number, aspect: GameManifest["aspect"]): GameManifest => ({ id: `builtin:${name}`, name: label, url, icon, min_players, max_players, aspect, kind: "web" });

/** Website games, each checked to allow framing (no X-Frame-Options or frame-ancestors) on 2026-10-17. */
export const WEB_GAMES: readonly GameManifest[] = [
  web("betrayal", "Betrayal", "https://betrayal.io/", "🔪", 4, 12, "16:9"),
  web("shellshockers", "Shell Shockers", "https://shellshock.io/", "🥚", 2, 16, "16:9"),
  web("smashkarts", "Smash Karts", "https://smashkarts.io/", "🏎️", 2, 8, "16:9"),
  web("skribbl", "skribbl.io", "https://skribbl.io/", "🖍️", 2, 16, "fill"),
  web("codenames", "Codenames", "https://codenames.game/", "🕵️", 4, 16, "fill"),
  web("krunker", "Krunker", "https://krunker.io/", "🎯", 2, 16, "16:9"),
];

export const BUILTIN_GAMES: readonly GameManifest[] = MOCK ? [SKETCH, ...WEB_GAMES, MOCK_GAME] : [SKETCH, ...WEB_GAMES];

export const isBuiltin = (game: Pick<GameManifest, "id">): boolean => game.id.startsWith(BUILTIN_PREFIX);

/** A website game with its own lobby: no SDK, a looser sandbox, a shareable room link. */
export const isWebGame = (game: Pick<GameManifest, "kind">): boolean => game.kind === "web";

export const builtinGame = (id: string): GameManifest | undefined => BUILTIN_GAMES.find(g => g.id === id);
