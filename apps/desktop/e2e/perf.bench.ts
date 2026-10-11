import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type CDPSession, type Page } from '@playwright/test';

// Perf harness: `npx playwright test -c e2e/perf.config.ts` (see docs/perf.md). Records into perf-results/<PERF_LABEL>.json:
// scroll FPS in a 20,000-message channel, channel switch time, member list open time, heap after scrolling 5,000 messages,
// React commits per gateway event for the rail / channel list / member list / message list, and the initial bundle size.

const LABEL = process.env.PERF_LABEL ?? 'latest';
const results: Record<string, unknown> = { label: LABEL, date: new Date().toISOString() };

type Win = {
  __vokko: {
    appStore: { getState(): { guilds: Record<string, { id: string; name: string }>; channels: Record<string, { id: string; name?: string; guild_id: string | null }> } };
    messageStore: { getState(id: string): { messages: unknown[]; hasMoreBefore: boolean; loadingOlder: boolean } };
  };
  __vokkoMock: { presence(username: string, status: string): void; typing(channelId: string, username: string): void; say(channelId: string, username: string, content: string): string };
  __vokkoPerf: { stats: Record<string, { commits: number; ms: number }>; reset(): void };
};

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

async function channelIds(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const s = (window as unknown as Win).__vokko.appStore.getState();
    const guild = Object.values(s.guilds).find(g => g.name === 'Big Server')!;
    const out: Record<string, string> = { guild: guild.id };
    for (const c of Object.values(s.channels)) if (c.guild_id === guild.id && c.name) out[c.name] = c.id;
    return out;
  });
}

/** Click a channel link and resolve with ms until the new channel's list is on screen (content rendered, two frames painted). */
async function timeSwitch(page: Page, guildId: string, channelId: string, name: string): Promise<number> {
  return page.evaluate(async ({ guildId, channelId, name }) => {
    const link = document.querySelector<HTMLAnchorElement>(`a[href="/channels/${guildId}/${channelId}"]`);
    if (!link) throw new Error(`no link for ${name}`);
    const frame = () => new Promise<number>(r => requestAnimationFrame(r));
    const t0 = performance.now();
    link.click();
    for (;;) {
      await frame();
      const main = document.querySelector('main.app-main');
      if (main?.getAttribute('aria-label') === name && !document.querySelector('.chat-skeleton') && document.querySelector('.chat-msg, .chat-list-empty')) break;
      if (performance.now() - t0 > 10_000) throw new Error('switch timeout');
    }
    await frame();
    return performance.now() - t0;
  }, { guildId, channelId, name });
}

/** Run a scroll gesture over the message list while recording frame times. */
async function scrollFrames(page: Page, cdp: CDPSession, distance: number, speed: number): Promise<number[]> {
  const box = await page.locator('.chat-scroller').boundingBox();
  if (!box) throw new Error('no scroller');
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __recording: boolean };
    w.__frames = [];
    w.__recording = true;
    const tick = (t: number) => { w.__frames.push(t); if (w.__recording) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  await cdp.send('Input.synthesizeScrollGesture', { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2), yDistance: distance, speed, gestureSourceType: 'mouse', repeatCount: 1 });
  return page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __recording: boolean };
    w.__recording = false;
    return w.__frames.slice(1).map((t, i) => t - w.__frames[i]!);
  });
}

test('perf harness: big server', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');

  const t0 = Date.now();
  await page.goto('/channels/@me?as=sam&mockLatency=0&seed=big');
  await page.waitForFunction(() => Object.values((window as unknown as Win).__vokko?.appStore.getState().guilds ?? {}).some(g => g.name === 'Big Server'), null, { timeout: 120_000 });
  results.bootMs = Date.now() - t0;
  const ids = await channelIds(page);
  const firehose = ids.firehose!;
  const quiet = ids['channel-0']!;
  const go = (id: string) => page.evaluate(p => { history.pushState({}, '', p); window.dispatchEvent(new PopStateEvent('popstate')); }, `/channels/${ids.guild}/${id}`);
  await go(quiet);
  await page.locator('main.app-main[aria-label="channel-0"]').waitFor();
  await page.waitForTimeout(500);

  await test.step('channel switch', async () => {
    const cold = await timeSwitch(page, ids.guild!, firehose, 'firehose');
    await page.waitForTimeout(300);
    const warm: number[] = [];
    const empty: number[] = [];
    for (let i = 0; i < 5; i++) {
      empty.push(await timeSwitch(page, ids.guild!, quiet, 'channel-0'));
      await page.waitForTimeout(200);
      warm.push(await timeSwitch(page, ids.guild!, firehose, 'firehose'));
      await page.waitForTimeout(200);
    }
    results.channelSwitch = { coldMs: round(cold), warmMedianMs: round(median(warm)), toEmptyMedianMs: round(median(empty)) };
  });

  await test.step('member list open', async () => {
    const hide = page.getByRole('button', { name: 'Hide Member List' });
    if (await hide.count()) await hide.click();
    await page.waitForTimeout(300);
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      times.push(await page.evaluate(async () => {
        const button = document.querySelector<HTMLButtonElement>('button[aria-label="Show Member List"]')!;
        const frame = () => new Promise<number>(r => requestAnimationFrame(r));
        const t = performance.now();
        button.click();
        while (!document.querySelector('.member-list .member-row')) await frame();
        await frame();
        return performance.now() - t;
      }));
      results.memberRowsInDom = await page.locator('.member-list .member-row').count();
      await page.getByRole('button', { name: 'Hide Member List' }).click();
      await page.waitForTimeout(300);
    }
    results.memberListOpen = { medianMs: round(median(times)), runs: times.map(t => round(t)) };
    await page.getByRole('button', { name: 'Show Member List' }).click();
    await page.locator('.member-list .member-row').first().waitFor();
  });

  await test.step('member list scroll', async () => {
    const list = page.locator('.member-list-scroller');
    const box = await list.boundingBox();
    if (!box) throw new Error('no member list');
    await page.evaluate(() => {
      const w = window as unknown as { __frames: number[]; __recording: boolean };
      w.__frames = [];
      w.__recording = true;
      const tick = (t: number) => { w.__frames.push(t); if (w.__recording) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    await cdp.send('Input.synthesizeScrollGesture', { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2), yDistance: -20_000, speed: 6000, gestureSourceType: 'mouse' });
    const frames = await page.evaluate(() => {
      const w = window as unknown as { __frames: number[]; __recording: boolean };
      w.__recording = false;
      return w.__frames.slice(1).map((t, i) => t - w.__frames[i]!);
    });
    const total = frames.reduce((a, b) => a + b, 0);
    results.memberScroll = { fps: round((frames.length / total) * 1000), longFrames: frames.filter(f => f > 50).length };
  });

  await test.step('gateway churn re-renders', async () => {
    await page.waitForTimeout(500);
    await page.evaluate(() => (window as unknown as Win).__vokkoPerf.reset());
    const churn = await page.evaluate(async ({ firehose, other }) => {
      const w = window as unknown as Win;
      const frame = () => new Promise<number>(r => requestAnimationFrame(r));
      const t = performance.now();
      // 100 presence changes (members 3, 6, 9... are online), 50 typing starts here, 50 messages in another channel.
      for (let i = 0; i < 100; i++) w.__vokkoMock.presence(`user${(i + 1) * 3}`, i % 2 ? 'online' : 'idle');
      for (let i = 0; i < 50; i++) w.__vokkoMock.typing(firehose, `user${i + 1}`);
      for (let i = 0; i < 50; i++) w.__vokkoMock.say(other, `user${i + 1}`, `ping ${i}`);
      for (let i = 0; i < 30; i++) await frame();
      return performance.now() - t;
    }, { firehose, other: ids['channel-5']! });
    await page.waitForTimeout(1000);
    const stats = await page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as Win).__vokkoPerf.stats)) as Record<string, { commits: number; ms: number }>);
    const per = (k: string) => ({ commits: stats[k]?.commits ?? 0, renderMs: round(stats[k]?.ms ?? 0) });
    results.churn200Events = { wallMs: round(churn), rail: per('rail'), channels: per('channels'), members: per('members'), messages: per('messages') };
  });

  await test.step('message scroll fps', async () => {
    await go(firehose);
    await page.locator('.chat-msg').first().waitFor();
    await page.waitForTimeout(500);
    // Upward through history (older pages load on the way): 30,000 px at 3,000 px/s, about ten seconds.
    const frames = await scrollFrames(page, cdp, 30_000, 3000);
    const total = frames.reduce((a, b) => a + b, 0);
    const sorted = [...frames].sort((a, b) => a - b);
    results.messageScroll = {
      fps: round((frames.length / total) * 1000),
      p95FrameMs: round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
      longFrames: frames.filter(f => f > 50).length,
      frames: frames.length,
    };
  });

  await test.step('memory after 5,000 messages', async () => {
    const loaded = () => page.evaluate(id => (window as unknown as Win).__vokko.messageStore.getState(id).messages.length, firehose);
    const start = Date.now();
    while ((await loaded()) < 5000 && Date.now() - start < 240_000) {
      await scrollFrames(page, cdp, 40_000, 40_000);
    }
    const count = await loaded();
    expect(count).toBeGreaterThanOrEqual(5000);
    await cdp.send('HeapProfiler.collectGarbage');
    await page.waitForTimeout(500);
    await cdp.send('HeapProfiler.collectGarbage');
    const { metrics } = await cdp.send('Performance.getMetrics');
    const metric = (name: string) => metrics.find(m => m.name === name)?.value ?? 0;
    results.memoryAfterScroll = {
      messagesScrolled: count,
      scrollSeconds: round((Date.now() - start) / 1000),
      jsHeapMB: round(metric('JSHeapUsedSize') / 1024 / 1024),
      domNodes: metric('Nodes'),
      messagesInDom: await page.locator('.chat-msg').count(),
    };
  });
});

test('perf harness: initial bundle', async () => {
  test.setTimeout(300_000);
  const out = 'node_modules/.perf-bundle';
  execSync(`npx vite build --sourcemap --outDir ${out} --emptyOutDir`, { cwd: path.resolve('.'), stdio: 'ignore' });
  const report = JSON.parse(execSync(`node scripts/bundle-report.mjs --json --dist ${out}`, { cwd: path.resolve('.') }).toString()) as {
    initial: { js: { raw: number; gzip: number }; css: { raw: number; gzip: number } };
    lazy: { file: string; raw: number }[];
  };
  const kb = (n: number) => round(n / 1024);
  results.bundle = {
    initialJsKB: kb(report.initial.js.raw),
    initialJsGzipKB: kb(report.initial.js.gzip),
    initialCssKB: kb(report.initial.css.raw),
    initialCssGzipKB: kb(report.initial.css.gzip),
    lazyChunks: report.lazy.length,
  };
});

test.afterAll(() => {
  const dir = path.resolve('perf-results');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${LABEL}.json`);
  const previous = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
  fs.writeFileSync(file, JSON.stringify({ ...previous, ...results }, null, 2));
  console.log(JSON.stringify(results, null, 2));
});
