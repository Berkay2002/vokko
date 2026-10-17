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
  "builtin:crazy-eights": [
    { work: "uno-game (rule flow reference)", author: "Guilherme Bromonschenkel", url: "https://github.com/guilhermebkel/uno-game", license: "MIT", file: "/games/crazy-eights/LICENSE-uno-game.txt" },
  ],
  "builtin:werewolf": [
    { work: "OpenWerewolf (rules)", author: "James Craster", url: "https://github.com/JamesCraster/OpenWerewolf", license: "Apache-2.0", file: "/games/werewolf/LICENSE-OpenWerewolf.txt" },
  ],
};
