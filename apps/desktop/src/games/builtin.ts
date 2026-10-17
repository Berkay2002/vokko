// Built-in games (docs/design/games-host.md section 4): shipped inside the app under /games/<name>/ and framed with an
// opaque origin. The server keeps the same ids in voice/games.rs; the client takes the URL from here, never from the server.

import { MOCK } from "../api/config";
import type { GameManifest } from "../api/types";

export const BUILTIN_PREFIX = "builtin:";

const SKETCH: GameManifest = { id: "builtin:sketch", name: "Sketch", url: "/games/sketch/index.html", icon: "✏️", min_players: 2, max_players: 12, aspect: "16:9" };
/** The e2e game (public/games/mock/): only in the mock build, so it never shows up against a real server. */
const MOCK_GAME: GameManifest = { id: "builtin:mock", name: "Mock Game", url: "/games/mock/index.html", icon: "🧪", min_players: 1, max_players: 16, aspect: "16:9" };

const TRIVIA: GameManifest = { id: "builtin:trivia", name: "Trivia", url: "/games/trivia/index.html", icon: "❓", min_players: 1, max_players: 16, aspect: "16:9" };
const WHOS_THE_SPY: GameManifest = { id: "builtin:whos-the-spy", name: "Who's the Spy", url: "/games/whos-the-spy/index.html", icon: "🕵️", min_players: 3, max_players: 16, aspect: "16:9" };
const SAME_WAVE: GameManifest = { id: "builtin:same-wave", name: "Same Wave", url: "/games/same-wave/index.html", icon: "📡", min_players: 2, max_players: 16, aspect: "16:9" };
const PARTY = [TRIVIA, WHOS_THE_SPY, SAME_WAVE];

export const BUILTIN_GAMES: readonly GameManifest[] = MOCK ? [SKETCH, ...PARTY, MOCK_GAME] : [SKETCH, ...PARTY];

export const isBuiltin = (game: Pick<GameManifest, "id">): boolean => game.id.startsWith(BUILTIN_PREFIX);

export const builtinGame = (id: string): GameManifest | undefined => BUILTIN_GAMES.find(g => g.id === id);
