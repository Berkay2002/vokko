import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Spotify in calls against the mock backend (src/api/mock/spotify.ts). No Spotify, bot or LiveKit here: the mock's stand-in bot
// starts each track after a beat, and the call's viewer Room is a stand-in too (mock:// url). i.scdn.co art is answered with a flat
// SVG per id so nothing leaves the machine. "Someone else in the call" is Alice or Bob, seeded in General, through __vokkoMock.requestAs.
// (e2e/spotify.spec.ts is the older "Listening to Spotify" presence spec.)
// Run from apps/desktop: npx playwright test -c e2e/spotify-calls.config.ts

const MOBILE = !!process.env.SPOTIFY_MOBILE;
const SHOTS = process.env.SPOTIFY_SHOTS ?? `/srv/vokko/.claude/artifacts/spotify-desktop${MOBILE ? '/mobile' : ''}`;

// SPOTIFY_MOBILE=1 runs only the phone-width test (the last one) to take the mobile screenshots.
if (MOBILE) test.use({ viewport: { width: 390, height: 844 } });

type MockWin = {
  __vokkoMock: { channelIdByName(name: string): string | null; requestAs(user: string, method: string, path: string, body?: unknown): unknown; voice(user: string, channelId: string | null): void };
  __vokkoMockSpotify: { botDelay(ms: number): void; ids: { album: string; playlist: string; artist: string; tracks: string[] } };
};

const art = (url: string) => {
  const hue = [...url].reduce((sum, c) => (sum * 31 + c.charCodeAt(0)) % 360, 7);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 55% 45%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360} 60% 25%)"/></linearGradient></defs><rect width="300" height="300" fill="url(#g)"/><circle cx="150" cy="150" r="60" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="10"/></svg>`;
};

async function openGuild(page: Page): Promise<void> {
  await page.route(/^https:\/\/i\.scdn\.co\/image\//, route => route.fulfill({ contentType: 'image/svg+xml', body: art(route.request().url()) }));
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.getByRole('list', { name: 'Channels' }).waitFor();
  await page.locator('.sidebar-scroller').evaluate(el => { el.scrollTop = el.scrollHeight; });
}

const call = (page: Page) => page.getByRole('region', { name: /call$/ });
const panel = (page: Page) => page.locator('aside.spotify-panel');
const tile = (page: Page) => call(page).locator('.voice-tile.spotify');
const channelId = (page: Page, name: string) => page.evaluate(n => (window as unknown as MockWin).__vokkoMock.channelIdByName(n) ?? '', name);
const ids = (page: Page) => page.evaluate(() => (window as unknown as MockWin).__vokkoMockSpotify.ids);
const as = (page: Page, user: string, method: string, path: string, body?: unknown) =>
  page.evaluate(([u, m, p, b]) => (window as unknown as MockWin).__vokkoMock.requestAs(u as string, m as string, p as string, b), [user, method, path, body] as const);
const shot = (page: Page, name: string) => (mkdirSync(SHOTS, { recursive: true }), page.screenshot({ path: join(SHOTS, name) }));

async function openSpotify(page: Page, screenshot?: string): Promise<void> {
  await call(page).getByRole('button', { name: 'Activities' }).click();
  await expect(page.getByRole('menuitem', { name: /Spotify/ })).toBeVisible();
  if (screenshot) await shot(page, screenshot);
  await page.getByRole('menuitem', { name: /Spotify/ }).click();
  await expect(panel(page)).toBeVisible();
}

async function searchFor(page: Page, text: string): Promise<void> {
  await panel(page).getByRole('searchbox', { name: 'Search the public catalog' }).fill(text);
}

const trackRow = (page: Page, title: string) => panel(page).locator('.spotify-track').filter({ has: page.locator('.spotify-track-title', { hasText: title }) }).first();

test('search, play now, queue and play next from another user, skip, stop', async ({ page }) => {
  test.skip(MOBILE, 'desktop flow');
  await openGuild(page);
  const general = await channelId(page, 'General');
  const path = `/channels/${general}/spotify`;
  await page.getByRole('button', { name: 'General voice channel' }).click();
  await expect(call(page).locator('.voice-tile')).toHaveCount(3);

  await openSpotify(page, '01-activities-menu.png');
  await searchFor(page, 'daft');
  await expect(trackRow(page, 'One More Time')).toBeVisible();
  await expect(panel(page).getByRole('tab', { name: 'Tracks' })).toHaveAttribute('aria-selected', 'true');

  // Nothing plays yet: a track row offers Play only.
  await trackRow(page, 'One More Time').locator('.spotify-track-main').click();
  await expect(trackRow(page, 'One More Time').getByRole('button', { name: 'Add to queue' })).toHaveCount(0);
  await shot(page, '02-search-results.png');
  await page.evaluate(() => (window as unknown as MockWin).__vokkoMockSpotify.botDelay(1500));
  await trackRow(page, 'One More Time').getByRole('button', { name: 'Play', exact: true }).click();
  await expect(panel(page).getByRole('status').filter({ hasText: 'Playing One More Time.' })).toBeVisible();

  // The tile comes up starting, then plays with the viewer Room connected; the bot is no person.
  await expect(tile(page)).toHaveAttribute('data-status', 'starting');
  await expect(tile(page)).toHaveAttribute('data-status', 'playing', { timeout: 10_000 });
  await expect(tile(page)).toHaveAttribute('data-room', 'connected');
  await expect(tile(page).locator('.spotify-now-title')).toHaveText('One More Time');
  await expect(tile(page).locator('.spotify-head-by')).toHaveText('Started by Sam');
  await expect(call(page).locator('.voice-tile')).toHaveCount(4);
  await expect(page.locator('.voice-spotify-line')).toContainText('Listening to One More Time on Spotify');
  await expect(page.locator('[data-bot-identity^="bot:spotify:"]')).toContainText('Spotify');
  await page.evaluate(() => (window as unknown as MockWin).__vokkoMockSpotify.botDelay(200));

  // Album page from the Albums tab; while something plays, Play next and Add to queue show up.
  await panel(page).getByRole('tab', { name: 'Albums' }).click();
  await panel(page).locator('.spotify-card', { hasText: 'Discovery' }).click();
  await expect(panel(page).getByRole('heading', { name: 'Discovery' }).last()).toBeVisible();
  await expect(panel(page).locator('.spotify-page-head').getByRole('button', { name: 'Add to queue' })).toBeVisible();
  await shot(page, '03-album-page.png');
  await trackRow(page, 'Digital Love').locator('.spotify-track-main').click();
  await trackRow(page, 'Digital Love').getByRole('button', { name: 'Add to queue' }).click();
  await expect(panel(page).getByRole('status').filter({ hasText: 'Added Digital Love to the queue.' })).toBeVisible();

  // Bob, from his side: one track at the end, one to play next.
  const { tracks } = await ids(page);
  await as(page, 'bob', 'PATCH', path, { queue_add: { uri: tracks.find(t => t.includes('getlucky'))! } });
  await as(page, 'bob', 'PATCH', path, { queue_add: { uri: tracks.find(t => t.includes('aroundworld'))!, next: true } });
  await panel(page).getByRole('button', { name: 'Close Spotify' }).click();
  await tile(page).getByRole('button', { name: 'Focus Spotify' }).click();
  await expect(tile(page)).toHaveClass(/focused/);
  await tile(page).getByRole('button', { name: 'Up next (3)' }).click();
  const queue = tile(page).getByRole('complementary', { name: 'Up next' });
  await expect(queue.locator('.stremio-queue-item')).toHaveText([/Around the World.*added by Bob/, /Digital Love.*added by Sam/, /Get Lucky.*added by Bob/]);
  await shot(page, '04-tile-playing-up-next.png');

  // Remove one, skip from here, previous and loop from Alice: everyone follows the server.
  await queue.getByRole('button', { name: 'Remove Get Lucky from Up next' }).click();
  await expect(queue.locator('.stremio-queue-item')).toHaveCount(2);
  await tile(page).getByRole('button', { name: 'Skip' }).click();
  await expect(tile(page).locator('.spotify-now-title')).toHaveText('Around the World');
  await expect(queue.locator('.stremio-queue-item')).toHaveCount(1);
  await as(page, 'alice', 'PATCH', path, { loop: 'queue' });
  await expect(tile(page).getByRole('button', { name: 'Loop: queue' })).toHaveAttribute('aria-pressed', 'true');
  await as(page, 'alice', 'PATCH', path, { previous: true });
  await expect(tile(page).locator('.spotify-now-title')).toHaveText('One More Time');
  await tile(page).getByRole('button', { name: 'Pause' }).click();
  await expect(tile(page)).toHaveAttribute('data-playing', 'false');
  await tile(page).getByLabel('Spotify volume').fill('30');
  await expect(tile(page)).toHaveAttribute('data-volume', '30');

  // Stop ends it for everyone: the tile, the line and the bot row go.
  await tile(page).getByRole('button', { name: 'Stop Spotify' }).click();
  await expect(tile(page)).toHaveCount(0);
  await expect(page.locator('.voice-spotify-line')).toHaveCount(0);
  await expect(page.locator('[data-bot-identity^="bot:spotify:"]')).toHaveCount(0);
});

test('a late joiner gets the running session, and it ends when the call empties', async ({ page }) => {
  test.skip(MOBILE, 'desktop flow');
  await openGuild(page);
  const general = await channelId(page, 'General');
  const path = `/channels/${general}/spotify`;
  const { album } = await ids(page);
  await as(page, 'alice', 'PUT', path, { uri: `spotify:album:${album}` });
  await expect(page.locator('.voice-spotify-line')).toContainText('Listening to One More Time on Spotify');
  await expect(page.locator('[data-bot-identity^="bot:spotify:"]')).toBeVisible();
  await shot(page, '06-sidebar-line-bot-row.png');

  await page.getByRole('button', { name: 'General voice channel' }).click();
  await expect(tile(page)).toBeVisible();
  await expect(tile(page)).toHaveAttribute('data-status', 'playing', { timeout: 10_000 });
  await expect(tile(page)).toHaveAttribute('data-room', 'connected');
  await expect(tile(page).locator('.spotify-head-by')).toHaveText('Started by Alice');
  await expect(tile(page).getByRole('button', { name: /^Up next \(\d+\)$/ })).not.toHaveAccessibleName('Up next (0)');
  await expect(tile(page)).toHaveClass(/grid/);
  await shot(page, '05-grid-tile.png');

  // Joining the voice channel switched Activities on for the music: Stremio refuses to start on top of it.
  await expect(as(page, 'alice', 'PUT', `/channels/${general}/stremio`, { sid: 'x' })).rejects.toBeTruthy();

  await page.evaluate(() => {
    const hooks = (window as unknown as MockWin).__vokkoMock;
    hooks.voice('alice', null);
    hooks.voice('bob', null);
  });
  await expect(tile(page)).toBeVisible();
  await call(page).getByRole('button', { name: 'Leave voice channel' }).click();
  await expect(page.locator('.voice-spotify-line')).toHaveCount(0);
  await expect(page.locator('.voice-tile.spotify')).toHaveCount(0);
});

test("the bot's own User Volume and Mute: right-click its row or tile, kept after a reload", async ({ page }) => {
  await openGuild(page);
  const general = await channelId(page, 'General');
  const { album } = await ids(page);
  await as(page, 'alice', 'PUT', `/channels/${general}/spotify`, { uri: `spotify:album:${album}` });
  const row = page.locator('[data-bot-identity^="bot:spotify:"]');
  const slider = page.getByRole('slider', { name: 'User Volume' });

  await row.click({ button: 'right' });
  await expect(slider).toHaveValue('100');
  // a bot has no profile, DM or friendship: only the volume and the local mute
  await expect(page.locator('[role^="menuitem"]')).toHaveText(['Mute']);
  await slider.fill('150');
  await expect(page.locator('.voice-volume-value')).toHaveText('150%');
  if (MOBILE) await page.waitForTimeout(500); // the phone's bottom sheet slides in
  await shot(page, MOBILE ? 'bot-volume-phone.png' : 'bot-volume-sidebar.png');
  await page.getByRole('menuitemcheckbox', { name: 'Mute' }).click();
  await expect(row.getByRole('img', { name: 'Locally Muted' })).toBeVisible();
  await row.click({ button: 'right' });
  await page.getByRole('menuitemcheckbox', { name: 'Mute' }).click();
  await expect(row.getByRole('img', { name: 'Locally Muted' })).toHaveCount(0);

  if (!MOBILE) {
    // the tile in the call opens the same menu on the same setting
    await page.getByRole('button', { name: 'General voice channel' }).click();
    await expect(tile(page)).toHaveAttribute('data-status', 'playing', { timeout: 10_000 });
    await tile(page).locator('.spotify-now-title').click({ button: 'right' });
    await expect(slider).toHaveValue('150');
    await shot(page, 'bot-volume-tile.png');
    await page.keyboard.press('Escape');
  }

  // personal and local: the mock forgets the session on reload, the level stays in this client's voice settings
  await openGuild(page);
  await as(page, 'alice', 'PUT', `/channels/${await channelId(page, 'General')}/spotify`, { uri: `spotify:album:${album}` });
  await row.click({ button: 'right' });
  await expect(slider).toHaveValue('150');
});

test('409: the house account already plays in another channel', async ({ page }) => {
  test.skip(MOBILE, 'desktop flow');
  await openGuild(page);
  const gaming = await channelId(page, 'Gaming');
  const { tracks } = await ids(page);
  await page.evaluate(id => (window as unknown as MockWin).__vokkoMock.voice('alice', id), gaming);
  await as(page, 'alice', 'PUT', `/channels/${gaming}/spotify`, { uri: tracks[0] });

  await page.getByRole('button', { name: 'General voice channel' }).click();
  await expect(call(page).locator('.voice-tile')).toHaveCount(2);
  await openSpotify(page);
  await searchFor(page, 'digital');
  await trackRow(page, 'Digital Love').locator('.spotify-track-main').click();
  await trackRow(page, 'Digital Love').getByRole('button', { name: 'Play', exact: true }).click();
  const notice = panel(page).locator('.spotify-conflict');
  await expect(notice).toContainText("Spotify is already playing in #Gaming on Sam's server (started by Alice)");
  await expect(tile(page)).toHaveCount(0);
  await shot(page, '07-busy-40035.png');
  await notice.getByRole('button', { name: 'Dismiss' }).click();
  await expect(notice).toHaveCount(0);
});

test('phone width: menu, panel and tile fit the screen', async ({ page }) => {
  test.skip(!MOBILE, 'run with SPOTIFY_MOBILE=1');
  await openGuild(page);
  await page.getByRole('button', { name: 'General voice channel' }).click();
  await page.getByRole('button', { name: 'Join Voice', exact: true }).click();
  await openSpotify(page, 'm1-activities-menu.png');
  await searchFor(page, 'daft');
  await trackRow(page, 'One More Time').locator('.spotify-track-main').click();
  await shot(page, 'm2-search-results.png');
  await trackRow(page, 'One More Time').getByRole('button', { name: 'Play', exact: true }).click();
  await panel(page).getByRole('tab', { name: 'Albums' }).click();
  await panel(page).locator('.spotify-card', { hasText: 'Discovery' }).click();
  await expect(panel(page).locator('.spotify-page-head')).toBeVisible();
  await shot(page, 'm3-album-page.png');
  await panel(page).locator('.spotify-page-head').getByRole('button', { name: 'Add to queue' }).click();
  await panel(page).getByRole('button', { name: 'Close Spotify' }).click();
  await expect(tile(page)).toHaveAttribute('data-status', 'playing', { timeout: 10_000 });
  await tile(page).getByRole('button', { name: /^Up next/ }).click();
  await shot(page, 'm4-tile-up-next.png');
  const box = await tile(page).getByRole('button', { name: 'Stop Spotify' }).boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
});
