// @ts-check
/*
 * Trivia rules for PartyHost (../party-host.js); no DOM. Tests in src/games/party.test.ts.
 *
 * Every copy has the question bank (questions.js), so the public state names questions by index and gives the answer
 * order; nothing about the right answer is secret. What each player picked stays on the host until the reveal.
 * Phases: lobby (host picks category, difficulty, length) -> q (timed) -> reveal -> q ... -> end.
 *
 * Intents: {k:"cfg", cat, diff, len} {k:"start"} {k:"again"} (host only), {k:"ans", i, c} (any player).
 */

/** @typedef {[number, number, string, string, ...string[]]} TriviaQuestion  [cat, diff, question, correct, ...wrong] */
/** @typedef {{ cats: string[], q: TriviaQuestion[] }} TriviaBank */

var TriviaCore = (() => {
  const { isInt, shuffle } = PartyHost;
  const C = { Q_MS: 20000, REVEAL_MS: 5000, LENGTHS: [5, 10, 15, 20], BASE: 500, SPEED: 500 };
  const DIFFS = ["Easy", "Medium", "Hard"];

  /** @param {TriviaBank} bank */
  function game(bank) {
    /** Picks this question, on the host only: app id -> {c: choice, left: ms left when answered}. */
    /** @type {Record<string, { c: number, left: number }>} */
    let picks = {};

    /** @param {number} cat @param {number} diff */
    const matching = (cat, diff) => {
      /** @type {number[]} */
      const out = [];
      bank.q.forEach((q, i) => (cat < 0 || q[0] === cat) && (diff < 0 || q[1] === diff) && out.push(i));
      return out;
    };

    /** @param {PartyState} st @param {PartyCtx} ctx */
    function ask(st, ctx) {
      const q = bank.q[st.qs[st.i]];
      st.phase = "q";
      st.ord = shuffle(q.slice(3).map((_, j) => j), ctx.random); // ord[shown position] = answer index; 0 is right
      st.answered = [];
      st.picks = {};
      st.gain = {};
      st.deadline = ctx.now() + C.Q_MS;
      picks = {};
    }

    /** @param {PartyState} st @param {PartyCtx} ctx */
    function reveal(st, ctx) {
      st.phase = "reveal";
      st.picks = {};
      st.gain = {};
      for (const [id, p] of Object.entries(picks)) {
        st.picks[id] = p.c;
        const pts = st.ord[p.c] === 0 ? C.BASE + Math.round((C.SPEED * p.left) / C.Q_MS) : 0;
        st.gain[id] = pts;
        if (pts) st.scores[id] = (st.scores[id] ?? 0) + pts;
      }
      st.deadline = ctx.now() + C.REVEAL_MS;
    }

    /** @type {PartyGame} */
    const g = {
      init: () => ({ phase: "lobby", deadline: 0, cat: -1, diff: -1, len: 10, qs: [], i: 0, ord: [], answered: [], picks: {}, gain: {}, scores: {}, note: "" }),
      intent(st, from, m, ctx) {
        const host = from === ctx.leader;
        const idle = st.phase === "lobby" || st.phase === "end";
        if (m.k === "cfg" && host && idle) {
          if (isInt(m.cat + 1, bank.cats.length)) st.cat = m.cat;
          if (isInt(m.diff + 1, 3)) st.diff = m.diff;
          if (C.LENGTHS.includes(m.len)) st.len = m.len;
          st.phase = "lobby";
          return true;
        }
        if (m.k === "start" && host && idle) {
          const pool = matching(st.cat, st.diff);
          if (!pool.length) {
            st.note = "No questions match; pick another category or difficulty";
            return true;
          }
          Object.assign(st, { qs: shuffle(pool, ctx.random).slice(0, st.len), i: 0, scores: {}, note: "" });
          ask(st, ctx);
          return true;
        }
        if (m.k === "again" && host && st.phase === "end") {
          st.phase = "lobby";
          return true;
        }
        if (m.k === "ans" && st.phase === "q" && m.i === st.i && isInt(m.c, st.ord.length - 1) && ctx.players.includes(from) && !picks[from]) {
          picks[from] = { c: m.c, left: Math.max(0, st.deadline - ctx.now()) };
          st.answered = [...st.answered, from];
          if (ctx.players.every((id) => picks[id])) reveal(st, ctx);
          return true;
        }
        return false;
      },
      timeout(st, ctx) {
        if (st.phase === "q") reveal(st, ctx);
        else if (st.phase === "reveal" && st.i + 1 < st.qs.length) {
          st.i += 1;
          ask(st, ctx);
        } else if (st.phase === "reveal") st.phase = "end";
      },
      players(st, ctx) {
        if (st.phase !== "q" || !ctx.players.length || !ctx.players.every((id) => picks[id])) return false;
        reveal(st, ctx);
        return true;
      },
      takeOver(st, ctx) {
        // Answers given to the old host are gone: ask the current question again; a reveal just runs its timer again.
        if (st.phase === "q") ask(st, ctx);
        else if (st.phase === "reveal") st.deadline = ctx.now() + C.REVEAL_MS;
      },
    };
    return g;
  }

  return { game, C, DIFFS };
})();
globalThis.TriviaCore = TriviaCore;
