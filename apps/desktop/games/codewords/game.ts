// Codewords on boardgame.io (own rules text and word list; no upstream code). Two teams, a 5 x 5 grid of words. Each team's
// clue-giver sees the key (which words are red, blue, neutral or the assassin) and gives a one-word clue with a number; their
// guessers pick words. The starting team has 9 words, the other 8; 7 are neutral, 1 is the assassin.
//
// Seats: "0" red clue-giver, "1" red guessers, "2" blue clue-giver, "3" blue guessers (several people may guess).
// Hidden info: playerView hides unrevealed key entries from everyone but the clue-givers (until the game ends), so the
// host only ever sends the full key with send(data, appId). Moves run on the host only (client: false).

import { ActivePlayers, INVALID_MOVE } from "boardgame.io/core";
import type { Game } from "boardgame.io";
import type { BoardDef } from "../_bgio/net";
import { WORDS } from "./words";

export type Team = "r" | "b";
export type Kind = Team | "n" | "a";

export interface Clue {
  team: Team;
  word: string;
  n: number;
}

export interface CodewordsG {
  words: string[];
  /** null: hidden from this player. */
  key: (Kind | null)[];
  revealed: boolean[];
  turn: Team;
  stage: "clue" | "guess";
  clue: Clue | null;
  /** Guesses left this turn; 0 after a clue of 0 means unlimited. */
  left: number;
  /** Guesses made this turn. */
  guessed: number;
  clues: Clue[];
  result: { winner: Team; reason: "all" | "assassin" } | null;
}

export interface Setup {
  words: string[];
  key: Kind[];
  first: Team;
}

export const SIZE = 25;
export const CLUE_SEAT: Record<Team, string> = { r: "0", b: "2" };
export const GUESS_SEAT: Record<Team, string> = { r: "1", b: "3" };
const other = (t: Team): Team => (t === "r" ? "b" : "r");

/** A fresh board: 25 distinct words and a key, from `rand` (0 <= rand() < 1). */
export function deal(rand: () => number): Setup {
  const shuffle = <T>(list: readonly T[]): T[] => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  };
  const first: Team = rand() < 0.5 ? "r" : "b";
  const kinds: Kind[] = [...Array<Kind>(9).fill(first), ...Array<Kind>(8).fill(other(first)), ...Array<Kind>(7).fill("n"), "a"];
  return { words: shuffle(WORDS).slice(0, SIZE), key: shuffle(kinds), first };
}

/** Crypto-random deal for the host (boardgame.io's own seed is guessable from the clock). */
export function secureDeal(): Setup {
  const buf = new Uint32Array(1);
  return deal(() => (crypto.getRandomValues(buf)[0]! / 2 ** 32));
}

function isSetup(v: unknown): v is Setup {
  const s = v as Setup;
  return !!s && Array.isArray(s.words) && s.words.length === SIZE && Array.isArray(s.key) && s.key.length === SIZE && (s.first === "r" || s.first === "b");
}

/** Words left to find for `team`. */
export const remaining = (G: CodewordsG, team: Team): number => G.key.filter((k, i) => k === team && !G.revealed[i]).length;

/** A clue is one word of letters (an apostrophe or hyphen inside is fine) that is not on the board. */
export function clueError(G: Pick<CodewordsG, "words">, word: string): string | null {
  const w = word.trim().toLowerCase();
  if (!/^[a-z](?:[a-z'-]{0,22}[a-z])?$/.test(w)) return "One word, letters only";
  if (G.words.some(b => b === w || b.startsWith(w) || w.startsWith(b))) return "Not a word on the board (or part of one)";
  return null;
}

function endTurn(G: CodewordsG): void {
  G.turn = other(G.turn);
  G.stage = "clue";
  G.clue = null;
  G.left = 0;
  G.guessed = 0;
}

export const CodewordsGame: Game<CodewordsG, Record<string, unknown>, Setup> = {
  name: "vokko-codewords",
  deltaState: true,
  setup: ({ random }, setupData) => {
    const s = isSetup(setupData) ? setupData : deal(() => random.Number());
    return { words: s.words, key: s.key, revealed: Array<boolean>(SIZE).fill(false), turn: s.first, stage: "clue", clue: null, left: 0, guessed: 0, clues: [], result: null };
  },
  turn: { activePlayers: ActivePlayers.ALL },
  playerView: ({ G, ctx, playerID }) =>
    ctx.gameover || playerID === CLUE_SEAT.r || playerID === CLUE_SEAT.b ? G : { ...G, key: G.key.map((k, i) => (G.revealed[i] ? k : null)) },
  moves: {
    clue: {
      client: false,
      move: ({ G, playerID }, word: unknown, n: unknown) => {
        if (playerID !== CLUE_SEAT[G.turn] || G.stage !== "clue" || typeof word !== "string" || clueError(G, word)) return INVALID_MOVE;
        if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 9) return INVALID_MOVE;
        const clue = { team: G.turn, word: word.trim().toLowerCase(), n };
        G.clue = clue;
        G.clues.push(clue);
        G.stage = "guess";
        G.left = n === 0 ? 0 : n + 1;
        G.guessed = 0;
      },
    },
    guess: {
      client: false,
      move: ({ G, playerID }, index: unknown) => {
        if (playerID !== GUESS_SEAT[G.turn] || G.stage !== "guess") return INVALID_MOVE;
        if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= SIZE || G.revealed[index]) return INVALID_MOVE;
        G.revealed[index] = true;
        G.guessed += 1;
        const kind = G.key[index];
        const team = G.turn;
        if (kind === "a") G.result = { winner: other(team), reason: "assassin" };
        else if (remaining(G, "r") === 0) G.result = { winner: "r", reason: "all" };
        else if (remaining(G, "b") === 0) G.result = { winner: "b", reason: "all" };
        else if (kind !== team) endTurn(G);
        else if (G.left > 0 && (G.left -= 1) === 0) endTurn(G);
      },
    },
    pass: {
      client: false,
      move: ({ G, playerID }) => {
        if (playerID !== GUESS_SEAT[G.turn] || G.stage !== "guess" || G.guessed === 0) return INVALID_MOVE;
        endTurn(G);
      },
    },
  },
  endIf: ({ G }) => G.result ?? undefined,
};

export const CODEWORDS: BoardDef = {
  game: CodewordsGame as Game,
  numPlayers: 4,
  seats: [
    { id: "0", label: "Red clue-giver" },
    { id: "1", label: "Red guessers", multi: true },
    { id: "2", label: "Blue clue-giver" },
    { id: "3", label: "Blue guessers", multi: true },
  ],
  hidden: true,
  canStart: seats => ["0", "1", "2", "3"].every(s => Object.values(seats).includes(s)),
  setupData: secureDeal,
};
