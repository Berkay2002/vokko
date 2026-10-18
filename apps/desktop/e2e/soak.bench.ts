import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type CDPSession, type Page } from '@playwright/test';

// Long-call soak (docs/perf.md, "Long calls"): `SOAK_MINUTES=60 SOAK_LABEL=after npx playwright test -c e2e/soak.config.ts`.
// Sam sits in General with four others (FakeTransport toggles everyone's speaking ring every 1.5 s), Bob's camera on, Alice's
// screen share watched, the call chat open and messages, typing and presence changes arriving every few seconds. Every minute
// it records JS heap (raw and after a forced GC), DOM nodes, listeners, video elements, loaded messages and the CPU time and
// memory of every browser process; at half time it takes a 30 s CPU profile. Writes perf-results/soak-<label>.json + .cpuprofile.

const LABEL = process.env.SOAK_LABEL ?? 'latest';
const MINUTES = Number(process.env.SOAK_MINUTES ?? 60);
const OUT = path.join('perf-results');

type Win = {
  __vokko: { messageStore: { getState(id: string): { messages: unknown[] } } };
  __vokkoMock: {
    channelIdByName(name: string): string | null;
    voice(user: string, channelId: string | null, opts?: { selfMute?: boolean; selfVideo?: boolean; selfStream?: boolean }): void;
    say(channelId: string, username: string, content: string): string;
    typing(channelId: string, username: string): void;
    presence(username: string, status: string): void;
  };
};

interface Sample {
  minute: number;
  heapMB: number;
  heapAfterGcMB: number;
  domNodes: number;
  listeners: number;
  videos: number;
  callMessages: number;
  cpuPct: number;
  rendererCpuPct: number;
  ramMB: number;
  rendererRamMB: number;
}

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const MB = 1024 * 1024;

/** Private bytes of the given processes (Windows: Get-Process; elsewhere: ps rss). */
function memoryMB(pids: number[]): Record<number, number> {
  const out: Record<number, number> = {};
  if (pids.length === 0) return out;
  try {
    if (process.platform === 'win32') {
      const raw = execSync(`powershell -NoProfile -Command "Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { \\"$($_.Id) $($_.PrivateMemorySize64)\\" }"`, { encoding: 'utf8' });
      for (const line of raw.trim().split(/\r?\n/)) {
        const [id, bytes] = line.trim().split(' ').map(Number);
        if (id && bytes) out[id] = bytes / MB;
      }
    } else {
      const raw = execSync(`ps -o pid=,rss= -p ${pids.join(',')}`, { encoding: 'utf8' });
      for (const line of raw.trim().split('\n')) {
        const [id, kb] = line.trim().split(/\s+/).map(Number);
        if (id && kb) out[id] = kb / 1024;
      }
    }
  } catch {
    /* a process exited between the two calls */
  }
  return out;
}

async function metrics(cdp: CDPSession): Promise<Record<string, number>> {
  const { metrics: list } = (await cdp.send('Performance.getMetrics')) as { metrics: { name: string; value: number }[] };
  return Object.fromEntries(list.map(m => [m.name, m.value]));
}

/** Self time per function from a .cpuprofile, top `n`. */
function topSelf(profile: { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[]; samples: number[]; timeDeltas: number[] }, n: number) {
  const byNode = new Map(profile.nodes.map(node => [node.id, node]));
  const self = new Map<string, number>();
  profile.samples.forEach((id, i) => {
    const frame = byNode.get(id)?.callFrame;
    if (!frame) return;
    const key = `${frame.functionName || '(anonymous)'} ${frame.url.split('/').pop() ?? ''}:${frame.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0));
  });
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  return [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([fn, us]) => ({ fn, ms: round(us / 1000), pct: round((us / total) * 100) }));
}

async function setUp(page: Page): Promise<{ voice: string; text: string }> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.getByRole('list', { name: 'Channels' }).waitFor();
  const ids = await page.evaluate(() => {
    const m = (window as unknown as Win).__vokkoMock;
    return { voice: m.channelIdByName('General')!, text: m.channelIdByName('general')! };
  });
  await page.getByRole('button', { name: 'General voice channel' }).click();
  await expect(page.getByRole('region', { name: 'Voice connection' }).getByRole('status')).toHaveText('Voice Connected');
  await page.evaluate(({ voice }) => {
    const m = (window as unknown as Win).__vokkoMock;
    m.voice('alice', voice, { selfStream: true });
    m.voice('bob', voice, { selfVideo: true });
    m.voice('nova', voice);
    m.voice('carol', voice);
  }, ids);
  const call = page.getByRole('region', { name: /call$/ });
  await call.locator('.voice-tile.stream', { hasText: 'Alice' }).getByRole('button', { name: 'Watch Stream' }).click();
  await expect(call.locator('video[data-source="screen"]')).toBeVisible();
  await call.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Show Chat' }).click();
  await expect(page.getByRole('complementary', { name: /chat$/ })).toBeVisible();
  return ids;
}

/** One second of call life: chat, typing, presence, mute toggles, a leave/rejoin every 5 min, stream re-watch every 10 min. */
async function tick(page: Page, ids: { voice: string; text: string }, t: number): Promise<void> {
  await page.evaluate(
    ({ ids, t }) => {
      const m = (window as unknown as Win).__vokkoMock;
      const people = ['alice', 'bob', 'nova', 'carol'];
      const who = people[Math.floor(t / 3) % people.length]!;
      if (t % 3 === 0) m.say(ids.voice, who, t % 15 === 0 ? `**gg** that was close https://example.com/clip/${t}` : `message ${t} from ${who}`);
      if (t % 7 === 0) m.say(ids.text, people[(t / 7) % people.length]!, `elsewhere ${t}`);
      if (t % 5 === 1) m.typing(ids.voice, people[(t + 1) % people.length]!);
      if (t % 20 === 0) m.presence('nova', (t / 20) % 2 ? 'idle' : 'online');
      if (t % 45 === 0) m.voice('bob', ids.voice, { selfVideo: true, selfMute: (t / 45) % 2 === 1 });
      if (t % 300 === 150) m.voice('nova', null);
      if (t % 300 === 160) m.voice('nova', ids.voice);
    },
    { ids, t },
  );
  if (t % 600 === 300) {
    const alice = page.getByRole('region', { name: /call$/ }).locator('.voice-tile.stream', { hasText: 'Alice' });
    await alice.getByRole('button', { name: 'Stream quality' }).click();
    await page.getByRole('menuitem', { name: 'Stop Watching' }).click();
    await alice.getByRole('button', { name: 'Watch Stream' }).click();
  }
}

test('soak: an hour in a call with a stream, cameras, speaking and chat', async ({ page, browser }) => {
  fs.mkdirSync(OUT, { recursive: true });
  const ids = await setUp(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const browserCdp = await browser.newBrowserCDPSession();
  const processes = async () => ((await browserCdp.send('SystemInfo.getProcessInfo')) as { processInfo: { type: string; id: number; cpuTime: number }[] }).processInfo;

  const samples: Sample[] = [];
  let profileTop: ReturnType<typeof topSelf> = [];
  let last = { at: Date.now(), cpu: new Map((await processes()).map(p => [p.id, p.cpuTime])) };

  const sample = async (minute: number) => {
    const now = Date.now();
    const procs = await processes();
    const wall = (now - last.at) / 1000;
    const cpuOf = (p: { id: number; cpuTime: number }) => Math.max(0, p.cpuTime - (last.cpu.get(p.id) ?? p.cpuTime));
    const renderers = procs.filter(p => p.type === 'renderer');
    const cpuPct = round((procs.reduce((a, p) => a + cpuOf(p), 0) / wall) * 100);
    const rendererCpuPct = round((renderers.reduce((a, p) => a + cpuOf(p), 0) / wall) * 100);
    last = { at: now, cpu: new Map(procs.map(p => [p.id, p.cpuTime])) };
    const mem = memoryMB(procs.map(p => p.id));
    const raw = await metrics(cdp);
    await cdp.send('HeapProfiler.collectGarbage');
    const gc = await metrics(cdp);
    const page_ = await page.evaluate(voice => ({
      videos: document.querySelectorAll('video').length,
      callMessages: (window as unknown as Win).__vokko.messageStore.getState(voice).messages.length,
    }), ids.voice);
    const s: Sample = {
      minute,
      heapMB: round((raw.JSHeapUsedSize ?? 0) / MB),
      heapAfterGcMB: round((gc.JSHeapUsedSize ?? 0) / MB),
      domNodes: gc.Nodes ?? 0,
      listeners: gc.JSEventListeners ?? 0,
      ...page_,
      cpuPct,
      rendererCpuPct,
      ramMB: round(Object.values(mem).reduce((a, b) => a + b, 0)),
      rendererRamMB: round(renderers.reduce((a, p) => a + (mem[p.id] ?? 0), 0)),
    };
    samples.push(s);
    console.log(JSON.stringify(s));
  };

  const start = Date.now();
  // Minute 0 is taken after a minute of warm-up so the CPU column has a full window.
  for (let t = 0, minute = -1; minute < MINUTES; t++) {
    await tick(page, ids, t);
    if (MINUTES >= 2 && t === Math.floor((MINUTES * 60) / 2)) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
      await cdp.send('Profiler.start');
    }
    if (MINUTES >= 2 && t === Math.floor((MINUTES * 60) / 2) + 30) {
      const { profile } = (await cdp.send('Profiler.stop')) as { profile: Parameters<typeof topSelf>[0] };
      fs.writeFileSync(path.join(OUT, `soak-${LABEL}.cpuprofile`), JSON.stringify(profile));
      profileTop = topSelf(profile, 25);
    }
    const due = start + (t + 1) * 1000;
    await page.waitForTimeout(Math.max(0, due - Date.now()));
    if ((t + 1) % 60 === 0) await sample(++minute);
  }

  const result = { label: LABEL, date: new Date().toISOString(), minutes: MINUTES, samples, profileTop };
  fs.writeFileSync(path.join(OUT, `soak-${LABEL}.json`), JSON.stringify(result, null, 2));
  console.table(samples.filter(s => [0, 15, 30, 45, 60].includes(s.minute) || s.minute === MINUTES));
  console.table(profileTop);
});
