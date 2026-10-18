import { expect, test, type Browser, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Website games (kind "web") against the mock backend: Krunker (a built-in web game) with its site faked by a route, so no
// network is needed. Three people, each on their own page with their own mock: sam starts it, alice shares a room link,
// the test replays her PUT /game/room in the other mocks (as alice), and every other tile loads the link; bob opens his
// tile late and lands in the room too. Clearing the link reloads nobody.
// Run from apps/desktop: VOKKO_E2E_PORT=1451 GAMES_SHOTS=../../.private/artifacts/games-web npx playwright test e2e/games-web.spec.ts

const SHOTS = process.env.GAMES_SHOTS;
const SITE = 'https://krunker.io/';
const ROOM = 'https://krunker.io/?game=FRA:e2e42';

type Mock = { channelIdByName(name: string): string | null; voice(username: string, channelId: string | null): void; requestAs(username: string, method: string, path: string, body?: unknown): unknown };
type Win = { __vokkoMock: Mock };
type Side = { user: string; page: Page; channel: string };

const call = (page: Page) => page.getByRole('region', { name: /call$/ });
const tile = (page: Page) => call(page).locator('.voice-tile.game');
const where = (page: Page) => page.frameLocator('iframe.game-frame').locator('#where');

async function signIn(browser: Browser, user: string): Promise<Side> {
  const context = await browser.newContext();
  // The site, faked: the page says where it was loaded, so the test can see which room a frame is in.
  await context.route('https://krunker.io/**', route =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Fake Krunker</title><body style="color:#fff;background:#203"><h1>Fake Krunker</h1><p id="where"></p><script>document.getElementById("where").textContent = location.href</script>' }),
  );
  const page = await context.newPage();
  await page.goto(`/channels/@me?as=${user}&mockLatency=0`);
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.getByRole('list', { name: 'Channels', exact: true }).waitFor();
  const channel = await page.evaluate(() => (window as unknown as Win).__vokkoMock.channelIdByName('General'));
  if (!channel) throw new Error('no General voice channel');
  // Sam, Alice and Bob in the call on every page (Alice and Bob are seeded there).
  await page.evaluate(({ user, channel }) => { if (user !== 'sam') (window as unknown as Win).__vokkoMock.voice('sam', channel); }, { user, channel });
  await page.locator('.sidebar-scroller').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.getByRole('button', { name: 'General voice channel' }).click();
  await expect(call(page).locator('.voice-tile:not(.game)')).toHaveCount(3);
  return { user, page, channel };
}

const as = (s: Side, user: string, method: string, path: string, body?: unknown) =>
  s.page.evaluate(({ user, method, path, body }) => (window as unknown as Win).__vokkoMock.requestAs(user, method, path, body), { user, method, path: path.replace('{c}', s.channel), body });

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

test('a website game: frame on load, share a room link, others and a late joiner load it, clear', async ({ browser }) => {
  test.setTimeout(120_000);
  const sam = await signIn(browser, 'sam');
  const alice = await signIn(browser, 'alice');

  // sam starts Krunker from Activities; alice's mock gets the same start.
  await call(sam.page).getByRole('button', { name: 'Activities', exact: true }).click();
  await sam.page.getByRole('menu').getByRole('menuitem', { name: /Krunker/ }).click();
  await as(alice, 'sam', 'PUT', '/channels/{c}/game', { game_id: 'builtin:krunker' });
  await alice.page.getByRole('button', { name: 'Open Krunker' }).click();

  // No SDK hello: the frame shows as soon as it loads, with the website sandbox and delegations.
  for (const s of [sam, alice]) {
    const frame = tile(s.page).locator('iframe.game-frame');
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin allow-pointer-lock allow-forms allow-popups allow-popups-to-escape-sandbox');
    await expect(frame).toHaveAttribute('allow', 'fullscreen; clipboard-write; autoplay; gamepad');
    await expect(frame).toHaveAttribute('allowfullscreen', '');
    await expect(frame).toHaveAttribute('referrerpolicy', 'strict-origin');
    await expect(where(s.page)).toHaveText(SITE);
    await expect(tile(s.page).locator('.game-loading')).toHaveCount(0);
    await expect(tile(s.page).locator('.game-origin')).toHaveText('krunker.io');
  }
  await shot(sam.page, 'mock-web-lobby');

  // alice shares a room: a link to another site is refused client-side; the right one goes to the server.
  await tile(alice.page).getByRole('button', { name: 'Share room to call' }).click();
  const share = alice.page.getByRole('dialog', { name: 'Share room to call' });
  await expect(share).toContainText('Create a private room in the game, copy its invite link, paste it here.');
  await share.getByLabel('Room link').fill('https://evil.example/?game=FRA:e2e42');
  await share.getByRole('button', { name: 'Share' }).click();
  await expect(share).toContainText('Paste an https link to krunker.io.');
  await share.getByLabel('Room link').fill(ROOM);
  await shot(alice.page, 'mock-web-share');
  await share.getByRole('button', { name: 'Share' }).click();
  await expect(share).toHaveCount(0);
  await as(sam, 'alice', 'PUT', '/channels/{c}/game/room', { url: ROOM });

  // sam's tile loads the room; alice's (she shared it, she is already there) does not reload.
  await expect(where(sam.page)).toHaveText(ROOM);
  await expect(tile(sam.page).locator('iframe.game-frame')).toHaveAttribute('data-room', 'joined');
  await expect(where(alice.page)).toHaveText(SITE);
  await shot(sam.page, 'mock-web-joined');

  // bob comes in late: his mock already has the game and the link, and opening the tile lands him in the room.
  const bob = await signIn(browser, 'bob');
  await as(bob, 'sam', 'PUT', '/channels/{c}/game', { game_id: 'builtin:krunker' });
  await as(bob, 'alice', 'PUT', '/channels/{c}/game/room', { url: ROOM });
  await bob.page.getByRole('button', { name: 'Open Krunker' }).click();
  await expect(where(bob.page)).toHaveText(ROOM);

  // Clear: the link is gone everywhere, and nobody's frame reloads.
  await tile(alice.page).getByRole('button', { name: 'Share room to call' }).click();
  await expect(share).toContainText(`Shared now: ${ROOM}`);
  await share.getByRole('button', { name: 'Clear' }).click();
  await expect(share).toHaveCount(0);
  for (const s of [sam, bob]) await as(s, 'alice', 'PUT', '/channels/{c}/game/room', { url: null });
  await expect(tile(sam.page).getByRole('button', { name: 'Share room to call' })).not.toHaveClass(/active/);
  await expect(where(sam.page)).toHaveText(ROOM);
  await expect(where(bob.page)).toHaveText(ROOM);

  // An SDK game has no room to share.
  await tile(sam.page).getByRole('button', { name: 'Stop game' }).click();
  await expect(tile(sam.page)).toHaveCount(0);
  const refused = await sam.page.evaluate(({ channel }) => {
    const mock = (window as unknown as Win).__vokkoMock;
    mock.requestAs('sam', 'PUT', `/channels/${channel}/game`, { game_id: 'builtin:sketch' });
    try {
      mock.requestAs('sam', 'PUT', `/channels/${channel}/game/room`, { url: 'https://krunker.io/' });
      return 'accepted';
    } catch (e) {
      return String((e as { status?: number }).status ?? e);
    }
  }, { channel: sam.channel });
  expect(refused).toBe('400');
  await expect(tile(sam.page).getByRole('button', { name: 'Share room to call' })).toHaveCount(0);
});

test('the Activities picker links to credits and licenses', async ({ browser }) => {
  const sam = await signIn(browser, 'sam');
  // Short enough that the shelf's grid scrolls inside itself, which must not close it.
  await sam.page.setViewportSize({ width: 1440, height: 600 });
  await call(sam.page).getByRole('button', { name: 'Activities', exact: true }).click();
  const menu = sam.page.getByRole('menu');
  await menu.evaluate(el => el.scrollBy(0, el.scrollHeight));
  await sam.page.waitForTimeout(100);
  await expect(menu).toBeVisible();
  await sam.page.getByRole('dialog', { name: 'Activities' }).getByRole('button', { name: 'Credits and licenses' }).click();
  const dialog = sam.page.getByRole('dialog', { name: 'Credits and licenses' });
  await expect(dialog.locator('[data-game-id="builtin:krunker"]')).toContainText('Runs on krunker.io. Its ads, accounts and terms apply.');
  await expect(dialog.locator('[data-game-id="builtin:sketch"]')).toContainText('Sketch');
  await shot(sam.page, 'mock-credits');
});
