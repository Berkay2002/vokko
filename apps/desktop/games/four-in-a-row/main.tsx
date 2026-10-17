// Four in a Row: click a column to drop a disc.

import { mount, holders, type BoardProps } from "../_bgio/ui";
import { COLS, FOUR, ROWS, landing, type FourG } from "./game";

const NAME = { "0": "Red", "1": "Yellow" } as const;

function resultText(G: FourG): string {
  const r = G.result!;
  if (r.reason === "full") return "Draw: the board is full";
  return `${NAME[r.winner!]} wins${r.reason === "resignation" ? " by resignation" : ""}`;
}

function Board({ room, state, seat, move }: BoardProps<FourG>) {
  const G = state.G;
  const playing = !G.result && (seat === "0" || seat === "1");
  const myTurn = playing && G.turn === seat;
  const win = new Set(G.result?.line ?? []);
  return (
    <div className="four">
      <div className="four-grid" role="grid" aria-label="Board" data-turn={G.turn}>
        {Array.from({ length: COLS }, (_, c) => (
          <button
            key={c}
            className="four-col"
            disabled={!myTurn || landing(G.cells, c) < 0}
            aria-label={`Drop in column ${c + 1}`}
            onClick={() => move("drop", c)}
          >
            {Array.from({ length: ROWS }, (_, r) => {
              const disc = G.cells[r * COLS + c];
              return <span key={r} className={`four-cell${disc ? ` d${disc}` : ""}${win.has(r * COLS + c) ? " win" : ""}`} />;
            })}
          </button>
        ))}
      </div>
      <aside className="four-side">
        {(["0", "1"] as const).map(d => (
          <div key={d} className={`four-player${G.turn === d && !G.result ? " to-move" : ""}`}>
            <span className={`four-cell d${d} small`} />
            <span>{NAME[d]}</span>
            <span className="name">{holders(room, d).join(", ") || "Empty"}</span>
          </div>
        ))}
        {G.result && <div className="four-result" role="status">{resultText(G)}</div>}
        {playing && (
          <div className="bg-actions">
            <button className="danger" onClick={() => move("resign")}>Resign</button>
          </div>
        )}
      </aside>
    </div>
  );
}

const CSS = `
.four { flex: 1; display: flex; gap: 16px; padding: 12px 16px; align-items: flex-start; justify-content: center; }
.four-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; padding: 10px; background: #2f4fb3; border-radius: 14px;
  width: min(calc((100vh - 120px) * 7 / 6), calc(100vw - 300px)); max-width: 640px; min-width: 240px; }
.four-col { display: grid; grid-template-rows: repeat(6, 1fr); gap: 6px; padding: 0; background: transparent; border-radius: 10px; }
.four-col:not(:disabled):hover { background: rgba(255, 255, 255, .12); }
.four-col:disabled { opacity: 1; }
.four-cell { display: block; aspect-ratio: 1; border-radius: 50%; background: var(--bg); box-shadow: inset 0 3px 6px rgba(0, 0, 0, .5); }
.four-cell.d0 { background: radial-gradient(circle at 35% 35%, #ff7a7e, var(--red) 60%); }
.four-cell.d1 { background: radial-gradient(circle at 35% 35%, #ffe28a, var(--yellow) 60%); }
.four-cell.win { outline: 4px solid #fff; outline-offset: -4px; }
.four-cell.small { width: 14px; }
.four-side { width: 220px; display: flex; flex-direction: column; gap: 8px; }
.four-player { display: flex; gap: 8px; align-items: center; background: var(--panel); padding: 8px 10px; border-radius: 8px; border: 2px solid transparent; }
.four-player.to-move { border-color: var(--accent); }
.four-player .name { margin-left: auto; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.four-result { background: #1f3b2c; color: #9ee6bd; padding: 8px 10px; border-radius: 8px; font-weight: 600; }
@media (max-width: 640px) {
  .four { flex-direction: column; align-items: center; padding: 8px; }
  .four-grid { width: calc(100vw - 16px); gap: 4px; padding: 6px; }
  .four-col { gap: 4px; }
  .four-side { width: calc(100vw - 16px); }
}
`;

void mount<FourG>(
  {
    title: "Four in a Row",
    def: FOUR,
    Board,
    status: state => (state.G.result ? resultText(state.G) : `${NAME[state.G.turn]} to move`),
  },
  { css: CSS, seatColor: s => (s === "0" ? "#e5484d" : "#f0c43c") },
);
