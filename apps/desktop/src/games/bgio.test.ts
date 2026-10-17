// boardgame.io over the games SDK (games/_bgio/net.ts) and the rules of Chess, Four in a Row and Codewords.
// A fake relay connects several BoardRoom copies the way the server does: the sender never gets its own message, `to`
// reaches one copy, and every message must fit in 4096 bytes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "boardgame.io/client";
import { BoardRoom, HOST_LEFT_NOTE, RELAY_MAX, type BoardDef, type Player, type Sdk } from "../../games/_bgio/net";
import { CHESS, ChessGame, replay } from "../../games/chess/game";
import { FOUR, FourGame, landing, lineThrough, COLS } from "../../games/four-in-a-row/game";
import { CODEWORDS, CodewordsGame, clueError, deal, type CodewordsG, type Kind } from "../../games/codewords/game";
import { WORDS } from "../../games/codewords/words";

type Handlers = { message: Set<(d: unknown, f: string) => void>; players: Set<(p: Player[], l: string) => void>; close: Set<() => void> };

class Hub {
  peers = new Map<string, { sdk: Sdk; h: Handlers }>();
  queue: { from: string; to?: string; data: unknown }[] = [];
  players: Player[] = [];
  leader = "";
  maxBytes = 0;
  sent: { from: string; to?: string; data: unknown }[] = [];

  join(id: string, name = id): Sdk {
    const h: Handlers = { message: new Set(), players: new Set(), close: new Set() };
    if (!this.players.some(p => p.app_id === id)) this.players.push({ app_id: id, name });
    const hub = this;
    const sdk: Sdk = {
      me: { app_id: id, name },
      get players() { return hub.players; },
      get leader() { return hub.leader; },
      send(data: unknown, to?: string) {
        const text = JSON.stringify(data);
        const size = new TextEncoder().encode(text).length;
        if (size > RELAY_MAX) throw new Error(`too large: ${size}`);
        hub.maxBytes = Math.max(hub.maxBytes, size);
        const m = { from: id, to, data: JSON.parse(text) };
        hub.queue.push(m);
        hub.sent.push(m);
      },
      on: ((event: keyof Handlers, fn: never) => {
        (h[event] as Set<unknown>).add(fn);
        return () => (h[event] as Set<unknown>).delete(fn);
      }) as Sdk["on"],
    };
    this.peers.set(id, { sdk, h });
    return sdk;
  }

  /** Close a copy (the tile) and optionally leave the call. */
  close(id: string, leaveCall = false): void {
    const peer = this.peers.get(id);
    for (const fn of peer?.h.close ?? []) fn();
    this.peers.delete(id);
    if (leaveCall) this.setPlayers(this.players.filter(p => p.app_id !== id), this.leader);
  }

  setPlayers(players: Player[], leader: string): void {
    this.players = players;
    this.leader = leader;
    for (const { h } of this.peers.values()) for (const fn of h.players) fn(players, leader);
  }

  flush(): void {
    for (let guard = 0; this.queue.length && guard < 10_000; guard += 1) {
      const m = this.queue.shift()!;
      for (const [id, { h }] of this.peers) {
        if (id === m.from || (m.to !== undefined && m.to !== id)) continue;
        for (const fn of h.message) fn(m.data, m.from);
      }
    }
  }
}

let hub: Hub;
let errors: string[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  hub = new Hub();
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...a) => void errors.push(a.join(" "))); // boardgame.io logs rejected moves
});
afterEach(() => {
  // Every patch the host sends must apply (a failed one costs a full resync), and no move may hit a stale state.
  expect(errors.filter(e => /apply failed|invalid stateID/.test(e))).toEqual([]);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Open a copy and let the join window pass. */
function open(def: BoardDef, id: string): BoardRoom {
  const room = new BoardRoom(def, hub.join(id));
  hub.flush();
  vi.advanceTimersByTime(1600);
  hub.flush();
  return room;
}

function seat(room: BoardRoom, s: string | null): void {
  room.takeSeat(s);
  hub.flush();
}

const G = <T>(room: BoardRoom) => room.client?.getState()?.G as T;
const ctx = (room: BoardRoom) => room.client!.getState()!.ctx;
function move(room: BoardRoom, name: string, ...args: unknown[]): void {
  room.client!.moves[name]!(...args);
  hub.flush();
}

describe("room", () => {
  it("the first copy hosts, later copies adopt its room; seats are checked on the host", () => {
    hub.leader = "a";
    const a = open(CHESS, "a");
    const b = open(CHESS, "b");
    expect(a.isHost).toBe(true);
    expect(b.room?.host).toBe("a");
    expect(a.open.has("b") && b.open.has("a")).toBe(true);

    seat(a, "0");
    seat(b, "0"); // taken: refused
    expect(b.room?.seats).toEqual({ a: "0" });
    seat(b, "1");
    expect(a.room?.seats).toEqual({ a: "0", b: "1" });
    expect(b.room?.seats).toEqual({ a: "0", b: "1" });
  });

  it("two copies that opened alone at once settle on one host (the leader)", () => {
    hub.leader = "b";
    const a = new BoardRoom(CHESS, hub.join("a"));
    const b = new BoardRoom(CHESS, hub.join("b"));
    hub.queue = []; // the hellos were lost
    vi.advanceTimersByTime(1600);
    hub.flush();
    expect(a.room?.host).toBe("b");
    expect(b.room?.host).toBe("b");
  });
});

describe("chess over the relay", () => {
  function chessTable() {
    hub.leader = "a";
    const a = open(CHESS, "a");
    const b = open(CHESS, "b");
    const c = open(CHESS, "c"); // spectator
    seat(a, "0");
    seat(b, "1");
    a.start();
    hub.flush();
    return { a, b, c };
  }

  it("plays a game to mate, spectators follow, a move out of turn or for someone else is refused", () => {
    const { a, b, c } = chessTable();
    expect(a.room?.phase).toBe("play");
    expect(c.seat).toBeNull();
    move(b, "move", "e7", "e5"); // not Black's turn
    expect(G<{ moves: string[] }>(a).moves).toEqual([]);
    // A spectator's forged move (claiming White's seat) is dropped: the seat comes from the relay sender.
    hub.peers.get("c")!.sdk.send({ t: "a", m: "1", s: 0, act: { type: "MAKE_MOVE", payload: { type: "resign", args: [], playerID: "0" } } }, "a");
    hub.flush();
    expect(ctx(a).gameover).toBeUndefined();
    // Nor can it take over the room while the host is still there.
    hub.peers.get("c")!.sdk.send({ t: "room", room: { v: 99, host: "c", phase: "lobby", match: 1, seats: { c: "0" }, note: "" } });
    hub.flush();
    for (const r of [a, b]) expect(r.room).toMatchObject({ host: "a", phase: "play" });
    for (const [who, from, to] of [[a, "f2", "f3"], [b, "e7", "e5"], [a, "g2", "g4"], [b, "d8", "h4"]] as const) move(who, "move", from, to);
    for (const r of [a, b, c]) expect(G<{ moves: string[] }>(r).moves).toEqual(["f3", "e5", "g4", "Qh4#"]);
    expect(ctx(c).gameover).toEqual({ winner: "1", reason: "checkmate" });  });

  it("rematch swaps colours; back to lobby keeps seats", () => {
    const { a, b } = chessTable();
    move(a, "resign");
    expect(ctx(b).gameover).toEqual({ winner: "1", reason: "resignation" });
    b.rematch();
    hub.flush();
    expect(a.room?.match).toBe(2);
    expect(a.seat).toBe("1");
    expect(b.seat).toBe("0");
    expect(G<{ moves: string[] }>(b).moves).toEqual([]);
    move(b, "resign");
    a.toLobby();
    hub.flush();
    expect(b.room?.phase).toBe("lobby");
    expect(b.client).toBeNull();
  });

  it("draw offers", () => {
    const { a, b } = chessTable();
    move(a, "offerDraw");
    expect(G<{ drawOffer: string }>(b).drawOffer).toBe("0");
    move(b, "answerDraw", false);
    expect(G<{ drawOffer: null }>(a).drawOffer).toBeNull();
    move(b, "offerDraw");
    move(a, "answerDraw", true);
    expect(ctx(b).gameover).toEqual({ winner: null, reason: "agreement" });
  });

  it("resumes from the last state when the host leaves", () => {
    const { a, b, c } = chessTable();
    move(a, "move", "e2", "e4");
    move(b, "move", "e7", "e5");
    hub.close("a", true);
    hub.flush();
    // b is the best open copy left (no leader in the call any more): it hosts and continues the game.
    expect(b.isHost).toBe(true);
    expect(c.room?.host).toBe("b");
    expect(b.room?.phase).toBe("play");
    expect(G<{ moves: string[] }>(c).moves).toEqual(["e4", "e5"]);
    move(b, "resign");
    expect(ctx(c).gameover).toEqual({ winner: "0", reason: "resignation" });
  });

  it("a late joiner gets the state", () => {
    const { a, b } = chessTable();
    move(a, "move", "d2", "d4");
    const d = open(CHESS, "d");
    expect(d.room?.phase).toBe("play");
    expect(G<{ moves: string[] }>(d).moves).toEqual(["d4"]);
    move(b, "move", "d7", "d5");
    expect(G<{ moves: string[] }>(d).moves).toEqual(["d4", "d5"]);
  });

  it("a long game's messages stay under the relay limit", () => {
    const { a, b } = chessTable();
    // Knights out and back twice: the start position comes up a third time, a draw by repetition.
    const line = ["Nf3", "Nf6", "Ng1", "Ng8"];
    for (let i = 0; i < 2; i += 1) for (const san of line) {
      const who = ctx(a).gameover ? null : replay(G<{ moves: string[] }>(a).moves).turn() === "w" ? a : b;
      if (!who) break;
      const m = replay(G<{ moves: string[] }>(a).moves).move(san);
      move(who, "move", m.from, m.to);
    }
    expect(ctx(a).gameover).toEqual({ winner: null, reason: "repetition" });
    // A late joiner after a long game gets a chunked sync if needed.
    const d = open(CHESS, "d");
    expect(G<{ moves: string[] }>(d).moves.length).toBe(8);
    expect(hub.maxBytes).toBeLessThanOrEqual(RELAY_MAX);
  });
});

describe("relay limits", () => {
  it("chunks a sync bigger than 4096 bytes", () => {
    hub.leader = "a";
    const a = open(CHESS, "a");
    const b = open(CHESS, "b");
    seat(a, "0");
    seat(b, "1");
    a.start();
    hub.flush();
    // 150 legal plies of shuffling pieces around without repeating a position thrice is fiddly; fake a long history
    // by patching the host's stored state directly, then have a new copy sync.
    const store = (a as unknown as { hosted: { master: { storageAPI: { state: { G: { moves: string[] } } } } } }).hosted.master.storageAPI;
    store.state = { ...store.state, G: { ...store.state.G, moves: Array(900).fill("Nf3") } };
    const d = open(CHESS, "d");
    expect(G<{ moves: string[] }>(d).moves).toHaveLength(900);
    expect(hub.sent.some(m => (m.data as { t: string }).t === "ch")).toBe(true);
    expect(hub.maxBytes).toBeLessThanOrEqual(RELAY_MAX);
  });
});

describe("four in a row", () => {
  it("landing and lines", () => {
    const cells = Array<"0" | "1" | null>(42).fill(null);
    expect(landing(cells, 3)).toBe(5 * COLS + 3);
    for (const c of [0, 1, 2, 3]) cells[5 * COLS + c] = "0";
    expect(lineThrough(cells, 5 * COLS + 2)).toEqual([35, 36, 37, 38]);
    const diag = Array<"0" | "1" | null>(42).fill(null);
    for (let k = 0; k < 4; k += 1) diag[(5 - k) * COLS + k] = "1";
    expect(lineThrough(diag, 5 * COLS)).toHaveLength(4);
  });

  it("plays to a win over the relay", () => {
    hub.leader = "a";
    const a = open(FOUR, "a");
    const b = open(FOUR, "b");
    seat(a, "0");
    seat(b, "1");
    b.start();
    hub.flush();
    for (const [who, col] of [[a, 0], [b, 1], [a, 0], [b, 1], [a, 0], [b, 1]] as const) move(who, "drop", col);
    move(b, "drop", 1); // not Yellow's turn
    move(a, "drop", 0);
    expect(ctx(b).gameover).toMatchObject({ winner: "0", reason: "four" });
    expect(G<{ result: { line: number[] } }>(b).result.line).toEqual([14, 21, 28, 35]);
  });

  it("a full column is refused (local rules)", () => {
    const c = Client({ game: FourGame, numPlayers: 2, playerID: "0" });
    for (let i = 0; i < 6; i += 1) {
      c.updatePlayerID(i % 2 ? "1" : "0");
      c.moves.drop!(2);
    }
    c.updatePlayerID("0");
    c.moves.drop!(2);
    expect(c.getState()!.G.cells.filter(Boolean)).toHaveLength(6);
    c.stop();
  });
});

describe("codewords", () => {
  it("has at least 400 distinct one-word nouns", () => {
    expect(WORDS.length).toBeGreaterThanOrEqual(400);
    expect(new Set(WORDS).size).toBe(WORDS.length);
    for (const w of WORDS) expect(w).toMatch(/^[a-z]+$/);
  });

  it("deals 9 / 8 / 7 / 1 on 25 distinct words", () => {
    let seed = 1;
    const s = deal(() => ((seed = (seed * 16807) % 2147483647) / 2147483647));
    expect(new Set(s.words).size).toBe(25);
    const count = (k: Kind) => s.key.filter(x => x === k).length;
    expect(count(s.first)).toBe(9);
    expect(count(s.first === "r" ? "b" : "r")).toBe(8);
    expect(count("n")).toBe(7);
    expect(count("a")).toBe(1);
  });

  it("rejects clues that are not one word or that are on the board", () => {
    const board = { words: ["apple", "castle"] };
    expect(clueError(board, "fruit")).toBeNull();
    expect(clueError(board, "two words")).not.toBeNull();
    expect(clueError(board, "Apple")).not.toBeNull();
    expect(clueError(board, "castles")).not.toBeNull();
    expect(clueError(board, "r2d2")).not.toBeNull();
  });

  function table() {
    hub.leader = "a";
    const rooms = ["a", "b", "c", "d", "e"].map(id => open(CODEWORDS, id));
    const [a, b, c, d, e] = rooms as [BoardRoom, BoardRoom, BoardRoom, BoardRoom, BoardRoom];
    seat(a, "0");
    seat(b, "1");
    seat(c, "2");
    seat(d, "3"); // e spectates
    a.start();
    hub.flush();
    return { a, b, c, d, e };
  }

  it("only the clue-givers get the key; the host sends it only to them", () => {
    const { a, b, c, d, e } = table();
    const sent = hub.sent.length;
    for (const r of [a, c]) expect(G<CodewordsG>(r).key.every(k => k !== null)).toBe(true);
    for (const r of [b, d, e]) expect(G<CodewordsG>(r).key.every(k => k === null)).toBe(true);
    // Every message carrying a full key went to a clue-giver by app id.
    for (const m of hub.sent) {
      const text = JSON.stringify(m.data);
      if (/"key":\["?[rbna]"?,/.test(text) || text.includes('\\"key\\":[\\"')) expect(["a", "c"]).toContain(m.to);
    }
    expect(sent).toBeGreaterThan(0);
  });

  it("clue, guesses, turn passes on a miss, the assassin ends the game and reveals the key", () => {
    const { a, b, c, d, e } = table();
    const full = G<CodewordsG>(a);
    const team = full.turn;
    const [clueGiver, guesser, otherClue, otherGuess] = team === "r" ? [a, b, c, d] : [c, d, a, b];
    move(guesser, "guess", 0); // no clue yet
    expect(G<CodewordsG>(e).revealed.some(Boolean)).toBe(false);
    move(clueGiver, "clue", full.words[0], 1); // a board word: refused
    expect(G<CodewordsG>(e).stage).toBe("clue");
    move(clueGiver, "clue", "zzz", 1);
    expect(G<CodewordsG>(e).clue).toEqual({ team, word: "zzz", n: 1 });

    const mine = full.key.indexOf(team);
    move(guesser, "guess", mine);
    expect(G<CodewordsG>(e).revealed[mine]).toBe(true);
    expect(G<CodewordsG>(e).key[mine]).toBe(team); // revealed cards show their colour to everyone
    const neutral = full.key.indexOf("n");
    move(guesser, "guess", neutral);
    expect(G<CodewordsG>(e).turn).not.toBe(team);

    move(otherClue, "clue", "qqq", 2);
    expect(G<CodewordsG>(e).clue?.word).toBe("qqq");
    move(otherGuess, "guess", full.key.indexOf("a"));
    expect(ctx(e).gameover).toEqual({ winner: team, reason: "assassin" });
    expect(G<CodewordsG>(e).key.every(k => k !== null)).toBe(true);
  });

  it("ends the round when the host leaves (hidden info)", () => {
    const { a, b, c } = table();
    hub.close("a", true);
    hub.flush();
    expect(b.isHost).toBe(true);
    expect(c.room?.phase).toBe("lobby");
    expect(c.room?.note).toBe(HOST_LEFT_NOTE);
    expect(c.client).toBeNull();
  });
});

describe("rules without the relay", () => {
  it("chess refuses illegal moves and a move by the wrong side", () => {
    const c = Client({ game: ChessGame, numPlayers: 2, playerID: "0" });
    c.moves.move!("e2", "e5");
    expect(c.getState()!.G.moves).toEqual([]);
    c.moves.move!("e2", "e4");
    c.moves.move!("d2", "d4"); // Black to move
    expect(c.getState()!.G.moves).toEqual(["e4"]);
    c.stop();
  });

  it("codewords: a clue of 0 allows unlimited guesses, a pass needs a guess first", () => {
    const c = Client({ game: CodewordsGame, numPlayers: 4, playerID: "0" });
    const g = () => c.getState()!.G;
    const t = g().turn;
    c.updatePlayerID(t === "r" ? "0" : "2");
    c.moves.clue!("zzz", 0);
    const own = g().key.map((k, i) => (k === t ? i : -1)).filter(i => i >= 0); // the clue-giver's view has the key
    c.updatePlayerID(t === "r" ? "1" : "3");
    expect(g().key.every(k => k === null)).toBe(true);
    c.moves.pass!();
    expect(g().stage).toBe("guess");
    for (const i of own.slice(0, 3)) c.moves.guess!(i);
    expect(g().turn).toBe(t);
    c.moves.pass!();
    expect(g().turn).not.toBe(t);
    c.stop();
  });
});
