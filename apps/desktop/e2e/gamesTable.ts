import { expect, type Browser, type FrameLocator, type Page } from '@playwright/test';
import path from 'node:path';

// Several people at one game: one page per user, each its own mock backend, all in General. Every relay send a page's
// own user makes (`__vokkoMock.gameRelay`) is replayed in every other page's mock as that user (`requestAs` POST
// /game/messages), so the pages behave like clients of one server. Pattern from games-sketch.shots.spec.ts.

type Mock = {
  channelIdByName(name: string): string | null;
  voice(username: string, channelId: string | null): void;
  requestAs(username: string, method: string, path: string, body?: unknown): unknown;
  gameRelay(fn: ((from: string, data: unknown, to: string | null) => void) | null): void;
};
type Win = { __vokkoMock: Mock; __bridge(from: string, data: unknown, to: string | null): Promise<void> };
export type Side = { user: string; page: Page; channel: string };

const SEEDED = ['sam', 'alice', 'bob', 'nova', 'carol'];

export const call = (page: Page) => page.getByRole('region', { name: /call$/ });
export const game = (page: Page): FrameLocator => page.frameLocator('iframe.game-frame');

async function signIn(browser: Browser, user: string, users: string[], ids: Record<string, string>): Promise<Side> {
  const page = await (await browser.newContext()).newPage();
  page.on('console', m => { if (m.type() === 'error') console.log(`[${user}]`, m.text()); });
  // The seed keeps user ids per tab in sessionStorage; later pages reuse the first one's, so app ids agree.
  await page.addInitScript(ids => { for (const [k, v] of Object.entries(ids)) sessionStorage.setItem(k, v); }, ids);
  await page.goto(`/channels/@me?as=${user}&mockLatency=0`);
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.getByRole('list', { name: 'Channels', exact: true }).waitFor();
  const channel = await page.evaluate(() => (window as unknown as Win).__vokkoMock.channelIdByName('General'));
  if (!channel) throw new Error('no General voice channel');
  // Exactly the players in General on every page; this page's own user joins through the UI.
  await page.evaluate(({ user, users, seeded, channel }) => {
    const mock = (window as unknown as Win).__vokkoMock;
    for (const u of seeded) if (u !== user) mock.voice(u, users.includes(u) ? channel : null);
  }, { user, users, seeded: SEEDED, channel });
  await page.locator('.sidebar-scroller').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.getByRole('button', { name: 'General voice channel' }).click();
  await expect(call(page).locator('.voice-tile')).toHaveCount(users.length);
  return { user, page, channel };
}

/** Every relay send `src.user` makes in src's mock is made again, as them, in every other page's mock. */
async function bridge(src: Side, others: Side[]): Promise<void> {
  await src.page.exposeFunction('__bridge', async (from: string, data: unknown, to: string | null) => {
    if (from !== src.user) return; // a replayed send from another page
    await Promise.all(others.map(dst => dst.page.evaluate(({ user, channel, body }) => {
      (window as unknown as Win).__vokkoMock.requestAs(user, 'POST', `/channels/${channel}/game/messages`, body);
    }, { user: src.user, channel: dst.channel, body: to ? { data, to } : { data } }).catch(err => console.warn('bridge', err))));
  });
  await src.page.evaluate(() => {
    const w = window as unknown as Win;
    w.__vokkoMock.gameRelay((from, data, to) => void w.__bridge(from, data, to));
  });
}

/** `users[0]` starts `gameId` (so it is the leader everywhere) and everyone opens it. */
export async function seat(browser: Browser, users: string[], gameId: string, gameName: string): Promise<Side[]> {
  const first = await signIn(browser, users[0]!, users, {});
  const ids = await first.page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage).filter(([k]) => k.startsWith('vokko.mock.userId.'))));
  const sides = [first];
  for (const u of users.slice(1)) sides.push(await signIn(browser, u, users, ids));
  for (const s of sides.slice(1)) {
    await s.page.evaluate(({ starter, channel, gameId }) => {
      (window as unknown as Win).__vokkoMock.requestAs(starter, 'PUT', `/channels/${channel}/game`, { game_id: gameId });
    }, { starter: first.user, channel: s.channel, gameId });
  }
  for (const s of sides) await bridge(s, sides.filter(x => x !== s));
  await call(first.page).getByRole('button', { name: 'Activities', exact: true }).click();
  await first.page.getByRole('menu').getByRole('menuitem', { name: new RegExp(gameName) }).click();
  await expect(call(first.page).locator('.voice-tile.game')).toHaveClass(/focused/);
  for (const s of sides.slice(1)) await s.page.getByRole('button', { name: `Open ${gameName}` }).click();
  for (const s of sides) await expect(call(s.page).locator('.voice-tile.game .game-loading')).toHaveCount(0);
  return sides;
}

/** A desktop (1440x900) and a phone (390x844) shot of `page` into VOKKO_SHOTS_DIR, when it is set. */
export async function shots(page: Page, name: string): Promise<void> {
  const dir = process.env.VOKKO_SHOTS_DIR;
  if (!dir) return;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(dir, `${name}-mobile.png`) });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(200);
}

export async function closeAll(sides: Side[]): Promise<void> {
  for (const s of sides) await s.page.context().close();
}
