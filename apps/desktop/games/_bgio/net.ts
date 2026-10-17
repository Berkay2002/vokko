// boardgame.io over the Vokko games SDK (docs/games-sdk.md): one open copy of the game is the host and runs boardgame.io's
// Master, like @boardgame.io/p2p's host mode with the SDK relay in place of PeerJS. Everyone else runs a boardgame.io Client
// whose transport sends actions to the host and applies the updates it sends back.
//
// Above the match sits a small room: who has the game open, who hosts, the seats (app id -> boardgame.io playerID), and
// lobby/play. The host owns the room and broadcasts it; seat claims and start/rematch requests go to the host.
//
// - Host: the copy that has hosted since the room began. A copy that opens alone (no answer to its `hi` within the join
//   window) hosts a fresh lobby. When the host leaves, the best open copy takes over (the SDK leader first, then the
//   smallest app id): games without hidden info resume from its last state, games with hidden info end the round.
// - Seats are checked on the host against the relay's `from`, so nobody can move for someone else.
// - Private state (a clue-giver's key) only goes out with send(data, appId) after boardgame.io's playerView filter.
// - Anything over the relay's 4096 bytes is split into chunks; the log is never sent (only deltalogs and the state).

import { Client } from "boardgame.io/client";
import { Master } from "boardgame.io/master";
import { Sync, Transport, createMatch, getFilterPlayerView } from "boardgame.io/internal";
import type { Game, LogEntry, Server, State } from "boardgame.io";

export interface Player {
  app_id: string;
  name: string;
}

/** The part of a VokkoGames session (public/games/vokko-games.js) the room uses. */
export interface Sdk {
  me: Player;
  players: Player[];
  leader: string;
  send(data: unknown, to?: string): void;
  on(event: "message", fn: (data: unknown, from: string) => void): () => void;
  on(event: "players", fn: (players: Player[], leader: string) => void): () => void;
  on(event: "close", fn: () => void): () => void;
}

export interface Seat {
  /** The boardgame.io playerID. */
  id: string;
  label: string;
  /** More than one person may sit here (Codewords guessers). */
  multi?: boolean;
}

export interface BoardDef {
  game: Game;
  numPlayers: number;
  seats: Seat[];
  /** Hidden info (hands, keys): a host change ends the round instead of resuming it. */
  hidden: boolean;
  /** Whether the seated people are enough to start. */
  canStart(seats: Record<string, string>): boolean;
  /** Rematch: who sits where next (Chess and Four in a Row swap colours). */
  rematch?(seats: Record<string, string>): Record<string, string>;
  /** Host-only setup data for a new match (random boards); never broadcast. */
  setupData?(): unknown;
}

export interface Room {
  /** Bumped by the host on every change. */
  v: number;
  host: string;
  phase: "lobby" | "play";
  /** Match number, also the boardgame.io matchID. */
  match: number;
  seats: Record<string, string>;
  note: string;
}

type Msg = Record<string, unknown> & { t: string };
type ClientT = ReturnType<typeof Client>;
/** What a Master sends a client ("sync", "update", "patch", "matchData"). */
type TransportData = { type: string; args: unknown[] };

export const RELAY_MAX = 4096;
const CHUNK_CHARS = 1000; // at most 3 bytes a char in JSON, so a chunk stays well under 4096 bytes with its envelope
const JOIN_MS = 1500;

export const HOST_LEFT_NOTE = "The host left, so the round ended.";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const bytes = (text: string) => new TextEncoder().encode(text).length;

/** In-memory storage for the host's Master. Keeps no log: nobody gets the full log, only deltalogs. */
class Memory extends Sync {
  state?: State;
  initialState?: State;
  metadata?: Server.MatchData;
  createMatch(_id: string, opts: { initialState: State; metadata: Server.MatchData }): void {
    this.state = this.initialState = opts.initialState;
    this.metadata = opts.metadata;
  }
  setState(_id: string, state: State): void {
    this.state = state;
  }
  setMetadata(_id: string, metadata: Server.MatchData): void {
    this.metadata = metadata;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fetch(): any {
    return { state: this.state, initialState: this.initialState, metadata: this.metadata, log: [] as LogEntry[] };
  }
  wipe(): void {
    this.state = undefined;
  }
  listMatches(): string[] {
    return this.state ? ["match"] : [];
  }
}

/** The host side of one match. */
interface Hosted {
  matchID: string;
  master: Master;
  /** During master.onSync: the app id that asked (onSync calls send() before its first await with sync storage). */
  syncTarget: string | null;
  /** Inside master.onUpdate. */
  busy: boolean;
  pendingSync: string[];
}

export class BoardRoom {
  readonly def: BoardDef;
  readonly sdk: Sdk;
  readonly me: string;
  room: Room | null = null;
  /** The running boardgame.io client for the current match, if any. */
  client: ClientT | null = null;
  /** Copies that have the game open (they said hi or answered ours), not counting this one. */
  readonly open = new Set<string>();
  private hosted: Hosted | null = null;
  private transport: VokkoTransport | null = null;
  private chunks = new Map<string, { n: number; parts: string[] }>();
  private chunkSeq = 0;
  private joinTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private offs: (() => void)[] = [];
  private filter: ReturnType<typeof getFilterPlayerView>;
  /** Bumps on every change, for React's useSyncExternalStore. */
  version = 0;

  constructor(def: BoardDef, sdk: Sdk, opts: { joinMs?: number } = {}) {
    this.def = def;
    this.sdk = sdk;
    this.me = sdk.me.app_id;
    this.filter = getFilterPlayerView(def.game);
    this.offs.push(
      sdk.on("message", (data, from) => this.receive(data, from)),
      sdk.on("players", () => this.onPlayers()),
      sdk.on("close", () => this.close()),
    );
    this.post({ t: "hi" });
    this.joinTimer = setTimeout(() => {
      this.joinTimer = null;
      if (!this.room) this.becomeHost(null);
    }, opts.joinMs ?? JOIN_MS);
  }

  // ---- public API for the UI ----

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get isHost(): boolean {
    return this.room?.host === this.me;
  }

  /** This copy's boardgame.io playerID, or null for a spectator. */
  get seat(): string | null {
    return this.room?.seats[this.me] ?? null;
  }

  nameOf(appId: string): string {
    return this.sdk.players.find(p => p.app_id === appId)?.name ?? "Someone";
  }

  takeSeat(seat: string | null): void {
    this.request({ t: "seat", seat });
  }

  start(): void {
    this.request({ t: "start" });
  }

  rematch(): void {
    this.request({ t: "rematch" });
  }

  toLobby(): void {
    this.request({ t: "lobby" });
  }

  close(): void {
    if (this.joinTimer) clearTimeout(this.joinTimer);
    this.post({ t: "bye" });
    this.client?.stop();
    this.client = null;
    for (const off of this.offs) off();
    this.offs = [];
  }

  // ---- relay ----

  /** Send `msg` to everyone or one copy, in chunks when it is over the relay limit. */
  private post(msg: Msg, to?: string): void {
    const text = JSON.stringify(msg);
    if (bytes(text) <= RELAY_MAX) return this.sdk.send(msg, to);
    const id = `${this.me.slice(0, 4)}${(this.chunkSeq += 1)}`;
    const n = Math.ceil(text.length / CHUNK_CHARS);
    for (let i = 0; i < n; i += 1) this.sdk.send({ t: "ch", id, i, n, s: text.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS) }, to);
  }

  private receive(data: unknown, from: string): void {
    if (!isObj(data) || typeof data.t !== "string") return;
    if (data.t === "ch") return this.receiveChunk(data, from);
    const msg = data as Msg;
    switch (msg.t) {
      case "hi":
        this.open.add(from);
        this.post({ t: "here", room: this.room }, from);
        return this.changed();
      case "here":
        this.open.add(from);
        if (!this.room && isRoom(msg.room)) {
          this.open.add(msg.room.host);
          this.applyRoom(msg.room);
        }
        return this.changed();
      case "bye":
        this.open.delete(from);
        return this.lost([from]);
      case "room":
        if (isRoom(msg.room) && msg.room.host === from) this.onRoom(msg.room, from);
        return;
      case "d":
        // Transport data from the host for our match.
        if (from === this.room?.host && isObj(msg.d) && msg.m === this.client?.matchID) this.transport?.deliver(msg.d as TransportData);
        return;
      default:
        if (this.isHost) this.hostReceive(msg, from);
    }
  }

  private receiveChunk(data: Record<string, unknown>, from: string): void {
    const { id, i, n, s } = data;
    if (typeof id !== "string" || typeof i !== "number" || typeof n !== "number" || typeof s !== "string" || n > 64 || i < 0 || i >= n) return;
    const key = `${from}:${id}`;
    const entry = this.chunks.get(key) ?? { n, parts: [] };
    entry.parts[i] = s;
    this.chunks.set(key, entry);
    if (entry.parts.filter(p => p !== undefined).length < entry.n) return;
    this.chunks.delete(key);
    let whole: unknown;
    try {
      whole = JSON.parse(entry.parts.join(""));
    } catch {
      return;
    }
    if (isObj(whole) && whole.t !== "ch") this.receive(whole, from);
  }

  /** A request for the host: handled here when this copy hosts, else sent to the host. */
  private request(msg: Msg): void {
    if (!this.room) return;
    if (this.isHost) this.hostReceive(msg, this.me);
    else this.post(msg, this.room.host);
  }

  // ---- room ----

  private rank(appId: string): string {
    return appId === this.sdk.leader ? "" : appId; // the leader sorts first, then app ids
  }

  private onRoom(room: Room, from: string): void {
    if (this.isHost && from !== this.me) {
      // Two hosts (both opened alone at once): the better-ranked one keeps hosting, the other adopts its room.
      if (this.rank(from) < this.rank(this.me)) this.dropHosting();
      else return this.broadcastRoom();
    }
    this.open.add(from);
    this.applyRoom(room);
  }

  private onPlayers(): void {
    const inCall = new Set(this.sdk.players.map(p => p.app_id));
    const gone = [...this.open].filter(id => !inCall.has(id));
    for (const id of gone) this.open.delete(id);
    this.lost(gone);
  }

  /** Copies that closed the game or left the call. */
  private lost(gone: string[]): void {
    const room = this.room;
    if (!room) return this.changed();
    if (gone.includes(room.host)) {
      const next = [this.me, ...this.open].sort((a, b) => (this.rank(a) < this.rank(b) ? -1 : 1))[0];
      if (next === this.me) this.becomeHost(room);
      return this.changed();
    }
    if (this.isHost && room.phase === "lobby") {
      // Free the seats of people who are gone, in the lobby only (in play a seat waits for its player to come back).
      const inCall = new Set(this.sdk.players.map(p => p.app_id));
      const seats = Object.fromEntries(Object.entries(room.seats).filter(([id]) => id === this.me || (this.open.has(id) && inCall.has(id))));
      if (Object.keys(seats).length !== Object.keys(room.seats).length) this.setRoom({ ...room, seats });
    }
    this.changed();
  }

  private becomeHost(previous: Room | null): void {
    if (!previous) return this.setRoom({ v: 1, host: this.me, phase: "lobby", match: 0, seats: {}, note: "" });
    let room: Room = { ...previous, host: this.me, v: previous.v + 1, note: "" };
    if (room.phase === "play") {
      const state = this.client?.store.getState() as State | null | undefined;
      if (this.def.hidden || !state) room = { ...room, phase: "lobby", note: HOST_LEFT_NOTE };
      else this.hostMatch(String(room.match), state);
    }
    this.setRoom(room);
  }

  private dropHosting(): void {
    this.hosted = null;
  }

  private setRoom(room: Room): void {
    this.applyRoom(room);
    this.broadcastRoom();
  }

  private broadcastRoom(): void {
    if (this.room) this.post({ t: "room", room: this.room });
  }

  /** Take a room from the host (or this copy's own) and start, swap or stop the local client to match it. */
  private applyRoom(room: Room): void {
    this.room = room;
    const seat = room.seats[this.me] ?? null;
    const matchID = String(room.match);
    if (room.phase !== "play") {
      this.stopClient();
    } else if (!this.client || this.client.matchID !== matchID || (this.client.playerID ?? null) !== seat) {
      this.stopClient();
      const client = Client({
        game: this.def.game,
        numPlayers: this.def.numPlayers,
        matchID,
        playerID: seat ?? undefined,
        debug: false,
        multiplayer: opts => (this.transport = new VokkoTransport(opts, this)),
      });
      this.client = client;
      client.subscribe(() => this.changed());
      client.start();
    } else if (this.transport && this.transport.hostSeen !== room.host) {
      this.transport.requestSync(); // a new host: get its state
    }
    if (this.transport) this.transport.hostSeen = room.host;
    this.changed();
  }

  private stopClient(): void {
    this.client?.stop();
    this.client = null;
    this.transport = null;
  }

  private changed(): void {
    this.version += 1;
    for (const fn of this.listeners) fn();
  }

  // ---- host ----

  private hostReceive(msg: Msg, from: string): void {
    const room = this.room;
    if (!room) return;
    const seat = room.seats[from];
    switch (msg.t) {
      case "seat": {
        if (room.phase !== "lobby") return;
        const want = msg.seat;
        const seats = { ...room.seats };
        delete seats[from];
        if (typeof want === "string") {
          const def = this.def.seats.find(s => s.id === want);
          if (!def || (!def.multi && Object.values(seats).includes(want))) return;
          seats[from] = want;
        } else if (want !== null) return;
        this.setRoom({ ...room, v: room.v + 1, seats });
        return;
      }
      case "start":
        if (room.phase === "lobby" && seat !== undefined && this.def.canStart(room.seats)) this.startMatch(room, room.seats);
        return;
      case "rematch":
        if (room.phase === "play" && seat !== undefined && this.over()) this.startMatch(room, this.def.rematch?.(room.seats) ?? room.seats);
        return;
      case "lobby":
        if (room.phase === "play" && seat !== undefined && this.over()) {
          this.hosted = null;
          this.setRoom({ ...room, v: room.v + 1, phase: "lobby", note: "" });
        }
        return;
      case "a": {
        // A move from a seated player. The seat comes from the relay's `from`, never from the message.
        const act = msg.act;
        const hosted = this.hosted;
        if (!hosted || msg.m !== hosted.matchID || seat === undefined || typeof msg.s !== "number") return;
        if (!isObj(act) || act.type !== "MAKE_MOVE" || !isObj(act.payload) || typeof act.payload.type !== "string") return;
        const args = Array.isArray(act.payload.args) ? act.payload.args : [];
        const action = { type: "MAKE_MOVE", payload: { type: act.payload.type, args, playerID: seat } };
        // With sync storage onUpdate runs to the end before it returns. A sync asked for while it fans out (our own
        // client after a failed patch) waits until the new state is stored.
        hosted.busy = true;
        void hosted.master.onUpdate(action as Parameters<Master["onUpdate"]>[0], msg.s, hosted.matchID, seat);
        hosted.busy = false;
        for (const id of hosted.pendingSync.splice(0)) this.hostSync(hosted, id);
        return;
      }
      case "sy": {
        const hosted = this.hosted;
        if (!hosted || msg.m !== hosted.matchID) return;
        if (hosted.busy) hosted.pendingSync.push(from);
        else this.hostSync(hosted, from);
        return;
      }
    }
  }

  private hostSync(hosted: Hosted, to: string): void {
    hosted.syncTarget = to;
    void hosted.master.onSync(hosted.matchID, this.room?.seats[to] ?? null, undefined, this.def.numPlayers);
    hosted.syncTarget = null;
  }

  private over(): boolean {
    return !!this.hosted?.master && this.hostedState()?.ctx.gameover !== undefined;
  }

  private hostedState(): State | undefined {
    return (this.hosted?.master.storageAPI as Memory | undefined)?.state;
  }

  private startMatch(room: Room, seats: Record<string, string>): void {
    const next = room.match + 1;
    this.hostMatch(String(next), null);
    this.setRoom({ ...room, v: room.v + 1, phase: "play", match: next, seats, note: "" });
  }

  /** Run a Master for `matchID`: a fresh match, or one resumed from `state` (a host change). */
  private hostMatch(matchID: string, state: State | null): void {
    const created = createMatch({ game: this.def.game, numPlayers: this.def.numPlayers, setupData: this.def.setupData?.(), unlisted: true });
    if ("setupDataError" in created) throw new Error(String(created.setupDataError));
    const db = new Memory();
    db.createMatch(matchID, { initialState: withoutApis(state ?? created.initialState), metadata: created.metadata });
    const hosted: Hosted = {
      matchID,
      syncTarget: null,
      busy: false,
      pendingSync: [],
      master: new Master(this.def.game, db, {
        send: ({ playerID, ...data }) => {
          // Only sync answers come through here: to the copy that asked. The log and initial state stay home.
          const target = hosted.syncTarget;
          if (!target || data.type !== "sync") return;
          const filtered = this.filter(playerID, data as never) as TransportData;
          const [, info] = filtered.args as [string, Record<string, unknown>];
          const out = { ...filtered, args: [matchID, { ...info, log: [], initialState: undefined }] };
          this.deliver(out, target);
        },
        sendAll: data => this.fanOut(data as never),
      }),
    };
    this.hosted = hosted;
  }

  /** Send an update to every open copy, filtered for its seat; one broadcast when everyone sees the same thing. */
  private fanOut(data: Parameters<ReturnType<typeof getFilterPlayerView>>[1]): void {
    const room = this.room;
    if (!room) return;
    if (data.type === "patch") {
      // The previous state carries the plugins' per-move `api` objects, which clients never have: a patch that
      // removed them would not apply on any client.
      const [matchID, stateID, prev, next] = data.args;
      data = { type: "patch", args: [matchID, stateID, withoutApis(prev), withoutApis(next)] };
    }
    const views = new Map<string, { out: TransportData; to: string[] }>();
    for (const id of [this.me, ...this.open]) {
      const out = this.filter(room.seats[id] ?? null, data) as TransportData;
      const key = JSON.stringify(out);
      const entry = views.get(key) ?? { out, to: [] };
      entry.to.push(id);
      views.set(key, entry);
    }
    if (views.size === 1) {
      const [{ out }] = views.values();
      this.transport?.deliver(out);
      this.post({ t: "d", m: this.hosted?.matchID, d: out });
      return;
    }
    for (const { out, to } of views.values()) for (const id of to) this.deliver(out, id);
  }

  private deliver(out: TransportData, to: string): void {
    if (to === this.me) this.transport?.deliver(out);
    else this.post({ t: "d", m: this.hosted?.matchID, d: out }, to);
  }

  /** Called by the local transport: a move from this copy. */
  localAction(action: Record<string, unknown>, stateID: number, matchID: string): void {
    if (this.isHost) this.hostReceive({ t: "a", act: action, s: stateID, m: matchID }, this.me);
    else if (this.room) this.post({ t: "a", act: action, s: stateID, m: matchID }, this.room.host);
  }

  /** Called by the local transport: ask the host for the full state. */
  localSync(matchID: string): void {
    if (this.isHost) this.hostReceive({ t: "sy", m: matchID }, this.me);
    else if (this.room) this.post({ t: "sy", m: matchID }, this.room.host);
  }
}

/** `state` with each plugin reduced to its data (boardgame.io adds an `api` while it runs a move). */
function withoutApis(state: State): State {
  const plugins = Object.fromEntries(Object.entries(state.plugins ?? {}).map(([name, p]) => [name, { data: (p as { data: unknown }).data }]));
  return { ...state, plugins } as State;
}

function isRoom(v: unknown): v is Room {
  return (
    isObj(v) &&
    typeof v.v === "number" &&
    typeof v.host === "string" &&
    (v.phase === "lobby" || v.phase === "play") &&
    typeof v.match === "number" &&
    isObj(v.seats) &&
    Object.values(v.seats).every(s => typeof s === "string") &&
    typeof v.note === "string"
  );
}

type TransportOpts = ConstructorParameters<typeof Transport>[0];

/** boardgame.io Transport over the room: actions and sync requests go to the host, its data comes back via deliver(). */
class VokkoTransport extends Transport {
  private room: BoardRoom;
  hostSeen: string | null = null;

  constructor(opts: TransportOpts, room: BoardRoom) {
    super(opts);
    this.room = room;
  }

  connect(): void {
    this.setConnectionStatus(true);
    this.requestSync();
  }

  disconnect(): void {
    this.setConnectionStatus(false);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendAction(state: State, action: any): void {
    if (action?.type === "MAKE_MOVE") this.room.localAction(action, state._stateID, this.matchID);
  }

  sendChatMessage(): void {}

  requestSync(): void {
    this.room.localSync(this.matchID);
  }

  /** Data from the host. A patch that does not follow our state means we missed one: resync instead. */
  deliver(data: TransportData): void {
    if (data.type === "patch") {
      const current = this.room.client?.store.getState() as State | null | undefined;
      const [, prev, next] = data.args as [string, number, number];
      if (current && current._stateID >= next) return; // our own move, already applied locally
      if (!current || current._stateID !== prev) return this.requestSync();
    }
    this.notifyClient(data as never);
  }

  updateMatchID(): void {}
  updatePlayerID(): void {}
  updateCredentials(): void {}
}
