// @ts-check
/*
 * A leader-hosted table for games with hidden information (crazy-eights, werewolf). No DOM; tests in
 * src/games/table-host.test.ts.
 *
 * The leader (host-computed, every copy agrees) holds the full state and runs the rules; everyone else sends it intents.
 * After every change the leader broadcasts the public view and sends each player their private view (only when it
 * changed). Both views stay under 4 KB, so a copy that opens late just asks the leader ("sync?") and gets both.
 *
 * Nobody but the leader can rebuild hidden state, so a new leader (the old one left) or a leader whose copy reopened
 * starts a new table (a new epoch) at the lobby. A copy that sees a new epoch while a round ran shows a note, and a
 * player who was seated takes their seat again ({k:"join"}).
 *
 * Messages (relay data is untrusted: only the leader's pub/priv are taken, and the rules shape-check every intent):
 *   any -> leader:  {t:"sync?"}  {t:"do", a}           a: the game's intent, {k, ...}
 *   leader -> all:  {t:"pub", e, v, s}                 e: epoch, v: version, s: public view ({phase, seats, ...})
 *   leader -> one:  {t:"priv", e, v, s}                s: that player's private view
 */

/**
 * @typedef {{ now: number, random: () => number }} TableCtx
 * @typedef {{ phase: string, seats: string[] }} TablePub
 * @typedef {{
 *   init: (prev: TablePub | null, ctx: TableCtx) => any,
 *   act: (s: any, from: string, a: any, ctx: TableCtx) => boolean,
 *   left: (s: any, present: string[], ctx: TableCtx) => boolean,
 *   tick?: (s: any, ctx: TableCtx) => boolean,
 *   pub: (s: any, ctx: TableCtx) => TablePub,
 *   priv: (s: any, id: string, ctx: TableCtx) => object | null,
 * }} TableRules
 * @typedef {{ pub: any, priv: any, note: string, waiting: boolean, at: number }} TableView
 */

var TableHost = (() => {
  const MAX_BYTES = 4000;

  /**
   * @param {{
   *   me: string, players: string[], leader: string, rules: TableRules,
   *   send: (data: object, to?: string) => void,
   *   onView?: (view: TableView) => void,
   *   random?: () => number,
   *   now?: () => number,
   * }} o
   */
  function create(o) {
    const { me, rules, send } = o;
    const onView = o.onView ?? (() => {});
    const random = o.random ?? Math.random;
    const now = o.now ?? Date.now;
    let players = o.players.slice();
    let leader = o.leader;
    const ctx = () => ({ now: now(), random });

    /** The leader's copy only. */
    let state = /** @type {any} */ (null);
    let version = 0;
    let tableEpoch = "";
    /** @type {Map<string, string>} */ let lastPriv = new Map();

    /** What this copy shows. */
    const view = /** @type {TableView} */ ({ pub: null, priv: null, note: "", waiting: true, at: 0 });
    let epoch = "";
    let pubV = -1;
    let privV = -1;
    let wasSeated = false;

    const newEpoch = () => Array.from(crypto.getRandomValues(new Uint32Array(2)), (x) => x.toString(36)).join("");

    /** @param {object} m @param {string} [to] */
    function post(m, to) {
      if (JSON.stringify(m).length > MAX_BYTES) console.error("table: message over the relay limit", m);
      else send(m, to);
    }

    /** @param {any} m */
    function takePub(m) {
      const fresh = m.e !== epoch;
      if (!fresh && m.v <= pubV) return;
      if (fresh) {
        if (view.pub && view.pub.phase !== "lobby") view.note = "The round ended: the host left or closed the game.";
        epoch = m.e;
        privV = -1;
        view.priv = null;
      } else if (m.s.phase !== "lobby") view.note = "";
      pubV = m.v;
      view.pub = m.s;
      view.waiting = false;
      view.at = now();
      const seated = Array.isArray(m.s.seats) && m.s.seats.includes(me);
      if (fresh && wasSeated && !seated && m.s.phase === "lobby" && me !== leader) act({ k: "join" });
      wasSeated = seated;
    }

    /** @param {any} m */
    function takePriv(m) {
      if (m.e !== epoch || m.v <= privV) return;
      privV = m.v;
      view.priv = m.s;
    }

    /** The leader: send the views that changed (or both views to one asker). @param {string} [only] */
    function publish(only) {
      const c = ctx();
      if (!only) version += 1;
      const pub = { t: "pub", e: tableEpoch, v: version, s: rules.pub(state, c) };
      if (only) post(pub, only);
      else {
        post(pub);
        takePub(pub);
      }
      for (const id of new Set([...players, me])) {
        if (only && id !== only) continue;
        const s = rules.priv(state, id, c);
        const text = JSON.stringify(s);
        if (!only && (lastPriv.get(id) ?? "null") === text) continue; // a new epoch starts every copy at null
        lastPriv.set(id, text);
        const m = { t: "priv", e: tableEpoch, v: version, s };
        if (id === me) takePriv(m);
        else post(m, id);
      }
      if (!only) onView(view);
    }

    /** This copy became the leader (or opened as it): a new table at the lobby, keeping the seats it knew. */
    function host() {
      const prev = view.pub && Array.isArray(view.pub.seats) ? view.pub : null;
      state = rules.init(prev && { phase: String(prev.phase), seats: prev.seats.filter((/** @type {unknown} */ id) => players.includes(String(id))) }, ctx());
      rules.left(state, players.concat(me), ctx());
      tableEpoch = newEpoch();
      version = 0;
      lastPriv = new Map();
      publish();
    }

    /** An intent from `from` (the leader's copy). @param {string} from @param {unknown} a */
    function apply(from, a) {
      if (!state || !a || typeof a !== "object") return;
      if (rules.act(state, from, a, ctx())) publish();
    }

    /** Send an intent to the leader, or apply it here when this copy is the leader. @param {object} a */
    function act(a) {
      if (me === leader) apply(me, a);
      else post({ t: "do", a }, leader);
    }

    const timer = setInterval(() => {
      if (me === leader && state && rules.tick && rules.tick(state, ctx())) publish();
    }, 1000);

    return {
      view,
      act,
      /** For tests: the leader's full state. */
      get state() {
        return state;
      },
      start() {
        if (me === leader) host();
        else send({ t: "sync?" }, leader);
        onView(view);
      },
      /** A relayed message. @param {unknown} data @param {string} from */
      receive(data, from) {
        const m = /** @type {any} */ (data);
        if (!m || typeof m !== "object") return;
        if (me === leader) {
          if (m.t === "sync?" && state) publish(from);
          else if (m.t === "do") apply(from, m.a);
          return;
        }
        if (from !== leader || typeof m.e !== "string" || !Number.isInteger(m.v) || !m.s || typeof m.s !== "object") return;
        if (m.t === "pub" && typeof m.s.phase === "string") takePub(m);
        else if (m.t === "priv") takePriv(m);
        else return;
        onView(view);
      },
      /** @param {string[]} list @param {string} newLeader */
      setPlayers(list, newLeader) {
        players = list.slice();
        const changed = newLeader !== leader;
        leader = newLeader;
        if (changed && me === leader) return host();
        if (changed) {
          view.waiting = true;
          send({ t: "sync?" }, leader);
          onView(view);
        } else if (me === leader && state && rules.left(state, players.concat(me), ctx())) publish();
      },
      stop() {
        clearInterval(timer);
      },
    };
  }

  /** Fisher-Yates in place. @template T @param {T[]} a @param {() => number} random */
  function shuffle(a, random) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  return { create, shuffle, MAX_BYTES };
})();
globalThis.TableHost = TableHost;
