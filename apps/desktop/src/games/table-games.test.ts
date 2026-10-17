// The leader-hosted table (public/games/table-host.js) and the rules it runs: Crazy Eights and Werewolf.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../public/games/table-host.js'; // classic scripts: define the TableHost, EightsCore and WerewolfCore globals
import '../../public/games/crazy-eights/eights-core.js';
import '../../public/games/werewolf/werewolf-core.js';

type Msg = { from: string; to?: string; data: Record<string, unknown> };

/** Copies of one game on a fake relay: `pump` delivers everything sent so far, like the server (sender excluded). */
function table(ids: string[], leader: string, rules: TableRules, random = () => 0.5) {
  const queue: Msg[] = [];
  const sent: Msg[] = [];
  const make = (me: string) => TableHost.create({
    me, players: ids, leader, rules, random,
    send: (data, to) => {
      const m = { from: me, to, data: data as Record<string, unknown> };
      queue.push(m);
      sent.push(m);
    },
  });
  const copies = new Map(ids.map(me => [me, make(me)]));
  const pump = () => {
    while (queue.length) {
      const m = queue.shift()!;
      for (const [id, c] of copies) if (id !== m.from && (!m.to || m.to === id)) c.receive(m.data, m.from);
    }
  };
  const get = (id: string) => copies.get(id)!;
  /** A copy that (re)opens: a fresh frame for `me`. */
  const reopen = (me: string) => {
    copies.get(me)?.stop();
    copies.set(me, make(me));
    return copies.get(me)!;
  };
  return { copies, get, pump, sent, reopen, start: () => { for (const c of copies.values()) c.start(); pump(); } };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('TableHost', () => {
  it('the leader hosts; intents go to it; each hand goes only to its owner', () => {
    const t = table(['a', 'b', 'c'], 'a', EightsCore.rules);
    t.start();
    for (const id of ['a', 'b', 'c']) expect(t.get(id).view.pub).toMatchObject({ phase: 'lobby', seats: [] });
    for (const id of ['b', 'c', 'a']) t.get(id).act({ k: 'join' });
    t.pump();
    t.get('b').act({ k: 'start' });
    t.pump();
    expect(t.get('c').view.pub).toMatchObject({ phase: 'play', seats: ['a', 'b', 'c'], counts: [7, 7, 7] }); // the leader's own join lands first
    for (const id of ['a', 'b', 'c']) expect(t.get(id).view.priv.hand).toEqual(t.get('a').state.hands[id]);
    // Private views always travel addressed to their owner.
    const privs = t.sent.filter(m => m.data.t === 'priv' && m.data.s);
    expect(privs.length).toBeGreaterThan(0);
    for (const m of privs) expect((m.data.s as { hand: number[] }).hand).toEqual(t.get('a').state.hands[m.to!]);
  });

  it('a late copy asks the leader and gets the table and its own hand', () => {
    const t = table(['a', 'b'], 'a', EightsCore.rules);
    t.get('a').start();
    t.get('a').act({ k: 'join' });
    t.pump();
    t.get('b').start();
    t.pump();
    t.get('b').act({ k: 'join' });
    t.pump();
    t.get('a').act({ k: 'start' });
    t.pump();
    const late = t.reopen('b');
    late.start();
    t.pump();
    expect(late.view.pub.phase).toBe('play');
    expect(late.view.priv.hand).toHaveLength(7);
  });

  it('a new leader starts a fresh table at the lobby with the seats it knew, and the others get a note', () => {
    const t = table(['a', 'b', 'c'], 'a', EightsCore.rules);
    t.start();
    for (const id of ['a', 'b', 'c']) t.get(id).act({ k: 'join' });
    t.pump();
    t.get('a').act({ k: 'start' });
    t.pump();
    t.copies.delete('a');
    for (const id of ['b', 'c']) t.get(id).setPlayers(['b', 'c'], 'b');
    t.pump();
    for (const id of ['b', 'c']) {
      expect(t.get(id).view.pub).toMatchObject({ phase: 'lobby', seats: ['b', 'c'] });
      expect(t.get(id).view.note).toMatch(/round ended/);
      expect(t.get(id).view.priv).toBeNull();
    }
  });

  it("the leader's copy reopening mid-round restarts the table and seated players take their seats again", () => {
    const t = table(['a', 'b', 'c'], 'a', EightsCore.rules);
    t.start();
    for (const id of ['a', 'b', 'c']) t.get(id).act({ k: 'join' });
    t.pump();
    t.get('a').act({ k: 'start' });
    t.pump();
    t.reopen('a').start();
    t.pump(); // b and c see the new table, note it and send "join" back
    expect(t.get('b').view.note).toMatch(/round ended/);
    expect(t.get('a').state.seats).toEqual(['b', 'c']);
    expect(t.get('c').view.pub).toMatchObject({ phase: 'lobby', seats: ['b', 'c'] });
  });

  it('ignores pub/priv from anyone but the leader and junk from the relay', () => {
    const t = table(['a', 'b'], 'a', EightsCore.rules);
    t.start();
    const b = t.get('b');
    b.receive({ t: 'pub', e: 'x', v: 99, s: { phase: 'over', seats: [] } }, 'c');
    b.receive(null, 'a');
    b.receive({ t: 'pub', e: 1, v: 1, s: {} }, 'a');
    expect(b.view.pub.phase).toBe('lobby');
  });
});

describe('Crazy Eights rules', () => {
  const { face, playable, rules, SKIP, REV, DRAW2, WILD, WILD4 } = EightsCore;
  const ctx = { now: 0, random: () => 0.5 };

  /** A dealt game with chosen hands, top card and turn. */
  function game(hands: Record<string, number[]>, top: number, turn = 0) {
    const s = rules.init({ phase: 'lobby', seats: Object.keys(hands) }, ctx) as ReturnType<typeof EightsCore.rules.init>;
    rules.act(s, Object.keys(hands)[0]!, { k: 'start' }, ctx);
    Object.assign(s, { hands: structuredClone(hands), discard: [top], suit: face(top).s, turn, pile: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
    return s;
  }
  // Card ids: suit*25 + (0 for zero, 1-2 for ones, ... 19-20 skip, 21-22 reverse, 23-24 draw two), 100-103 wild, 104-107 wild four.
  const card = (suit: number, v: number) => suit * 25 + (v === 0 ? 0 : 1 + (v - 1) * 2);

  it('has 108 cards: 4 x 25 suited, 4 wilds and 4 wild draw fours', () => {
    const faces = Array.from({ length: 108 }, (_, i) => face(i));
    expect(faces.filter(f => f.s === 4 && f.v === WILD)).toHaveLength(4);
    expect(faces.filter(f => f.v === WILD4)).toHaveLength(4);
    for (const s of [0, 1, 2, 3]) {
      expect(faces.filter(f => f.s === s && f.v === 0)).toHaveLength(1);
      for (const v of [1, 9, SKIP, REV, DRAW2]) expect(faces.filter(f => f.s === s && f.v === v)).toHaveLength(2);
    }
    expect(face(card(2, 7))).toEqual({ s: 2, v: 7 });
    expect(playable(card(1, 7), card(2, 7), 2)).toBe(true);
    expect(playable(card(1, 6), card(2, 7), 2)).toBe(false);
    expect(playable(100, card(2, 7), 2)).toBe(true);
  });

  it('deals seven each and turns up a number card', () => {
    const s = rules.init({ phase: 'lobby', seats: ['a', 'b', 'c'] }, ctx) as never as { hands: Record<string, number[]>; discard: number[]; pile: number[] };
    expect(rules.act(s, 'a', { k: 'start' }, ctx)).toBe(true);
    expect(Object.values(s.hands).map(h => h.length)).toEqual([7, 7, 7]);
    expect(face(s.discard[0]!).v).toBeLessThanOrEqual(9);
    expect(s.pile.length + 21 + 1).toBe(108);
  });

  it('only the player whose turn it is plays a legal card; wilds need a suit', () => {
    const s = game({ a: [card(0, 5), card(1, 3), 100], b: [card(0, 1), card(0, 2)], c: [card(3, 3), card(3, 4)] }, card(0, 7));
    expect(rules.act(s, 'b', { k: 'play', card: card(0, 1) }, ctx)).toBe(false);
    expect(rules.act(s, 'a', { k: 'play', card: card(1, 3) }, ctx)).toBe(false);
    expect(rules.act(s, 'a', { k: 'play', card: 100 }, ctx)).toBe(false);
    expect(rules.act(s, 'a', { k: 'play', card: 100, suit: 3 }, ctx)).toBe(true);
    expect(s.suit).toBe(3);
    expect(s.seats[s.turn]).toBe('b');
    expect(rules.act(s, 'b', { k: 'play', card: card(0, 1) }, ctx)).toBe(false); // suit is now 3
  });

  it('skip, reverse, draw two and wild draw four', () => {
    let s = game({ a: [card(0, SKIP), card(0, 1)], b: [card(2, 2), card(2, 3)], c: [card(3, 3), card(3, 4)] }, card(0, 7));
    rules.act(s, 'a', { k: 'play', card: card(0, SKIP) }, ctx);
    expect(s.seats[s.turn]).toBe('c');
    s = game({ a: [card(0, REV), card(0, 1)], b: [card(2, 2), card(2, 3)], c: [card(3, 3), card(3, 4)] }, card(0, 7));
    rules.act(s, 'a', { k: 'play', card: card(0, REV) }, ctx);
    expect([s.dir, s.seats[s.turn]]).toEqual([-1, 'c']);
    s = game({ a: [card(0, REV), card(0, 1)], b: [card(2, 2), card(2, 3)] }, card(0, 7));
    rules.act(s, 'a', { k: 'play', card: card(0, REV) }, ctx);
    expect(s.seats[s.turn]).toBe('a'); // a skip with two players
    s = game({ a: [card(0, DRAW2), card(0, 1)], b: [card(2, 2), card(2, 3)], c: [card(3, 3), card(3, 4)] }, card(0, 7));
    rules.act(s, 'a', { k: 'play', card: card(0, DRAW2) }, ctx);
    expect([s.hands.b!.length, s.seats[s.turn]]).toEqual([4, 'c']);
    s = game({ a: [104, card(0, 1)], b: [card(2, 2), card(2, 3)], c: [card(3, 3), card(3, 4)] }, card(0, 7));
    rules.act(s, 'a', { k: 'play', card: 104, suit: 1 }, ctx);
    expect([s.hands.b!.length, s.seats[s.turn], s.suit]).toEqual([6, 'c', 1]);
  });

  it('draw: a playable card may be played (only that one) or kept with pass; an unplayable one passes the turn', () => {
    const s = game({ a: [card(1, 1), card(1, 2)], b: [card(2, 2), card(2, 3)] }, card(0, 7));
    s.pile = [card(0, 4)];
    rules.act(s, 'a', { k: 'draw' }, ctx);
    expect(rules.pub(s, ctx)).toMatchObject({ turn: 'a', drew: true });
    expect(rules.priv(s, 'a', ctx)).toMatchObject({ drawn: card(0, 4) });
    expect(rules.act(s, 'a', { k: 'draw' }, ctx)).toBe(false);
    expect(rules.act(s, 'a', { k: 'pass' }, ctx)).toBe(true);
    expect(s.seats[s.turn]).toBe('b');
    s.pile = [card(1, 9)];
    rules.act(s, 'b', { k: 'draw' }, ctx);
    expect([s.seats[s.turn], s.hands.b!.length]).toEqual(['a', 3]);
  });

  it('the draw pile is reshuffled from the discards when it runs out', () => {
    const s = game({ a: [card(1, 1), card(1, 2)], b: [card(2, 2), card(2, 3)] }, card(0, 7));
    s.pile = [];
    s.discard = [card(3, 5), card(3, 6), card(0, 7)];
    rules.act(s, 'a', { k: 'draw' }, ctx);
    expect(s.discard).toEqual([card(0, 7)]);
    expect(s.hands.a!.length + s.pile.length).toBe(4);
  });

  it('last card: an uncalled single card can be caught for two until the next player acts', () => {
    let s = game({ a: [card(0, 1), card(0, 2)], b: [card(2, 2), card(2, 3)], c: [card(3, 3), card(3, 4)] }, card(0, 7));
    rules.act(s, 'a', { k: 'play', card: card(0, 1) }, ctx);
    expect(s.exposed).toBe('a');
    expect(rules.act(s, 'a', { k: 'catch', who: 'a' }, ctx)).toBe(false);
    expect(rules.act(s, 'c', { k: 'catch', who: 'a' }, ctx)).toBe(true);
    expect(s.hands.a).toHaveLength(3);
    // Called in time: nothing to catch.
    s = game({ a: [card(0, 1), card(0, 2)], b: [card(2, 2), card(2, 3)], c: [card(3, 3), card(3, 4)] }, card(0, 7));
    rules.act(s, 'a', { k: 'last' }, ctx);
    rules.act(s, 'a', { k: 'play', card: card(0, 1) }, ctx);
    expect(s.exposed).toBe('');
    // Calling right after playing still counts; the next player's move closes the window.
    s = game({ a: [card(0, 1), card(0, 2)], b: [card(2, 2), card(0, 3)], c: [card(3, 3), card(3, 4)] }, card(0, 7));
    rules.act(s, 'a', { k: 'play', card: card(0, 1) }, ctx);
    rules.act(s, 'b', { k: 'play', card: card(0, 3) }, ctx);
    expect(rules.act(s, 'c', { k: 'catch', who: 'a' }, ctx)).toBe(false);
  });

  it('the first out of cards wins; "again" goes back to the lobby with the seats and the score', () => {
    const s = game({ a: [card(0, 1)], b: [card(2, 2), card(2, 3)] }, card(0, 7));
    rules.act(s, 'a', { k: 'play', card: card(0, 1) }, ctx);
    expect(rules.pub(s, ctx)).toMatchObject({ phase: 'over', winner: 'a', wins: { a: 1 } });
    rules.act(s, 'b', { k: 'again' }, ctx);
    expect(rules.pub(s, ctx)).toMatchObject({ phase: 'lobby', seats: ['a', 'b'], wins: { a: 1 } });
  });

  it('a player who leaves loses their seat, their cards go back, the turn moves on; one left wins', () => {
    const s = game({ a: [card(1, 1), card(1, 2)], b: [card(2, 2), card(2, 3)], c: [card(3, 3), card(3, 4)] }, card(0, 7), 1);
    const pile = s.pile.length;
    expect(rules.left(s, ['a', 'c'], ctx)).toBe(true);
    expect([s.seats, s.seats[s.turn], s.pile.length]).toEqual([['a', 'c'], 'c', pile + 2]);
    rules.left(s, ['a'], ctx);
    expect(rules.pub(s, ctx)).toMatchObject({ phase: 'over', winner: 'a' });
  });

  it('views stay under the relay limit with ten players', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `${'x'.repeat(21)}${i}`);
    const s = rules.init({ phase: 'lobby', seats: ids }, ctx);
    rules.act(s, ids[0]!, { k: 'start' }, ctx);
    (s as { hands: Record<string, number[]> }).hands[ids[0]!] = Array.from({ length: 60 }, (_, i) => i + 40);
    for (let i = 0; i < 6; i++) rules.act(s, ids[0]!, { k: 'last' }, ctx);
    (s as { wins: Record<string, number> }).wins = Object.fromEntries(ids.map(id => [id, 99]));
    const msg = (v: unknown) => JSON.stringify({ t: 'pub', e: 'abcdefghijklmnop', v: 99999, s: v }).length;
    expect(msg(rules.pub(s, ctx))).toBeLessThan(TableHost.MAX_BYTES);
    expect(msg(rules.priv(s, ids[0]!, ctx))).toBeLessThan(TableHost.MAX_BYTES);
  });
});

describe('Werewolf rules', () => {
  const { rules, C, wolvesFor } = WerewolfCore;
  const tick = rules.tick!;
  type S = { phase: string; roles: Record<string, string>; dead: string[]; seats: string[]; seerLog: [string, boolean][]; winner: string; shooter: string; deadline: number; news: string[] };
  const ctx = { now: 1000, random: () => 0.5 };
  const later = (secs: number) => ({ now: ctx.now + secs * 1000 + 1, random: ctx.random });

  /** A night-1 game with chosen roles. */
  function game(roles: Record<string, string>, hunter = false): S {
    const s = rules.init({ phase: 'lobby', seats: Object.keys(roles) }, ctx) as S;
    rules.act(s, Object.keys(roles)[0]!, { k: 'hunter', on: hunter }, ctx);
    rules.act(s, Object.keys(roles)[0]!, { k: 'start' }, ctx);
    s.roles = { ...roles };
    return s;
  }
  const five = { w: 'werewolf', s: 'seer', d: 'doctor', v1: 'villager', v2: 'villager' };

  it('deals 1/2/3 wolves by size, one seer and doctor, the hunter only when on', () => {
    expect([5, 6, 7, 11, 12, 16].map(wolvesFor)).toEqual([1, 1, 2, 2, 3, 3]);
    for (const [n, hunter] of [[5, false], [9, true], [16, true]] as const) {
      const ids = Array.from({ length: n }, (_, i) => `p${i}`);
      const s = rules.init({ phase: 'lobby', seats: ids }, ctx) as S;
      rules.act(s, 'p0', { k: 'hunter', on: hunter }, ctx);
      rules.act(s, 'p0', { k: 'start' }, ctx);
      const roles = Object.values(s.roles);
      expect(roles.filter(r => r === 'werewolf')).toHaveLength(wolvesFor(n));
      expect(roles.filter(r => r === 'seer')).toHaveLength(1);
      expect(roles.filter(r => r === 'doctor')).toHaveLength(1);
      expect(roles.filter(r => r === 'hunter')).toHaveLength(hunter ? 1 : 0);
      expect(s.phase).toBe('night');
    }
    const small = rules.init({ phase: 'lobby', seats: ['a', 'b', 'c', 'd'] }, ctx);
    expect(rules.act(small, 'a', { k: 'start' }, ctx)).toBe(false);
  });

  it('a night: the wolf kills, the seer learns privately, roles stay hidden from the living', () => {
    const s = game(five);
    expect(rules.act(s, 'v1', { k: 'pick', target: 'v2' }, ctx)).toBe(false); // villagers have no night action
    expect(rules.act(s, 'w', { k: 'pick', target: 'v1' }, ctx)).toBe(true);
    expect(rules.act(s, 's', { k: 'pick', target: 'w' }, ctx)).toBe(true);
    expect(rules.act(s, 'd', { k: 'pick', target: 'd' }, ctx)).toBe(true); // everyone picked: dawn
    expect(s.phase).toBe('day');
    expect(rules.pub(s, ctx)).toMatchObject({ dead: ['v1'], reveal: { v1: 'villager' }, news: ['v1'], day: 1 });
    expect(rules.priv(s, 's', ctx)).toMatchObject({ role: 'seer', seerLog: [['w', true]] });
    expect(rules.priv(s, 'v2', ctx)).toEqual({ role: 'villager' });
    expect(JSON.stringify(rules.pub(s, ctx))).not.toContain('werewolf');
    expect(rules.priv(s, 'w', ctx)).toMatchObject({ role: 'werewolf', wolves: ['w'] });
    // The dead see everything.
    expect(rules.priv(s, 'v1', ctx)).toMatchObject({ all: five });
    expect(rules.priv(s, 'stranger', ctx)).toBeNull();
  });

  it('the doctor saves the victim, but not the same player two nights running', () => {
    const s = game(five);
    rules.act(s, 'w', { k: 'pick', target: 'v1' }, ctx);
    rules.act(s, 's', { k: 'pick', target: 'v2' }, ctx);
    rules.act(s, 'd', { k: 'pick', target: 'v1' }, ctx);
    expect([s.phase, s.dead]).toEqual(['day', []]);
    tick(s, later(C.DAY));
    expect(s.phase).toBe('vote');
    tick(s, later(C.DAY + C.VOTE + 1));
    expect(s.phase).toBe('night');
    expect(rules.act(s, 'd', { k: 'pick', target: 'v1' }, ctx)).toBe(false);
  });

  it('the vote: a strict majority eliminates at once and the village wins when the last wolf goes', () => {
    const s = game(five);
    tick(s, later(C.NIGHT)); // nobody picked: nobody dies
    expect([s.phase, s.dead]).toEqual(['day', []]);
    for (const id of ['w', 's', 'd', 'v1', 'v2']) rules.act(s, id, { k: 'ready' }, ctx);
    expect(s.phase).toBe('vote');
    rules.act(s, 's', { k: 'vote', target: 'w' }, ctx);
    rules.act(s, 'd', { k: 'vote', target: 'w' }, ctx);
    expect(rules.pub(s, ctx)).toMatchObject({ votes: { s: 'w', d: 'w' } });
    rules.act(s, 'v1', { k: 'vote', target: 'w' }, ctx); // 3 of 5
    expect(rules.pub(s, ctx)).toMatchObject({ phase: 'over', winner: 'village', dead: ['w'], causes: { w: 'vote' } });
    expect((rules.pub(s, ctx) as unknown as { reveal: unknown }).reveal).toEqual(five);
  });

  it('no majority by the deadline: nobody is eliminated; the wolves win at parity', () => {
    const s = game(five);
    rules.act(s, 'w', { k: 'pick', target: 'v1' }, ctx);
    tick(s, later(C.NIGHT));
    tick(s, later(C.NIGHT + C.DAY));
    rules.act(s, 'w', { k: 'vote', target: 'v2' }, ctx);
    rules.act(s, 's', { k: 'vote', target: '' }, ctx);
    tick(s, later(C.NIGHT + C.DAY + C.VOTE + 1));
    expect([s.phase, s.dead]).toEqual(['night', ['v1']]);
    rules.act(s, 'w', { k: 'pick', target: 's' }, ctx);
    tick(s, later(2 * C.NIGHT + C.DAY + C.VOTE + 2));
    tick(s, later(2 * C.NIGHT + 2 * C.DAY + C.VOTE + 2));
    for (const id of ['w', 'd']) rules.act(s, id, { k: 'vote', target: 'v2' }, ctx); // 2 of 3
    expect(rules.pub(s, ctx)).toMatchObject({ phase: 'over', winner: 'wolves' });
  });

  it('a hunter who dies shoots someone before the game goes on', () => {
    const s = game({ w1: 'werewolf', w2: 'werewolf', s: 'seer', d: 'doctor', h: 'hunter', v1: 'villager', v2: 'villager' }, true);
    rules.act(s, 'w1', { k: 'pick', target: 'h' }, ctx);
    rules.act(s, 'w2', { k: 'pick', target: 'h' }, ctx);
    rules.act(s, 's', { k: 'pick', target: 'v1' }, ctx);
    rules.act(s, 'd', { k: 'pick', target: 'v1' }, ctx);
    expect(rules.pub(s, ctx)).toMatchObject({ phase: 'hunter', shooter: 'h', reveal: { h: 'hunter' } });
    expect(rules.act(s, 'v1', { k: 'shoot', target: 'w1' }, ctx)).toBe(false);
    expect(rules.act(s, 'h', { k: 'shoot', target: 'w1' }, ctx)).toBe(true);
    expect(rules.pub(s, ctx)).toMatchObject({ phase: 'day', dead: ['h', 'w1'], news: ['h', 'w1'], causes: { w1: 'hunter' } });
  });

  it('wolves must agree to end the night early; on time out the most picked dies', () => {
    const s = game({ w1: 'werewolf', w2: 'werewolf', s: 'seer', d: 'doctor', v1: 'villager', v2: 'villager', v3: 'villager' });
    rules.act(s, 'w1', { k: 'pick', target: 'v1' }, ctx);
    rules.act(s, 'w2', { k: 'pick', target: 'v2' }, ctx);
    rules.act(s, 's', { k: 'pick', target: 'v3' }, ctx);
    rules.act(s, 'd', { k: 'pick', target: 'd' }, ctx);
    expect(s.phase).toBe('night');
    expect(rules.priv(s, 'w2', ctx)).toMatchObject({ wolves: ['w1', 'w2'], wolf: { w1: 'v1', w2: 'v2' } });
    expect(rules.act(s, 'w1', { k: 'pick', target: 'w2' }, ctx)).toBe(false); // not a fellow wolf
    tick(s, later(C.NIGHT));
    expect(s.dead).toHaveLength(1);
    expect(['v1', 'v2']).toContain(s.dead[0]);
  });

  it('a player who leaves dies and is revealed; the dead cannot act', () => {
    const s = game(five);
    expect(rules.left(s, ['s', 'd', 'v1', 'v2'], ctx)).toBe(true);
    expect(rules.pub(s, ctx)).toMatchObject({ phase: 'over', winner: 'village', causes: { w: 'left' } });
    const t = game(five);
    rules.left(t, ['w', 's', 'd', 'v2'], ctx);
    expect(rules.act(t, 'v1', { k: 'ready' }, ctx)).toBe(false);
    expect(t.phase).toBe('night');
  });

  it('views stay under the relay limit with sixteen players', () => {
    const ids = Array.from({ length: 16 }, (_, i) => `${'x'.repeat(20)}${String(i).padStart(2, '0')}`);
    const s = rules.init({ phase: 'lobby', seats: ids }, ctx) as S;
    rules.act(s, ids[0]!, { k: 'start' }, ctx);
    s.dead = ids.slice(0, 7);
    s.news = ids.slice(0, 7);
    (s as unknown as { causes: Record<string, string> }).causes = Object.fromEntries(ids.map(id => [id, 'wolves']));
    s.phase = 'vote';
    (s as unknown as { votes: Record<string, string> }).votes = Object.fromEntries(ids.map(id => [id, id]));
    const msg = (v: unknown) => JSON.stringify({ t: 'pub', e: 'abcdefghijklmnop', v: 99999, s: v }).length;
    expect(msg(rules.pub(s, ctx))).toBeLessThan(TableHost.MAX_BYTES);
    expect(msg(rules.priv(s, ids[0]!, ctx))).toBeLessThan(TableHost.MAX_BYTES);
  });
});
