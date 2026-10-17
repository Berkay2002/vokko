import { expect, test, type Browser, type FrameLocator, type Page } from '@playwright/test';
import path from 'node:path';

// Sketch between two people: two pages, each its own mock backend, signed in as sam and alice in General (Bob leaves).
// The test bridges the relay: `__vokkoMock.gameRelay` hands every send in one page to Playwright, which replays it in the
// other page's mock as the same user (`requestAs` POST /game/messages). Both pages share seeded user ids, so app ids match.
// VOKKO_SHOTS_DIR=/srv/vokko/.claude/artifacts/games-host VOKKO_E2E_PORT=1453 npx playwright test e2e/games-sketch.shots.spec.ts
const dir = process.env.VOKKO_SHOTS_DIR;
test.skip(!dir, 'set VOKKO_SHOTS_DIR to capture screenshots');

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
  // The seed keeps user ids per tab in sessionStorage; the second page reuses the first one's, so app ids agree.
  await page.addInitScript(ids => { for (const [k, v] of Object.entries(ids)) sessionStorage.setItem(k, v); }, ids);
  await page.goto(`/channels/@me?as=${user}&mockLatency=0`);
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.getByRole('list', { name: 'Channels' }).waitFor();
  const channel = await page.evaluate(() => (window as unknown as Win).__vokkoMock.channelIdByName('General'));
  if (!channel) throw new Error('no General voice channel');
  // The same two people in the call on both pages: Bob leaves, and sam joins alice's copy of General.
  await page.evaluate(({ user, channel }) => {
    const mock = (window as unknown as Win).__vokkoMock;
    mock.voice('bob', null);
    if (user !== 'sam') mock.voice('sam', channel);
  }, { user, channel });
  await page.locator('.sidebar-scroller').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.getByRole('button', { name: 'General voice channel' }).click();
  await expect(call(page).locator('.voice-tile')).toHaveCount(2);
  return { user, page, channel };
}

/** Every relay send `src.user` makes in src's mock is made again, as them, in dst's mock. */
async function bridge(src: Side, dst: Side): Promise<void> {
  await src.page.exposeFunction('__bridge', async (from: string, data: unknown, to: string | null) => {
    if (from !== src.user) return; // a replayed send from the other page
    await dst.page.evaluate(({ user, channel, body }) => {
      (window as unknown as Win).__vokkoMock.requestAs(user, 'POST', `/channels/${channel}/game/messages`, body);
    }, { user: src.user, channel: dst.channel, body: to ? { data, to } : { data } }).catch(err => console.warn('bridge', err));
  });
  await src.page.evaluate(() => {
    const w = window as unknown as Win;
    w.__vokkoMock.gameRelay((from, data, to) => void w.__bridge(from, data, to));
  });
}

const playerIds = (s: Side) => s.page.evaluate(({ channel }) =>
  ((window as unknown as Win).__vokkoMock.requestAs('sam', 'GET', `/channels/${channel}/game/players`) as { app_id: string }[]).map(p => p.app_id).sort(), { channel: s.channel });

async function shotBoth(page: Page, name: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(dir!, `${name}.png`) });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(dir!, `${name}-mobile.png`) });
  await page.setViewportSize({ width: 1440, height: 900 });
}

test('sketch: drawer, guesser, round end', async ({ browser }) => {
  test.setTimeout(120_000);
  const sam = await signIn(browser, 'sam');
  const ids = await sam.page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage).filter(([k]) => k.startsWith('vokko.mock.userId.'))));
  const alice = await signIn(browser, 'alice', ids);

  // sam starts on alice's page through her mock (so sam is the starter, hence the leader, on both), then in the UI on his.
  await alice.page.evaluate(({ channel }) => {
    (window as unknown as Win).__vokkoMock.requestAs('sam', 'PUT', `/channels/${channel}/game`, { game_id: 'builtin:sketch' });
  }, { channel: alice.channel });
  await bridge(sam, alice);
  await bridge(alice, sam);
  await call(sam.page).getByRole('button', { name: 'Activities', exact: true }).click();
  await sam.page.getByRole('menu').getByRole('menuitem', { name: /Sketch/ }).click();
  await expect(call(sam.page).locator('.voice-tile.game')).toHaveClass(/focused/);
  expect(await playerIds(sam)).toEqual(await playerIds(alice));
  await alice.page.getByRole('button', { name: 'Open Sketch' }).click();

  // Whoever the leader's rotation picked draws; the other guesses.
  const status = (s: Side) => game(s.page).locator('#status');
  await expect.poll(async () => `${await status(sam).textContent()} | ${await status(alice).textContent()}`, { timeout: 15_000 })
    .toMatch(/Your turn: draw \| .* is drawing|.* is drawing \| Your turn: draw/);
  const [drawer, guesser] = (await status(sam).textContent())?.startsWith('Your turn') ? [sam, alice] : [alice, sam];
  const word = (await game(drawer.page).locator('#word').textContent())!.trim();
  expect(word).toMatch(/^[a-z]+$/);

  // A house with a sun, drawn with the mouse.
  const box = (await game(drawer.page).locator('#canvas').boundingBox())!;
  const at = (x: number, y: number) => [box.x + (x / 800) * box.width, box.y + (y / 600) * box.height] as const;
  const strokes: [number, number][][] = [
    [[220, 480], [220, 300], [420, 300], [420, 480], [220, 480]],
    [[200, 310], [320, 190], [440, 310]],
    [[295, 480], [295, 400], [345, 400], [345, 480]],
    [[600, 110], [650, 80], [700, 110], [700, 160], [650, 190], [600, 160], [600, 110]],
    [[80, 480], [720, 480]],
  ];
  for (const s of strokes) {
    await drawer.page.mouse.move(...at(...s[0]!));
    await drawer.page.mouse.down();
    for (const p of s.slice(1)) await drawer.page.mouse.move(...at(...p), { steps: 8 });
    await drawer.page.mouse.up();
  }

  const wrong = word === 'castle' ? 'tent' : 'castle';
  await game(guesser.page).locator('#guess').fill(wrong);
  await game(guesser.page).getByRole('button', { name: 'Guess' }).click();
  await expect(game(drawer.page).locator('#guesses li')).toContainText([`: ${wrong}`]);
  await expect(game(guesser.page).locator('#word')).toHaveText(Array(word.length).fill('_').join(' '));
  await guesser.page.waitForTimeout(600); // the last stroke batch arrives within 100 ms
  await shotBoth(drawer.page, 'sketch-drawer');
  await shotBoth(guesser.page, 'sketch-guesser');

  // The right guess ends the round; the next one starts 4 s later, so shoot right away.
  await game(guesser.page).locator('#guess').fill(word);
  await game(guesser.page).locator('#guess').press('Enter');
  await expect(game(guesser.page).locator('#status')).toHaveText('Next round soon');
  await expect(game(guesser.page).locator('#scores li').first()).toContainText('(you): 1');
  await shotBoth(guesser.page, 'sketch-round-end');
});
