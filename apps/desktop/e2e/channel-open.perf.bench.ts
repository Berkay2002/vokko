import fs from 'node:fs';
import path from 'node:path';
import { test, type Page } from '@playwright/test';

// Channel open, frame by frame: `npx playwright test -c e2e/perf.config.ts channel-open` (docs/perf.md). From the click on a channel
// link, after every painted frame it records whether the newest message is on screen at the bottom of the list. Reports frames and ms
// to the first correct frame, frames that showed rows but not the bottom, and whether the bottom held for the next 30 frames.
// Three sizes: 6 messages (less than a screen), 40 (one page, no older history) and #firehose (20,000, full page plus history).

const LABEL = process.env.PERF_LABEL ?? 'latest';
type Win = {
  __vokko: { appStore: { getState(): { guilds: Record<string, { id: string; name: string }>; channels: Record<string, { id: string; name?: string; guild_id: string | null }> } } };
  __vokkoMock: { say(channelId: string, username: string, content: string): string };
};
type Open = { frames: number; ms: number; wrongFrames: number; held: boolean; trace: string };

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

async function timeOpen(page: Page, guildId: string, channelId: string): Promise<Open> {
  return page.evaluate(async ({ guildId, channelId }) => {
    const link = document.querySelector<HTMLAnchorElement>(`a[href="/channels/${guildId}/${channelId}"]`)!;
    const store = (window as unknown as { __vokko: { messageStore: { getState(id: string): { messages: { id: string }[] } } } }).__vokko.messageStore;
    // After paint: a task posted from rAF runs once that frame's rendering steps are done.
    const painted = () => new Promise<number>(r => requestAnimationFrame(() => { const c = new MessageChannel(); c.port1.onmessage = () => r(performance.now()); c.port2.postMessage(0); }));
    const look = (): 'none' | 'wrong' | 'ok' => {
      const scroller = document.querySelector('.chat-scroller');
      const rows = document.querySelectorAll('.chat-scroller .chat-msg');
      if (!scroller || rows.length === 0 || location.pathname !== `/channels/${guildId}/${channelId}` || getComputedStyle(scroller).visibility === 'hidden') return 'none';
      const last = store.getState(channelId).messages.at(-1);
      const el = last && document.querySelector(`.chat-scroller [data-message-id="${last.id}"]`);
      if (!el) return 'wrong';
      const s = scroller.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return r.bottom <= s.bottom + 1 && r.bottom >= s.bottom - 60 && r.height > 0 ? 'ok' : 'wrong';
    };
    const t0 = performance.now();
    link.click();
    let frames = 0;
    let wrongFrames = 0;
    let trace = '';
    for (;;) {
      const t = await painted();
      frames++;
      const v = look();
      trace += v[0];
      if (v === 'ok') {
        let held = true;
        for (let i = 0; i < 30; i++) { await painted(); const w = look(); trace += w[0]; if (w !== 'ok') held = false; }
        return { frames, ms: Math.round((t - t0) * 10) / 10, wrongFrames, held, trace };
      }
      if (v === 'wrong') wrongFrames++;
      if (t - t0 > 10_000) throw new Error('open timeout');
    }
  }, { guildId, channelId });
}

test('perf harness: channel open', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0&seed=big');
  await page.waitForFunction(() => Object.values((window as unknown as Win).__vokko?.appStore.getState().guilds ?? {}).some(g => g.name === 'Big Server'), null, { timeout: 120_000 });
  const ids = await page.evaluate(() => {
    const s = (window as unknown as Win).__vokko.appStore.getState();
    const guild = Object.values(s.guilds).find(g => g.name === 'Big Server')!;
    const out: Record<string, string> = { guild: guild.id };
    for (const c of Object.values(s.channels)) if (c.guild_id === guild.id && c.name) out[c.name] = c.id;
    return out;
  });
  await page.evaluate(({ small, medium }) => {
    const m = (window as unknown as Win).__vokkoMock;
    for (let i = 0; i < 6; i++) m.say(small, `user${i + 1}`, `small channel message ${i}`);
    for (let i = 0; i < 40; i++) m.say(medium, `user${(i % 7) + 1}`, `medium channel message ${i} ${'lorem ipsum '.repeat(i % 5)}`);
  }, { small: ids['channel-1']!, medium: ids['channel-2']! });
  const go = (id: string) => page.evaluate(p => { history.pushState({}, '', p); window.dispatchEvent(new PopStateEvent('popstate')); }, `/channels/${ids.guild}/${id}`);
  await go(ids['channel-0']!);
  await page.locator('main.app-main[aria-label="channel-0"]').waitFor();
  await page.waitForTimeout(500);

  const out: Record<string, unknown> = { label: LABEL, date: new Date().toISOString() };
  for (const [size, name] of [['6', 'channel-1'], ['40', 'channel-2'], ['20000', 'firehose']] as const) {
    const cold = await timeOpen(page, ids.guild!, ids[name]!);
    const warm: Open[] = [];
    for (let i = 0; i < 9; i++) {
      await go(ids['channel-0']!);
      await page.locator('main.app-main[aria-label="channel-0"]').waitFor();
      await page.waitForTimeout(150);
      warm.push(await timeOpen(page, ids.guild!, ids[name]!));
    }
    const w = { frames: median(warm.map(w => w.frames)), ms: median(warm.map(w => w.ms)), wrongFrames: warm.reduce((a, w) => a + w.wrongFrames, 0), held: warm.filter(w => w.held).length };
    out[size] = { cold, warm: { ...w, traces: warm.map(w => w.trace) } };
    console.log(`${LABEL.padEnd(12)} ${size.padStart(5)} msgs | cold ${cold.frames} fr ${cold.ms} ms wrong ${cold.wrongFrames} held ${cold.held} | warm median ${w.frames} fr ${w.ms} ms, wrong frames ${w.wrongFrames} in 9, held ${w.held}/9`);
    await go(ids['channel-0']!);
    await page.waitForTimeout(300);
  }
  const dir = path.join(process.cwd(), 'perf-results');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `channel-open-${LABEL}.json`), JSON.stringify(out, null, 2));
});
