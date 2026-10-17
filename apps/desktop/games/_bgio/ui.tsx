// The shared shell of the boardgame.io games: connect to Vokko, the lobby (seats, start), the game area and the
// rematch / lobby buttons after a game. Each game passes its rules (BoardDef) and a Board component.
// Relay data reaches the page only through React text nodes (never innerHTML).

import { StrictMode, useSyncExternalStore, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { State } from "boardgame.io";
import { BoardRoom, type BoardDef, type Sdk } from "./net";

declare const VokkoGames: { connect(): Promise<Sdk & { ready(): void }> };

export interface BoardProps<G = unknown> {
  room: BoardRoom;
  state: State<G>;
  /** This copy's seat (boardgame.io playerID), or null when watching. */
  seat: string | null;
  move(name: string, ...args: unknown[]): void;
}

export interface GameUi<G> {
  title: string;
  def: BoardDef;
  Board(props: BoardProps<G>): ReactNode;
  /** One line under the title while playing ("White to move", "Red wins"). */
  status(state: State<G>, room: BoardRoom): string;
}

const CSS = `
:root { color-scheme: dark; --bg: #1e1f22; --panel: #2b2d31; --line: #3f4147; --text: #f2f3f5; --muted: #b5bac1;
  --accent: #5865f2; --red: #e5484d; --blue: #3e8ed0; --yellow: #f0c43c; --green: #2fa36b; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font: 15px/1.4 system-ui, "Segoe UI", sans-serif; }
#root { height: 100%; }
button { font: inherit; color: var(--text); background: var(--accent); border: 0; border-radius: 6px; padding: 7px 14px; cursor: pointer; }
button:disabled { opacity: .45; cursor: default; }
button.ghost { background: transparent; border: 1px solid var(--line); }
button.danger { background: #a33a3d; }
.bg-app { height: 100%; display: flex; flex-direction: column; }
.bg-top { display: flex; align-items: baseline; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.bg-top h1 { font-size: 17px; margin: 0; }
.bg-status { color: var(--muted); }
.bg-role { margin-left: auto; font-size: 13px; color: var(--muted); }
.bg-main { flex: 1; min-height: 0; display: flex; overflow: auto; }
.bg-center { margin: auto; padding: 24px 16px; text-align: center; color: var(--muted); }
.bg-lobby { margin: auto; width: min(520px, 100%); padding: 20px 16px; display: flex; flex-direction: column; gap: 10px; }
.bg-lobby h2 { margin: 0 0 4px; font-size: 16px; }
.bg-seat { display: flex; align-items: center; gap: 10px; background: var(--panel); border-radius: 8px; padding: 10px 12px; }
.bg-seat .who { flex: 1; min-width: 0; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bg-seat .label { font-weight: 600; min-width: 128px; }
.bg-seat .swatch { width: 12px; height: 12px; border-radius: 50%; flex: none; }
.bg-note { background: #4a3b1a; color: #f5d68a; border-radius: 8px; padding: 8px 12px; }
.bg-watch { color: var(--muted); font-size: 13px; }
.bg-actions { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }
.bg-over { display: flex; gap: 8px; justify-content: center; padding: 10px; border-top: 1px solid var(--line); flex-wrap: wrap; }
.bg-play { flex: 1; min-height: 0; display: flex; }
@media (max-width: 640px) { .bg-seat .label { min-width: 0; } }
`;

function useRoom(room: BoardRoom): number {
  return useSyncExternalStore(cb => room.subscribe(cb), () => room.version);
}

/** Who sits in `seat`, as names. */
export const holders = (room: BoardRoom, seat: string): string[] =>
  Object.entries(room.room?.seats ?? {}).filter(([, s]) => s === seat).map(([id]) => (id === room.me ? `${room.nameOf(id)} (you)` : room.nameOf(id)));

function Lobby({ room, seatColor }: { room: BoardRoom; seatColor?: (seat: string) => string }) {
  const r = room.room!;
  const mine = room.seat;
  const seated = new Set(Object.keys(r.seats));
  const watching = room.sdk.players.filter(p => !seated.has(p.app_id) && (p.app_id === room.me || room.open.has(p.app_id)));
  return (
    <section className="bg-lobby" aria-label="Lobby">
      {r.note && <div className="bg-note" role="status">{r.note}</div>}
      <h2>Pick a seat</h2>
      {room.def.seats.map(s => {
        const who = holders(room, s.id);
        const taken = !s.multi && who.length > 0 && mine !== s.id;
        return (
          <div className="bg-seat" key={s.id} data-seat={s.id}>
            {seatColor && <span className="swatch" style={{ background: seatColor(s.id) }} />}
            <span className="label">{s.label}</span>
            <span className="who">{who.length ? who.join(", ") : "Empty"}</span>
            {mine === s.id ? (
              <button className="ghost" onClick={() => room.takeSeat(null)}>Leave</button>
            ) : (
              <button disabled={taken} onClick={() => room.takeSeat(s.id)} aria-label={`Sit as ${s.label}`}>Sit</button>
            )}
          </div>
        );
      })}
      {watching.length > 0 && <div className="bg-watch">Watching: {watching.map(p => (p.app_id === room.me ? `${p.name} (you)` : p.name)).join(", ")}</div>}
      <div className="bg-actions">
        <button disabled={!mine || !room.def.canStart(r.seats)} onClick={() => room.start()}>Start</button>
      </div>
    </section>
  );
}

function Shell<G>({ room, ui, seatColor }: { room: BoardRoom; ui: GameUi<G>; seatColor?: (seat: string) => string }) {
  useRoom(room);
  const r = room.room;
  const state = room.client?.getState() as State<G> | null | undefined;
  const seat = room.seat;
  const role = seat === null ? "Watching" : ui.def.seats.find(s => s.id === seat)?.label ?? "";
  let body: ReactNode;
  let status = "";
  if (!r) body = <div className="bg-center">Joining...</div>;
  else if (r.phase === "lobby") {
    body = <Lobby room={room} seatColor={seatColor} />;
    status = ui.def.canStart(r.seats) ? "Ready to start" : "Waiting for players";
  } else if (!state) body = <div className="bg-center">Loading the game...</div>;
  else {
    status = ui.status(state, room);
    const move = (name: string, ...args: unknown[]) => room.client?.moves[name]?.(...args);
    body = (
      <div className="bg-play">
        <ui.Board room={room} state={state} seat={seat} move={move} />
      </div>
    );
  }
  const over = r?.phase === "play" && state?.ctx.gameover !== undefined;
  return (
    <div className="bg-app">
      <header className="bg-top">
        <h1>{ui.title}</h1>
        <span className="bg-status" id="status" aria-live="polite">{status}</span>
        {r && <span className="bg-role">{role}</span>}
      </header>
      <main className="bg-main">{body}</main>
      {over && seat !== null && (
        <div className="bg-over">
          <button onClick={() => room.rematch()}>Rematch</button>
          <button className="ghost" onClick={() => room.toLobby()}>Back to lobby</button>
        </div>
      )}
    </div>
  );
}

/** Connect to Vokko and render the game. */
export async function mount<G>(ui: GameUi<G>, opts: { css?: string; seatColor?: (seat: string) => string } = {}): Promise<void> {
  const style = document.createElement("style");
  style.textContent = CSS + (opts.css ?? "");
  document.head.append(style);
  const el = document.getElementById("root")!;
  const root = createRoot(el);
  let sdk: Awaited<ReturnType<typeof VokkoGames.connect>>;
  try {
    sdk = await VokkoGames.connect();
  } catch (err) {
    root.render(<div className="bg-center">{err instanceof Error ? err.message : String(err)}</div>);
    return;
  }
  const room = new BoardRoom(ui.def, sdk);
  root.render(
    <StrictMode>
      <Shell room={room} ui={ui} seatColor={opts.seatColor} />
    </StrictMode>,
  );
  sdk.ready();
}
