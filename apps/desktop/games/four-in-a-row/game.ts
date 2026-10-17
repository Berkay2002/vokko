// Four in a Row on boardgame.io: a 7 x 6 grid, discs fall to the lowest free cell, four in a line wins.
// Seats: "0" Red (moves first), "1" Yellow.

import { ActivePlayers, INVALID_MOVE } from "boardgame.io/core";
import type { Game } from "boardgame.io";
import type { BoardDef } from "../_bgio/net";

export const COLS = 7;
export const ROWS = 6;

export type Disc = "0" | "1";

export interface FourG {
  /** Row-major from the top: cells[row * COLS + col]. */
  cells: (Disc | null)[];
  turn: Disc;
  /** The winning four, or the resigner's opponent with no line. */
  result: { winner: Disc | null; line: number[]; reason: "four" | "full" | "resignation" } | null;
}

const DIRS = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
] as const;

/** The four cells through `index` that are all `disc`, if any. */
export function lineThrough(cells: (Disc | null)[], index: number): number[] | null {
  const disc = cells[index];
  if (!disc) return null;
  const r0 = Math.floor(index / COLS);
  const c0 = index % COLS;
  for (const [dr, dc] of DIRS) {
    const line = [index];
    for (const sign of [1, -1]) {
      for (let k = 1; k < 4; k += 1) {
        const r = r0 + dr * k * sign;
        const c = c0 + dc * k * sign;
        if (r < 0 || r >= ROWS || c < 0 || c >= COLS || cells[r * COLS + c] !== disc) break;
        line.push(r * COLS + c);
      }
    }
    if (line.length >= 4) return line.sort((a, b) => a - b);
  }
  return null;
}

/** The cell a disc dropped in `col` lands in, or -1 when the column is full. */
export function landing(cells: (Disc | null)[], col: number): number {
  for (let r = ROWS - 1; r >= 0; r -= 1) if (!cells[r * COLS + col]) return r * COLS + col;
  return -1;
}

const seated = (id: string | null | undefined): id is Disc => id === "0" || id === "1";

export const FourGame: Game<FourG> = {
  name: "vokko-four-in-a-row",
  deltaState: true,
  setup: () => ({ cells: Array<Disc | null>(COLS * ROWS).fill(null), turn: "0", result: null }),
  turn: { activePlayers: ActivePlayers.ALL },
  moves: {
    drop: ({ G, playerID }, col: unknown) => {
      if (!seated(playerID) || G.turn !== playerID || typeof col !== "number" || !Number.isInteger(col) || col < 0 || col >= COLS) return INVALID_MOVE;
      const at = landing(G.cells, col);
      if (at < 0) return INVALID_MOVE;
      G.cells[at] = playerID;
      const line = lineThrough(G.cells, at);
      if (line) G.result = { winner: playerID, line, reason: "four" };
      else if (G.cells.every(Boolean)) G.result = { winner: null, line: [], reason: "full" };
      G.turn = playerID === "0" ? "1" : "0";
    },
    resign: ({ G, playerID }) => {
      if (!seated(playerID)) return INVALID_MOVE;
      G.result = { winner: playerID === "0" ? "1" : "0", line: [], reason: "resignation" };
    },
  },
  endIf: ({ G }) => G.result ?? undefined,
};

export const FOUR: BoardDef = {
  game: FourGame as Game,
  numPlayers: 2,
  seats: [
    { id: "0", label: "Red" },
    { id: "1", label: "Yellow" },
  ],
  hidden: false,
  canStart: seats => ["0", "1"].every(s => Object.values(seats).includes(s)),
  rematch: seats => Object.fromEntries(Object.entries(seats).map(([id, s]) => [id, s === "0" ? "1" : "0"])),
};
