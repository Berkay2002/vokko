// @ts-check
/*
 * Same Wave rules for PartyHost (../party-host.js); no DOM. Tests in src/games/party.test.ts.
 *
 * One team plays together. Each round a clue-giver (in turn) privately sees a target spot on a dial between two
 * opposite words and gives a one-line clue; everyone else moves one shared dial and locks it in. Points by distance:
 * 4 within 2, 3 within 7, 2 within 12 (the dial runs 0-100). Private info: the clue-giver's {target}. A new host cannot
 * know it, so it ends the game and goes back to the lobby.
 *
 * Intents: {k:"cfg", rounds} {k:"start"} {k:"next"} {k:"again"} (host), {k:"clue", text} (giver), {k:"dial", v} {k:"lock"}.
 */

var WaveCore = (() => {
  const { isInt, shuffle } = PartyHost;
  const C = { ROUNDS: [4, 6, 8, 12], CLUE_MS: 90000, GUESS_MS: 90000, REVEAL_MS: 8000, MAX_CLUE: 60, BANDS: [2, 7, 12] };

  /** Our own spectrum pairs (left end, right end). */
  const PAIRS = /** @type {const} */ ([
    ["Quiet", "Loud"], ["Cheap", "Pricey"], ["Tiny", "Huge"], ["Boring hobby", "Thrilling hobby"], ["Easy to spell", "Hard to spell"],
    ["Breakfast food", "Dinner food"], ["Calm animal", "Scary animal"], ["Feels old", "Feels new"], ["Smells bad", "Smells good"],
    ["Rare", "Everywhere"], ["Soft", "Hard"], ["Slow", "Fast"], ["Useless gadget", "Useful gadget"], ["Light snack", "Heavy meal"],
    ["Sad song", "Happy song"], ["Bad first date", "Great first date"], ["Indoor activity", "Outdoor activity"],
    ["Short-lived", "Lasts forever"], ["For kids", "For grown-ups"], ["Overpriced", "A bargain"], ["Unhealthy", "Healthy"],
    ["Low effort", "High effort"], ["Wet", "Dry"], ["Dull color", "Bright color"], ["Easy job", "Hard job"],
    ["Bad superpower", "Great superpower"], ["Fake", "Real"], ["Lazy pet", "Energetic pet"], ["Weak drink", "Strong drink"],
    ["Bad gift", "Great gift"], ["Cold place", "Hot place"], ["Ugly word", "Beautiful word"], ["Mild", "Spicy"],
    ["Common name", "Unusual name"], ["Bad advice", "Good advice"], ["Clean hobby", "Messy hobby"], ["Simple", "Complicated"],
    ["Rough texture", "Smooth texture"], ["Bad movie snack", "Good movie snack"], ["Tame", "Wild"],
    ["Sounds made up", "Sounds real"], ["Background character", "Main character"], ["Forgettable", "Unforgettable"],
    ["Bad place to nap", "Good place to nap"], ["Flimsy", "Sturdy"], ["Ancient", "Futuristic"], ["Mundane", "Magical"],
    ["Polite", "Rude"], ["Small talk topic", "Deep talk topic"], ["Normal pizza topping", "Weird pizza topping"],
    ["Safe", "Dangerous"], ["Bad smell to wake up to", "Good smell to wake up to"], ["Dark", "Bright"], ["Cozy", "Uncomfortable"],
    ["Bad vacation", "Dream vacation"], ["Underground", "Sky high"], ["Quick to learn", "Takes years to learn"],
    ["Silly", "Serious"], ["Bad roommate habit", "Good roommate habit"], ["Light", "Heavy"], ["Plain", "Fancy"],
    ["Lonely activity", "Social activity"], ["Weak argument", "Strong argument"], ["Unknown", "Famous"],
    ["Hard to draw", "Easy to draw"], ["Bad sandwich", "Great sandwich"], ["Peaceful", "Chaotic"], ["Short", "Tall"],
    ["Bad name for a boat", "Good name for a boat"], ["Fragile", "Unbreakable"], ["Natural", "Artificial"],
    ["Bad weather", "Perfect weather"], ["Tastes bland", "Tastes rich"], ["Needs no skill", "Needs lots of skill"],
    ["Bad villain", "Great villain"], ["Quiet neighbor", "Noisy neighbor"], ["Useless in a crisis", "Saves the day"],
    ["Bad sound", "Lovely sound"], ["Narrow", "Wide"], ["Sleepy", "Wide awake"], ["Clumsy", "Graceful"],
    ["Bad ice cream flavor", "Great ice cream flavor"], ["Hidden", "Obvious"], ["Old-fashioned", "Trendy"],
    ["Bad pet name", "Great pet name"], ["Close by", "Far away"], ["Shallow", "Deep"], ["Bad song for a road trip", "Perfect road trip song"],
    ["Not scary", "Terrifying"], ["Tidy", "Cluttered"], ["Unlucky", "Lucky"], ["Bitter", "Sweet"],
  ]);

  /** Points for a dial at `dial` when the target was `target`. @param {number} dial @param {number} target */
  const points = (dial, target) => {
    const d = Math.abs(dial - target);
    return d <= C.BANDS[0] ? 4 : d <= C.BANDS[1] ? 3 : d <= C.BANDS[2] ? 2 : 0;
  };

  function game() {
    let target = -1; // host only
    /** @type {number[]} */
    let deck = [];

    /** @param {PartyState} st @param {PartyCtx} ctx */
    function round(st, ctx) {
      const order = st.order.filter((/** @type {string} */ id) => ctx.players.includes(id));
      if (st.r >= st.rounds || order.length < 2) {
        Object.assign(st, { phase: "end", deadline: 0, note: order.length < 2 ? "Not enough players left" : "" });
        ctx.secret = {};
        return;
      }
      if (!deck.length) deck = shuffle(PAIRS.map((_, i) => i), ctx.random);
      st.r += 1;
      st.giver = order[(st.r - 1) % order.length];
      st.card = /** @type {number} */ (deck.pop());
      target = 5 + Math.floor(ctx.random() * 91);
      ctx.secret = { [st.giver]: { target } };
      Object.assign(st, { phase: "clue", clue: "", dial: 50, target: -1, pts: 0, lockedBy: "", deadline: ctx.now() + C.CLUE_MS });
    }

    /** @param {PartyState} st @param {PartyCtx} ctx @param {string} by */
    function lock(st, ctx, by) {
      st.pts = points(st.dial, target);
      st.total += st.pts;
      Object.assign(st, { phase: "reveal", target, lockedBy: by, note: "", deadline: ctx.now() + C.REVEAL_MS });
      ctx.secret = {};
    }

    /** @type {PartyGame} */
    const g = {
      init: () => ({ phase: "lobby", deadline: 0, rounds: 8, r: 0, order: [], giver: "", card: 0, clue: "", dial: 50, target: -1, pts: 0, lockedBy: "", total: 0, note: "" }),
      intent(st, from, m, ctx) {
        const host = from === ctx.leader;
        const idle = st.phase === "lobby" || st.phase === "end";
        const guesser = ctx.players.includes(from) && from !== st.giver;
        if (m.k === "cfg" && host && idle && C.ROUNDS.includes(m.rounds)) {
          Object.assign(st, { rounds: m.rounds, phase: "lobby" });
          return true;
        }
        if (m.k === "again" && host && st.phase === "end") {
          st.phase = "lobby";
          return true;
        }
        if (m.k === "start" && host && idle) {
          if (ctx.players.length < 2) {
            st.note = "Needs at least 2 players";
            return true;
          }
          Object.assign(st, { order: shuffle(ctx.players, ctx.random), r: 0, total: 0, note: "" });
          round(st, ctx);
          return true;
        }
        if (m.k === "next" && host && st.phase === "reveal") {
          round(st, ctx);
          return true;
        }
        if (m.k === "clue" && st.phase === "clue" && from === st.giver && typeof m.text === "string") {
          const text = m.text.replace(/\s+/g, " ").trim().slice(0, C.MAX_CLUE);
          if (!text) return false;
          Object.assign(st, { phase: "guess", clue: text, deadline: ctx.now() + C.GUESS_MS });
          return true;
        }
        if (m.k === "dial" && st.phase === "guess" && guesser && isInt(m.v, 100) && m.v !== st.dial) {
          st.dial = m.v;
          return true;
        }
        if (m.k === "lock" && st.phase === "guess" && guesser) {
          lock(st, ctx, from);
          return true;
        }
        return false;
      },
      timeout(st, ctx) {
        if (st.phase === "clue") {
          st.note = "No clue in time, so that round was skipped";
          round(st, ctx);
        } else if (st.phase === "guess") lock(st, ctx, "");
        else if (st.phase === "reveal") round(st, ctx);
      },
      players(st, ctx) {
        if ((st.phase === "clue" || st.phase === "guess") && !ctx.players.includes(st.giver)) {
          st.note = "The clue-giver left, so that round was skipped";
          round(st, ctx);
          return true;
        }
        return false;
      },
      takeOver(st, ctx) {
        if (st.phase === "clue" || st.phase === "guess") Object.assign(st, { phase: "lobby", deadline: 0, note: "The host left, so the game ended" });
      },
    };
    return g;
  }

  return { game, PAIRS, points, C };
})();
globalThis.WaveCore = WaveCore;
