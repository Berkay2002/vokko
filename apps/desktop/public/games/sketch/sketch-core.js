// @ts-check
/*
 * Sketch game logic, no DOM (sketch.js draws; src/games/sketch.test.ts tests this file).
 *
 * Every open copy keeps the public round state: round n, drawer, scores, word length, the strokes since the last clear
 * (each batch has a seq number) and the time left. Only the drawer knows the word: it picks it and checks guesses. The
 * leader (host-computed, everyone agrees) only starts rounds, ends them on timeout and answers late joiners.
 *
 * Late join (the server keeps no game state): a copy that opens sends {t:"sync?", a} (a = attempt 1..3, every 2 s) and
 * buffers live messages. The leader answers every attempt, everyone else from attempt 2 (the leader's copy may be
 * closed), with a snapshot in chunks under 4 KB. The joiner takes the first answerer's chunks, then applies its buffer,
 * skipping stroke seqs it already has. No answer after 3 attempts: it starts fresh. The leader's own copy gives up after
 * one attempt (about 2 s), so a call where everyone opens at once starts quickly; a waiting copy that gets the
 * leader's round start adopts it at once.
 *
 * Messages (all {t, n: round, ...}); relay data is untrusted and shape-checked here:
 *   leader -> all:    {t:"round", n, drawer, secs, scores} {t:"end", n, by:null, word:null} (timeout)
 *   drawer -> all:    {t:"len", n, len}   {t:"s", n, seq, id, c, w, p:[x,y,...]}   {t:"clear", n, seq}
 *                     {t:"end", n, by, word} (by: the guesser's app_id, or null on timeout)
 *   guesser -> all:   {t:"g", n, text}
 *   joiner -> all:    {t:"sync?", a}
 *   any -> joiner:    {t:"snap", n, drawer, len, secs, over, scores, top, cleared, i, total, strokes}
 */

/** @typedef {{ seq: number, id: number, c: number, w: number, p: number[] }} SketchStroke */

var SketchCore = (() => {
  const WORDS = [
    "apple", "banana", "bicycle", "bridge", "butterfly", "camera", "candle", "castle", "cat", "cloud", "crown", "dog",
    "dragon", "drum", "elephant", "fish", "flower", "ghost", "guitar", "hat", "house", "island", "key", "kite", "ladder",
    "lamp", "moon", "mountain", "mushroom", "octopus", "penguin", "pizza", "rainbow", "robot", "rocket", "shoe", "snake",
    "snowman", "spider", "sun", "tree", "umbrella", "volcano", "whale", "window",
  ];
  const C = {
    ROUND_SECS: 80,
    NEXT_ROUND_MS: 4000,
    END_GRACE_MS: 2000, // the leader ends a round this long after the deadline if the drawer did not
    SYNC_RETRY_MS: 2000,
    SYNC_TRIES: 3,
    W: 800,
    H: 600,
    COLORS: 6,
    WIDTHS: 3,
    MAX_POINTS: 300, // about 3 KB serialized, under the 4 KB relay cap
    MAX_GUESS: 40,
    CHUNK_BYTES: 3600,
    MAX_CHUNKS: 30, // shortcut: a snapshot sends at most the newest ~100 KB of strokes; raise with the relay limits
  };

  /** @param {unknown} v @param {number} max @returns {v is number} */
  const isInt = (v, max) => Number.isInteger(v) && /** @type {number} */ (v) >= 0 && /** @type {number} */ (v) <= max;

  /** @param {any} m @returns {SketchStroke | null} */
  function validStroke(m) {
    if (!m || !isInt(m.seq, 1e9) || !isInt(m.id, 1e9) || !isInt(m.c, C.COLORS - 1) || !isInt(m.w, C.WIDTHS - 1)) return null;
    const p = m.p;
    if (!Array.isArray(p) || p.length < 2 || p.length % 2 || p.length > C.MAX_POINTS * 2) return null;
    if (!p.every((v, i) => isInt(v, i % 2 ? C.H : C.W))) return null;
    return { seq: m.seq, id: m.id, c: m.c, w: m.w, p: p.slice() };
  }

  /** @param {unknown} s */
  function validScores(s) {
    /** @type {Record<string, number>} */
    const out = {};
    if (s && typeof s === "object" && !Array.isArray(s)) {
      for (const [k, v] of Object.entries(s).slice(0, 64)) if (isInt(v, 10000)) out[k] = v;
    }
    return out;
  }

  /**
   * @param {{
   *   me: string, players: string[], leader: string,
   *   send: (data: object, to?: string) => void,
   *   nameOf?: (appId: string) => string,
   *   onChange?: () => void,
   *   onLine?: (text: string, hit: boolean) => void,
   *   onDraw?: (stroke: SketchStroke) => void,
   *   onClear?: () => void,
   *   random?: () => number,
   * }} o
   */
  function create(o) {
    const noop = () => {};
    const { me, send } = o;
    const nameOf = o.nameOf ?? ((/** @type {string} */ id) => id);
    const onChange = o.onChange ?? noop;
    const onLine = o.onLine ?? noop;
    const onDraw = o.onDraw ?? noop;
    const onClear = o.onClear ?? noop;
    const random = o.random ?? Math.random;
    let players = o.players.slice();
    let leader = o.leader;

    const st = {
      n: 0,
      drawer: "",
      len: 0,
      /** @type {Record<string, number>} */ scores: {},
      /** @type {SketchStroke[]} */ strokes: [],
      top: 0, // highest stroke/clear seq seen this round
      cleared: 0, // seq of the last clear
      deadline: 0,
      over: true,
      endedAt: 0,
      word: "", // the drawer's copy only
      syncing: true,
    };
    /** @type {{ data: any, from: string }[]} */
    let buffer = [];
    /** @type {{ from: string, n: number, total: number, parts: any[] } | null} */
    let incoming = null;
    let tries = 0;
    /** @type {ReturnType<typeof setTimeout> | undefined} */ let syncTimer;
    /** @type {ReturnType<typeof setTimeout> | undefined} */ let leaderTimer;
    /** @type {ReturnType<typeof setTimeout> | undefined} */ let drawerTimer;

    /** Send to everyone and apply locally (the relay skips the sender). @param {object} m */
    const publish = (m) => {
      send(m);
      apply(m, me);
    };
    const secsLeft = () => Math.max(0, Math.min(C.ROUND_SECS, Math.round((st.deadline - Date.now()) / 1000)));

    function trySync() {
      tries += 1;
      send({ t: "sync?", a: tries });
      const max = me === leader ? 1 : C.SYNC_TRIES;
      syncTimer = setTimeout(() => (tries < max ? trySync() : finishSync()), C.SYNC_RETRY_MS);
    }

    function finishSync() {
      clearTimeout(syncTimer);
      st.syncing = false;
      incoming = null;
      const live = buffer;
      buffer = [];
      for (const x of live) apply(x.data, x.from);
      // Reopened as the drawer: the word was lost with the old frame, so this round cannot be judged.
      if (st.drawer === me && !st.over && !st.word) publish({ t: "end", n: st.n, by: null, word: null });
      plan();
      onChange();
    }

    /** @param {any} m @param {string} from */
    function takeSnapshotPart(m, from) {
      if (!isInt(m.n, 1e9) || !isInt(m.total, 64) || m.total < 1 || !isInt(m.i, m.total - 1)) return;
      if (!incoming) incoming = { from, n: m.n, total: m.total, parts: [] };
      if (incoming.from !== from || incoming.n !== m.n || incoming.total !== m.total) return; // first answer wins
      incoming.parts[m.i] = m;
      if (incoming.parts.filter(Boolean).length < incoming.total) return;
      const head = incoming.parts[0];
      st.n = head.n;
      st.drawer = typeof head.drawer === "string" ? head.drawer : "";
      st.len = isInt(head.len, 32) ? head.len : 0;
      st.over = head.over !== false || !st.drawer;
      st.scores = validScores(head.scores);
      st.top = isInt(head.top, 1e9) ? head.top : 0;
      st.cleared = isInt(head.cleared, 1e9) ? head.cleared : 0;
      st.deadline = Date.now() + (isInt(head.secs, C.ROUND_SECS) ? head.secs : 0) * 1000;
      st.endedAt = Date.now();
      st.strokes = [];
      onClear();
      for (const part of incoming.parts) {
        for (const raw of Array.isArray(part.strokes) ? part.strokes : []) {
          const s = validStroke(raw);
          if (s && s.seq > st.cleared) {
            st.strokes.push(s);
            onDraw(s);
          }
        }
      }
      finishSync();
    }

    /** @param {string} to */
    function sendSnapshot(to) {
      const head = {
        t: "snap", n: st.n, drawer: st.drawer, len: st.len, secs: secsLeft(), over: st.over, scores: st.scores,
        top: st.top, cleared: st.cleared,
      };
      const base = JSON.stringify(head).length + 40;
      /** @type {SketchStroke[][]} */
      const parts = [];
      let cur = [];
      let size = base;
      for (const s of st.strokes) {
        const b = JSON.stringify(s).length + 1;
        if (cur.length && size + b > C.CHUNK_BYTES) {
          parts.push(cur);
          cur = [];
          size = base;
        }
        cur.push(s);
        size += b;
      }
      parts.push(cur);
      const sent = parts.slice(-C.MAX_CHUNKS);
      sent.forEach((strokes, i) => send({ ...head, i, total: sent.length, strokes }, to));
    }

    /** @param {string} text */
    function endLocally(text) {
      st.over = true;
      st.endedAt = Date.now();
      onLine(text, true);
    }

    /** Apply one message (from the relay, or our own via publish). @param {any} m @param {string} from */
    function apply(m, from) {
      if (!m || typeof m !== "object" || typeof m.t !== "string") return;
      const fromLeader = from === leader;
      const now = m.n === st.n;
      if (m.t === "sync?") {
        if (isInt(m.a, 9) && (me === leader || m.a >= 2)) sendSnapshot(from);
        return;
      } else if (m.t === "round" && fromLeader && isInt(m.n, 1e9) && m.n > st.n && typeof m.drawer === "string" && isInt(m.secs, C.ROUND_SECS)) {
        Object.assign(st, { n: m.n, drawer: m.drawer, len: 0, strokes: [], top: 0, cleared: 0, over: false, word: "" });
        if (m.scores) st.scores = validScores(m.scores);
        st.deadline = Date.now() + m.secs * 1000;
        onClear();
        if (st.drawer === me) {
          st.word = WORDS[Math.floor(random() * WORDS.length)];
          publish({ t: "len", n: st.n, len: st.word.length });
        }
      } else if (m.t === "len" && now && from === st.drawer && isInt(m.len, 32)) {
        st.len = m.len;
      } else if (m.t === "s" && now && from === st.drawer && !st.over) {
        const s = validStroke(m);
        if (!s || s.seq <= st.cleared || st.strokes.some((x) => x.seq === s.seq)) return; // already have it
        st.top = Math.max(st.top, s.seq);
        st.strokes.push(s);
        onDraw(s);
        return; // strokes change nothing else; skip onChange
      } else if (m.t === "clear" && now && from === st.drawer && isInt(m.seq, 1e9) && m.seq > st.cleared) {
        st.cleared = m.seq;
        st.top = Math.max(st.top, m.seq);
        st.strokes = st.strokes.filter((x) => x.seq > m.seq);
        onClear();
        st.strokes.forEach(onDraw);
      } else if (m.t === "g" && now && !st.over && from !== st.drawer && typeof m.text === "string") {
        const text = m.text.trim().slice(0, C.MAX_GUESS);
        if (!text) return;
        onLine(`${nameOf(from)}: ${text}`, false);
        if (me === st.drawer && st.word && text.toLowerCase() === st.word) publish({ t: "end", n: st.n, by: from, word: st.word });
      } else if (m.t === "end" && now && !st.over && (from === st.drawer || (fromLeader && m.by === null))) {
        const by = from === st.drawer && typeof m.by === "string" && m.by !== st.drawer ? m.by : null;
        if (by) st.scores = { ...st.scores, [by]: (st.scores[by] ?? 0) + 1 };
        const w = typeof m.word === "string" ? m.word.slice(0, 32) : "";
        endLocally(by ? `${nameOf(by)} guessed "${w}"` : w ? `Nobody guessed "${w}"` : "Time's up");
      } else {
        return;
      }
      plan();
      onChange();
    }

    /** (Re)arm the timers this copy owns: the drawer's deadline, the leader's round start and timeout. */
    function plan() {
      clearTimeout(leaderTimer);
      clearTimeout(drawerTimer);
      if (st.syncing) return;
      const n = st.n;
      if (me === st.drawer && !st.over) {
        drawerTimer = setTimeout(() => publish({ t: "end", n, by: null, word: st.word }), Math.max(0, st.deadline - Date.now()));
      }
      if (me !== leader) return;
      if (!st.over) {
        const wait = Math.max(0, st.deadline + C.END_GRACE_MS - Date.now());
        leaderTimer = setTimeout(() => publish({ t: "end", n, by: null, word: null }), wait);
      } else if (players.length >= 2) {
        leaderTimer = setTimeout(startRound, st.n === 0 ? 0 : Math.max(0, st.endedAt + C.NEXT_ROUND_MS - Date.now()));
      }
    }

    function startRound() {
      const ids = players.slice().sort();
      if (ids.length < 2) return;
      const next = ids.find((id) => id > st.drawer) ?? ids[0]; // rotation in app_id order, fixed at round start
      publish({ t: "round", n: st.n + 1, drawer: next, secs: C.ROUND_SECS, scores: st.scores });
    }

    return {
      state: st,
      start() {
        trySync();
        onChange();
      },
      /** A relayed message. @param {unknown} data @param {string} from */
      receive(data, from) {
        const m = /** @type {any} */ (data);
        if (!st.syncing) return apply(m, from);
        if (m && m.t === "snap") takeSnapshotPart(m, from);
        else if (m && m.t === "round" && from === leader) {
          buffer.push({ data: m, from }); // a fresh round needs no snapshot: adopt it now
          finishSync();
        } else if (m && m.t !== "sync?" && buffer.length < 1000) buffer.push({ data: m, from });
      },
      /** @param {string[]} list @param {string} newLeader */
      setPlayers(list, newLeader) {
        players = list.slice();
        leader = newLeader;
        if (!st.syncing && !st.over && st.drawer && !players.includes(st.drawer)) {
          endLocally(`${nameOf(st.drawer)} left, no points this round`);
        }
        plan();
        onChange();
      },
      /** @param {string} text */
      guess(text) {
        if (st.syncing || st.over || !st.drawer || me === st.drawer) return;
        publish({ t: "g", n: st.n, text: text.slice(0, C.MAX_GUESS) });
      },
      /** The drawer's batched points (already drawn locally). @param {number} id @param {number} c @param {number} w @param {number[]} p */
      stroke(id, c, w, p) {
        if (me !== st.drawer || st.over || !p.length) return;
        const s = { seq: ++st.top, id, c, w, p };
        st.strokes.push(s);
        send({ t: "s", n: st.n, ...s });
      },
      clear() {
        if (me === st.drawer && !st.over) publish({ t: "clear", n: st.n, seq: st.top + 1 });
      },
      stop() {
        clearTimeout(syncTimer);
        clearTimeout(leaderTimer);
        clearTimeout(drawerTimer);
      },
    };
  }

  /**
   * A pointer position in canvas units. The canvas is drawn with object-fit: contain, so map against the drawn content
   * box (centred in the element box `r`), not the whole box; clamped to the board.
   * @param {{ left: number, top: number, width: number, height: number }} r @param {number} x @param {number} y
   */
  function toBoard(r, x, y) {
    const s = Math.min(r.width / C.W, r.height / C.H);
    const bx = Math.round((x - r.left - (r.width - C.W * s) / 2) / s);
    const by = Math.round((y - r.top - (r.height - C.H * s) / 2) / s);
    return [Math.max(0, Math.min(C.W, bx)), Math.max(0, Math.min(C.H, by))];
  }

  return { create, toBoard, C };
})();
globalThis.SketchCore = SketchCore;
