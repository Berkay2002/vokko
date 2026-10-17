// Telephone's game logic (public/games/telephone/telephone-core.js): turn order, image chunks, a full game between
// copies over a simulated relay, private tasks, timeouts, skips, a leader change, a reopened frame and a lost chunk.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../public/games/telephone/telephone-core.js'; // classic script: defines the TelephoneCore global

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
/** A PNG-signed data URL of about `chars` characters (the checks look at the signature, not the pixels). */
const bigPng = (chars: number) => PNG.slice(0, 40) + 'A'.repeat(chars - 40);

type Msg = { from: string; to?: string; data: Record<string, unknown> };
type Copy = { id: string; game: ReturnType<typeof TelephoneCore.create>; got: Msg[]; open: boolean };

function network(ids: string[], leader = ids[0]!) {
  const queue: Msg[] = [];
  const copies = new Map<string, Copy>();
  const net = {
    ids: ids.slice(),
    leader,
    copies,
    drop: (_m: Msg, _to: string) => false,
    /** Every message any copy sent, for size and privacy checks. */
    log: [] as Msg[],
    open(id: string) {
      const copy: Copy = {
        id,
        got: [],
        open: true,
        game: TelephoneCore.create({
          me: id,
          players: net.ids,
          leader: net.leader,
          send: (data, to) => {
            const m = { from: id, to, data: data as Record<string, unknown> };
            expect(JSON.stringify(data).length).toBeLessThan(4096);
            net.log.push(m);
            queue.push(m);
          },
          nameOf: (x) => x.toUpperCase(),
          prompts: ['a cat', 'a dog'],
          random: () => 0,
          pace: 1,
        }),
      };
      copies.get(id)?.game.stop();
      copies.set(id, copy);
      copy.game.start();
      return copy;
    },
    close(id: string) {
      const c = copies.get(id)!;
      c.open = false;
      c.game.stop();
    },
    deliver() {
      while (queue.length) {
        const m = queue.shift()!;
        for (const c of copies.values()) {
          if (!c.open || c.id === m.from || !net.ids.includes(c.id) || (m.to && m.to !== c.id) || net.drop(m, c.id)) continue;
          c.got.push(m);
          c.game.receive(m.data, m.from);
        }
      }
    },
    async run(ms: number, step = 10) {
      for (let t = 0; t < ms; t += step) {
        net.deliver();
        await vi.advanceTimersByTimeAsync(step);
      }
      net.deliver();
    },
    /** People leave or join the call; the host recomputes the leader. */
    setPlayers(list: string[], newLeader: string) {
      net.ids = list.slice();
      net.leader = newLeader;
      for (const c of copies.values()) if (c.open && list.includes(c.id)) c.game.setPlayers(list, newLeader);
    },
    st: (id: string) => copies.get(id)!.game.state,
  };
  return net;
}

/** Everyone opens, the leader starts a game. */
async function started(ids = ['a', 'b', 'c'], turns?: number) {
  const net = network(ids);
  for (const id of ids) net.open(id);
  await net.run(200);
  expect(net.st('a').roster.slice().sort()).toEqual(ids.slice().sort());
  if (turns) net.copies.get('a')!.game.setTurns(turns);
  expect(net.copies.get('a')!.game.startGame()).toBe(true);
  await net.run(200);
  return net;
}

/** Everyone with a task does it: prompts and descriptions are "<id> says <turn>", drawings are PNGs. */
async function playTurn(net: ReturnType<typeof network>, only?: string[]) {
  for (const c of net.copies.values()) {
    const t = c.game.state.task;
    if (!c.open || !t || c.game.state.submitted || (only && !only.includes(c.id))) continue;
    if (t.kind === 'draw') expect(c.game.submitImage(bigPng(9000))).toBe(true);
    else expect(c.game.submitText(`${c.id} says ${t.turn}`)).toBe(true);
  }
  await net.run(500);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('turn order', () => {
  it('every row is a permutation and no player meets a chain twice (drawphone limits, 3 to 12 players)', () => {
    for (let n = 3; n <= 12; n++) {
      const options = TelephoneCore.turnOptions(n);
      expect(options[0]).toBe(3);
      expect(options.every((t) => t % 2 === 1 && t <= n)).toBe(true);
      const turns = options[options.length - 1]!;
      const rows = TelephoneCore.latinSquare(n, turns);
      expect(rows).toHaveLength(turns);
      expect(rows[0]).toEqual(Array.from({ length: n }, (_, i) => i));
      for (const row of rows) expect(row.slice().sort((x, y) => x - y)).toEqual(rows[0]);
      for (let p = 0; p < n; p++) expect(new Set(rows.map((r) => r[p])).size).toBe(turns);
    }
    expect(TelephoneCore.turnOptions(4)).toEqual([3]);
    expect(TelephoneCore.turnOptions(12)).toEqual([3, 5, 7, 9, 11]);
  });
});

describe('image chunks', () => {
  it('round-trips a drawing in chunks under 4 KB and rejects damaged or foreign data', () => {
    const url = bigPng(23000);
    const chunks = TelephoneCore.imageChunks('g1', '0.1', url);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(JSON.stringify(c).length).toBeLessThan(4096);
    const asm = TelephoneCore.assembler();
    // Out of order, with a duplicate.
    const shuffled = [...chunks.slice(1).reverse(), chunks[1]!, chunks[0]!];
    const out = shuffled.map((c) => asm.add(c, 'x'));
    expect(out.at(-1)).toBe(url);
    expect(out.slice(0, -1).every((r) => r === null)).toBe(true);

    const bad = TelephoneCore.assembler();
    const tampered = chunks.map((c, i) => (i === 2 ? { ...c, d: c.d.replace('A', 'B') } : c));
    expect(tampered.map((c) => bad.add(c, 'x')).at(-1)).toBeNull();

    expect(TelephoneCore.checkImage(PNG)).toBe(true);
    expect(TelephoneCore.checkImage('data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==')).toBe(true);
    expect(TelephoneCore.checkImage(PNG.replace('png', 'webp'))).toBe(false); // PNG bytes labelled WebP
    expect(TelephoneCore.checkImage('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')).toBe(false);
    expect(TelephoneCore.checkImage('data:text/html;base64,PGI+aGk8L2I+')).toBe(false);
    expect(TelephoneCore.checkImage(bigPng(TelephoneCore.C.MAX_IMG + 1))).toBe(false);
  });
});

describe('a game', () => {
  it('prompt, drawing, description: tasks are private, every chain is revealed to everyone', async () => {
    const net = await started();
    for (const id of ['a', 'b', 'c']) expect(net.st(id)).toMatchObject({ phase: 'play', turn: 0, turns: 3, task: { kind: 'write' } });

    await playTurn(net);
    for (const id of ['a', 'b', 'c']) expect(net.st(id)).toMatchObject({ turn: 1, task: { kind: 'draw' } });
    // Each player draws someone else's prompt, and only ever got their own task.
    for (const id of ['a', 'b', 'c']) {
      const t = net.st(id).task!;
      expect(t.text).toMatch(/^[abc] says 0$/);
      expect(t.text.startsWith(id)).toBe(false);
    }
    for (const m of net.log.filter((m) => m.data.t === 'task')) expect(m.to).toBeDefined();
    expect(net.log.some((m) => m.data.t === 'chain')).toBe(false);

    await playTurn(net);
    for (const id of ['a', 'b', 'c']) {
      const st = net.st(id);
      expect(st.task).toMatchObject({ turn: 2, kind: 'describe' });
      expect(st.imgs.get(st.task!.img)).toBe(bigPng(9000)); // the drawing came through in chunks
    }

    await playTurn(net);
    await net.run(2000);
    for (const id of ['a', 'b', 'c']) {
      const st = net.st(id);
      expect(st.phase).toBe('reveal');
      expect(st.chains).toHaveLength(3);
      for (const [c, chain] of st.chains.entries()) {
        expect(chain!.links.map((l) => l.kind)).toEqual(['w', 'd', 'w']);
        expect(chain!.links[0]!.by).toBe(chain!.owner);
        expect(new Set(chain!.links.map((l) => l.by)).size).toBe(3);
        expect(net.copies.get(id)!.game.chainReady(c)).toBe(true);
      }
    }
    net.copies.get('a')!.game.show(2);
    await net.run(50);
    expect(net.st('c').k).toBe(2);
    net.copies.get('b')!.game.show(1); // only the leader moves the reveal
    await net.run(50);
    expect(net.st('c').k).toBe(2);

    net.copies.get('a')!.game.newGame();
    await net.run(50);
    expect(net.st('c')).toMatchObject({ phase: 'lobby', chains: [] });
    expect(net.st('c').roster).toContain('c');
  });

  it('time runs out: missing prompts become random ones, missing drawings are skipped and the chain carries on', async () => {
    const net = await started();
    await playTurn(net, ['a', 'b']); // c writes nothing
    expect(net.st('a').turn).toBe(0);
    await net.run((TelephoneCore.C.WRITE_SECS * 1000) + TelephoneCore.C.GRACE_MS, 500);
    expect(net.st('a')).toMatchObject({ turn: 1 });
    const draws = ['a', 'b', 'c'].map((id) => net.st(id).task!.text);
    expect(draws.filter((t) => t === 'a cat')).toHaveLength(1);

    await playTurn(net, ['a', 'c']); // b draws nothing
    await net.run((TelephoneCore.C.DRAW_SECS * 1000) + TelephoneCore.C.GRACE_MS, 500);
    // Whoever follows b's skipped drawing draws the prompt again instead of describing nothing.
    const kinds = ['a', 'b', 'c'].map((id) => net.st(id).task!.kind).sort();
    expect(kinds).toEqual(['describe', 'describe', 'draw']);
    await playTurn(net);
    await net.run(2000);
    const chains = net.st('b').chains.map((ch) => ch!.links.map((l) => l.kind + (l.auto ? '*' : '')).join(','));
    expect(chains.sort()).toEqual(['w*,skip,d', 'w,d,w', 'w,d,w']);
  });

  it('skips a player who leaves the call at once, and the leader can skip someone who is away', async () => {
    const net = await started(['a', 'b', 'c', 'd']);
    await playTurn(net, ['a', 'b', 'c']);
    expect(net.st('a').waiting).toEqual(['d']);
    net.setPlayers(['a', 'b', 'c'], 'a');
    await net.run(100);
    expect(net.st('b')).toMatchObject({ turn: 1, waiting: expect.not.arrayContaining(['d']) });

    await playTurn(net, ['a', 'b']);
    expect(net.st('a').waiting).toEqual(['c']);
    net.copies.get('b')!.game.skip('c'); // not the leader: nothing happens
    await net.run(50);
    expect(net.st('a').waiting).toEqual(['c']);
    net.copies.get('a')!.game.skip('c');
    await net.run(100);
    expect(net.st('b').turn).toBe(2);
  });

  it('a leader change ends the game and the new leader runs a fresh lobby', async () => {
    const net = await started(['a', 'b', 'c', 'd']);
    await playTurn(net);
    net.close('a');
    net.setPlayers(['b', 'c', 'd'], 'b');
    await net.run(3000);
    for (const id of ['b', 'c', 'd']) {
      expect(net.st(id)).toMatchObject({ phase: 'lobby', note: 'A left, so the game ended.', task: null });
      expect(net.st(id).roster.slice().sort()).toEqual(['b', 'c', 'd']);
    }
    expect(net.copies.get('b')!.game.startGame()).toBe(true);
  });

  it('a reopened frame gets its task and drawing again; a lost chunk is sent again', async () => {
    const net = await started();
    await playTurn(net);
    // c reopens while drawing: the leader sends the task again.
    const task = net.st('c').task!;
    net.close('c');
    net.open('c');
    await net.run(300);
    expect(net.st('c')).toMatchObject({ phase: 'play', turn: 1, task: { chain: task.chain, kind: 'draw', text: task.text } });

    // b's first upload loses a chunk on the way to the leader; the retry gets through.
    let dropped = 0;
    net.drop = (m, to) => m.from === 'b' && to === 'a' && m.data.t === 'img' && m.data.i === 1 && dropped++ === 0;
    await playTurn(net);
    expect(net.st('a').waiting).toEqual(['b']);
    await net.run(TelephoneCore.C.ACK_MS + 500, 100);
    expect(dropped).toBe(2);
    expect(net.st('a')).toMatchObject({ turn: 2 });

    // b reopens while describing: the drawing to describe comes with the task.
    net.close('b');
    net.open('b');
    await net.run(500);
    const st = net.st('b');
    expect(st.task).toMatchObject({ kind: 'describe' });
    expect(st.imgs.get(st.task!.img)).toBe(bigPng(9000));
  });

  it('ignores game messages from anyone but the leader and links from players out of turn', async () => {
    const net = await started();
    const c = net.copies.get('c')!.game;
    c.receive({ t: 'lobby', g: 'x', roster: ['c'], turns: 3, note: 'fake' }, 'b');
    c.receive({ t: 'task', g: net.st('c').g, turn: 0, chain: 2, kind: 'draw', text: 'fake' }, 'b');
    expect(net.st('c')).toMatchObject({ phase: 'play', task: { kind: 'write' } });
    const a = net.copies.get('a')!.game;
    a.receive({ t: 'text', g: net.st('a').g, id: '1.0', text: 'not my chain' }, 'b');
    a.receive({ t: 'text', g: net.st('a').g, id: '9.0', text: 'no such chain' }, 'z');
    expect(net.st('a').waiting).toHaveLength(3);
  });
});
