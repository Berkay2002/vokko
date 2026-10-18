import { expect, test, type Browser, type FrameLocator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

// Telephone between three people: three pages, each its own mock backend, signed in as sam, alice and bob in General.
// The test bridges the relay like games-sketch.shots.spec.ts: `__vokkoMock.gameRelay` hands every send in one page to
// Playwright, which replays it in the other pages' mocks as the same user (`requestAs` POST /game/messages, `to` kept,
// so a private task reaches only its player's page). All pages share seeded user ids, so app ids match.
// Run from apps/desktop: VOKKO_E2E_PORT=1453 npx playwright test e2e/games-telephone.spec.ts
// Screenshots (lobby, mid-round, reveal; desktop and phone): set VOKKO_SHOTS_DIR.
const dir = process.env.VOKKO_SHOTS_DIR;

type Mock = {
  channelIdByName(name: string): string | null;
  voice(username: string, channelId: string | null): void;
  requestAs(username: string, method: string, path: string, body?: unknown): unknown;
  gameRelay(fn: ((from: string, data: unknown, to: string | null) => void) | null): void;
};
type Win = { __vokkoMock: Mock; __bridge(from: string, data: unknown, to: string | null): Promise<void> };
type Side = { user: string; page: Page; channel: string };

const call = (page: Page) => page.getByRole('region', { name: /call$/ });
const game = (page: Page): FrameLocator => page.frameLocator('iframe.game-frame');

async function signIn(browser: Browser, user: string, ids: Record<string, string> = {}): Promise<Side> {
  const page = await (await browser.newContext()).newPage();
  // The seed keeps user ids per tab in sessionStorage; later pages reuse the first one's, so app ids agree.
  await page.addInitScript(ids => { for (const [k, v] of Object.entries(ids)) sessionStorage.setItem(k, v); }, ids);
  await page.goto(`/channels/@me?as=${user}&mockLatency=0`);
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.getByRole('list', { name: 'Channels', exact: true }).waitFor();
  const channel = await page.evaluate(() => (window as unknown as Win).__vokkoMock.channelIdByName('General'));
  if (!channel) throw new Error('no General voice channel');
  // Alice and Bob are seeded in General; sam joins it in every page's mock.
  if (user !== 'sam') await page.evaluate(({ channel }) => (window as unknown as Win).__vokkoMock.voice('sam', channel), { channel });
  await page.locator('.sidebar-scroller').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.getByRole('button', { name: 'General voice channel' }).click();
  await expect(call(page).locator('.voice-tile')).toHaveCount(3);
  return { user, page, channel };
}

/** Every relay send `src.user` makes in src's mock is made again, as them, in the other pages' mocks. */
async function bridge(src: Side, others: Side[]): Promise<void> {
  await src.page.exposeFunction('__bridge', async (from: string, data: unknown, to: string | null) => {
    if (from !== src.user) return; // a replayed send from another page
    for (const dst of others) {
      await dst.page.evaluate(({ user, channel, body }) => {
        (window as unknown as Win).__vokkoMock.requestAs(user, 'POST', `/channels/${channel}/game/messages`, body);
      }, { user: src.user, channel: dst.channel, body: to ? { data, to } : { data } }).catch(err => console.warn('bridge', err));
    }
  });
  await src.page.evaluate(() => {
    const w = window as unknown as Win;
    w.__vokkoMock.gameRelay((from, data, to) => void w.__bridge(from, data, to));
  });
}

async function shotBoth(page: Page, name: string): Promise<void> {
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

/** Draws a few strokes with the mouse in canvas units (480 x 360). */
async function draw(page: Page, strokes: [number, number][][]): Promise<void> {
  const box = (await game(page).locator('#canvas').boundingBox())!;
  const at = (x: number, y: number) => [box.x + (x / 480) * box.width, box.y + (y / 360) * box.height] as const;
  for (const s of strokes) {
    await page.mouse.move(...at(...s[0]!));
    await page.mouse.down();
    for (const p of s.slice(1)) await page.mouse.move(...at(...p), { steps: 6 });
    await page.mouse.up();
  }
}

const HOUSE: [number, number][][] = [
  [[130, 300], [130, 170], [330, 170], [330, 300], [130, 300]],
  [[110, 180], [230, 80], [350, 180]],
  [[205, 300], [205, 230], [255, 230], [255, 300]],
  [[390, 60], [420, 40], [450, 60], [450, 90], [420, 110], [390, 90], [390, 60]],
];

test('telephone: three players write, draw, describe, and see every chain', async ({ browser }) => {
  test.setTimeout(180_000);
  if (dir) mkdirSync(dir, { recursive: true });
  const sam = await signIn(browser, 'sam');
  const ids = await sam.page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage).filter(([k]) => k.startsWith('vokko.mock.userId.'))));
  const alice = await signIn(browser, 'alice', ids);
  const bob = await signIn(browser, 'bob', ids);
  const all = [sam, alice, bob];

  // sam starts in the others' mocks first (so sam is the starter, hence the leader, everywhere), then in his UI.
  for (const s of [alice, bob]) {
    await s.page.evaluate(({ channel }) => {
      (window as unknown as Win).__vokkoMock.requestAs('sam', 'PUT', `/channels/${channel}/game`, { game_id: 'builtin:telephone' });
    }, { channel: s.channel });
  }
  for (const s of all) await bridge(s, all.filter(o => o !== s));
  await call(sam.page).getByRole('button', { name: 'Activities', exact: true }).click();
  await sam.page.getByRole('menu').getByRole('menuitem', { name: /Telephone/ }).click();
  await expect(call(sam.page).locator('.voice-tile.game')).toHaveClass(/focused/);
  for (const s of [alice, bob]) await s.page.getByRole('button', { name: 'Open Telephone' }).click();

  // Lobby: everyone shows up; only the leader (sam) can start.
  await expect(game(sam.page).locator('#roster li')).toHaveCount(3, { timeout: 15_000 });
  await expect(game(alice.page).locator('#roster li')).toHaveCount(3);
  await expect(game(alice.page).locator('#host')).toBeHidden();
  await expect(game(sam.page).getByRole('button', { name: 'Start' })).toBeEnabled();
  await shotBoth(sam.page, 'telephone-lobby');
  await game(sam.page).getByRole('button', { name: 'Start' }).click();

  // Turn 1: everyone writes a prompt.
  const prompts: Record<string, string> = { sam: 'a house with a sun', alice: 'a fish in a hat', bob: 'a rocket to the moon' };
  for (const s of all) {
    await expect(game(s.page).locator('#instruction')).toHaveText('Write something for the next player to draw.');
    await game(s.page).locator('#text').fill(prompts[s.user]!);
    await game(s.page).locator('#send-text').click();
  }

  // Turn 2: everyone draws someone else's prompt.
  for (const s of all) {
    await expect(game(s.page).locator('#instruction')).toHaveText('Draw this:', { timeout: 15_000 });
    const prompt = (await game(s.page).locator('#prompt').textContent())!;
    expect(Object.values(prompts)).toContain(prompt);
    expect(prompt).not.toBe(prompts[s.user]);
  }
  for (const s of all) await draw(s.page, HOUSE);
  // Undo takes the last stroke (the sun) away and the eraser is selectable, on alice's pad.
  await game(alice.page).getByRole('button', { name: 'Undo' }).click();
  await game(alice.page).getByRole('button', { name: 'Eraser' }).click();
  await expect(game(alice.page).getByRole('button', { name: 'Eraser' })).toHaveAttribute('aria-pressed', 'true');
  await shotBoth(bob.page, 'telephone-drawing');
  for (const s of all) await game(s.page).locator('#send-drawing').click();

  // Turn 3: everyone describes a drawing that arrived in chunks.
  for (const s of all) {
    await expect(game(s.page).locator('#instruction')).toHaveText('What is this drawing?', { timeout: 20_000 });
    await expect(game(s.page).locator('#incoming')).toBeVisible({ timeout: 20_000 });
    expect(await game(s.page).locator('#incoming').getAttribute('src')).toMatch(/^data:image\/(webp|png);base64,/);
  }
  await shotBoth(alice.page, 'telephone-describe');
  for (const s of all) {
    await game(s.page).locator('#text').fill(`${s.user} guesses a house`);
    await game(s.page).locator('#send-text').press('Enter');
  }

  // Reveal: every page shows the same chain with a prompt, a drawing and a description.
  for (const s of all) {
    await expect(game(s.page).locator('#links li')).toHaveCount(3, { timeout: 20_000 });
    await expect(game(s.page).locator('#links li img')).toHaveCount(1, { timeout: 20_000 });
  }
  const owner = (s: Side) => game(s.page).locator('#chain-title').textContent().then(t => t!.replace(' (you)', ''));
  for (const s of all) await expect(game(s.page).locator('#status')).toHaveText('Chain 1 of 3');
  expect(new Set(await Promise.all(all.map(owner))).size).toBe(1);
  await game(sam.page).getByRole('button', { name: 'Next chain' }).click();
  for (const s of all) await expect(game(s.page).locator('#status')).toHaveText('Chain 2 of 3');
  await expect(game(alice.page).locator('#links li img')).toHaveCount(1, { timeout: 20_000 });
  await expect(game(alice.page).locator('#links q').last()).toHaveText(/guesses a house$/);
  await shotBoth(alice.page, 'telephone-reveal');
  await shotBoth(sam.page, 'telephone-reveal-host');

  // New game: back to the lobby with everyone still in it.
  await game(sam.page).getByRole('button', { name: 'New game' }).click();
  for (const s of all) await expect(game(s.page).locator('#roster li')).toHaveCount(3);
});
