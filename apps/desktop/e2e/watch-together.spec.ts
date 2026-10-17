import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Watch Together against the mock backend (src/api/mock/watch.ts). There is no network to YouTube here: the embed page the
// tile loads (public/youtube-embed.html) is replaced by a stand-in that speaks the same postMessage protocol and shows what
// it was told in #s. The mock is per page, so "someone else in the call" is Alice or Bob, who are seeded in General, acting
// through __vokkoMock.requestAs.
// Run from apps/desktop: npx playwright test -c e2e/watch.config.ts

// Default under the test's own output dir (test-results/); call only inside a test.
const shotPath = () => process.env.WATCH_SHOT ?? test.info().outputPath('call.png');
const ID = 'dQw4w9WgXcQ';
const NEXT = 'aaaaaaaaaaa';

type MockWin = { __vokkoMock: { channelIdByName(name: string): string | null; requestAs(user: string, method: string, path: string, body?: unknown): unknown; voice(user: string, channelId: string | null): void } };

const FAKE_PLAYER = `<!doctype html><html><body style="margin:0;background:linear-gradient(135deg,#1b1f3a,#7a1f3d);color:#fff;font:600 28px system-ui;display:flex;align-items:center;justify-content:center;height:100vh">
<div>Stand-in YouTube player</div>
<div id="s" style="display:none"></div>
<script>
  var s = document.getElementById('s'), origin = null, pos = 0, playing = false, at = 0;
  function now() { return playing ? pos + (Date.now() - at) / 1000 : pos; }
  function show(extra) { s.dataset.pos = String(Math.round(now())); s.dataset.playing = String(playing); if (extra) for (var k in extra) s.dataset[k] = extra[k]; }
  function post(m) { if (origin) { m.source = 'vokko-embed'; parent.postMessage(m, origin); } }
  addEventListener('message', function (e) {
    var m = e.data;
    if (e.source !== parent || !m || typeof m.type !== 'string') return;
    origin = e.origin;
    if (m.type === 'init') post({ event: 'ready' });
    else if (m.type === 'load') {
      pos = m.startSeconds || 0; at = Date.now(); playing = m.autoplay !== false;
      show({ video: m.videoId });
      post({ event: 'state', state: playing ? 'playing' : 'cued' });
      post({ event: 'meta', title: 'Stand-in video ' + m.videoId });
    } else if (m.type === 'play') { if (!playing) { pos = now(); at = Date.now(); playing = true; post({ event: 'state', state: 'playing' }); } }
    else if (m.type === 'pause') { if (playing) { pos = now(); playing = false; post({ event: 'state', state: 'paused' }); } }
    else if (m.type === 'seek') { pos = m.seconds; at = Date.now(); }
    else if (m.type === 'volume') s.dataset.volume = String(m.volume);
    show();
  });
  setInterval(function () { show(); post({ event: 'time', seconds: now(), duration: 300 }); }, 250);
</script></body></html>`;

async function openGuild(page: Page): Promise<void> {
  await page.route('**/youtube-embed.html', route => route.fulfill({ contentType: 'text/html', body: FAKE_PLAYER }));
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.getByRole('list', { name: 'Channels' }).waitFor();
  await page.locator('.sidebar-scroller').evaluate(el => { el.scrollTop = el.scrollHeight; });
}

const call = (page: Page) => page.getByRole('region', { name: /call$/ });
const player = (page: Page) => page.frameLocator('iframe.watch-player').locator('#s');
const general = (page: Page) => page.evaluate(() => (window as unknown as MockWin).__vokkoMock.channelIdByName('General') ?? '');
const as = (page: Page, user: string, method: string, path: string, body?: unknown) =>
  page.evaluate(([u, m, p, b]) => (window as unknown as MockWin).__vokkoMock.requestAs(u as string, m as string, p as string, b), [user, method, path, body] as const);

test('start from a link in a call, pause, queue and skip from others, stop', async ({ page }) => {
  await openGuild(page);
  const channelId = await general(page);
  const path = `/channels/${channelId}/watch-together`;
  await page.getByRole('button', { name: 'General voice channel' }).click();
  await expect(call(page).locator('.voice-tile')).toHaveCount(3);

  // A link that is not YouTube is refused in the dialog; a real one starts the session and focuses the tile.
  await call(page).getByRole('button', { name: 'Watch Together', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Watch Together' });
  await dialog.getByLabel('YouTube link').fill('https://example.com/watch?v=' + ID);
  await dialog.getByRole('button', { name: 'Start Watching' }).click();
  await expect(dialog.getByRole('alert')).toContainText("doesn't look like a YouTube link");
  await dialog.getByLabel('YouTube link').fill(`https://youtu.be/${ID}?t=5`);
  await dialog.getByRole('button', { name: 'Start Watching' }).click();

  const tile = call(page).locator('.voice-tile.watch');
  await expect(tile).toHaveClass(/focused/);
  await expect(tile).toHaveAttribute('data-video-id', ID);
  await expect(tile).toHaveAttribute('data-playing', 'true');
  await expect(player(page)).toHaveAttribute('data-video', ID);
  await expect(player(page)).toHaveAttribute('data-playing', 'true');
  // The title the player learned is shared through the session.
  await expect(tile.locator('.watch-title')).toHaveText(`Stand-in video ${ID}`);
  await expect(tile.locator('.watch-by')).toHaveText('Started by Sam');
  // The sidebar line is for people outside the call; we are in it, but the row still shows it.
  await expect(page.locator('.voice-watch-line')).toHaveText('Watching YouTube Together');

  // The picture of the call with the tile.
  await page.waitForTimeout(600);
  const shot = shotPath();
  mkdirSync(dirname(shot), { recursive: true });
  await page.screenshot({ path: shot });

  // Alice (another person in the call) pauses: the tile and the player follow.
  await as(page, 'alice', 'PATCH', path, { playing: false, position_ms: 42_000 });
  await expect(tile).toHaveAttribute('data-playing', 'false');
  await expect(player(page)).toHaveAttribute('data-playing', 'false');
  await expect(player(page)).toHaveAttribute('data-pos', '42');
  await expect(tile.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  // A seek while paused moves the player too.
  await as(page, 'alice', 'PATCH', path, { position_ms: 100_000 });
  await expect(player(page)).toHaveAttribute('data-pos', '100');
  await as(page, 'bob', 'PATCH', path, { playing: true });
  await expect(player(page)).toHaveAttribute('data-playing', 'true');

  // Our own pause button goes through the server and comes back as the new state.
  await tile.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(tile).toHaveAttribute('data-playing', 'false');
  await expect(player(page)).toHaveAttribute('data-playing', 'false');

  // Queue: add from the panel (one bad link first), and Bob adds one too.
  await tile.getByRole('button', { name: 'Up next (0)' }).click();
  const queue = tile.getByRole('complementary', { name: 'Up next' });
  await queue.getByLabel('Add a YouTube link to the queue').fill('nonsense');
  await queue.getByRole('button', { name: 'Add' }).click();
  await expect(queue.getByRole('alert')).toBeVisible();
  await queue.getByLabel('Add a YouTube link to the queue').fill(`https://www.youtube.com/shorts/${NEXT}`);
  await queue.getByRole('button', { name: 'Add' }).click();
  await expect(queue.locator('.watch-queue-item')).toHaveText([NEXT]);
  await as(page, 'bob', 'PATCH', path, { queue_add: 'bbbbbbbbbbb' });
  await expect(queue.locator('.watch-queue-item')).toHaveText([NEXT, 'bbbbbbbbbbb']);

  // Skip plays the next one from the start, for everyone.
  await tile.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(tile).toHaveAttribute('data-video-id', NEXT);
  await expect(player(page)).toHaveAttribute('data-video', NEXT);
  await expect(player(page)).toHaveAttribute('data-playing', 'true');
  await expect(queue.locator('.watch-queue-item')).toHaveText(['bbbbbbbbbbb']);
  await as(page, 'alice', 'PATCH', path, { skip: true, video_id: NEXT });
  await expect(tile).toHaveAttribute('data-video-id', 'bbbbbbbbbbb');

  // Stop ends it for everyone and the tile goes.
  await tile.getByRole('button', { name: 'Stop Watch Together' }).click();
  await expect(call(page).locator('.voice-tile.watch')).toHaveCount(0);
  await expect(page.locator('.voice-watch-line')).toHaveCount(0);
  await expect(call(page).locator('.voice-tile')).toHaveCount(3);
});

test('someone else starts it: the sidebar line shows outside the call, the tile when we join, and it ends when the call empties', async ({ page }) => {
  await openGuild(page);
  const channelId = await general(page);
  const path = `/channels/${channelId}/watch-together`;

  // Not in the call: Alice starts a video.
  await as(page, 'alice', 'PUT', path, { video_id: ID });
  await expect(page.locator('.voice-watch-line')).toHaveText('Watching YouTube Together');
  await expect(page.locator('iframe.watch-player')).toHaveCount(0);

  // Joining brings the tile (and its player, playing) along.
  await page.getByRole('button', { name: 'General voice channel' }).click();
  const tile = call(page).locator('.voice-tile.watch');
  await expect(tile).toBeVisible();
  await expect(tile.locator('.watch-by')).toHaveText('Started by Alice');
  await expect(player(page)).toHaveAttribute('data-video', ID);
  // A watch tile can be focused from the grid and put back.
  await tile.getByRole('button', { name: 'Focus Watch Together' }).click();
  await expect(tile).toHaveClass(/focused/);
  await tile.getByRole('button', { name: 'Back to grid' }).click();
  await expect(tile).toHaveClass(/grid/);

  // Everyone leaves: the session ends with the last person.
  await page.evaluate(() => {
    const hooks = (window as unknown as MockWin).__vokkoMock;
    hooks.voice('alice', null);
    hooks.voice('bob', null);
  });
  await expect(tile).toBeVisible();
  await call(page).getByRole('button', { name: 'Leave voice channel' }).click();
  await expect(page.locator('.voice-watch-line')).toHaveCount(0);
  await expect(page.locator('.voice-tile.watch')).toHaveCount(0);
});
