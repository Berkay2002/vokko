// @ts-check
/*
 * Leader-hosted state for the party games (Trivia, Who's the Spy, Same Wave). No DOM; tests in src/games/party.test.ts.
 *
 * The leader's copy is the host: it holds the whole state, applies everyone's intents and broadcasts the public state
 * (at most every MIN_GAP_MS). Private info (roles, the secret target) goes only to its owner. Every copy keeps the last
 * public state, so:
 *   - a copy that opens late sends {t:"sync?", a} (a = attempt 1..3, every 2 s); the host answers with the state and the
 *     asker's private info. The others answer from attempt 2, or when the asker is the host (its copy was closed), with
 *     the public state only. The host's own copy waits one attempt, then starts a fresh lobby.
 *   - when the leader changes, the new host carries on from its public copy; `takeOver` lets the game drop what needed
 *     the lost private info (the games with secrets end the round and go back to the lobby).
 * Times go over the wire as `left` (ms to the deadline), so clocks need not agree.
 *
 * Messages (relay data is untrusted: the host checks intents in each game's `intent`):
 *   host -> all:     {t:"s", v, st}       host -> one: {t:"p", v, p}  (p: that player's private info, or null)
 *   player -> host:  {t:"i", k, ...}      joiner -> all: {t:"sync?", a}
 */

/**
 * @typedef {{ phase: string, deadline: number, note?: string, [key: string]: any }} PartyState
 * @typedef {{ players: string[], leader: string, secret: Record<string, any>, random: () => number, now: () => number }} PartyCtx
 * @typedef {{
 *   init(ctx: PartyCtx): PartyState,
 *   intent(st: PartyState, from: string, m: any, ctx: PartyCtx): boolean,
 *   timeout(st: PartyState, ctx: PartyCtx): void,
 *   players(st: PartyState, ctx: PartyCtx): boolean,
 *   takeOver(st: PartyState, ctx: PartyCtx): void,
 * }} PartyGame
 */

var PartyHost = (() => {
  const C = { SYNC_RETRY_MS: 2000, SYNC_TRIES: 3, MIN_GAP_MS: 120, MAX_BYTES: 4000 };

  /** @param {unknown} v @param {number} max @returns {v is number} */
  const isInt = (v, max) => Number.isInteger(v) && /** @type {number} */ (v) >= 0 && /** @type {number} */ (v) <= max;

  /** Fisher-Yates on a copy. @template T @param {T[]} list @param {() => number} random */
  function shuffle(list, random) {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  /**
   * @param {{
   *   me: string, players: string[], leader: string, game: PartyGame,
   *   send: (data: object, to?: string) => void,
   *   onChange?: () => void,
   *   random?: () => number,
   * }} o
   */
  function create(o) {
    const { me, send, game } = o;
    const onChange = o.onChange ?? (() => {});
    /** @type {PartyCtx} */
    const ctx = { players: o.players.slice().sort(), leader: o.leader, secret: {}, random: o.random ?? Math.random, now: () => Date.now() };
    const view = {
      /** @type {PartyState | null} */ st: null,
      /** My private info. @type {any} */ mine: null,
      syncing: true,
      v: 0,
    };
    /** @type {Record<string, string>} */
    let sentSecret = {};
    let tries = 0;
    let lastFlush = 0;
    /** @type {ReturnType<typeof setTimeout> | undefined} */ let syncTimer;
    /** @type {ReturnType<typeof setTimeout> | undefined} */ let deadlineTimer;
    /** @type {ReturnType<typeof setTimeout> | undefined} */ let flushTimer;
    const isHost = () => ctx.leader === me;

    /** @param {PartyState} st */
    const wire = (st) => {
      const { deadline, ...rest } = st;
      return { ...rest, left: deadline ? Math.max(0, deadline - Date.now()) : 0 };
    };
    /** @param {any} w @returns {PartyState} */
    const unwire = (w) => {
      const { left, ...rest } = w;
      return { ...rest, deadline: isInt(left, 36e5) && left > 0 ? Date.now() + left : 0 };
    };
    /** @param {any} m */
    const validState = (m) => isInt(m.v, 1e9) && m.st && typeof m.st === "object" && !Array.isArray(m.st) && typeof m.st.phase === "string";

    /** @param {object} m @param {string} [to] */
    function sendChecked(m, to) {
      if (JSON.stringify(m).length > C.MAX_BYTES) return console.warn("party: message too large", m);
      send(m, to);
    }

    function flush() {
      flushTimer = undefined;
      const st = view.st;
      if (!st || !isHost()) return;
      lastFlush = Date.now();
      sendChecked({ t: "s", v: view.v, st: wire(st) });
      for (const id of new Set([...Object.keys(ctx.secret), ...Object.keys(sentSecret)])) {
        if (id === me) continue;
        const json = JSON.stringify(ctx.secret[id] ?? null);
        if (sentSecret[id] === json) continue;
        sentSecret[id] = json;
        sendChecked({ t: "p", v: view.v, p: ctx.secret[id] ?? null }, id);
      }
      for (const id of Object.keys(sentSecret)) if (!(id in ctx.secret)) delete sentSecret[id];
    }

    /** The host changed the state: schedule a broadcast, re-arm the deadline. */
    function changed() {
      view.v += 1;
      view.mine = ctx.secret[me] ?? null;
      if (!flushTimer) flushTimer = setTimeout(flush, Math.max(0, lastFlush + C.MIN_GAP_MS - Date.now()));
      arm();
      onChange();
    }

    function arm() {
      clearTimeout(deadlineTimer);
      const st = view.st;
      if (!st || !isHost() || !st.deadline) return;
      deadlineTimer = setTimeout(() => {
        if (view.st !== st || !isHost()) return;
        st.deadline = 0; // the game sets a new one if the next phase has a timer
        game.timeout(st, ctx);
        changed();
      }, Math.max(0, st.deadline - Date.now()));
    }

    /** This copy is the host now, from a public copy (or nothing). */
    function becomeHost() {
      ctx.secret = {};
      sentSecret = {};
      if (view.st) game.takeOver(view.st, ctx);
      else view.st = game.init(ctx);
      changed();
    }

    function trySync() {
      tries += 1;
      send({ t: "sync?", a: tries });
      const max = isHost() ? 1 : C.SYNC_TRIES;
      syncTimer = setTimeout(() => (tries < max && view.syncing ? trySync() : finishSync()), C.SYNC_RETRY_MS);
    }

    function finishSync() {
      clearTimeout(syncTimer);
      if (!view.syncing) return;
      view.syncing = false;
      if (isHost()) becomeHost();
      else onChange(); // no host answered: wait for its first broadcast
    }

    /** @param {any} m @param {string} from */
    function receive(m, from) {
      if (!m || typeof m !== "object" || typeof m.t !== "string") return;
      if (m.t === "sync?") {
        if (!isInt(m.a, 9) || !view.st || view.syncing) return;
        if (isHost()) {
          sendChecked({ t: "s", v: view.v, st: wire(view.st) }, from);
          sentSecret[from] = JSON.stringify(ctx.secret[from] ?? null);
          sendChecked({ t: "p", v: view.v, p: ctx.secret[from] ?? null }, from);
        } else if (m.a >= 2 || from === ctx.leader) {
          sendChecked({ t: "s", v: view.v, st: wire(view.st) }, from);
        }
      } else if (m.t === "s" && validState(m)) {
        if (from === ctx.leader && !isHost()) {
          view.st = unwire(m.st);
          view.v = m.v;
          if (view.syncing) {
            view.syncing = false;
            clearTimeout(syncTimer);
          }
          onChange();
        } else if (view.syncing && !view.st) {
          // A public copy from a non-host answering our sync?: the host's copy was closed, or this copy is the host.
          view.st = unwire(m.st);
          view.v = m.v;
          if (isHost()) {
            // A peer's copy becomes authoritative here: keep only the fields a fresh state has, with the same JSON types.
            const base = game.init(ctx);
            const peer = /** @type {Record<string, unknown>} */ (view.st);
            for (const k of Object.keys(base)) {
              const v = peer[k];
              if (typeof v === typeof base[k] && Array.isArray(v) === Array.isArray(base[k]) && (v === null) === (base[k] === null)) base[k] = v;
            }
            base.deadline = view.st.deadline;
            view.st = base;
            finishSync();
          } else onChange();
        }
      } else if (m.t === "p" && from === ctx.leader && !isHost()) {
        view.mine = m.p ?? null;
        onChange();
      } else if (m.t === "i" && typeof m.k === "string" && isHost() && view.st && !view.syncing) {
        if (game.intent(view.st, from, m, ctx)) changed();
      }
    }

    return {
      view,
      ctx,
      start() {
        trySync();
        onChange();
      },
      receive,
      /** An intent from this player: applied here when we host, else sent to the host. @param {{ k: string, [key: string]: any }} m */
      act(m) {
        if (!isHost()) return void send({ ...m, t: "i" }, ctx.leader);
        if (view.st && !view.syncing && game.intent(view.st, me, m, ctx)) changed();
      },
      /** @param {string[]} list @param {string} leader */
      setPlayers(list, leader) {
        ctx.players = list.slice().sort();
        const was = ctx.leader;
        ctx.leader = leader;
        if (view.syncing) return onChange();
        if (leader === me && was !== me) return becomeHost();
        if (isHost() && view.st && game.players(view.st, ctx)) changed();
        else onChange();
      },
      stop() {
        clearTimeout(syncTimer);
        clearTimeout(deadlineTimer);
        clearTimeout(flushTimer);
      },
    };
  }

  /** Seconds left on a deadline, for the UI. @param {PartyState | null} st */
  const secsLeft = (st) => (st && st.deadline ? Math.max(0, Math.ceil((st.deadline - Date.now()) / 1000)) : 0);

  return { create, shuffle, isInt, secsLeft, C };
})();
globalThis.PartyHost = PartyHost;
