// Sketch's game logic (public/games/sketch/sketch-core.js): late-join sync, guess checking and the drawer leaving.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../public/games/sketch/sketch-core.js'; // classic script: defines the SketchCore global

type Sent = { data: Record<string, unknown>; to?: string };

function copy(me: string, players: string[], leader: string) {
  const sent: Sent[] = [];
  const drawn: number[] = [];
  const lines: string[] = [];
  const game = SketchCore.create({
    me,
    players,
    leader,
    send: (data, to) => sent.push({ data: data as Record<string, unknown>, to }),
    onDraw: (s) => drawn.push(s.seq),
    onLine: (text) => lines.push(text),
    random: () => 0, // always "apple"
  });
  return { game, sent, drawn, lines, st: game.state };
}

/** Deliver everything `from` sent since `since` to `target` (broadcasts, and messages addressed to it). */
function deliver(from: ReturnType<typeof copy>, fromId: string, target: ReturnType<typeof copy>, targetId: string, since = 0) {
  for (const m of from.sent.slice(since)) if (!m.to || m.to === targetId) target.game.receive(m.data, fromId);
  return from.sent.length;
}

const points = (n: number) => Array.from({ length: n * 2 }, (_, i) => (i % 2 ? 599 : 799));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** A leader copy "a" that synced alone, started round 1 and is drawing it. */
async function leaderDrawing(players = ['a', 'b', 'c']) {
  const a = copy('a', players, 'a');
  a.game.start();
  await vi.advanceTimersByTimeAsync(2000 + 1);
  expect(a.st.syncing).toBe(false);
  expect(a.st).toMatchObject({ n: 1, drawer: 'a', word: 'apple', len: 5, over: false });
  return a;
}

describe('SketchCore late join', () => {
  it('the leader tries sync? once, other copies three times, then they start fresh', async () => {
    const a = await leaderDrawing();
    expect(a.sent.filter((m) => m.data.t === 'sync?').map((m) => m.data.a)).toEqual([1]);
    expect(a.sent.some((m) => m.data.t === 'round' && m.data.drawer === 'a')).toBe(true);
    const b = copy('b', ['b'], 'a');
    b.game.start();
    await vi.advanceTimersByTimeAsync(3 * 2000 + 1);
    expect(b.sent.filter((m) => m.data.t === 'sync?').map((m) => m.data.a)).toEqual([1, 2, 3]);
    expect(b.st.syncing).toBe(false);
  });

  it('when everyone opens at once, round 1 starts on every copy after about 2 s', async () => {
    const ids = ['a', 'b', 'c'];
    const copies = ids.map((id) => copy(id, ids, 'a'));
    const seen = copies.map(() => 0);
    const pump = () => {
      for (let progress = true; progress; ) {
        progress = false;
        copies.forEach((from, i) => {
          const fresh = from.sent.slice(seen[i]);
          seen[i] = from.sent.length;
          for (const m of fresh) {
            progress = true;
            copies.forEach((to, j) => j !== i && (!m.to || m.to === ids[j]) && to.game.receive(m.data, ids[i]));
          }
        });
      }
    };
    copies.forEach((c) => c.game.start());
    pump();
    await vi.advanceTimersByTimeAsync(2001);
    pump();
    for (const c of copies) expect(c.st).toMatchObject({ syncing: false, n: 1, drawer: 'a', len: 5, over: false });
  });

  it('applies the snapshot, then the buffered live strokes, without duplicates or gaps', async () => {
    const a = await leaderDrawing();
    for (let i = 0; i < 10; i++) a.game.stroke(i + 1, 0, 1, points(300)); // seq 1..10, each about 2.4 KB

    const c = copy('c', ['a', 'b', 'c'], 'a');
    c.game.start();
    expect(c.sent).toEqual([{ data: { t: 'sync?', a: 1 }, to: undefined }]);
    // While c waits, seq 10 arrives live again (it is in the snapshot too), then seq 11 is drawn.
    const live10 = a.sent.find((m) => m.data.t === 's' && m.data.seq === 10)!;
    c.game.receive(live10.data, 'a');
    a.game.stroke(11, 0, 1, points(2));
    const live11 = a.sent[a.sent.length - 1];
    c.game.receive(live11.data, 'a');
    expect(c.drawn).toEqual([]);

    const before = a.sent.length;
    a.game.receive({ t: 'sync?', a: 1 }, 'c');
    const snaps = a.sent.slice(before);
    expect(snaps.length).toBeGreaterThan(1);
    for (const m of snaps) {
      expect(m.to).toBe('c');
      expect(m.data.t).toBe('snap');
      expect(JSON.stringify(m.data).length).toBeLessThan(4096);
    }
    // A second answer from b (same round) arriving first in part is ignored once a's chunks are being collected.
    c.game.receive(snaps[0].data, 'a');
    c.game.receive({ ...snaps[1].data, strokes: [] }, 'b');
    for (const m of snaps.slice(1)) c.game.receive(m.data, 'a');

    expect(c.st.syncing).toBe(false);
    expect(c.st).toMatchObject({ n: 1, drawer: 'a', len: 5, over: false, word: '' });
    expect(c.drawn).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(c.st.strokes.map((s) => s.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('only the leader answers the first sync?; anyone with state answers retries', async () => {
    const a = await leaderDrawing();
    const b = copy('b', ['a', 'b', 'c'], 'a');
    b.game.start();
    deliver(a, 'a', b, 'b', a.sent.length); // nothing new
    a.game.receive({ t: 'sync?', a: 1 }, 'b');
    deliver(a, 'a', b, 'b', a.sent.length - 1);
    expect(b.st.syncing).toBe(false);

    const n = b.sent.length;
    b.game.receive({ t: 'sync?', a: 1 }, 'c');
    expect(b.sent.length).toBe(n);
    b.game.receive({ t: 'sync?', a: 2 }, 'c');
    expect(b.sent[n].data).toMatchObject({ t: 'snap', n: 1, drawer: 'a', i: 0, total: 1 });
  });
});

describe('SketchCore rounds', () => {
  it('the drawer checks guesses; a drawer who leaves ends the round with no points', async () => {
    const a = await leaderDrawing();
    a.game.receive({ t: 'g', n: 1, text: 'pear' }, 'b');
    expect(a.st.over).toBe(false);
    a.game.receive({ t: 'g', n: 1, text: ' Apple ' }, 'b');
    expect(a.st.over).toBe(true);
    expect(a.st.scores).toEqual({ b: 1 });
    expect(a.sent.at(-1)!.data).toEqual({ t: 'end', n: 1, by: 'b', word: 'apple' });

    await vi.advanceTimersByTimeAsync(4000);
    expect(a.st).toMatchObject({ n: 2, drawer: 'b', over: false });

    a.game.setPlayers(['a', 'c'], 'a');
    expect(a.st.over).toBe(true);
    expect(a.st.scores).toEqual({ b: 1 });
    expect(a.lines.at(-1)).toContain('left');

    await vi.advanceTimersByTimeAsync(4000);
    expect(a.st).toMatchObject({ n: 3, drawer: 'c', over: false });
  });

  it('a drawer who reopens the frame lost the word, so that round ends without points', async () => {
    const a = await leaderDrawing(['a', 'b']);
    a.game.receive({ t: 'g', n: 1, text: 'apple' }, 'b');
    await vi.advanceTimersByTimeAsync(4000); // round 2, b draws
    const b = copy('b', ['a', 'b'], 'a');
    b.game.start();
    a.game.receive({ t: 'sync?', a: 1 }, 'b');
    deliver(a, 'a', b, 'b', a.sent.length - 1);
    expect(b.st).toMatchObject({ n: 2, drawer: 'b', over: true, scores: { b: 1 } });
    expect(b.sent.at(-1)!.data).toEqual({ t: 'end', n: 2, by: null, word: null });
  });

  it('a new leader carries on the round, ends it on timeout and starts the next', async () => {
    const c = copy('c', ['a', 'c', 'd'], 'a');
    c.game.start();
    await vi.advanceTimersByTimeAsync(3 * 2000 + 1);
    c.game.receive({ t: 'round', n: 5, drawer: 'd', secs: 80 }, 'a');
    c.game.setPlayers(['c', 'd'], 'c'); // a left mid-round; c leads now
    expect(c.st).toMatchObject({ n: 5, drawer: 'd', over: false });
    await vi.advanceTimersByTimeAsync(80_000 + 2000);
    expect(c.st.over).toBe(true);
    expect(c.sent.at(-1)!.data).toEqual({ t: 'end', n: 5, by: null, word: null });
    await vi.advanceTimersByTimeAsync(4000);
    expect(c.st).toMatchObject({ n: 6, drawer: 'c', over: false, word: 'apple' });
  });
});

describe('toBoard', () => {
  it('maps to the drawn 4:3 content box of a letterboxed canvas and clamps to the board', () => {
    // 704x433 box: the content is 577.33 wide, centred with 63.33 px side margins.
    const r = { left: 10, top: 20, width: 704, height: 433 };
    expect(SketchCore.toBoard(r, 10 + 352, 20 + 216.5)).toEqual([400, 300]);
    expect(SketchCore.toBoard(r, 10 + 63.34, 20)).toEqual([0, 0]);
    expect(SketchCore.toBoard(r, 10, 20 + 433)).toEqual([0, 600]); // in the side margin
    expect(SketchCore.toBoard({ left: 0, top: 0, width: 400, height: 300 }, 100, 75)).toEqual([200, 150]);
  });
});
