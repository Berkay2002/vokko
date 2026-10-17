// Codewords: clue-givers see the key and give a one-word clue with a number; their team's guessers pick words.

import { useState } from "react";
import { mount, holders, type BoardProps } from "../_bgio/ui";
import { CLUE_SEAT, CODEWORDS, GUESS_SEAT, clueError, remaining, type CodewordsG, type Team } from "./game";

const TEAM = { r: "Red", b: "Blue" } as const;

function resultText(G: CodewordsG): string {
  const r = G.result!;
  return `${TEAM[r.winner]} wins${r.reason === "assassin" ? ": the other team found the assassin" : ""}`;
}

function statusText(G: CodewordsG): string {
  if (G.result) return resultText(G);
  if (G.stage === "clue") return `${TEAM[G.turn]} clue-giver is thinking`;
  const left = G.left === 0 ? "any number of guesses" : `${G.left} guess${G.left === 1 ? "" : "es"} left`;
  return `${TEAM[G.turn]} is guessing: ${left}`;
}

function ClueForm({ G, move }: { G: CodewordsG; move: BoardProps["move"] }) {
  const [word, setWord] = useState("");
  const [n, setN] = useState(1);
  const error = word.trim() ? clueError(G, word) : null;
  const give = () => {
    if (!word.trim() || error) return;
    move("clue", word.trim(), n);
    setWord("");
  };
  return (
    <div className="cw-clue-form">
      <input value={word} onChange={e => setWord(e.target.value)} onKeyDown={e => e.key === "Enter" && give()} maxLength={24}
        placeholder="One-word clue" aria-label="Clue" autoComplete="off" />
      <select value={n} onChange={e => setN(Number(e.target.value))} aria-label="Number">
        {Array.from({ length: 10 }, (_, i) => (
          <option key={i} value={i}>{i === 0 ? "0 (any)" : i}</option>
        ))}
      </select>
      <button disabled={!word.trim() || !!error} onClick={give}>Give clue</button>
      {error && <span className="cw-error">{error}</span>}
    </div>
  );
}

function Board({ room, state, seat, move }: BoardProps<CodewordsG>) {
  const G = state.G;
  const over = !!G.result;
  const giver = seat === CLUE_SEAT.r || seat === CLUE_SEAT.b;
  const myGuess = !over && G.stage === "guess" && seat === GUESS_SEAT[G.turn];
  const myClue = !over && G.stage === "clue" && seat === CLUE_SEAT[G.turn];
  return (
    <div className="cw">
      <div className="cw-grid" role="grid" aria-label="Words">
        {G.words.map((w, i) => {
          const kind = G.key[i];
          const shown = G.revealed[i];
          const cls = ["cw-card", shown ? `on k-${kind}` : kind && (giver || over) ? `hint k-${kind}` : ""].join(" ");
          return (
            <button key={i} className={cls} disabled={!myGuess || shown} onClick={() => move("guess", i)} aria-pressed={shown} data-index={i}>
              {w}
            </button>
          );
        })}
      </div>
      <aside className="cw-side">
        {(["r", "b"] as Team[]).map(t => (
          <div key={t} className={`cw-team t-${t}${G.turn === t && !over ? " to-move" : ""}`}>
            <strong>{TEAM[t]}</strong> <span className="cw-left">{remaining(G, t) || (G.key.some(k => k === null) ? "?" : 0)} left</span>
            <div className="cw-who">Clue: {holders(room, CLUE_SEAT[t]).join(", ") || "Empty"}</div>
            <div className="cw-who">Guess: {holders(room, GUESS_SEAT[t]).join(", ") || "Empty"}</div>
          </div>
        ))}
        {G.result && <div className="cw-result" role="status">{resultText(G)}</div>}
        {G.clue && !over && (
          <div className={`cw-current t-${G.clue.team}`} data-testid="clue">
            {G.clue.word} {G.clue.n}
          </div>
        )}
        {myClue && <ClueForm G={G} move={move} />}
        {myGuess && G.guessed > 0 && (
          <button className="ghost" onClick={() => move("pass")}>End guessing</button>
        )}
        <ol className="cw-clues" aria-label="Clues">
          {G.clues.map((c, i) => (
            <li key={i} className={`t-${c.team}`}>{c.word} {c.n}</li>
          ))}
        </ol>
      </aside>
    </div>
  );
}

const CSS = `
.cw { flex: 1; display: flex; gap: 16px; padding: 12px 16px; align-items: flex-start; justify-content: center; }
.cw-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; width: min(760px, calc(100vw - 300px)); }
.cw-card { aspect-ratio: 8 / 5; display: flex; align-items: center; justify-content: center; padding: 4px; border-radius: 8px;
  background: #ece6d6; color: #222; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; font-size: clamp(10px, 1.4vw, 16px);
  border: 3px solid transparent; overflow-wrap: anywhere; }
.cw-card:disabled { opacity: 1; cursor: default; }
.cw-card:not(:disabled):hover { filter: brightness(1.08); outline: 2px solid var(--accent); }
.cw-card.hint.k-r { border-color: var(--red); background: #f3d3d3; }
.cw-card.hint.k-b { border-color: var(--blue); background: #d3e2f3; }
.cw-card.hint.k-n { border-color: #b9ad8c; }
.cw-card.hint.k-a { border-color: #111; background: #8d8d8d; color: #fff; }
.cw-card.on { color: #fff; text-decoration: line-through; text-decoration-thickness: 2px; }
.cw-card.on.k-r { background: var(--red); }
.cw-card.on.k-b { background: var(--blue); }
.cw-card.on.k-n { background: #a2977a; }
.cw-card.on.k-a { background: #111; }
.cw-side { width: 240px; display: flex; flex-direction: column; gap: 8px; }
.cw-team { background: var(--panel); border-radius: 8px; padding: 8px 10px; border-left: 4px solid; }
.cw-team.t-r { border-left-color: var(--red); } .cw-team.t-b { border-left-color: var(--blue); }
.cw-team.to-move { outline: 2px solid var(--accent); }
.cw-left { color: var(--muted); }
.cw-who { color: var(--muted); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cw-current { font-size: 22px; font-weight: 700; text-transform: uppercase; text-align: center; padding: 8px; border-radius: 8px; background: var(--panel); }
.cw-current.t-r { color: #ff8a8d; } .cw-current.t-b { color: #8cc2ff; }
.cw-clue-form { display: flex; flex-wrap: wrap; gap: 6px; }
.cw-clue-form input { flex: 1; min-width: 0; font: inherit; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--text); }
.cw-clue-form select { font: inherit; border-radius: 6px; background: var(--bg); color: var(--text); border: 1px solid var(--line); }
.cw-error { color: #ff8a8d; font-size: 13px; width: 100%; }
.cw-result { background: #1f3b2c; color: #9ee6bd; padding: 8px 10px; border-radius: 8px; font-weight: 600; }
.cw-clues { margin: 0; padding: 8px 12px; list-style: none; background: var(--panel); border-radius: 8px; max-height: 200px; overflow: auto; }
.cw-clues .t-r { color: #ff8a8d; } .cw-clues .t-b { color: #8cc2ff; }
@media (max-width: 640px) {
  .cw { flex-direction: column; align-items: center; padding: 8px; gap: 8px; }
  .cw-grid { width: calc(100vw - 16px); gap: 4px; }
  .cw-card { font-size: 10px; border-width: 2px; aspect-ratio: 5 / 4; }
  .cw-side { width: calc(100vw - 16px); }
  .cw-clues { max-height: 80px; }
}
`;

void mount<CodewordsG>(
  { title: "Codewords", def: CODEWORDS, Board, status: state => statusText(state.G) },
  { css: CSS, seatColor: s => (s === "0" || s === "1" ? "#e5484d" : "#3e8ed0") },
);
