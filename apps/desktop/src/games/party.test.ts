// The party games (public/games/party-host.js + trivia, whos-the-spy, same-wave cores): host sync, private info and rules.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../public/games/party-host.js'; // classic scripts: define the PartyHost, TriviaCore, SpyCore and WaveCore globals
import '../../public/games/trivia/trivia-core.js';
import '../../public/games/whos-the-spy/spy-core.js';
import '../../public/games/same-wave/wave-core.js';

type Msg = { from: string; data: Record<string, unknown>; to?: string };

/** Copies of one game on a relay that delivers when pumped (the sender never gets its own messages). */
function net(ids: string[], leader: string, makeGame: () => PartyGame, rand = () => 0) {
  const queue: Msg[] = [];
  const log: Msg[] = [];
  const open = new Set(ids);
  const copies: Record<string, ReturnType<typeof PartyHost.create>> = {};
  const add = (id: string, players = ids, lead = leader) => {
    open.add(id);
    copies[id] = PartyHost.create({
      me: id, players, leader: lead, game: makeGame(), random: rand,
      send: (data, to) => {
        const m = { from: id, data: data as Record<string, unknown>, to };
        queue.push(m);
        log.push(m);
      },
    });
    return copies[id];
  };
  for (const id of ids) add(id);
  const pump = () => {
    while (queue.length) {
      const m = queue.shift()!;
      for (const id of open) if (id !== m.from && (!m.to || m.to === id)) copies[id].receive(m.data, m.from);
    }
  };
  const close = (id: string) => {
    copies[id].stop();
    open.delete(id);
  };
  /** Everyone starts, the host's copy gives up waiting after one try and broadcasts a fresh lobby. */
  const boot = async () => {
    for (const id of ids) copies[id].start();
    pump();
    await vi.advanceTimersByTimeAsync(2001);
    pump();
    await vi.advanceTimersByTimeAsync(200);
    pump();
  };
  /** Let the host's coalesced broadcast go out and be delivered. */
  const settle = async (ms = 200) => {
    pump();
    await vi.advanceTimersByTimeAsync(ms);
    pump();
  };
  return { copies, add, close, pump, boot, settle, log, queue };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const BANK: TriviaBank = {
  cats: ['Science', 'History'],
  q: [
    [0, 0, 'Water boils at?', '100 C', '50 C', '80 C', '120 C'],
    [0, 1, 'H2O is?', 'Water', 'Salt', 'Air', 'Gold'],
    [1, 0, 'First moon landing year?', '1969', '1959', '1979', '1989'],
    [1, 2, 'True or false?', 'True', 'False'],
  ],
};

describe('PartyHost', () => {
  it('a late joiner gets the state and its own private info, and nothing goes over 4 KB', async () => {
    const n = net(['a', 'b', 'c'], 'a', () => SpyCore.game());
    await n.boot();
    expect(n.copies.b.view.st?.phase).toBe('lobby');
    n.copies.a.act({ k: 'start' });
    await n.settle();
    expect(n.copies.b.view.st?.phase).toBe('play');
    const roles = ['a', 'b', 'c'].map(id => n.copies[id].view.mine);
    expect(roles.filter(r => r?.spy)).toHaveLength(1);

    // c closes and reopens: it asks, and the host sends the public state and c's role again.
    const before = n.copies.c.view.mine;
    n.close('c');
    const c2 = n.add('c');
    c2.start();
    expect(c2.view.syncing).toBe(true);
    n.pump();
    expect(c2.view.syncing).toBe(false);
    expect(c2.view.st?.phase).toBe('play');
    expect(c2.view.mine).toEqual(before);
    for (const m of n.log) expect(JSON.stringify(m.data).length).toBeLessThan(4096);
  });

  it('only the host learns intents; non-host copies ignore states from non-hosts', async () => {
    const n = net(['a', 'b'], 'a', () => WaveCore.game());
    await n.boot();
    n.copies.b.receive({ t: 's', v: 99, st: { phase: 'end', left: 0 } }, 'c');
    expect(n.copies.b.view.st?.phase).toBe('lobby');
    n.copies.b.act({ k: 'start' }); // not the host
    await n.settle();
    expect(n.copies.a.view.st?.phase).toBe('lobby');
    expect(n.log.some(m => m.from === 'b' && m.to === 'a' && m.data.t === 'i')).toBe(true);
  });

  it('a reopened host takes the public state from the others and carries on', async () => {
    const n = net(['a', 'b'], 'a', () => TriviaCore.game(BANK));
    await n.boot();
    n.copies.a.act({ k: 'start' });
    await n.settle();
    n.copies.b.act({ k: 'ans', i: 0, c: 0 });
    await n.settle();
    n.close('a');
    const a2 = n.add('a');
    a2.start();
    n.pump();
    expect(a2.view.st?.phase).toBe('q');
    expect(a2.view.st?.answered).toEqual([]); // answers were lost with the old copy; the question runs again
    expect(a2.view.st?.qs).toEqual(n.copies.b.view.st?.qs);
  });

  it('broadcasts at most every MIN_GAP_MS while the dial moves', async () => {
    const n = net(['a', 'b', 'c'], 'a', () => WaveCore.game(), () => 0.5);
    await n.boot();
    n.copies.a.act({ k: 'start' });
    await n.settle();
    const giver = n.copies.a.view.st!.giver as string;
    n.copies[giver].act({ k: 'clue', text: 'Lukewarm' });
    await n.settle();
    const guesser = ['a', 'b', 'c'].find(id => id !== giver)!;
    const sent = n.log.length;
    for (let v = 0; v < 30; v++) {
      n.copies[guesser].act({ k: 'dial', v });
      n.pump();
      await vi.advanceTimersByTimeAsync(10);
    }
    await n.settle();
    const states = n.log.slice(sent).filter(m => m.from === 'a' && m.data.t === 's').length;
    expect(states).toBeLessThanOrEqual(4);
    expect(n.copies.c.view.st?.dial).toBe(29);
  });
});

describe('Trivia', () => {
  it('scores right answers by speed, reveals picks only after everyone answered, then ends', async () => {
    const n = net(['a', 'b'], 'a', () => TriviaCore.game(BANK));
    await n.boot();
    n.copies.a.act({ k: 'cfg', cat: 0, diff: -1, len: 5 });
    n.copies.a.act({ k: 'start' });
    await n.settle();
    const st = () => n.copies.b.view.st!;
    expect(st()).toMatchObject({ phase: 'q', i: 0 });
    expect(st().qs).toHaveLength(2); // only two science questions
    const right = (st().ord as number[]).indexOf(0);
    n.copies.a.act({ k: 'ans', i: 0, c: right });
    await n.settle();
    expect(st().answered).toEqual(['a']);
    expect(st().picks).toEqual({}); // hidden until the reveal
    await vi.advanceTimersByTimeAsync(10_000);
    n.copies.b.act({ k: 'ans', i: 0, c: (right + 1) % 4 });
    await n.settle();
    expect(st().phase).toBe('reveal');
    expect(st().gain).toEqual({ a: 995, b: 0 }); // answered 200 ms in: 500 + 500 * 19.8 / 20
    await n.settle(5000); // next question
    expect(st()).toMatchObject({ phase: 'q', i: 1 });
    await n.settle(20_000); // nobody answers
    expect(st().phase).toBe('reveal');
    await n.settle(5000);
    expect(st().phase).toBe('end');
    expect(st().scores).toEqual({ a: 995 });
  });

  it('ignores answers from non-players, twice, or for another question; only the host configures', async () => {
    const n = net(['a', 'b'], 'a', () => TriviaCore.game(BANK));
    await n.boot();
    n.copies.b.act({ k: 'cfg', cat: 1, diff: -1, len: 5 });
    await n.settle();
    expect(n.copies.a.view.st?.cat).toBe(-1);
    n.copies.a.act({ k: 'start' });
    await n.settle();
    const host = n.copies.a;
    host.receive({ t: 'i', k: 'ans', i: 0, c: 0 }, 'zz');
    host.receive({ t: 'i', k: 'ans', i: 3, c: 0 }, 'b');
    host.receive({ t: 'i', k: 'ans', i: 0, c: 9 }, 'b');
    expect(host.view.st?.answered).toEqual([]);
    host.receive({ t: 'i', k: 'ans', i: 0, c: 0 }, 'b');
    host.receive({ t: 'i', k: 'ans', i: 0, c: 1 }, 'b');
    expect(host.view.st?.answered).toEqual(['b']);
  });

  it('says so when no question matches', async () => {
    const n = net(['a'], 'a', () => TriviaCore.game(BANK));
    await n.boot();
    n.copies.a.act({ k: 'cfg', cat: 0, diff: 2, len: 5 });
    n.copies.a.act({ k: 'start' });
    expect(n.copies.a.view.st).toMatchObject({ phase: 'lobby', note: expect.stringMatching(/No questions/) });
  });
});

describe("Who's the Spy", () => {
  const players = ['a', 'b', 'c', 'd'];
  async function started(ids = players, rand = () => 0) {
    const n = net(ids, 'a', () => SpyCore.game(), rand);
    await n.boot();
    n.copies.a.act({ k: 'start' });
    await n.settle();
    const spies = ids.filter(id => n.copies[id].view.mine?.spy);
    return { n, spies, town: ids.filter(id => !spies.includes(id)) };
  }

  it('has at least 30 locations, each with enough roles; one spy, two from 7 players', async () => {
    expect(SpyCore.LOCATIONS.length).toBeGreaterThanOrEqual(30);
    for (const [name, roles] of SpyCore.LOCATIONS) expect(roles.length, name).toBeGreaterThanOrEqual(7);
    const { n, spies, town } = await started();
    expect(spies).toHaveLength(1);
    const locs = new Set(town.map(id => n.copies[id].view.mine.loc));
    expect(locs.size).toBe(1);
    expect(n.copies.b.view.st?.spies).toBeUndefined(); // the public state never names the spy
    expect(JSON.stringify(n.copies.b.view.st)).not.toContain('"spy"');
    const seven = await started(['a', 'b', 'c', 'd', 'e', 'f', 'g'], Math.random);
    expect(seven.spies).toHaveLength(2);
  });

  it('a unanimous accusation of the spy wins it for the town', async () => {
    const { n, spies, town } = await started();
    n.copies[town[0]].act({ k: 'accuse', id: spies[0] });
    await n.settle();
    expect(n.copies.a.view.st).toMatchObject({ phase: 'vote', accused: spies[0] });
    for (const id of town.slice(1)) n.copies[id].act({ k: 'vote', yes: true });
    await n.settle();
    const st = n.copies.b.view.st!;
    expect(st.phase).toBe('end');
    expect(st.result).toMatchObject({ win: 'town', spies });
    for (const id of town) expect(st.scores[id]).toBe(1);
  });

  it('a single no resumes play with the clock where it was, and that accuser cannot accuse again', async () => {
    const { n, spies, town } = await started();
    await vi.advanceTimersByTimeAsync(60_000);
    const left = n.copies.a.view.st!.deadline - Date.now();
    n.copies[town[0]].act({ k: 'accuse', id: town[1] });
    await n.settle(5000);
    n.copies[spies[0]].act({ k: 'vote', yes: false });
    await n.settle();
    const st = n.copies.a.view.st!;
    expect(st.phase).toBe('play');
    expect(Math.abs(st.deadline - Date.now() - left)).toBeLessThan(500);
    n.copies[town[0]].act({ k: 'accuse', id: spies[0] });
    await n.settle();
    expect(n.copies.a.view.st?.phase).toBe('play');
  });

  it('the spy wins by naming the location and loses on a wrong guess', async () => {
    const { n, spies, town } = await started();
    const loc = n.copies[town[0]].view.mine.loc as number;
    n.copies[spies[0]].act({ k: 'guess', loc });
    await n.settle();
    expect(n.copies.b.view.st?.result).toMatchObject({ win: 'spy', loc });
    const again = await started();
    const wrong = (again.n.copies[again.town[0]].view.mine.loc + 1) % SpyCore.LOCATIONS.length;
    again.n.copies[again.town[0]].act({ k: 'guess', loc: wrong }); // not a spy: ignored
    again.n.copies[again.spies[0]].act({ k: 'guess', loc: wrong });
    await again.n.settle();
    expect(again.n.copies.b.view.st?.result).toMatchObject({ win: 'town' });
  });

  it('time out goes to a final vote; a tie lets the spy win', async () => {
    const { n, spies, town } = await started();
    await n.settle(6 * 60_000);
    expect(n.copies.b.view.st?.phase).toBe('final');
    n.copies[town[0]].act({ k: 'final', id: spies[0] });
    n.copies[town[1]].act({ k: 'final', id: spies[0] });
    n.copies[town[2]].act({ k: 'final', id: town[0] });
    n.copies[spies[0]].act({ k: 'final', id: town[1] });
    await n.settle();
    expect(n.copies.b.view.st?.result).toMatchObject({ win: 'town' });
    const tie = await started(['a', 'b', 'c']);
    await tie.n.settle(6 * 60_000);
    const [x, y] = tie.town;
    tie.n.copies[x].act({ k: 'final', id: y });
    tie.n.copies[y].act({ k: 'final', id: tie.spies[0] });
    tie.n.copies[tie.spies[0]].act({ k: 'final', id: x });
    await tie.n.settle();
    expect(tie.n.copies.a.view.st?.result).toMatchObject({ win: 'spy', why: 'The vote was split' });
  });

  it('a new host ends the round (it cannot know the spy); a spy leaving ends it too', async () => {
    const { n } = await started();
    n.copies.b.setPlayers(['b', 'c', 'd'], 'b');
    expect(n.copies.b.view.st).toMatchObject({ phase: 'lobby', note: 'The host left, so the round ended' });
    const again = await started();
    again.n.copies.a.setPlayers(players.filter(id => id !== again.spies[0]), 'a');
    expect(again.n.copies.a.view.st).toMatchObject({ phase: 'lobby', note: 'A spy left the call, so the round ended' });
  });
});

describe('Same Wave', () => {
  it('has at least 80 distinct spectrum pairs', () => {
    expect(WaveCore.PAIRS.length).toBeGreaterThanOrEqual(80);
    expect(new Set(WaveCore.PAIRS.map(p => p.join('|'))).size).toBe(WaveCore.PAIRS.length);
  });

  it('scores by distance', () => {
    expect([50, 52, 53, 57, 58, 62, 63].map(v => WaveCore.points(v, 50))).toEqual([4, 4, 3, 3, 2, 2, 0]);
  });

  it('only the clue-giver sees the target; guessers move the dial and lock; the target is revealed', async () => {
    const n = net(['a', 'b', 'c'], 'a', () => WaveCore.game(), () => 0.5);
    await n.boot();
    n.copies.a.act({ k: 'cfg', rounds: 4 });
    n.copies.a.act({ k: 'start' });
    await n.settle();
    const st = () => n.copies.c.view.st!;
    const giver = st().giver as string;
    const [g1, g2] = ['a', 'b', 'c'].filter(id => id !== giver);
    const target = n.copies[giver].view.mine.target as number;
    expect(n.copies[g1].view.mine).toBeNull();
    expect(st().target).toBe(-1);
    n.copies[g1].act({ k: 'clue', text: 'nope' }); // not the giver
    n.copies[giver].act({ k: 'dial', v: 10 }); // the giver cannot move the dial
    n.copies[giver].act({ k: 'clue', text: '  Warm   bath ' });
    await n.settle();
    expect(st()).toMatchObject({ phase: 'guess', clue: 'Warm bath', dial: 50 });
    n.copies[g1].act({ k: 'dial', v: target + 5 });
    await n.settle();
    n.copies[g2].act({ k: 'lock' });
    await n.settle();
    expect(st()).toMatchObject({ phase: 'reveal', target, pts: 3, total: 3 });
    expect(n.copies[giver].view.mine).toBeNull();
    await n.settle(8000);
    expect(st()).toMatchObject({ phase: 'clue', r: 2 });
    expect(st().giver).not.toBe(giver);
  });

  it('a timed-out guess locks where the dial is; after the last round the game ends', async () => {
    const n = net(['a', 'b'], 'a', () => WaveCore.game(), () => 0.5);
    await n.boot();
    n.copies.a.act({ k: 'cfg', rounds: 4 });
    n.copies.a.act({ k: 'start' });
    await n.settle();
    for (let r = 0; r < 4; r++) {
      const giver = n.copies.a.view.st!.giver as string;
      n.copies[giver].act({ k: 'clue', text: 'x' });
      await n.settle(90_000 + 200);
      expect(n.copies.a.view.st?.phase).toBe('reveal');
      await n.settle(8000);
    }
    expect(n.copies.b.view.st?.phase).toBe('end');
  });

  it('a new host mid-round ends the game; the giver leaving skips the round', async () => {
    const n = net(['a', 'b', 'c'], 'a', () => WaveCore.game(), () => 0.5);
    await n.boot();
    n.copies.a.act({ k: 'start' });
    await n.settle();
    const giver = n.copies.a.view.st!.giver as string;
    const rest = ['a', 'b', 'c'].filter(id => id !== giver);
    if (giver !== 'a') {
      n.copies.a.setPlayers(rest, 'a');
      expect(n.copies.a.view.st).toMatchObject({ phase: 'clue', r: 2, note: expect.stringMatching(/clue-giver left/) });
    }
    n.copies.b.setPlayers(['b', 'c'], 'b');
    expect(n.copies.b.view.st).toMatchObject({ phase: 'lobby', note: 'The host left, so the game ended' });
  });
});
