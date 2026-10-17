// @ts-check
/*
 * Telephone game logic, no DOM (telephone.js draws; src/games/telephone.test.ts tests this file).
 * Rules ported from drawphone by Tanner Krewson (MIT, LICENSE-drawphone.txt): every player starts a chain with a prompt,
 * the next player draws it, the next describes the drawing, and so on; each turn every player works on a different
 * chain (a row-complete Latin square), chains have an odd number of links so they end in words, and every chain is
 * revealed at the end. drawphone's server moves into the leader's copy.
 *
 * The leader (host-computed, everyone agrees) holds the chains and is the only one who sees them before the reveal.
 * A player's task (a prompt or a drawing) goes to that player alone with send(data, appId). Drawings travel as image
 * data URLs (WebP, PNG fallback, at most C.MAX_IMG chars) split into chunks under 4 KB with a length and a checksum,
 * reassembled and checked on arrival. A turn ends when everyone has sent their link, or C.GRACE_MS after the timer;
 * missing links are skipped (a missing first prompt gets a random one). Players who leave the call are skipped at once;
 * the leader can skip anyone it is waiting for. On a leader change the game ends and everyone returns to the lobby
 * (the new leader does not have the chains).
 *
 * Messages (relay data is untrusted and shape-checked here). g: the game id, new per game.
 *   any -> all:      {t:"hi"}  (on open, retried until the leader answers; the leader adds the sender to the lobby)
 *   leader -> all:   {t:"lobby", g, roster, turns, note}   {t:"turn", g, turn, turns, secs, roster, waiting}
 *                    {t:"reveal", g, total}   {t:"chain", g, c, owner, links, names}   {t:"show", g, k}
 *   leader -> one:   {t:"task", g, turn, chain, kind, text?, img?}   {t:"got", g, id}  (a link arrived)
 *   player -> leader {t:"text", g, id, text}  (empty: gave up)   {t:"need", g, c}  (reveal data went missing)
 *   either way:      {t:"img", g, id, i, total, len, sum, d}  (a chunk of an image data URL)
 * A link id is "<chain>.<turn>"; turn 0 is the chain's prompt.
 */

/** @typedef {"write" | "draw" | "describe"} TelephoneKind */
/** @typedef {{ by: string, kind: "w" | "d" | "skip", text?: string, img?: string, auto?: boolean }} TelephoneLink */
/** @typedef {{ owner: string, links: TelephoneLink[] }} TelephoneChain */
/** @typedef {{ turn: number, chain: number, kind: TelephoneKind, text: string, img: string }} TelephoneTask */

var TelephoneCore = (() => {
  const C = {
    MIN_PLAYERS: 3,
    MAX_PLAYERS: 12,
    WRITE_SECS: 45,
    DRAW_SECS: 90,
    DESCRIBE_SECS: 45,
    GRACE_MS: 10000, // uploads still arriving after the timer
    HI_RETRY_MS: 2000,
    RESEND_MS: 6000, // re-ask the leader when a task's drawing or reveal data has not arrived
    ACK_MS: 5000,
    UPLOAD_TRIES: 3,
    MAX_TEXT: 80,
    CHUNK: 3400,
    MAX_IMG: 24000, // chars of a data URL: about 16 KB of image
    MAX_CHUNKS: 8,
    PACE_MS: 70, // the leader sends at most ~14 messages a second; others slow down with the call size (20/s user, 30/s call)
  };
  const IMG_RE = /^data:image\/(webp|png);base64,[A-Za-z0-9+/]+={0,2}$/;

  /** @param {unknown} v @param {number} max @returns {v is number} */
  const isInt = (v, max) => Number.isInteger(v) && /** @type {number} */ (v) >= 0 && /** @type {number} */ (v) <= max;
  /** @param {unknown} v @returns {v is string} */
  const isId = (v) => typeof v === "string" && v.length > 0 && v.length <= 64;
  /** @param {unknown} v */
  const ids = (v) => (Array.isArray(v) ? v.filter(isId).slice(0, 64) : []);
  /** Trimmed, one line, no control or bidi characters, at most C.MAX_TEXT. @param {unknown} v */
  const cleanText = (v) =>
    // eslint-disable-next-line no-control-regex
    typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim().slice(0, C.MAX_TEXT) : "";

  // Turn order from drawphone's round.js (MIT), after https://math.stackexchange.com/a/4000891: row t lists the chain
  // each player works on in turn t. Every row is a permutation; no player meets the same chain twice in `turns` turns.
  /** @param {number[]} a @param {number} k */
  const rotate = (a, k) => {
    const n = ((k % a.length) + a.length) % a.length;
    return [...a.slice(n), ...a.slice(0, n)];
  };
  /** @param {number} n @param {number} turns @returns {number[][]} */
  function latinSquare(n, turns) {
    const rows = [Array.from({ length: n }, (_, i) => i)];
    const last = () => rows[rows.length - 1];
    if (n % 2 === 0) {
      for (let i = 1; i < turns; i++) rows.push(rotate(last(), i * (i % 2 === 0 ? -1 : 1)));
    } else {
      const m = (n - 1) / 2;
      for (let i = 1; i <= m; i++) rows.push(rotate(last(), i * (i % 2 === 0 ? -1 : 1)));
      rows.push(rotate(last(), m % 2 === 0 ? -1 : 1));
      for (let i = m - 1; i >= Math.max(1, m - turns); i--) rows.push(rotate(last(), i * (i % 2 === 0 ? 1 : -1)));
    }
    return rows.slice(0, turns);
  }

  /** The turn counts a game of `n` players can have (drawphone's word-first limits): odd, from 3 up to n or n - 1. @param {number} n */
  function turnOptions(n) {
    const max = Math.max(3, Math.floor((n + 1) / 2) * 2 - 1);
    const out = [];
    for (let t = 3; t <= max; t += 2) out.push(t);
    return out;
  }

  /** FNV-1a over the string's UTF-16 units, as 8 hex digits. @param {string} s */
  function checksum(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
    return h.toString(16).padStart(8, "0");
  }

  /** A data URL is a WebP or PNG of at most C.MAX_IMG chars whose bytes start with that format's signature. @param {unknown} url */
  function checkImage(url) {
    if (typeof url !== "string" || url.length > C.MAX_IMG) return false;
    const m = IMG_RE.exec(url);
    if (!m) return false;
    const at = url.indexOf(",") + 1;
    let head = "";
    try {
      head = atob(url.slice(at, at + 16));
    } catch {
      return false;
    }
    return m[1] === "png" ? head.startsWith("\x89PNG\r\n\x1a\n") : head.startsWith("RIFF") && head.slice(8, 12) === "WEBP";
  }

  /** Split a data URL into relay messages. @param {string} g @param {string} id @param {string} url */
  function imageChunks(g, id, url) {
    const total = Math.ceil(url.length / C.CHUNK);
    const len = url.length;
    const sum = checksum(url);
    return Array.from({ length: total }, (_, i) => ({ t: "img", g, id, i, total, len, sum, d: url.slice(i * C.CHUNK, (i + 1) * C.CHUNK) }));
  }

  /** Collects image chunks per sender and id; returns the checked data URL once complete. */
  function assembler() {
    /** @type {Map<string, { total: number, len: number, sum: string, parts: string[] }>} */
    const open = new Map();
    return {
      /** @param {any} m @param {string} from @returns {string | null} */
      add(m, from) {
        if (!isId(m.id) || !isInt(m.total, C.MAX_CHUNKS) || m.total < 1 || !isInt(m.i, m.total - 1)) return null;
        if (!isInt(m.len, C.MAX_IMG) || typeof m.sum !== "string" || typeof m.d !== "string" || m.d.length > C.CHUNK) return null;
        const key = `${from} ${m.id}`;
        let entry = open.get(key);
        if (!entry || entry.total !== m.total || entry.len !== m.len || entry.sum !== m.sum) {
          entry = { total: m.total, len: m.len, sum: m.sum, parts: [] }; // a different image under this id starts over
          open.set(key, entry);
          if (open.size > 64) open.delete(/** @type {string} */ (open.keys().next().value));
        }
        entry.parts[m.i] = m.d;
        if (entry.parts.filter((p) => typeof p === "string").length < entry.total) return null;
        open.delete(key);
        const url = entry.parts.join("");
        return url.length === entry.len && checksum(url) === entry.sum && checkImage(url) ? url : null;
      },
      clear() {
        open.clear();
      },
    };
  }

  /**
   * @param {{
   *   me: string, players: string[], leader: string,
   *   send: (data: object, to?: string) => void,
   *   nameOf?: (appId: string) => string,
   *   onChange?: () => void,
   *   prompts?: string[],
   *   random?: () => number,
   *   pace?: number,
   * }} o
   */
  function create(o) {
    const { me } = o;
    const nameOf = o.nameOf ?? ((/** @type {string} */ id) => id);
    const onChange = o.onChange ?? (() => {});
    const prompts = o.prompts?.length ? o.prompts : ["a cat"];
    const random = o.random ?? Math.random;
    let players = o.players.slice();
    let leader = o.leader;

    const st = {
      synced: false,
      phase: /** @type {"lobby" | "play" | "reveal"} */ ("lobby"),
      g: "",
      note: "",
      /** @type {string[]} */ roster: [],
      turns: 3,
      turn: 0,
      deadline: 0,
      /** @type {string[]} */ waiting: [],
      /** @type {TelephoneTask | null} */ task: null,
      submitted: false,
      /** @type {(TelephoneChain | null)[]} */ chains: [],
      k: 0,
      /** @type {Map<string, string>} image data URLs by link id */ imgs: new Map(),
      /** @type {Record<string, string>} names the leader sent with the reveal (covers players who left) */ names: {},
    };

    // Leader-only state: who has the game open, the turn order and the chains.
    /** @type {string[]} */ let present = [];
    /** @type {number[][]} */ let order = [];
    /** @type {TelephoneChain[]} */ let chains = [];
    /** @type {Map<string, number>} when each copy last said hi */ const hiSeen = new Map();

    const asm = assembler();
    /** @type {{ data: any, to?: string }[]} */ const fast = [];
    /** @type {{ data: any, to?: string }[]} */ const slow = [];
    /** @type {ReturnType<typeof setTimeout> | undefined} */ let pump;
    /** @type {ReturnType<typeof setTimeout> | undefined} */ let hiTimer;
    /** @type {ReturnType<typeof setTimeout> | undefined} */ let turnTimer;
    /** @type {ReturnType<typeof setTimeout> | undefined} */ let resendTimer;
    /** @type {ReturnType<typeof setTimeout> | undefined} */ let uploadTimer;
    /** @type {{ id: string, msgs: object[], tries: number } | null} */ let upload = null;
    let hiTries = 0;
    let lastHi = 0;

    const isLeader = () => me === leader;
    const pace = () => o.pace ?? (isLeader() ? C.PACE_MS : C.PACE_MS * Math.max(1, players.length - 1));
    function drain() {
      pump = undefined;
      const next = fast.shift() ?? slow.shift();
      if (!next) return;
      o.send(next.data, next.to);
      pump = setTimeout(drain, pace());
    }
    /** Queue a relay send, paced; image chunks go after everything else. @param {object} data @param {string} [to] @param {boolean} [bulk] */
    function out(data, to, bulk = false) {
      if (to === me) return void handle(data, me);
      (bulk ? slow : fast).push(to === undefined ? { data } : { data, to });
      if (!pump) drain();
    }
    /** Send to everyone and apply locally (the relay skips the sender). @param {object} m */
    function publish(m) {
      out(m);
      handle(m, me);
    }
    const flushQueues = () => {
      fast.length = 0;
      slow.length = 0;
    };
    /** Image chunks (of chain `c`, or any) still queued for `to`. @param {string} to @param {number} c */
    const queuedFor = (to, c) => slow.some((x) => (!x.to || x.to === to) && String(x.data.id).startsWith(`${c}.`));
    const secsLeft = () => Math.max(0, Math.round((st.deadline - Date.now()) / 1000));
    const linkId = (/** @type {number} */ chain, /** @type {number} */ turn) => `${chain}.${turn}`;
    const randomPrompt = () => prompts[Math.floor(random() * prompts.length)];

    // ---- every copy ----

    function sayHi() {
      clearTimeout(hiTimer);
      if (isLeader()) return;
      hiTries += 1;
      lastHi = Date.now();
      out({ t: "hi" });
      hiTimer = setTimeout(() => !st.synced && sayHi(), hiTries < 3 ? C.HI_RETRY_MS : C.HI_RETRY_MS * 5);
    }

    /** Back to the lobby of game `g`. @param {string} g @param {string} note */
    function toLobby(g, note) {
      clearTimeout(turnTimer);
      clearTimeout(uploadTimer);
      upload = null;
      if (g !== st.g) {
        st.imgs = new Map();
        asm.clear();
      }
      Object.assign(st, { phase: "lobby", g, note, turn: 0, waiting: [], task: null, submitted: false, chains: [], k: 0, names: {} });
    }

    /** @param {number} c */
    function chainReady(c) {
      const chain = st.chains[c];
      return !!chain && chain.links.every((l) => l.kind !== "d" || st.imgs.has(/** @type {string} */ (l.img)));
    }

    /** Ask again for whatever has not arrived: the task's drawing, or the shown chain. */
    function planResend() {
      clearTimeout(resendTimer);
      if (isLeader()) return;
      const missing = (st.phase === "play" && !!st.task?.img && !st.imgs.has(st.task.img) && !st.submitted) || (st.phase === "reveal" && !chainReady(st.k));
      if (!missing) return;
      resendTimer = setTimeout(() => {
        if (st.phase === "play") out({ t: "hi" });
        else if (st.phase === "reveal") out({ t: "need", g: st.g, c: st.k }, leader);
        planResend();
      }, C.RESEND_MS);
    }

    /** One message, relayed or our own. @param {any} m @param {string} from */
    function handle(m, from) {
      if (!m || typeof m !== "object" || typeof m.t !== "string") return;
      if (m.t === "hi") return void (isLeader() && from !== me && leaderHi(from));
      if (m.g !== st.g && !(from === leader && ["lobby", "turn", "reveal"].includes(m.t) && isId(m.g))) return;
      if (m.t === "img") {
        const url = asm.add(m, from);
        if (!url) return;
        if (isLeader() && from !== me) return void leaderLink(from, m.id, { kind: "d", url });
        if (from === leader) {
          st.imgs.set(m.id, url);
          planResend();
          onChange();
        }
        return;
      }
      if (isLeader() && from !== me) {
        if (m.t === "text" && isId(m.id)) leaderLink(from, m.id, { kind: "w", text: cleanText(m.text) });
        else if (m.t === "need" && st.phase === "reveal" && isInt(m.c, chains.length - 1) && !queuedFor(from, m.c)) sendChain(m.c, from);
        return;
      }
      if (from !== leader) return;
      // From the leader, or the leader's own copy:
      if (m.t === "lobby") {
        toLobby(m.g, typeof m.note === "string" ? m.note.slice(0, 120) : "");
        st.roster = ids(m.roster);
        st.turns = isInt(m.turns, 99) ? m.turns : 3;
        st.synced = true;
        if (!st.roster.includes(me)) {
          // The leader has not seen our hi (it may have come before it knew it leads): say it again, throttled.
          clearTimeout(hiTimer);
          hiTimer = setTimeout(() => st.phase === "lobby" && !st.roster.includes(me) && sayHi(), Math.max(0, lastHi + C.HI_RETRY_MS - Date.now()));
        }
      } else if (m.t === "turn" && isInt(m.turn, 99) && isInt(m.turns, 99) && isInt(m.secs, 600)) {
        if (m.g !== st.g) toLobby(m.g, "");
        if (m.turn !== st.turn || st.phase !== "play") {
          st.task = null;
          st.submitted = false;
        }
        Object.assign(st, { phase: "play", turn: m.turn, turns: m.turns, roster: ids(m.roster), waiting: ids(m.waiting), synced: true });
        st.deadline = Date.now() + m.secs * 1000;
      } else if (m.t === "task" && st.phase === "play" && m.turn === st.turn && isInt(m.chain, C.MAX_PLAYERS) && ["write", "draw", "describe"].includes(m.kind)) {
        if (st.task && st.task.chain === m.chain) return; // a resend
        st.task = { turn: m.turn, chain: m.chain, kind: m.kind, text: cleanText(m.text), img: m.kind === "describe" && isId(m.img) ? m.img : "" };
        st.submitted = false;
      } else if (m.t === "got") {
        if (upload && m.id === upload.id) {
          clearTimeout(uploadTimer);
          upload = null;
        }
        return;
      } else if (m.t === "reveal" && isInt(m.total, C.MAX_PLAYERS)) {
        if (m.g !== st.g) toLobby(m.g, "");
        if (st.phase !== "reveal") Object.assign(st, { phase: "reveal", chains: Array(m.total).fill(null), k: 0, task: null, waiting: [], synced: true });
      } else if (m.t === "chain" && st.phase === "reveal" && isInt(m.c, st.chains.length - 1) && isId(m.owner) && Array.isArray(m.links)) {
        const links = m.links.slice(0, 99).map(validLink).filter(Boolean);
        st.chains[m.c] = { owner: m.owner, links: /** @type {TelephoneLink[]} */ (links) };
        if (m.names && typeof m.names === "object") {
          for (const [id, name] of Object.entries(m.names).slice(0, 64)) if (typeof name === "string") st.names[id] = cleanText(name).slice(0, 32);
        }
      } else if (m.t === "show" && st.phase === "reveal" && isInt(m.k, st.chains.length - 1)) {
        st.k = m.k;
      } else {
        return;
      }
      planResend();
      onChange();
    }

    /** @param {any} l @returns {TelephoneLink | null} */
    function validLink(l) {
      if (!l || !isId(l.by)) return null;
      if (l.kind === "w") return { by: l.by, kind: "w", text: cleanText(l.text), auto: l.auto === true };
      if (l.kind === "d" && isId(l.img)) return { by: l.by, kind: "d", img: l.img };
      if (l.kind === "skip") return { by: l.by, kind: "skip" };
      return null;
    }

    // ---- leader ----

    const lobbyRoster = () => present.filter((id) => players.includes(id));
    /** Default: the second option (5 turns) when the lobby allows it. */
    const fitTurns = (/** @type {number} */ turns) => {
      const options = turnOptions(lobbyRoster().length);
      return options.includes(turns) ? turns : options[Math.min(1, options.length - 1)];
    };

    /** A new game id and an empty lobby. @param {string} note */
    function leaderLobby(note) {
      clearTimeout(turnTimer);
      flushQueues();
      present = [me, ...present.filter((id) => id !== me)];
      order = [];
      chains = [];
      const g = Math.floor(random() * 2 ** 31).toString(36) + Date.now().toString(36).slice(-4);
      publish({ t: "lobby", g, roster: lobbyRoster(), turns: fitTurns(st.turns), note });
    }

    function broadcastLobby() {
      publish({ t: "lobby", g: st.g, roster: lobbyRoster(), turns: fitTurns(st.turns), note: st.note });
    }

    /** @param {string} from */
    function leaderHi(from) {
      // One hi per sender per second: a spamming copy must not make the leader queue the same data over and over.
      if (Date.now() - (hiSeen.get(from) ?? -Infinity) < C.HI_RETRY_MS / 2) return;
      hiSeen.set(from, Date.now());
      if (!present.includes(from)) present.push(from);
      if (st.phase === "lobby") return broadcastLobby();
      if (st.phase === "play") {
        out(turnMsg(), from);
        const i = st.roster.indexOf(from);
        if (i >= 0 && st.waiting.includes(from)) sendTask(from, order[st.turn][i]);
        return;
      }
      out({ t: "reveal", g: st.g, total: chains.length }, from);
      chains.forEach((_, c) => queuedFor(from, c) || sendChain(c, from));
      out({ t: "show", g: st.g, k: st.k }, from);
    }

    const turnMsg = () => ({ t: "turn", g: st.g, turn: st.turn, turns: st.turns, secs: secsLeft(), roster: st.roster, waiting: st.waiting });

    /** The last link that is not a skip. @param {TelephoneChain} chain */
    const lastReal = (chain) => [...chain.links].reverse().find((l) => l.kind !== "skip");

    /** Turn 0 writes; after that a chain alternates, skipping over skipped links. @param {number} c @returns {TelephoneKind} */
    const kindFor = (c) => (st.turn === 0 ? "write" : lastReal(chains[c])?.kind === "d" ? "describe" : "draw");

    /** @param {string} player @param {number} c */
    function sendTask(player, c) {
      const kind = kindFor(c);
      const prev = lastReal(chains[c]);
      const task = { t: "task", g: st.g, turn: st.turn, chain: c, kind };
      if (kind === "draw") Object.assign(task, { text: prev?.text ?? "" });
      if (kind === "describe" && prev?.img) Object.assign(task, { img: prev.img });
      out(task, player);
      const url = prev?.img && st.imgs.get(prev.img);
      if (kind === "describe" && url && player !== me && !queuedFor(player, c)) for (const chunk of imageChunks(st.g, /** @type {string} */ (prev?.img), url)) out(chunk, player, true);
    }

    /** The link of a player who sent nothing: a random prompt in turn 0 (a chain needs a start), else a skip. @param {string} id @returns {TelephoneLink} */
    const missing = (id) => (st.turn === 0 ? { by: id, kind: "w", text: randomPrompt(), auto: true } : { by: id, kind: "skip" });

    /** @param {number} c @param {TelephoneLink} link */
    function addLink(c, link) {
      if (chains[c].links.length === st.turn) chains[c].links.push(link);
    }

    function nextTurn() {
      clearTimeout(turnTimer);
      if (st.turn + 1 >= st.turns) return startReveal();
      st.turn += 1;
      st.task = null;
      st.submitted = false;
      const row = order[st.turn];
      st.waiting = st.roster.filter((id) => players.includes(id));
      st.roster.forEach((id, i) => st.waiting.includes(id) || addLink(row[i], missing(id)));
      const kinds = st.waiting.map((id) => kindFor(row[st.roster.indexOf(id)]));
      const secs = st.turn === 0 ? C.WRITE_SECS : kinds.includes("draw") ? C.DRAW_SECS : C.DESCRIBE_SECS;
      st.deadline = Date.now() + secs * 1000;
      publish(turnMsg());
      for (const id of st.waiting) sendTask(id, row[st.roster.indexOf(id)]);
      turnTimer = setTimeout(endTurn, secs * 1000 + C.GRACE_MS);
      if (!st.waiting.length) nextTurn();
    }

    /** Time is up: skip whoever has not sent a link. */
    function endTurn() {
      for (const id of st.waiting.slice()) skipPlayer(id, false);
      nextTurn();
    }

    /** @param {string} id @param {boolean} advance */
    function skipPlayer(id, advance) {
      const i = st.roster.indexOf(id);
      if (st.phase !== "play" || i < 0 || !st.waiting.includes(id)) return;
      addLink(order[st.turn][i], missing(id));
      done(id, advance);
    }

    /** @param {string} id @param {boolean} advance */
    function done(id, advance) {
      st.waiting = st.waiting.filter((x) => x !== id);
      if (!advance) return;
      if (st.waiting.length) publish(turnMsg());
      else nextTurn();
    }

    /** A link from a player, or the leader's own. @param {string} from @param {string} id @param {{ kind: "w", text: string } | { kind: "d", url: string }} link */
    function leaderLink(from, id, link) {
      if (st.phase !== "play") return;
      const i = st.roster.indexOf(from);
      const c = i >= 0 ? order[st.turn][i] : -1;
      if (id !== linkId(c, st.turn)) return;
      const kind = kindFor(c);
      /** @type {TelephoneLink | null} */
      let got = null;
      if (link.kind === "d") got = kind === "draw" ? { by: from, kind: "d", img: id } : null;
      else if (!link.text) got = missing(from); // gave up
      else if (kind !== "draw") got = { by: from, kind: "w", text: link.text };
      if (!got) return;
      if (from !== me) out({ t: "got", g: st.g, id }, from);
      if (!st.waiting.includes(from)) return; // a retry of a link we already have
      if (link.kind === "d") st.imgs.set(id, link.url);
      addLink(c, got);
      done(from, true);
    }

    function startReveal() {
      clearTimeout(turnTimer);
      publish({ t: "reveal", g: st.g, total: chains.length });
      chains.forEach((_, c) => sendChain(c));
      publish({ t: "show", g: st.g, k: 0 });
    }

    /** Chain `c` and its drawings, to everyone or one player. @param {number} c @param {string} [to] */
    function sendChain(c, to) {
      const chain = chains[c];
      /** @type {Record<string, string>} */
      const names = {};
      for (const id of new Set([chain.owner, ...chain.links.map((l) => l.by)])) names[id] = nameOf(id).slice(0, 32);
      const m = { t: "chain", g: st.g, c, owner: chain.owner, links: chain.links, names };
      if (to === undefined) publish(m);
      else out(m, to);
      for (const l of chain.links) {
        const url = l.img && st.imgs.get(l.img);
        if (url) for (const chunk of imageChunks(st.g, /** @type {string} */ (l.img), url)) out(chunk, to, true);
      }
    }

    // ---- uploads (players other than the leader) ----

    /** @param {string} id @param {object[]} msgs */
    function startUpload(id, msgs) {
      clearTimeout(uploadTimer);
      upload = { id, msgs, tries: 0 };
      pushUpload();
    }
    function pushUpload() {
      if (!upload || st.phase !== "play") return void (upload = null);
      upload.tries += 1;
      for (const m of upload.msgs) out(m, leader, true);
      uploadTimer = setTimeout(() => (upload && upload.tries < C.UPLOAD_TRIES ? pushUpload() : (upload = null)), C.ACK_MS + upload.msgs.length * pace());
    }

    /** @param {"w" | "d"} kind @param {string} payload */
    function submit(kind, payload) {
      const t = st.task;
      if (!t || st.submitted) return false;
      st.submitted = true;
      const id = linkId(t.chain, t.turn);
      if (isLeader()) leaderLink(me, id, kind === "d" ? { kind, url: payload } : { kind, text: payload });
      else startUpload(id, kind === "d" ? imageChunks(st.g, id, payload) : [{ t: "text", g: st.g, id, text: payload }]);
      onChange();
      return true;
    }

    return {
      state: st,
      start() {
        st.synced = isLeader();
        if (isLeader()) leaderLobby("");
        else sayHi();
        onChange();
      },
      /** A relayed message. @param {unknown} data @param {string} from */
      receive(data, from) {
        handle(data, from);
      },
      /** @param {string[]} list @param {string} newLeader */
      setPlayers(list, newLeader) {
        const old = leader;
        players = list.slice();
        leader = newLeader;
        if (newLeader !== old) {
          // The chains were on the old leader's copy: back to a lobby that the new leader runs.
          const note = st.phase === "lobby" ? "" : `${nameOf(old)} left, so the game ended.`;
          flushQueues();
          toLobby(st.g, note);
          present = [];
          hiTries = 0;
          st.synced = isLeader();
          if (isLeader()) leaderLobby(note);
          else sayHi();
        } else if (isLeader() && st.phase === "lobby") broadcastLobby();
        else if (isLeader() && st.phase === "play") for (const id of st.waiting.slice()) if (!players.includes(id)) skipPlayer(id, true);
        onChange();
      },
      /** Leader: how many turns the next game has. @param {number} turns */
      setTurns(turns) {
        if (!isLeader() || st.phase !== "lobby" || !turnOptions(lobbyRoster().length).includes(turns)) return;
        st.turns = turns;
        broadcastLobby();
      },
      /** Leader: start a game with the lobby (the first 12). */
      startGame() {
        const roster = lobbyRoster().slice(0, C.MAX_PLAYERS);
        if (!isLeader() || st.phase !== "lobby" || roster.length < C.MIN_PLAYERS) return false;
        // Shuffled seats, like drawphone, so the chains travel in a new order every game.
        for (let i = roster.length - 1; i > 0; i--) {
          const j = Math.floor(random() * (i + 1));
          [roster[i], roster[j]] = [roster[j], roster[i]];
        }
        const options = turnOptions(roster.length);
        st.turns = options.includes(st.turns) ? st.turns : options[options.length - 1];
        Object.assign(st, { phase: "play", roster, turn: -1, note: "" });
        order = latinSquare(roster.length, st.turns);
        chains = roster.map((owner) => ({ owner, links: [] }));
        nextTurn();
        onChange();
        return true;
      },
      /** Send a prompt or a description. @param {string} text */
      submitText(text) {
        const clean = cleanText(text);
        return !!clean && st.task?.kind !== "draw" && submit("w", clean);
      },
      /** Send a finished drawing (an image data URL from the canvas). @param {string} url */
      submitImage(url) {
        return st.task?.kind === "draw" && checkImage(url) && submit("d", url);
      },
      /** Time ran out with nothing to send. */
      giveUp() {
        return submit("w", "");
      },
      /** Leader: stop waiting for a player. @param {string} id */
      skip(id) {
        if (isLeader()) skipPlayer(id, true);
        onChange();
      },
      /** Leader: show chain k; its drawings jump the send queue. @param {number} k */
      show(k) {
        if (!isLeader() || st.phase !== "reveal" || !isInt(k, chains.length - 1)) return;
        const first = slow.filter((x) => String(x.data.id).startsWith(`${k}.`));
        const rest = slow.filter((x) => !first.includes(x));
        slow.splice(0, slow.length, ...first, ...rest);
        publish({ t: "show", g: st.g, k });
      },
      /** Leader: back to the lobby for another game. */
      newGame() {
        if (isLeader()) leaderLobby("");
      },
      isLeader,
      suggest: randomPrompt,
      chainReady,
      nameOf: (/** @type {string} */ id) => st.names[id] ?? nameOf(id),
      stop() {
        for (const t of [pump, hiTimer, turnTimer, resendTimer, uploadTimer]) clearTimeout(t);
        flushQueues();
      },
    };
  }

  return { create, latinSquare, turnOptions, checksum, checkImage, imageChunks, assembler, cleanText, C };
})();
globalThis.TelephoneCore = TelephoneCore;
