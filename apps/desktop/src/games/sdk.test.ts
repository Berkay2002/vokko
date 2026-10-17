// The games SDK (public/games/vokko-games.js) against a fake parent window and a real MessageChannel.
// Runs in the node environment: the SDK only touches window.parent, window.postMessage events and MessagePort.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../public/games/vokko-games.js'; // classic script: defines the VokkoGames global

type Posted = { msg: unknown; target: string };

let parentPosts: Posted[];
let parent: { postMessage: (msg: unknown, target: string) => void };
let win: EventTarget & { parent: unknown };
let channels: MessageChannel[];

beforeEach(() => {
  parentPosts = [];
  channels = [];
  parent = { postMessage: (msg, target) => parentPosts.push({ msg, target }) };
  win = Object.assign(new EventTarget(), { parent });
  vi.stubGlobal('window', win);
});

afterEach(() => {
  for (const ch of channels) {
    ch.port1.close();
    ch.port2.close();
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function windowMessage(data: unknown, source: unknown, ports: MessagePort[] = []) {
  win.dispatchEvent(Object.assign(new Event('message'), { data, source, ports }));
}

function channel() {
  const ch = new MessageChannel();
  channels.push(ch);
  return ch;
}

const alice = { app_id: 'aaaaaaaaaaaaaaaaaaaaaa', name: 'Alice', avatar: null };
const bob = { app_id: 'bbbbbbbbbbbbbbbbbbbbbb', name: 'Bob', avatar: null };

async function connected() {
  const pending = VokkoGames.connect();
  const ch = channel();
  windowMessage({ vokko: 'init', v: 1 }, parent, [ch.port2]);
  ch.port1.postMessage({ type: 'init', game_id: 'builtin:sketch', me: alice, players: [alice, bob], leader: bob.app_id });
  return { vokko: await pending, host: ch.port1 };
}

describe('VokkoGames.connect', () => {
  it('says hello to the parent and resolves on init', async () => {
    const { vokko } = await connected();
    expect(parentPosts).toEqual([{ msg: { vokko: 'hello', v: 1 }, target: '*' }]);
    expect(vokko.gameId).toBe('builtin:sketch');
    expect(vokko.me).toEqual(alice);
    expect(vokko.players).toEqual([alice, bob]);
    expect(vokko.leader).toBe(bob.app_id);
  });

  it('rejects after 5 s without init', async () => {
    vi.useFakeTimers();
    const pending = VokkoGames.connect();
    const result = expect(pending).rejects.toThrow('Open this inside Vokko');
    await vi.advanceTimersByTimeAsync(4999);
    windowMessage({ vokko: 'init', v: 1 }, {}, [channel().port2]); // wrong source: ignored
    await vi.advanceTimersByTimeAsync(1);
    await result;
  });

  it('ignores window messages after init', async () => {
    const pending = VokkoGames.connect();
    const ch = channel();
    windowMessage({ vokko: 'init', v: 1 }, parent, [ch.port2]);
    const other = channel();
    windowMessage({ vokko: 'init', v: 1 }, parent, [other.port2]);
    other.port1.postMessage({ type: 'init', game_id: 'evil', me: bob, players: [bob], leader: bob.app_id });
    ch.port1.postMessage({ type: 'init', game_id: 'builtin:mock', me: alice, players: [alice], leader: alice.app_id });
    const vokko = await pending;
    expect(vokko.gameId).toBe('builtin:mock');
    const seen = vi.fn();
    vokko.on('message', seen);
    other.port1.postMessage({ type: 'message', from: bob.app_id, data: 'spoof' });
    ch.port1.postMessage({ type: 'message', from: bob.app_id, data: 'real' });
    await vi.waitFor(() => expect(seen).toHaveBeenCalled());
    expect(seen.mock.calls).toEqual([['real', bob.app_id]]);
  });
});

describe('VokkoSession', () => {
  it('routes players, message, error and close from the host', async () => {
    const { vokko, host } = await connected();
    const players = vi.fn();
    const message = vi.fn();
    const error = vi.fn();
    const close = vi.fn();
    vokko.on('players', players);
    const off = vokko.on('message', message);
    vokko.on('error', error);
    vokko.on('close', close);

    host.postMessage({ type: 'players', players: [alice], leader: alice.app_id });
    host.postMessage({ type: 'message', from: bob.app_id, data: { ping: 1 } });
    host.postMessage({ type: 'future-thing' });
    host.postMessage({ type: 'error', code: 'rate_limited' });
    host.postMessage({ type: 'close' });
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));

    expect(players).toHaveBeenCalledWith([alice], alice.app_id);
    expect(vokko.players).toEqual([alice]);
    expect(vokko.leader).toBe(alice.app_id);
    expect(message).toHaveBeenCalledWith({ ping: 1 }, bob.app_id);
    expect(error).toHaveBeenCalledWith('rate_limited');

    off();
    host.postMessage({ type: 'message', from: bob.app_id, data: 2 });
    host.postMessage({ type: 'close' });
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(2));
    expect(message).toHaveBeenCalledTimes(1);
  });

  it('sends send, ready and close to the host', async () => {
    const { vokko, host } = await connected();
    const received: unknown[] = [];
    host.onmessage = (e) => received.push(e.data);
    vokko.send({ ping: 1 });
    vokko.send('hi', bob.app_id);
    vokko.ready();
    vokko.close();
    await vi.waitFor(() => expect(received).toHaveLength(4));
    expect(received).toEqual([
      { type: 'send', data: { ping: 1 } },
      { type: 'send', data: 'hi', to: bob.app_id },
      { type: 'ready' },
      { type: 'close' },
    ]);
  });

  it('reports an Escape the game did not handle', async () => {
    const { host } = await connected();
    const received: unknown[] = [];
    host.onmessage = (e) => received.push(e.data);
    const key = (prevented: boolean) => {
      const event = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' });
      if (prevented) event.preventDefault();
      win.dispatchEvent(event);
    };
    key(true);
    key(false);
    await vi.waitFor(() => expect(received).toEqual([{ type: 'escape' }]));
  });
});
