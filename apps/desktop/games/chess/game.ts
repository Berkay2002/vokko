// Chess rules on boardgame.io; chess.js (BSD-2-Clause) checks moves and finds mate, stalemate and draws.
// G keeps only the moves in SAN: every check replays them, so threefold repetition and the 50-move rule work.
// Seats: "0" White, "1" Black. Everyone is active at all times (resign and draw offers are off-turn), so each move checks
// whose turn it is itself.

import { Chess } from "chess.js";
import { ActivePlayers, INVALID_MOVE } from "boardgame.io/core";
import type { Game } from "boardgame.io";
import type { BoardDef } from "../_bgio/net";

export type Side = "0" | "1";

export interface ChessG {
  moves: string[];
  /** Who offered a draw that is still open. */
  drawOffer: Side | null;
  result: ChessResult | null;
}

export interface ChessResult {
  winner: Side | null;
  reason: "checkmate" | "resignation" | "stalemate" | "agreement" | "repetition" | "insufficient material" | "50-move rule";
}

export function replay(moves: string[]): Chess {
  const chess = new Chess();
  for (const san of moves) chess.move(san);
  return chess;
}

export const sideToMove = (chess: Chess): Side => (chess.turn() === "w" ? "0" : "1");

function endOf(chess: Chess): ChessResult | null {
  if (chess.isCheckmate()) return { winner: chess.turn() === "w" ? "1" : "0", reason: "checkmate" };
  if (chess.isStalemate()) return { winner: null, reason: "stalemate" };
  if (chess.isInsufficientMaterial()) return { winner: null, reason: "insufficient material" };
  if (chess.isThreefoldRepetition()) return { winner: null, reason: "repetition" };
  if (chess.isDrawByFiftyMoves()) return { winner: null, reason: "50-move rule" };
  return null;
}

const other = (side: Side): Side => (side === "0" ? "1" : "0");
const seated = (id: string | null | undefined): id is Side => id === "0" || id === "1";

export const ChessGame: Game<ChessG> = {
  name: "vokko-chess",
  deltaState: true,
  setup: () => ({ moves: [], drawOffer: null, result: null }),
  turn: { activePlayers: ActivePlayers.ALL },
  moves: {
    move: ({ G, playerID }, from: unknown, to: unknown, promotion?: unknown) => {
      if (!seated(playerID) || typeof from !== "string" || typeof to !== "string") return INVALID_MOVE;
      const chess = replay(G.moves);
      if (sideToMove(chess) !== playerID) return INVALID_MOVE;
      const promo = typeof promotion === "string" && /^[qrbn]$/.test(promotion) ? promotion : undefined;
      let san: string;
      try {
        san = chess.move({ from, to, promotion: promo }).san;
      } catch {
        return INVALID_MOVE;
      }
      G.moves.push(san);
      G.drawOffer = null;
      G.result = endOf(chess);
    },
    resign: ({ G, playerID }) => {
      if (!seated(playerID)) return INVALID_MOVE;
      G.result = { winner: other(playerID), reason: "resignation" };
    },
    offerDraw: ({ G, playerID }) => {
      if (!seated(playerID) || G.drawOffer) return INVALID_MOVE;
      G.drawOffer = playerID;
    },
    answerDraw: ({ G, playerID }, accept: unknown) => {
      if (!seated(playerID) || !G.drawOffer || G.drawOffer === playerID) return INVALID_MOVE;
      G.drawOffer = null;
      if (accept === true) G.result = { winner: null, reason: "agreement" };
    },
  },
  endIf: ({ G }) => G.result ?? undefined,
};

export const CHESS: BoardDef = {
  game: ChessGame as Game,
  numPlayers: 2,
  seats: [
    { id: "0", label: "White" },
    { id: "1", label: "Black" },
  ],
  hidden: false,
  canStart: seats => ["0", "1"].every(s => Object.values(seats).includes(s)),
  rematch: seats => Object.fromEntries(Object.entries(seats).map(([id, s]) => [id, s === "0" ? "1" : "0"])),
};
