import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Stremio against the mock backend (src/api/mock/stremio.ts). No Stremio, TorBox or LiveKit here: the mock has a stand-in bot
// (starting, then playing) and the tile's second LiveKit Room is a stand-in too (mock:// url). The poster hosts are answered
// with a flat SVG so the CSP-listed hosts never leave the machine. "Someone else in the call" is Alice or Bob, who are seeded
// in General (and already linked to Stremio), acting through __vokkoMock.requestAs.
// Run from apps/desktop: npx playwright test -c e2e/stremio.config.ts

const MOBILE = !!process.env.STREMIO_MOBILE;
const SHOTS = process.env.STREMIO_SHOTS ?? `/srv/vokko/.claude/artifacts/vokko-stremio-desktop${MOBILE ? '/mobile' : ''}`;

// STREMIO_MOBILE=1 runs only the phone-width test (the last one) to take the mobile screenshots.
if (MOBILE) test.use({ viewport: { width: 390, height: 844 } });

type MockWin = {
  __vokkoMock: { channelIdByName(name: string): string | null; requestAs(user: string, method: string, path: string, body?: unknown): unknown; voice(user: string, channelId: string | null): void };
  __vokkoMockStremio: { approve(): void; botDelay(ms: number): void };
};
type Stream = { sid: string; playable: boolean };

/** A flat poster whose colours depend on the url, so a row of them is tellable apart in the screenshots. */
const poster = (url: string) => {
  const hue = [...url].reduce((sum, c) => (sum * 31 + c.charCodeAt(0)) % 360, 7);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 45% 30%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360} 55% 22%)"/></linearGradient></defs><rect width="300" height="450" fill="url(#g)"/></svg>`;
};

async function openGuild(page: Page): Promise<void> {
  await page.route(/^https:\/\/(images|episodes)\.metahub\.space\/|^https:\/\/m\.media-amazon\.com\//, route => route.fulfill({ contentType: 'image/svg+xml', body: poster(route.request().url()) }));
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.getByRole('list', { name: 'Channels' }).waitFor();
  await page.locator('.sidebar-scroller').evaluate(el => { el.scrollTop = el.scrollHeight; });
}

const call = (page: Page) => page.getByRole('region', { name: /call$/ });
const panel = (page: Page) => page.locator('aside.stremio-panel');
const general = (page: Page) => page.evaluate(() => (window as unknown as MockWin).__vokkoMock.channelIdByName('General') ?? '');
const as = (page: Page, user: string, method: string, path: string, body?: unknown) =>
  page.evaluate(([u, m, p, b]) => (window as unknown as MockWin).__vokkoMock.requestAs(u as string, m as string, p as string, b), [user, method, path, body] as const);
/** The first playable stream sid Alice or Bob would get for a title. */
const sidFor = async (page: Page, user: string, path: string) => ((await as(page, user, 'GET', path)) as { streams: Stream[] }).streams.find(s => s.playable)!.sid;
const shot = (page: Page, name: string) => (mkdirSync(SHOTS, { recursive: true }), page.screenshot({ path: join(SHOTS, name) }));

async function openStremio(page: Page): Promise<void> {
  await call(page).getByRole('button', { name: 'Activities' }).click();
  await shot(page, MOBILE ? 'm0-activities-menu.png' : '09-activities-menu.png');
  await page.getByRole('menuitem', { name: 'Stremio' }).click();
  await expect(panel(page)).toBeVisible();
}

test('link, search, pick a stream, play in call, control it from others, stop', async ({ page }) => {
  test.skip(MOBILE, 'desktop flow');
  await openGuild(page);
  const channelId = await general(page);
  const path = `/channels/${channelId}/stremio`;
  await page.getByRole('button', { name: 'General voice channel' }).click();
  await expect(call(page).locator('.voice-tile')).toHaveCount(3);

  // Not linked: the card, then the email fallback (a wrong password is explained), then the link code.
  await openStremio(page);
  await expect(panel(page).getByRole('heading', { name: 'Link your Stremio account' })).toBeVisible();
  await shot(page, '01-panel-not-linked.png');
  await panel(page).getByRole('button', { name: 'Sign in with email instead' }).click();
  await panel(page).getByLabel('Email').fill('sam@example.com');
  await panel(page).getByLabel('Password').fill('wrong');
  await panel(page).getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(panel(page).getByRole('alert')).toContainText('did not accept');
  await panel(page).getByRole('button', { name: 'Use a link code instead' }).click();
  await panel(page).getByRole('button', { name: 'Link with Stremio' }).click();
  await expect(panel(page).getByRole('link', { name: 'Open Stremio link' })).toHaveAttribute('href', /^https:\/\/link\.stremio\.com\//);
  await expect(panel(page).getByLabel('Link code')).not.toBeEmpty();
  await expect(panel(page).getByRole('img', { name: 'QR code for the Stremio link' })).toBeVisible();
  await shot(page, '02-linking.png');
  await page.evaluate(() => (window as unknown as MockWin).__vokkoMockStremio.approve());

  // Linked: rows from the catalog, then a search.
  const search = panel(page).getByRole('searchbox', { name: 'Search movies and series' });
  await expect(search).toBeVisible({ timeout: 10_000 });
  await expect(panel(page).getByRole('region', { name: 'Popular movies' })).toBeVisible();
  await search.fill('heat');
  await expect(panel(page).getByRole('region', { name: 'Movies' }).locator('[data-title-id="tt0113277"]')).toBeVisible();
  await shot(page, '03-search-results.png');

  // Title page of a movie with its stream list: the plain 1080p is picked, the torrent and YouTube rows are disabled.
  await panel(page).locator('[data-title-id="tt0113277"]').click();
  await expect(panel(page).getByRole('heading', { name: 'Heat' }).first()).toBeVisible();
  const rows = panel(page).getByRole('radio');
  await expect(rows).toHaveCount(5);
  await expect(panel(page).locator('.stremio-stream[aria-disabled="true"]')).toHaveCount(2);
  await expect(rows.first()).toHaveAttribute('aria-checked', 'true');
  await expect(panel(page).getByText("Couldn't reach: TorBox")).toBeVisible();
  await rows.nth(1).click();
  await expect(panel(page).locator('.stremio-chip.heavy').first()).toBeVisible();
  await panel(page).getByRole('radio').first().click();
  await shot(page, '05-stream-list.png');

  // Play in call: the panel closes, the tile is focused, shows the poster and "starting", then plays with the viewer Room up.
  await page.evaluate(() => (window as unknown as MockWin).__vokkoMockStremio.botDelay(2500));
  await panel(page).getByRole('button', { name: 'Play in call' }).click();
  const tile = call(page).locator('.voice-tile.stremio');
  await expect(panel(page)).toHaveCount(0);
  await expect(tile).toHaveClass(/focused/);
  await expect(tile).toHaveAttribute('data-status', 'starting');
  await expect(tile.locator('.stremio-poster')).toBeVisible();
  await expect(tile.locator('.stremio-status')).toBeVisible();
  await shot(page, '06-tile-starting.png');
  await expect(tile).toHaveAttribute('data-status', 'playing', { timeout: 10_000 });
  await expect(tile).toHaveAttribute('data-playing', 'true');
  await expect(tile).toHaveAttribute('data-room', 'connected');
  await expect(tile.locator('video.stremio-video')).toBeAttached();
  await expect(tile.locator('.stremio-title')).toContainText('Heat');
  await expect(tile.locator('.stremio-by')).toContainText('Started by Sam');
  await expect(page.locator('.voice-stremio-line')).toContainText('Watching Heat on Stremio');
  await expect(page.locator('[data-bot-identity]')).toContainText('Bot');
  // The bot is not a person: the three user tiles stay three, plus the Stremio tile.
  await expect(call(page).locator('.voice-tile')).toHaveCount(4);

  // Alice pauses and seeks: the tile follows the server state.
  await as(page, 'alice', 'PATCH', path, { playing: false, position_ms: 42_000 });
  await expect(tile).toHaveAttribute('data-playing', 'false');
  await expect(tile.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await expect(tile.getByLabel('Position')).toContainText('0:42');
  await as(page, 'alice', 'PATCH', path, { position_ms: 100_000 });
  await expect(tile.getByLabel('Position')).toContainText('1:40');
  await as(page, 'bob', 'PATCH', path, { playing: true });
  await expect(tile).toHaveAttribute('data-playing', 'true');
  // Our own buttons: pause, then +10 s.
  await tile.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(tile).toHaveAttribute('data-playing', 'false');
  await tile.getByRole('button', { name: 'Forward 10 seconds' }).click();
  await expect(tile.getByLabel('Position')).toContainText('1:50');
  await tile.getByRole('button', { name: 'Back 10 seconds' }).click();
  await expect(tile.getByLabel('Position')).toContainText('1:40');
  await tile.getByRole('button', { name: 'Forward 10 seconds' }).click();
  await expect(tile.getByLabel('Position')).toContainText('1:50');
  await tile.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(tile).toHaveAttribute('data-playing', 'true');
  // Local volume stays local.
  await tile.getByLabel('Stremio volume').fill('30');
  await expect(tile).toHaveAttribute('data-volume', '30');

  // Bob queues The Matrix from his side; we queue an episode of Breaking Bad through the panel (title page, season tab, streams).
  await as(page, 'bob', 'PATCH', path, { queue_add: await sidFor(page, 'bob', '/stremio/streams/movie/tt0133093') });
  await tile.getByRole('button', { name: 'Up next (1)' }).click();
  const queue = tile.getByRole('complementary', { name: 'Up next' });
  await expect(queue.locator('.stremio-queue-item')).toHaveText([/The Matrix/]);
  await queue.getByRole('button', { name: 'Add to Up next' }).click();
  await panel(page).getByRole('searchbox', { name: 'Search movies and series' }).fill('breaking');
  await panel(page).locator('[data-title-id="tt0903747"]').click();
  await expect(panel(page).getByRole('tab', { name: 'Season 1' })).toHaveAttribute('aria-selected', 'true');
  await panel(page).getByRole('tab', { name: 'Season 2' }).click();
  await expect(panel(page).locator('.stremio-episode')).not.toHaveCount(0);
  await panel(page).getByRole('tab', { name: 'Season 1' }).click();
  await expect(panel(page).locator('.stremio-episode')).toHaveCount(3);
  await shot(page, '04-title-page-series.png');
  await panel(page).locator('[data-video-id="tt0903747:1:2"]').click();
  await expect(panel(page).getByRole('radio').first()).toBeVisible();
  await panel(page).getByRole('button', { name: 'Add to Up next' }).click();
  await expect(panel(page).getByRole('status').filter({ hasText: 'Added to Up next.' })).toBeVisible();
  await panel(page).getByRole('button', { name: 'Close Stremio' }).click();
  await expect(queue.locator('.stremio-queue-item')).toHaveCount(2);
  await expect(queue.locator('.stremio-queue-item').nth(1)).toContainText('Breaking Bad');
  await shot(page, '07-tile-playing-up-next.png');

  // Skip plays The Matrix for everyone; Alice skips again to the episode; the last skip with an empty queue ends it.
  await tile.getByRole('button', { name: 'Skip to next' }).click();
  await expect(tile.locator('.stremio-title')).toContainText('The Matrix');
  await expect(queue.locator('.stremio-queue-item')).toHaveCount(1);
  await as(page, 'alice', 'PATCH', path, { skip: true });
  await expect(tile.locator('.stremio-title')).toContainText('Breaking Bad');
  await expect(tile.locator('.stremio-by')).toContainText('S1E2');
  // A sid nobody listed is refused.
  await expect(as(page, 'alice', 'PATCH', path, { queue_add: 'not-a-sid' })).rejects.toBeTruthy();

  // Skip with nothing queued ends the session (the server answers null): the tile and the line go.
  await tile.getByRole('button', { name: 'Skip and stop' }).click();
  await expect(call(page).locator('.voice-tile.stremio')).toHaveCount(0);
  await expect(page.locator('.voice-stremio-line')).toHaveCount(0);

  // Alice starts another one; Stop ends it for everyone and the tile, the viewer Room and the sidebar line go.
  await as(page, 'alice', 'PUT', path, { sid: await sidFor(page, 'alice', '/stremio/streams/movie/tt1375666') });
  await expect(tile.locator('.stremio-title')).toContainText('Inception');
  await tile.getByRole('button', { name: 'Stop Stremio' }).click();
  await expect(call(page).locator('.voice-tile.stremio')).toHaveCount(0);
  await expect(page.locator('.voice-stremio-line')).toHaveCount(0);
  await expect(call(page).locator('.voice-tile')).toHaveCount(3);
});

test('someone else starts it: the line shows outside the call, the tile when we join, and it ends when the call empties', async ({ page }) => {
  test.skip(MOBILE, 'desktop flow');
  await openGuild(page);
  const channelId = await general(page);
  const path = `/channels/${channelId}/stremio`;
  const sid = await sidFor(page, 'alice', '/stremio/streams/movie/tt0113277');
  // Alice is linked and in the call; we are not in it.
  await as(page, 'alice', 'PUT', path, { sid });
  await expect(page.locator('.voice-stremio-line')).toContainText('Watching Heat on Stremio');
  await expect(page.locator('.voice-tile.stremio')).toHaveCount(0);
  await shot(page, '08-sidebar-line.png');

  // Joining brings the tile along (late joiner), already playing, and connects the viewer Room.
  await page.getByRole('button', { name: 'General voice channel' }).click();
  const tile = call(page).locator('.voice-tile.stremio');
  await expect(tile).toBeVisible();
  await expect(tile.locator('.stremio-by')).toContainText('Started by Alice');
  await expect(tile).toHaveAttribute('data-status', 'playing', { timeout: 10_000 });
  await expect(tile).toHaveAttribute('data-room', 'connected');
  // The viewer Room belongs to the call: Focus and Back to grid must not reconnect it (a new connection passes through "connecting").
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __rooms: string[] }).__rooms = seen;
    const note = (el: Element) => el.querySelectorAll('[data-room]').forEach(e => seen.push(e.getAttribute('data-room') ?? ''));
    new MutationObserver(list =>
      list.forEach(m => {
        if (m.type === 'attributes') seen.push((m.target as Element).getAttribute('data-room') ?? '');
        // A tile that mounts fresh (and would open its own Room) arrives with its data-room already set.
        m.addedNodes.forEach(n => n instanceof Element && (n.hasAttribute('data-room') && seen.push(n.getAttribute('data-room') ?? ''), note(n)));
      }),
    ).observe(document.body, { attributes: true, attributeFilter: ['data-room'], childList: true, subtree: true });
  });
  await tile.getByRole('button', { name: 'Focus Stremio' }).click();
  await expect(tile).toHaveClass(/focused/);
  await tile.getByRole('button', { name: 'Back to grid' }).click();
  await expect(tile).toHaveClass(/grid/);
  await page.waitForTimeout(300);
  expect((await page.evaluate(() => (window as unknown as { __rooms: string[] }).__rooms)).filter(r => r !== 'connected')).toEqual([]);
  await expect(tile).toHaveAttribute('data-room', 'connected');

  // Alice stops it from her side: the tile and the line go for us, and she can start it again.
  await as(page, 'alice', 'DELETE', path);
  await expect(tile).toHaveCount(0);
  await expect(page.locator('.voice-stremio-line')).toHaveCount(0);
  await as(page, 'alice', 'PUT', path, { sid: await sidFor(page, 'alice', '/stremio/streams/movie/tt0133093') });
  await expect(tile).toBeVisible();
  await expect(tile.locator('.stremio-title')).toContainText('The Matrix');

  // Everyone else leaves, then we do: the session ends with the last person.
  await page.evaluate(() => {
    const hooks = (window as unknown as MockWin).__vokkoMock;
    hooks.voice('alice', null);
    hooks.voice('bob', null);
  });
  await expect(tile).toBeVisible();
  await call(page).getByRole('button', { name: 'Leave voice channel' }).click();
  await expect(page.locator('.voice-stremio-line')).toHaveCount(0);
  await expect(page.locator('.voice-tile.stremio')).toHaveCount(0);
});

test('phone width: panel, tile with the controls and the queue fit the screen', async ({ page }) => {
  test.skip(!MOBILE, 'run with STREMIO_MOBILE=1');
  await openGuild(page);
  const channelId = await general(page);
  const path = `/channels/${channelId}/stremio`;
  await page.getByRole('button', { name: 'General voice channel' }).click();
  await page.getByRole('button', { name: 'Join Voice', exact: true }).click();
  await openStremio(page);
  await shot(page, 'm1-panel-not-linked.png');
  await panel(page).getByRole('button', { name: 'Link with Stremio' }).click();
  await expect(panel(page).getByLabel('Link code')).not.toBeEmpty();
  await shot(page, 'm2-linking.png');
  await page.evaluate(() => (window as unknown as MockWin).__vokkoMockStremio.approve());
  await expect(panel(page).getByRole('searchbox', { name: 'Search movies and series' })).toBeVisible({ timeout: 10_000 });
  await panel(page).getByRole('searchbox', { name: 'Search movies and series' }).fill('heat');
  await expect(panel(page).locator('[data-title-id="tt0113277"]')).toBeVisible();
  await shot(page, 'm3-search-results.png');
  await panel(page).locator('[data-title-id="tt0113277"]').click();
  await expect(panel(page).getByRole('radio')).toHaveCount(5);
  await shot(page, 'm4-stream-list.png');
  await panel(page).getByRole('button', { name: 'Play in call' }).click();
  const tile = call(page).locator('.voice-tile.stremio');
  await expect(tile).toHaveAttribute('data-status', 'playing', { timeout: 10_000 });
  await as(page, 'bob', 'PATCH', path, { queue_add: await sidFor(page, 'bob', '/stremio/streams/movie/tt0133093') });
  await tile.getByRole('button', { name: 'Up next (1)' }).click();
  await shot(page, 'm5-tile-playing-up-next.png');
  // Nothing sticks out sideways: the tile's controls stay inside the viewport.
  const box = await tile.getByRole('button', { name: 'Stop Stremio' }).boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
});
