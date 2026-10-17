// Third-party work used by built-in games, shown on the Activities "Credits and licenses" screen. Keyed by game id; `file` is a
// license text under the game's folder (e.g. "/games/chess/LICENSE-chess.js.txt"). Games made entirely in-house have no entry.

export interface GameCredit {
  /** What was used: a library, a ruleset, a data set or a website. */
  work: string;
  author: string;
  url: string;
  /** SPDX id where there is one ("MIT", "CC-BY-SA-4.0"); free text for a website's own terms. */
  license: string;
  file?: string;
}

const BOARDGAME_IO = (game: string): GameCredit => ({
  work: "boardgame.io (with immer, redux, rfc6902, nanoid, svelte, lodash.isplainobject, setimmediate)",
  author: "The boardgame.io Authors",
  url: "https://github.com/boardgameio/boardgame.io",
  license: "MIT",
  file: `/games/${game}/LICENSE-boardgame.io.txt`,
});

export const GAME_CREDITS: Record<string, GameCredit[]> = {
  "builtin:chess": [
    BOARDGAME_IO("chess"),
    { work: "chess.js", author: "Jeff Hlywa", url: "https://github.com/jhlywa/chess.js", license: "BSD-2-Clause", file: "/games/chess/LICENSE-chess.js.txt" },
    { work: "react-chessboard (board and pieces, with dnd-kit)", author: "Ryan Gregory", url: "https://github.com/Clariity/react-chessboard", license: "MIT", file: "/games/chess/LICENSE-react-chessboard.txt" },
  ],
  "builtin:four-in-a-row": [BOARDGAME_IO("four-in-a-row")],
  "builtin:codewords": [BOARDGAME_IO("codewords")],
};
