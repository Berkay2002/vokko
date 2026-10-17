// Chess: react-chessboard (MIT) draws the board, chess.js (BSD-2-Clause) the rules, boardgame.io carries the moves.
// Drag a piece or click it and then its target square. Pawns promote to a queen.

import { useState } from "react";
import { Chessboard } from "react-chessboard";
import type { Square } from "chess.js";
import { mount, holders, type BoardProps } from "../_bgio/ui";
import { CHESS, replay, sideToMove, type ChessG, type ChessResult } from "./game";

const SIDE = { "0": "White", "1": "Black" } as const;

function resultText(r: ChessResult): string {
  if (!r.winner) return `Draw by ${r.reason}`;
  return `${SIDE[r.winner]} wins by ${r.reason}`;
}

function Board({ room, state, seat, move }: BoardProps<ChessG>) {
  const G = state.G;
  const chess = replay(G.moves);
  const turn = sideToMove(chess);
  const playing = !G.result && (seat === "0" || seat === "1");
  const myTurn = playing && seat === turn;
  const [picked, setPicked] = useState<string | null>(null);

  const tryMove = (from: string, to: string): boolean => {
    setPicked(null);
    if (!myTurn) return false;
    const legal = chess.moves({ square: from as Square, verbose: true }).find(m => m.to === to);
    if (!legal) return false;
    move("move", from, to, legal.promotion ? "q" : undefined); // ponytail: always a queen; add a picker if anyone asks
    return true;
  };

  const onSquare = (square: string) => {
    if (!myTurn) return;
    const piece = chess.get(square as Square);
    if (picked && picked !== square && tryMove(picked, square)) return;
    setPicked(piece && (piece.color === "w" ? "0" : "1") === seat ? square : null);
  };

  const styles: Record<string, React.CSSProperties> = {};
  if (picked) {
    styles[picked] = { background: "rgba(88, 101, 242, .55)" };
    for (const m of chess.moves({ square: picked as Square, verbose: true })) styles[m.to] = { boxShadow: "inset 0 0 0 4px rgba(88, 101, 242, .7)" };
  }
  const history = chess.history({ verbose: true });
  const last = history[history.length - 1];
  if (last) for (const sq of [last.from, last.to]) styles[sq] = { ...styles[sq], background: styles[sq]?.background ?? "rgba(240, 196, 60, .35)" };
  if (chess.inCheck() && !G.result) {
    const king = chess.board().flat().find(p => p?.type === "k" && p.color === chess.turn());
    if (king) styles[king.square] = { ...styles[king.square], boxShadow: "inset 0 0 12px 4px rgba(229, 72, 77, .9)" };
  }

  const pairs: string[] = [];
  for (let i = 0; i < G.moves.length; i += 2) pairs.push(`${i / 2 + 1}. ${G.moves[i]} ${G.moves[i + 1] ?? ""}`);
  const offerFromOther = G.drawOffer && G.drawOffer !== seat && playing;

  return (
    <div className="chess">
      <div className="chess-board" data-turn={turn}>
        <Chessboard
          options={{
            id: "vokko-chess",
            position: chess.fen(),
            boardOrientation: seat === "1" ? "black" : "white",
            allowDragging: myTurn,
            canDragPiece: ({ piece }) => myTurn && (piece.pieceType[0] === "w" ? "0" : "1") === seat,
            onPieceDrop: ({ sourceSquare, targetSquare }) => !!targetSquare && tryMove(sourceSquare, targetSquare),
            onSquareClick: ({ square }) => onSquare(square),
            squareStyles: styles,
            darkSquareStyle: { backgroundColor: "#6d8a5a" },
            lightSquareStyle: { backgroundColor: "#e4e8d0" },
            animationDurationInMs: 150,
          }}
        />
      </div>
      <aside className="chess-side">
        {(["1", "0"] as const).map(side => (
          <div key={side} className={`chess-player${turn === side && !G.result ? " to-move" : ""}`}>
            <span className={`dot ${side === "0" ? "w" : "b"}`} />
            <span>{SIDE[side]}</span>
            <span className="name">{holders(room, side).join(", ") || "Empty"}</span>
          </div>
        ))}
        {G.result && <div className="chess-result" role="status">{resultText(G.result)}</div>}
        {offerFromOther && (
          <div className="chess-offer" role="status">
            <span>{SIDE[G.drawOffer!]} offers a draw</span>
            <button onClick={() => move("answerDraw", true)}>Accept</button>
            <button className="ghost" onClick={() => move("answerDraw", false)}>Decline</button>
          </div>
        )}
        {G.drawOffer && G.drawOffer === seat && !G.result && <div className="chess-offer">Draw offered</div>}
        <ol className="chess-moves" aria-label="Moves">
          {pairs.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ol>
        {playing && (
          <div className="bg-actions">
            <button className="ghost" disabled={!!G.drawOffer} onClick={() => move("offerDraw")}>Offer draw</button>
            <button className="danger" onClick={() => move("resign")}>Resign</button>
          </div>
        )}
      </aside>
    </div>
  );
}

const CSS = `
.chess { flex: 1; min-height: 0; display: flex; gap: 16px; padding: 12px 16px; align-items: flex-start; justify-content: center; }
.chess-board { width: min(calc(100vh - 110px), calc(100vw - 300px)); max-width: 640px; min-width: 240px; flex: none; }
.chess-side { width: 240px; display: flex; flex-direction: column; gap: 8px; min-height: 0; }
.chess-player { display: flex; gap: 8px; align-items: center; background: var(--panel); padding: 8px 10px; border-radius: 8px; border: 2px solid transparent; }
.chess-player.to-move { border-color: var(--accent); }
.chess-player .name { margin-left: auto; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dot { width: 12px; height: 12px; border-radius: 50%; border: 1px solid #888; }
.dot.w { background: #fff; } .dot.b { background: #111; }
.chess-result { background: #1f3b2c; color: #9ee6bd; padding: 8px 10px; border-radius: 8px; font-weight: 600; }
.chess-offer { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; background: var(--panel); padding: 8px 10px; border-radius: 8px; }
.chess-moves { margin: 0; padding: 8px 10px 8px 12px; list-style: none; background: var(--panel); border-radius: 8px; overflow: auto; max-height: 260px; font-variant-numeric: tabular-nums; color: var(--muted); }
@media (max-width: 640px) {
  .chess { flex-direction: column; align-items: center; padding: 8px; gap: 8px; }
  .chess-board { width: min(calc(100vw - 16px), calc(100vh - 300px)); }
  .chess-side { width: min(calc(100vw - 16px), 100%); }
  .chess-moves { max-height: 90px; }
}
`;

void mount<ChessG>(
  {
    title: "Chess",
    def: CHESS,
    Board,
    status: state => (state.G.result ? resultText(state.G.result) : `${SIDE[sideToMove(replay(state.G.moves))]} to move`),
  },
  { css: CSS, seatColor: s => (s === "0" ? "#ffffff" : "#111111") },
);
