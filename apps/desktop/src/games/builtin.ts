// Built-in games (docs/design/games-host.md section 4): shipped inside the app under /games/<name>/ and framed with an
// opaque origin. The server keeps the same ids in voice/games.rs; the client takes the URL from here, never from the server.

import { MOCK } from "../api/config";
import type { GameManifest } from "../api/types";

export const BUILTIN_PREFIX = "builtin:";

const SKETCH: GameManifest = { id: "builtin:sketch", name: "Sketch", url: "/games/sketch/index.html", icon: "✏️", min_players: 2, max_players: 12, aspect: "16:9" };
const CHESS: GameManifest = { id: "builtin:chess", name: "Chess", url: "/games/chess/index.html", icon: "♟️", min_players: 2, max_players: 16, aspect: "16:9" };
const FOUR_IN_A_ROW: GameManifest = { id: "builtin:four-in-a-row", name: "Four in a Row", url: "/games/four-in-a-row/index.html", icon: "🟡", min_players: 2, max_players: 16, aspect: "16:9" };
const CODEWORDS: GameManifest = { id: "builtin:codewords", name: "Codewords", url: "/games/codewords/index.html", icon: "🗝️", min_players: 4, max_players: 16, aspect: "16:9" };
const TELEPHONE: GameManifest = { id: "builtin:telephone", name: "Telephone", url: "/games/telephone/index.html", icon: "☎️", min_players: 3, max_players: 12, aspect: "16:9" };
const TRIVIA: GameManifest = { id: "builtin:trivia", name: "Trivia", url: "/games/trivia/index.html", icon: "❓", min_players: 1, max_players: 16, aspect: "16:9" };
const WHOS_THE_SPY: GameManifest = { id: "builtin:whos-the-spy", name: "Who's the Spy", url: "/games/whos-the-spy/index.html", icon: "🕵️", min_players: 3, max_players: 16, aspect: "16:9" };
const SAME_WAVE: GameManifest = { id: "builtin:same-wave", name: "Same Wave", url: "/games/same-wave/index.html", icon: "📡", min_players: 2, max_players: 16, aspect: "16:9" };
const CRAZY_EIGHTS: GameManifest = { id: "builtin:crazy-eights", name: "Crazy Eights", url: "/games/crazy-eights/index.html", icon: "🃏", min_players: 2, max_players: 10, aspect: "16:9" };
const WEREWOLF: GameManifest = { id: "builtin:werewolf", name: "Werewolf", url: "/games/werewolf/index.html", icon: "🐺", min_players: 5, max_players: 16, aspect: "16:9" };
/** The e2e game (public/games/mock/): only in the mock build, so it never shows up against a real server. */
const MOCK_GAME: GameManifest = { id: "builtin:mock", name: "Mock Game", url: "/games/mock/index.html", icon: "🧪", min_players: 1, max_players: 16, aspect: "16:9" };

const PUBLIC_GAMES = [SKETCH, CHESS, FOUR_IN_A_ROW, CODEWORDS, TELEPHONE, TRIVIA, WHOS_THE_SPY, SAME_WAVE, CRAZY_EIGHTS, WEREWOLF];

export const BUILTIN_GAMES: readonly GameManifest[] = MOCK ? [...PUBLIC_GAMES, MOCK_GAME] : PUBLIC_GAMES;

export const isBuiltin = (game: Pick<GameManifest, "id">): boolean => game.id.startsWith(BUILTIN_PREFIX);

export const builtinGame = (id: string): GameManifest | undefined => BUILTIN_GAMES.find(g => g.id === id);
