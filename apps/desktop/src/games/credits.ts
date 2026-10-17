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

export const GAME_CREDITS: Record<string, GameCredit[]> = {
  "builtin:trivia": [
    { work: "Open Trivia Database (questions)", author: "PIXELTAIL GAMES LLC and contributors", url: "https://opentdb.com", license: "CC-BY-SA-4.0", file: "/games/trivia/LICENSE-opentdb.txt" },
  ],
};
