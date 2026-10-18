import { expect, test, type Browser, type FrameLocator, type Page } from '@playwright/test';
import path from 'node:path';

// The party games (Trivia, Who's the Spy, Same Wave) between two or three people: one page each, each its own mock
// backend, signed in as sam, alice (and bob) in General. The test bridges the relay like e2e/games-sketch.shots.spec.ts:
// `__vokkoMock.gameRelay` hands every send in one page to Playwright, which replays it in the other pages' mocks as the
// same user. Pages share seeded user ids, so app ids match. sam starts the game, so sam is the leader (the host).
// VOKKO_E2E_PORT=1454 npx playwright test e2e/games-party.spec.ts   (VOKKO_SHOTS_DIR=<dir> also saves screenshots)
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
const game = (s: Side): FrameLocator => s.page.frameLocator('iframe.game-frame');

async function signIn(browser: Browser, user: string, everyone: string[], ids: Record<string, string> = {}): Promise<Side> {
  const page = await (await browser.newContext()).newPage();
  await page.addInitScript(ids => { for (const [k, v] of Object.entries(ids)) sessionStorage.setItem(k, v); }, ids);
  await page.goto(`/channels/@me?as=${user}&mockLatency=0`);
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.getByRole('list', { name: 'Channels', exact: true }).waitFor();
  const channel = await page.evaluate(() => (window as unknown as Win).__vokkoMock.channelIdByName('General'));
  if (!channel) throw new Error('no General voice channel');
  // The same people in the call on every page: sam joins the others' copies of General; bob leaves when not playing.
  await page.evaluate(({ user, channel, everyone }) => {
    const mock = (window as unknown as Win).__vokkoMock;
    if (!everyone.includes('bob')) mock.voice('bob', null);
    if (user !== 'sam') mock.voice('sam', channel);
  }, { user, channel, everyone });
  await page.locator('.sidebar-scroller').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.getByRole('button', { name: 'General voice channel' }).click();
  await expect(call(page).locator('.voice-tile')).toHaveCount(everyone.length);
  return { user, page, channel };
}

/** Every relay send `src.user` makes in src's mock is made again, as them, in each other page's mock. */
async function bridge(src: Side, dsts: Side[]): Promise<void> {
  await src.page.exposeFunction('__bridge', async (from: string, data: unknown, to: string | null) => {
    if (from !== src.user) return; // a replayed send from another page
    for (const dst of dsts) {
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

/** Sign everyone in, start `gameId` as sam and open it on every page. Returns sam first. */
async function play(browser: Browser, users: string[], gameId: string, name: string): Promise<Side[]> {
  const sam = await signIn(browser, 'sam', users);
  const ids = await sam.page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage).filter(([k]) => k.startsWith('vokko.mock.userId.'))));
  const sides = [sam];
  for (const user of users.slice(1)) sides.push(await signIn(browser, user, users, ids));
  for (const s of sides.slice(1)) {
    await s.page.evaluate(({ channel, gameId }) => {
      (window as unknown as Win).__vokkoMock.requestAs('sam', 'PUT', `/channels/${channel}/game`, { game_id: gameId });
    }, { channel: s.channel, gameId });
  }
  for (const s of sides) await bridge(s, sides.filter(x => x !== s));
  await call(sam.page).getByRole('button', { name: 'Activities', exact: true }).click();
  await sam.page.getByRole('menu').getByRole('menuitem', { name: new RegExp(name) }).click();
  await expect(call(sam.page).locator('.voice-tile.game')).toHaveClass(/focused/);
  await expect(game(sam).locator('#status')).not.toHaveText(/Joining|Connecting/);
  for (const s of sides.slice(1)) await s.page.getByRole('button', { name: `Open ${name}` }).click();
  return sides;
}

async function shot(s: Side, name: string): Promise<void> {
  if (!dir) return;
  await s.page.setViewportSize({ width: 1440, height: 900 });
  await s.page.waitForTimeout(300);
  await s.page.screenshot({ path: path.join(dir, `${name}.png`) });
  await s.page.setViewportSize({ width: 390, height: 844 });
  await s.page.waitForTimeout(300);
  await s.page.screenshot({ path: path.join(dir, `${name}-mobile.png`) });
  await s.page.setViewportSize({ width: 1440, height: 900 });
}

test('trivia: host sets up, both answer, reveal, final scores with the credit line', async ({ browser }) => {
  test.setTimeout(180_000);
  const [sam, alice] = await play(browser, ['sam', 'alice'], 'builtin:trivia', 'Trivia');
  await expect(game(alice).locator('#status')).toHaveText(/Sam.* is setting up the game/);
  await game(sam).getByLabel('Category').selectOption({ label: 'Geography' });
  await game(sam).getByLabel('Length').selectOption({ label: '5 questions' });
  await expect(game(alice).locator('.card .big')).toHaveText('Geography · Any difficulty · 5 questions');
  await shot(sam, 'trivia-lobby');
  await game(sam).getByRole('button', { name: 'Start' }).click();

  for (let q = 1; q <= 5; q++) {
    for (const s of [sam, alice]) await expect(game(s).getByText(`Question ${q} of 5`)).toBeVisible({ timeout: 15_000 });
    await expect(game(alice).locator('.chip').first()).toHaveText('Geography');
    await game(sam).locator('.answer').first().click();
    await expect(game(alice).locator('#status')).toHaveText('1 of 2 answered');
    if (q === 1) await shot(alice, 'trivia-question');
    await game(alice).locator('.answer').nth(1).click();
    for (const s of [sam, alice]) await expect(game(s).locator('.answer.right')).toHaveCount(1);
    if (q === 1) await shot(alice, 'trivia-reveal');
  }
  for (const s of [sam, alice]) await expect(game(s).getByText('Final scores')).toBeVisible({ timeout: 15_000 });
  await expect(game(alice).locator('.credit')).toContainText('Open Trivia Database');
  await expect(game(alice).locator('.ranking li')).toHaveCount(2);
  await shot(sam, 'trivia-end');
  await game(sam).getByRole('button', { name: 'Play again' }).click();
  await expect(game(alice).locator('#status')).toHaveText(/is setting up the game/);
});

test("who's the spy: secret cards, an accusation, a unanimous vote, the reveal", async ({ browser }) => {
  test.setTimeout(180_000);
  const sides = await play(browser, ['sam', 'alice', 'bob'], 'builtin:whos-the-spy', "Who's the Spy");
  const [sam] = sides;
  for (const s of sides) await expect(game(s).locator('#players li')).toHaveCount(3);
  await shot(sam, 'spy-lobby');
  await game(sam).getByRole('button', { name: 'Start round' }).click();

  for (const s of sides) await expect(game(s).locator('.secret .big')).not.toHaveText(/Getting your card|^$/);
  const cards = await Promise.all(sides.map(s => game(s).locator('.secret .big').textContent()));
  const spyIdx = cards.findIndex(c => c === 'You are the spy');
  expect(spyIdx).toBeGreaterThanOrEqual(0);
  const town = sides.filter((_, i) => i !== spyIdx);
  const spy = sides[spyIdx]!;
  expect(new Set(town.map((_, i) => cards[sides.indexOf(town[i]!)])).size).toBe(1); // the same location for the town
  await expect(game(spy).locator('.place')).toHaveCount(36);
  await shot(town[0]!, 'spy-town-card');
  await shot(spy, 'spy-spy-card');

  const spyName = (await game(spy).locator('#players li .name', { hasText: '(you' }).textContent())!.replace(/ \(.*\)$/, '');
  await game(town[0]!).getByRole('button', { name: spyName, exact: true }).click();
  await expect(game(town[1]!).locator('.vote .big')).toContainText(`accuses ${spyName}`);
  await shot(town[1]!, 'spy-vote');
  await game(town[1]!).getByRole('button', { name: 'Yes, a spy' }).click();
  for (const s of sides) await expect(game(s).locator('.result .big')).toHaveText('The town wins');
  await expect(game(spy).locator('.result')).toContainText(`Spy: ${spyName}. Location: ${cards[sides.indexOf(town[0]!)]}`);
  await shot(spy, 'spy-end');
  await game(sam).getByRole('button', { name: 'Next round' }).click();
  await expect(game(spy).getByText('How to play')).toBeVisible();
});

test('same wave: clue, the team turns the dial, lock in, reveal, game over', async ({ browser }) => {
  test.setTimeout(180_000);
  const [sam, alice] = await play(browser, ['sam', 'alice'], 'builtin:same-wave', 'Same Wave');
  await expect(game(alice).locator('#status')).toHaveText(/starts the game/);
  await game(sam).getByLabel('Rounds').selectOption({ label: '4 rounds' });
  await shot(sam, 'wave-lobby');
  await game(sam).getByRole('button', { name: 'Start' }).click();

  for (let r = 1; r <= 4; r++) {
    await expect(game(sam).getByText(`Round ${r} of 4`)).toBeVisible();
    const giverIsSam = (await game(sam).locator('#status').textContent()) === 'You give the clue';
    const [giver, guesser] = giverIsSam ? [sam, alice] : [alice, sam];
    await expect(game(giver).locator('.dial .bands')).toHaveCount(1); // only the giver sees the target
    await expect(game(guesser).locator('.dial .bands')).toHaveCount(0);
    await game(giver).getByLabel('Your clue').fill('Lukewarm tea');
    await game(giver).getByLabel('Your clue').press('Enter');
    await expect(game(guesser).locator('.clue')).toHaveText('"Lukewarm tea"');

    // Drag the needle toward the right end; the giver sees it move.
    const box = (await game(guesser).locator('.dial').boundingBox())!;
    await guesser.page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.1);
    await guesser.page.mouse.down();
    await guesser.page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.4, { steps: 10 });
    await guesser.page.mouse.up();
    await expect.poll(async () => Number(await game(giver).locator('.dial').getAttribute('aria-valuenow')), { timeout: 5000 }).toBeGreaterThan(70);
    if (r === 1) await shot(guesser, 'wave-guess');
    await game(guesser).getByRole('button', { name: 'Lock in' }).click();
    for (const s of [sam, alice]) await expect(game(s).locator('.dial .bands')).toHaveCount(1);
    if (r === 1) await shot(giver, 'wave-reveal');
    await game(sam).getByRole('button', { name: r === 4 ? 'See the score' : 'Next round' }).click();
  }
  for (const s of [sam, alice]) await expect(game(s).getByText(/Your team scored \d+ of 16/)).toBeVisible();
  await shot(alice, 'wave-end');
});
