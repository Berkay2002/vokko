import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Who controls media in a call (docs/design/bot-control.md) against the mock backend. Sam's server is put in "DJ mode"
// (CONTROL_MEDIA off @everyone), and the page is Carol, a plain member: no control unless he hosts. Alice (host of what she
// starts) and Bob are seeded in General and act through __vokkoMock.requestAs, so the call has three listeners and a skip
// needs two votes.
// Run from apps/desktop: npx playwright test -c e2e/bot-control.config.ts

const SHOTS = process.env.BOTCTL_SHOTS ?? '/srv/vokko/.claude/artifacts/bot-control';
const VIDEO = 'dQw4w9WgXcQ';
const QUEUED = ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'];
const CONTROL_MEDIA = 1n << 60n;

type MockWin = {
  __vokkoMock: { channelIdByName(name: string): string | null; requestAs(user: string, method: string, path: string, body?: unknown): unknown };
  __vokkoMockSpotify: { ids: { tracks: string[] } };
};

// The YouTube embed answers with a stand-in that speaks the embed protocol (as in watch-together.spec.ts) but never ends.
const FAKE_PLAYER = `<!doctype html><html><body style="margin:0;background:linear-gradient(135deg,#1b1f3a,#7a1f3d);height:100vh"><script>
  var origin = null, pos = 0, at = Date.now(), playing = true;
  function now() { return playing ? pos + (Date.now() - at) / 1000 : pos; }
  function post(m) { if (origin) { m.source = 'vokko-embed'; parent.postMessage(m, origin); } }
  addEventListener('message', function (e) {
    var m = e.data;
    if (e.source !== parent || !m || typeof m.type !== 'string') return;
    origin = e.origin;
    if (m.type === 'init') post({ event: 'ready' });
    else if (m.type === 'load') { pos = m.startSeconds || 0; at = Date.now(); post({ event: 'state', state: 'playing' }); post({ event: 'meta', title: 'Stand-in video ' + m.videoId }); }
  });
  setInterval(function () { post({ event: 'time', seconds: now(), duration: 300 }); }, 250);
</script></body></html>`;

type StoreWin = { __vokko: { appStore: { getState(): { channels: Record<string, { guild_id: string | null }>; guilds: Record<string, { roles: { id: string; permissions: string }[] }> } } } };

const call = (page: Page) => page.getByRole('region', { name: /call$/ });
const as = (page: Page, user: string, method: string, path: string, body?: unknown) =>
  page.evaluate(([u, m, p, b]) => (window as unknown as MockWin).__vokkoMock.requestAs(u as string, m as string, p as string, b), [user, method, path, body] as const);
/** The API error code of a request that should fail, or null. */
const errorCode = (page: Page, user: string, method: string, path: string, body?: unknown) =>
  page.evaluate(([u, m, p, b]) => {
    try {
      (window as unknown as MockWin).__vokkoMock.requestAs(u as string, m as string, p as string, b);
      return null;
    } catch (e) {
      return (e as { api?: { code?: number } }).api?.code ?? -1;
    }
  }, [user, method, path, body] as const);

/** A non-controller's view of a tile with one vote in, at desktop and phone width. */
async function shots(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}-1440.png`) });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, `${name}-390.png`) });
  await page.setViewportSize({ width: 1440, height: 900 });
}

/** Signs in as Carol, turns on DJ mode in Sam's server and joins General (Alice and Bob are there). Returns General's id. */
async function joinAsMember(page: Page): Promise<string> {
  await page.route('**/youtube-embed.html', route => route.fulfill({ contentType: 'text/html', body: FAKE_PLAYER }));
  await page.route(/^https:\/\/(i\.scdn\.co|images\.metahub\.space)\//, route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#456"/></svg>' }));
  await page.goto('/channels/@me?as=carol&mockLatency=0');
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.getByRole('list', { name: 'Channels' }).waitFor();
  const general = await page.evaluate(() => (window as unknown as MockWin).__vokkoMock.channelIdByName('General') ?? '');
  const guildId = await page.evaluate(id => (window as unknown as StoreWin).__vokko.appStore.getState().channels[id]!.guild_id!, general);
  const everyone = await page.evaluate(id => (window as unknown as StoreWin).__vokko.appStore.getState().guilds[id]!.roles.find(r => r.id === id)!, guildId);
  await as(page, 'sam', 'PATCH', `/guilds/${guildId}/roles/${guildId}`, { permissions: (BigInt(everyone.permissions) & ~CONTROL_MEDIA).toString() });
  await page.locator('.sidebar-scroller').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.getByRole('button', { name: 'General voice channel' }).click();
  await expect(call(page).locator('.voice-tile')).toHaveCount(3);
  return general;
}

test('Watch Together: a non-controller votes, queues up to the quota, skips what they added, and controls what they start', async ({ page }) => {
  const general = await joinAsMember(page);
  const path = `/channels/${general}/watch-together`;
  await as(page, 'alice', 'PUT', path, { video_id: VIDEO });
  const tile = call(page).locator('.voice-tile.watch');
  await expect(tile).toHaveAttribute('data-video-id', VIDEO);

  // No play / pause, seek or stop; Skip is a vote.
  await expect(tile.getByRole('button', { name: 'Pause' })).toHaveCount(0);
  await expect(tile.getByRole('button', { name: 'Stop Watch Together' })).toHaveCount(0);
  await expect(tile.getByRole('slider', { name: 'Seek' })).toHaveCount(0);
  const vote = tile.getByRole('button', { name: /^Vote to skip/ });
  await expect(vote).toHaveAccessibleName('Vote to skip (0/2)');

  // Three of my own in Up next, then the form says so and refuses more (the server does too).
  await tile.getByRole('button', { name: /^Up next/ }).click();
  const queue = tile.getByRole('complementary', { name: 'Up next' });
  for (const id of QUEUED) {
    await queue.getByLabel('Add a YouTube link to the queue').fill(`https://youtu.be/${id}`);
    await queue.getByRole('button', { name: 'Add' }).click();
    await expect(queue.locator('.watch-queue-item')).toHaveCount(QUEUED.indexOf(id) + 1);
  }
  await expect(queue.locator('.media-quota')).toHaveText('3 of 3 added');
  await queue.getByLabel('Add a YouTube link to the queue').fill('https://youtu.be/ddddddddddd');
  await expect(queue.getByRole('button', { name: 'Add' })).toBeDisabled();
  expect(await errorCode(page, 'carol', 'PATCH', path, { queue_add: 'ddddddddddd' })).toBe(50035);
  await tile.getByRole('button', { name: /^Up next/ }).click();

  // One vote of two: everyone sees the count; withdrawing and voting again works.
  await vote.click();
  await expect(vote).toHaveAccessibleName('Vote to skip (1/2)');
  await expect(vote).toHaveAttribute('aria-pressed', 'true');
  await expect(tile.locator('.media-votes')).toHaveText('1 of 2 voted to skip');
  await shots(page, 'watch-vote');
  await vote.click();
  await expect(vote).toHaveAccessibleName('Vote to skip (0/2)');
  await vote.click();
  await as(page, 'bob', 'PATCH', path, { skip: true, video_id: VIDEO });
  await expect(tile).toHaveAttribute('data-video-id', QUEUED[0]!);

  // I added this one: Skip skips it at once.
  await expect(tile.getByRole('button', { name: 'Skip', exact: true })).toBeVisible();
  await tile.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(tile).toHaveAttribute('data-video-id', QUEUED[1]!);

  // Alice (the host) stops it; then I start one and host it, so I control it.
  await as(page, 'alice', 'DELETE', path);
  await expect(tile).toHaveCount(0);
  await call(page).getByRole('button', { name: 'Watch Together', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Watch Together' });
  await dialog.getByLabel('YouTube link').fill(`https://youtu.be/${VIDEO}`);
  await dialog.getByRole('button', { name: 'Start Watching' }).click();
  await expect(tile.getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect(tile.getByRole('button', { name: 'Stop Watch Together' })).toBeVisible();
  expect(await errorCode(page, 'alice', 'PATCH', path, { playing: false })).toBe(50013);
  await tile.getByRole('button', { name: 'Stop Watch Together' }).click();
  await expect(tile).toHaveCount(0);
});

test('Stremio: a non-controller has no transport or track controls and votes the item off', async ({ page }) => {
  const general = await joinAsMember(page);
  const path = `/channels/${general}/stremio`;
  const sid = async (who: string, title: string) => ((await as(page, who, 'GET', `/stremio/streams/movie/${title}`)) as { streams: { sid: string; playable: boolean }[] }).streams.find(s => s.playable)!.sid;
  await as(page, 'alice', 'PUT', path, { sid: await sid('alice', 'tt0113277') });
  await as(page, 'alice', 'PATCH', path, { queue_add: await sid('alice', 'tt0133093') });
  await as(page, 'bob', 'PATCH', path, { queue_add: await sid('bob', 'tt1375666') });
  const tile = call(page).locator('.voice-tile.stremio');
  await expect(tile).toHaveAttribute('data-status', 'playing', { timeout: 10_000 });

  for (const name of ['Pause', 'Back 10 seconds', 'Forward 10 seconds', 'Stop Stremio']) await expect(tile.getByRole('button', { name })).toHaveCount(0);
  await expect(tile.getByRole('slider', { name: 'Seek' })).toHaveCount(0);
  await tile.getByRole('button', { name: 'Audio and subtitles' }).click();
  await expect(tile.getByRole('menuitemradio', { name: /English/ }).first()).toBeDisabled();
  await tile.getByRole('button', { name: 'Audio and subtitles' }).click();
  // Nobody's entries are mine to remove.
  await tile.getByRole('button', { name: 'Up next (2)' }).click();
  await expect(tile.getByRole('button', { name: /^Remove / })).toHaveCount(0);
  await expect(tile.locator('.media-quota')).toHaveText('0 of 2 added');
  await tile.getByRole('button', { name: 'Up next (2)' }).click();

  const vote = tile.getByRole('button', { name: /^Vote to skip/ });
  await vote.click();
  await expect(vote).toHaveAccessibleName('Vote to skip (1/2)');
  await expect(tile.locator('.media-votes')).toHaveText('1 of 2 voted to skip');
  await shots(page, 'stremio-vote');
  await as(page, 'bob', 'PATCH', path, { skip: true });
  await expect(tile).toHaveAttribute('aria-label', 'Stremio: The Matrix');
  await expect(vote).toHaveAccessibleName('Vote to skip (0/2)');
  expect(await errorCode(page, 'carol', 'DELETE', path)).toBe(50013);
  await as(page, 'alice', 'DELETE', path);
  await expect(tile).toHaveCount(0);
});

test('Spotify: a non-controller only adds to the end, removes their own entry and votes', async ({ page }) => {
  const general = await joinAsMember(page);
  const path = `/channels/${general}/spotify`;
  const { tracks } = await page.evaluate(() => (window as unknown as MockWin).__vokkoMockSpotify.ids);
  await as(page, 'alice', 'PUT', path, { uri: tracks.find(t => t.includes('omt'))! });
  const tile = call(page).locator('.voice-tile.spotify');
  await expect(tile).toHaveAttribute('data-status', 'playing', { timeout: 10_000 });
  for (const name of ['Pause', 'Previous', 'Shuffle the queue', 'Loop: off', 'Stop Spotify']) await expect(tile.getByRole('button', { name })).toHaveCount(0);
  await expect(tile.getByRole('slider', { name: 'Seek' })).toHaveCount(0);

  // The panel offers Add to queue only (no Play now, no Play next).
  await call(page).getByRole('button', { name: 'Activities' }).click();
  await page.getByRole('menuitem', { name: /Spotify/ }).click();
  const panel = page.locator('aside.spotify-panel');
  await panel.getByRole('searchbox', { name: 'Search the public catalog' }).fill('strobe');
  const row = panel.locator('.spotify-track').filter({ hasText: 'Strobe' }).first();
  await row.locator('.spotify-track-main').click();
  await expect(row.getByRole('button', { name: /^Play/ })).toHaveCount(0);
  await row.getByRole('button', { name: 'Add to queue' }).click();
  await expect(panel.getByRole('status').filter({ hasText: 'Added Strobe to the queue.' })).toBeVisible();
  await panel.getByRole('button', { name: 'Close Spotify' }).click();
  await as(page, 'bob', 'PATCH', path, { queue_add: { uri: tracks.find(t => t.includes('dafunk'))! } });
  expect(await errorCode(page, 'carol', 'PATCH', path, { queue_add: { uri: tracks.find(t => t.includes('dafunk'))!, next: true } })).toBe(50013);

  await tile.getByRole('button', { name: 'Up next (2)' }).click();
  const queue = tile.getByRole('complementary', { name: 'Up next' });
  await expect(queue.getByRole('button', { name: /^Remove / })).toHaveCount(1);
  await expect(queue.getByRole('button', { name: 'Remove Strobe from Up next' })).toBeVisible();
  await expect(queue.locator('.media-quota')).toHaveText('1 of 10 added');
  await tile.getByRole('button', { name: 'Up next (2)' }).click();

  const vote = tile.getByRole('button', { name: /^Vote to skip/ });
  await vote.click();
  await expect(vote).toHaveAccessibleName('Vote to skip (1/2)');
  await expect(tile.locator('.media-votes')).toHaveText('1 of 2 voted to skip');
  await shots(page, 'spotify-vote');
  await as(page, 'bob', 'PATCH', path, { skip: true });
  await expect(tile.locator('.spotify-now-title')).toHaveText('Strobe');
  // Mine now: Skip goes at once.
  await tile.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(tile.locator('.spotify-now-title')).toHaveText('Da Funk');
  await as(page, 'alice', 'DELETE', path);
  await expect(tile).toHaveCount(0);
});
