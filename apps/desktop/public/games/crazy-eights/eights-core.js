// @ts-check
/*
 * Crazy Eights rules for TableHost (../table-host.js), no DOM; tests in src/games/crazy-eights.test.ts.
 * Rule flow after guilhermebkel/uno-game (MIT), our own code and card design.
 *
 * 108 cards, ids 0..107: four suits (0..3) of 25 (one 0, two each of 1-9, skip, reverse, draw two), then four wilds
 * and four wild draw fours. Match the top card's suit or value, or play a wild and name a suit. No playable card: draw
 * one; if that card is playable you may play it, else the turn passes. Skip, reverse (a skip with two players), draw two
 * and wild draw four (the next player draws and loses their turn) work as usual; no stacking. Going down to one card
 * without calling "last card" leaves you exposed until the next player acts: anyone may catch you for two cards.
 * The first player out of cards wins the round.
 *
 * Intents: {k:"join"} {k:"leave"} {k:"start"} {k:"play", card, suit?} {k:"draw"} {k:"pass"} {k:"last"}
 *          {k:"catch", who} {k:"again"}
 */

/**
 * @typedef {{ s: number, v: number }} Face  s: suit 0..3, 4 = wild; v: 0-9, SKIP, REV, DRAW2, WILD, WILD4
 * @typedef {{ k: string, by: string, card?: number, suit?: number, n?: number, who?: string }} EightsEvent
 * @typedef {{
 *   phase: "lobby" | "play" | "over", seats: string[], hands: Record<string, number[]>, pile: number[], discard: number[],
 *   suit: number, turn: number, dir: number, drawn: number, exposed: string, called: string[], winner: string,
 *   wins: Record<string, number>, log: EightsEvent[],
 * }} EightsState
 */

var EightsCore = (() => {
  const SKIP = 10;
  const REV = 11;
  const DRAW2 = 12;
  const WILD = 13;
  const WILD4 = 14;
  const C = { HAND: 7, MIN: 2, MAX: 10, DECK: 108, LOG: 6, CATCH: 2 };

  /** @param {number} id @returns {Face} */
  function face(id) {
    if (id >= 100) return { s: 4, v: id < 104 ? WILD : WILD4 };
    const r = id % 25;
    return { s: Math.floor(id / 25), v: r === 0 ? 0 : 1 + Math.floor((r - 1) / 2) };
  }

  /** @param {number} card @param {number} top @param {number} suit */
  function playable(card, top, suit) {
    const f = face(card);
    return f.s === 4 || f.s === suit || f.v === face(top).v;
  }

  /** @param {unknown} v @param {number} max @returns {v is number} */
  const isInt = (v, max) => Number.isInteger(v) && /** @type {number} */ (v) >= 0 && /** @type {number} */ (v) <= max;

  /** @param {{ seats: string[] } | null} prev @returns {EightsState} */
  function init(prev) {
    return {
      phase: "lobby", seats: prev ? prev.seats.slice(0, C.MAX) : [], hands: {}, pile: [], discard: [], suit: 0, turn: 0, dir: 1,
      drawn: -1, exposed: "", called: [], winner: "", wins: {}, log: [],
    };
  }

  /** @param {EightsState} s @param {EightsEvent} e */
  function log(s, e) {
    s.log.push(e);
    if (s.log.length > C.LOG) s.log.shift();
  }

  /** One card off the pile, reshuffling the discards under the top card when it runs out. @param {EightsState} s @param {() => number} random */
  function take(s, random) {
    if (!s.pile.length && s.discard.length > 1) {
      const top = /** @type {number} */ (s.discard.pop());
      s.pile = TableHost.shuffle(s.discard, random);
      s.discard = [top];
    }
    return s.pile.pop();
  }

  /** @param {EightsState} s @param {string} id @param {number} n @param {() => number} random */
  function give(s, id, n, random) {
    for (let i = 0; i < n; i++) {
      const c = take(s, random);
      if (c === undefined) break;
      s.hands[id].push(c);
    }
    s.called = s.called.filter((x) => x !== id);
  }

  /** @param {EightsState} s @param {number} steps */
  function advance(s, steps) {
    const n = s.seats.length;
    s.turn = (((s.turn + s.dir * steps) % n) + n) % n;
    s.drawn = -1;
  }

  const nextSeat = (/** @type {EightsState} */ s) => s.seats[(((s.turn + s.dir) % s.seats.length) + s.seats.length) % s.seats.length];

  /** @param {EightsState} s @param {() => number} random */
  function deal(s, random) {
    const deck = TableHost.shuffle(Array.from({ length: C.DECK }, (_, i) => i), random);
    s.hands = {};
    for (const id of s.seats) s.hands[id] = deck.splice(0, C.HAND);
    // The first card up is a number card; anything else goes back under the pile.
    const i = deck.findIndex((c) => face(c).v <= 9);
    const [first] = deck.splice(i, 1);
    s.pile = deck;
    s.discard = [first];
    s.suit = face(first).s;
    s.turn = Math.floor(random() * s.seats.length);
    Object.assign(s, { phase: "play", dir: 1, drawn: -1, exposed: "", called: [], winner: "", log: [] });
  }

  /** @param {EightsState} s @param {string} id */
  function win(s, id) {
    s.phase = "over";
    s.winner = id;
    s.wins[id] = (s.wins[id] ?? 0) + 1;
    s.exposed = "";
  }

  /** @param {EightsState} s @param {string} from @param {any} a @param {{ random: () => number }} ctx */
  function act(s, from, a, ctx) {
    const seated = s.seats.includes(from);
    const turn = s.phase === "play" && s.seats[s.turn] === from;
    const hand = s.hands[from];
    switch (a.k) {
      case "join":
        if (s.phase !== "lobby" || seated || s.seats.length >= C.MAX) return false;
        s.seats.push(from);
        return true;
      case "leave":
        if (s.phase !== "lobby" || !seated) return false;
        s.seats = s.seats.filter((x) => x !== from);
        return true;
      case "start":
        if (s.phase !== "lobby" || !seated || s.seats.length < C.MIN) return false;
        deal(s, ctx.random);
        return true;
      case "again":
        if (s.phase !== "over" || !seated) return false;
        Object.assign(s, { phase: "lobby", hands: {}, pile: [], discard: [], log: [], winner: "" });
        return true;
      case "play": {
        if (!turn || !isInt(a.card, C.DECK - 1) || !hand.includes(a.card)) return false;
        if (s.drawn >= 0 && a.card !== s.drawn) return false;
        const top = s.discard[s.discard.length - 1];
        if (!playable(a.card, top, s.suit)) return false;
        const f = face(a.card);
        if (f.s === 4 && !isInt(a.suit, 3)) return false;
        if (s.exposed !== from) s.exposed = "";
        hand.splice(hand.indexOf(a.card), 1);
        s.discard.push(a.card);
        s.suit = f.s === 4 ? a.suit : f.s;
        log(s, f.s === 4 ? { k: "play", by: from, card: a.card, suit: a.suit } : { k: "play", by: from, card: a.card });
        if (!hand.length) {
          win(s, from);
          return true;
        }
        if (hand.length === 1 && !s.called.includes(from)) s.exposed = from;
        if (hand.length > 1) s.called = s.called.filter((x) => x !== from);
        const two = s.seats.length === 2;
        if (f.v === REV) s.dir = -s.dir;
        if (f.v === DRAW2 || f.v === WILD4) {
          const victim = nextSeat(s);
          const n = f.v === DRAW2 ? 2 : 4;
          give(s, victim, n, ctx.random);
          log(s, { k: "draw", by: victim, n });
          advance(s, 2);
        } else advance(s, f.v === SKIP || (f.v === REV && two) ? 2 : 1);
        return true;
      }
      case "draw": {
        if (!turn || s.drawn >= 0) return false;
        if (s.exposed !== from) s.exposed = "";
        const c = take(s, ctx.random);
        log(s, { k: "draw", by: from, n: c === undefined ? 0 : 1 });
        if (c === undefined) {
          advance(s, 1);
          return true;
        }
        hand.push(c);
        s.called = s.called.filter((x) => x !== from);
        if (playable(c, s.discard[s.discard.length - 1], s.suit)) s.drawn = c;
        else advance(s, 1);
        return true;
      }
      case "pass":
        if (!turn || s.drawn < 0) return false;
        advance(s, 1);
        return true;
      case "last":
        if (s.phase !== "play" || !hand || hand.length > 2 || s.called.includes(from)) return false;
        s.called.push(from);
        if (s.exposed === from) s.exposed = "";
        log(s, { k: "last", by: from });
        return true;
      case "catch": {
        if (s.phase !== "play" || !seated || typeof a.who !== "string" || a.who === from || s.exposed !== a.who) return false;
        s.exposed = "";
        give(s, a.who, C.CATCH, ctx.random);
        log(s, { k: "catch", by: from, who: a.who });
        return true;
      }
    }
    return false;
  }

  /** Players who left the call lose their seat; their cards go back into the pile. @param {EightsState} s @param {string[]} present */
  function left(s, present, ctx = { random: Math.random }) {
    const gone = s.seats.filter((id) => !present.includes(id));
    for (const id of gone) {
      const i = s.seats.indexOf(id);
      s.seats.splice(i, 1);
      if (s.phase !== "play") continue;
      s.pile = TableHost.shuffle(s.pile.concat(s.hands[id] ?? []), ctx.random);
      delete s.hands[id];
      if (s.exposed === id) s.exposed = "";
      s.called = s.called.filter((x) => x !== id);
      log(s, { k: "left", by: id });
      if (s.seats.length < C.MIN) {
        if (s.seats.length) win(s, s.seats[0]);
        else s.phase = "over";
        continue;
      }
      if (i === s.turn) s.drawn = -1;
      if (i < s.turn || (i === s.turn && s.dir < 0)) s.turn -= 1;
      s.turn = ((s.turn % s.seats.length) + s.seats.length) % s.seats.length;
    }
    return gone.length > 0;
  }

  /** @param {EightsState} s */
  function pub(s) {
    return {
      phase: s.phase, seats: s.seats, counts: s.seats.map((id) => s.hands[id]?.length ?? 0), top: s.discard[s.discard.length - 1] ?? -1,
      suit: s.suit, turn: s.phase === "play" ? s.seats[s.turn] : "", dir: s.dir, drew: s.drawn >= 0, pile: s.pile.length,
      exposed: s.exposed, called: s.called, winner: s.winner, wins: s.wins, log: s.log,
    };
  }

  /** @param {EightsState} s @param {string} id */
  function priv(s, id) {
    const hand = s.hands[id];
    return hand ? { hand, drawn: s.seats[s.turn] === id ? s.drawn : -1 } : null;
  }

  /** @type {TableRules} */
  const rules = { init, act, left, pub, priv };
  return { rules, face, playable, C, SKIP, REV, DRAW2, WILD, WILD4 };
})();
globalThis.EightsCore = EightsCore;
