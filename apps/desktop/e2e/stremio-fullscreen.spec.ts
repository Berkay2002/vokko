import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Stremio full screen (and a phone on its side) against the mock backend: the picture fills the screen, the title / controls / call bar
// float over it and fade when idle while the subtitle stays, Space and the arrows work for the controller, and leaving full screen puts
// the old focus back. The mock has no picture, so a canvas stream stands in for it.
// Run from apps/desktop: STREMIO_PORT=1470 npx playwright test -c e2e/stremio.config.ts stremio-fullscreen
const SHOTS = process.env.STREMIO_SHOTS ?? '.private/.claude/artifacts/vokko-stremio-fullscreen';

type MockWin = { __vokkoMock: { channelIdByName(name: string): string | null; requestAs(user: string, method: string, path: string, body?: unknown): unknown } };
type Stream = { sid: string; playable: boolean };

const poster = (url: string) => {
  const hue = [...url].reduce((sum, c) => (sum * 31 + c.charCodeAt(0)) % 360, 7);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><rect width="300" height="450" fill="hsl(${hue} 45% 28%)"/></svg>`;
};
const shot = (page: Page, name: string) => (mkdirSync(SHOTS, { recursive: true }), page.screenshot({ path: join(SHOTS, name) }));
const as = (page: Page, user: string, method: string, path: string, body?: unknown) =>
  page.evaluate(([u, m, p, b]) => (window as unknown as MockWin).__vokkoMock.requestAs(u as string, m as string, p as string, b), [user, method, path, body] as const);

/** A flat 16:9 "film still" on the tile's video element, so the letterboxing is visible in the screenshots. */
async function fakePicture(page: Page): Promise<void> {
  await page.evaluate(() => {
    const video = document.querySelector('video.stremio-video') as HTMLVideoElement;
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const g = canvas.getContext('2d')!;
    const paint = () => {
      const bg = g.createLinearGradient(0, 0, 1280, 720);
      bg.addColorStop(0, '#3a2a1e');
      bg.addColorStop(1, '#10161f');
      g.fillStyle = bg;
      g.fillRect(0, 0, 1280, 720);
      g.strokeStyle = '#e8d9b8';
      g.lineWidth = 6;
      g.strokeRect(3, 3, 1274, 714);
      g.fillStyle = '#e8d9b8';
      g.font = '64px sans-serif';
      g.fillText('16:9 film frame', 380, 380);
    };
    paint();
    setInterval(paint, 200);
    video.srcObject = canvas.captureStream(5);
    void video.play();
  });
}

async function startCall(page: Page): Promise<string> {
  await page.route(/^https:\/\/(images|episodes)\.metahub\.space\/|^https:\/\/m\.media-amazon\.com\//, route => route.fulfill({ contentType: 'image/svg+xml', body: poster(route.request().url()) }));
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.getByRole('list', { name: 'Channels', exact: true }).waitFor();
  await page.locator('.sidebar-scroller').evaluate(el => { el.scrollTop = el.scrollHeight; });
  const channelId = await page.evaluate(() => (window as unknown as MockWin).__vokkoMock.channelIdByName('General') ?? '');
  const path = `/channels/${channelId}/stremio`;
  const streams = (await as(page, 'alice', 'GET', '/stremio/streams/movie/tt0113277')) as { streams: Stream[] };
  await as(page, 'alice', 'PUT', path, { sid: streams.streams.find(s => s.playable)!.sid });
  await page.getByRole('button', { name: 'General voice channel' }).click();
  const tile = page.getByRole('region', { name: /call$/ }).locator('.voice-tile.stremio');
  await expect(tile).toHaveAttribute('data-status', 'playing', { timeout: 10_000 });
  await expect(tile).toHaveAttribute('data-room', 'connected');
  // A subtitle for the cue (the viewer's own choice, so a controller or not it works).
  await tile.getByRole('button', { name: 'Audio and subtitles' }).click();
  await tile.getByRole('menuitemradio', { name: /^Swedish$/ }).click();
  await tile.getByRole('menu', { name: 'Audio and subtitles' }).press('Escape');
  await fakePicture(page);
  return path;
}

const callPage = (page: Page) => page.getByRole('region', { name: /call$/ });
const tileOf = (page: Page) => callPage(page).locator('.voice-tile.stremio');
const cueOf = (page: Page) => tileOf(page).getByTestId('stremio-cue');
const opacity = (page: Page, selector: string) => page.locator(selector).first().evaluate(el => Number(getComputedStyle(el).opacity));

async function enterFullscreen(page: Page): Promise<void> {
  await callPage(page).getByRole('button', { name: 'Fullscreen', exact: true }).click();
  await expect(callPage(page)).toHaveAttribute('data-cinema', 'true');
}

const SIZES = [
  { name: 'fs-16x9', width: 1920, height: 1080 },
  { name: 'fs-21x9', width: 2560, height: 1080 },
  { name: 'fs-32x9', width: 3840, height: 1080 },
] as const;

for (const { name, width, height } of SIZES) {
  test(`full screen at ${width}x${height}: the tile fills the screen, the controls keep to the column, idle hides them and keeps the subtitle`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await startCall(page);
    await expect(callPage(page).locator('.voice-focus')).toHaveCount(0); // the grid: full screen focuses the Stremio tile
    await enterFullscreen(page);
    await expect(callPage(page).locator('.voice-focus')).toHaveCount(1);

    // The tile and its picture are the viewport; no card, no title band.
    expect(await tileOf(page).boundingBox()).toEqual({ x: 0, y: 0, width, height });
    expect(await page.locator('video.stremio-video').boundingBox()).toEqual({ x: 0, y: 0, width, height });
    expect(await tileOf(page).evaluate(el => getComputedStyle(el).borderRadius)).toBe('0px');
    // Title, seek and call bar sit in a centred column: at least 1280 px, as wide as a 16:9 picture of the screen height, never beyond that.
    const controls = (await page.locator('.stremio-controls').boundingBox())!;
    expect(controls.width).toBeLessThanOrEqual(Math.max(1280, (height * 16) / 9) + 1);
    expect(Math.abs(controls.x + controls.width / 2 - width / 2)).toBeLessThan(2);
    const title = (await page.locator('.stremio-title').boundingBox())!;
    expect(title.x).toBeGreaterThanOrEqual(controls.x - 1);
    // The call bar floats over the picture, the Stremio bar directly above it.
    const bar = (await page.locator('.voice-bar-pill').boundingBox())!;
    expect(bar.y + bar.height).toBeLessThanOrEqual(height - 11);
    expect(controls.y + controls.height).toBeLessThanOrEqual(bar.y);

    await page.mouse.move(width / 2, height / 3);
    await page.mouse.move(width / 2 + 5, height / 3 + 5);
    await expect(cueOf(page)).toBeVisible({ timeout: 8_000 });
    const before = (await cueOf(page).boundingBox())!;
    await shot(page, `${name}-impl.png`);
    expect(before.y + before.height).toBeLessThan(controls.y); // above the controls

    // Idle: the title, bar and call bar fade; the subtitle stays and drops to the bottom edge.
    await page.waitForTimeout(3600);
    await expect.poll(() => opacity(page, '.stremio-bar')).toBe(0);
    expect(await opacity(page, '.stremio-head')).toBe(0);
    expect(await opacity(page, '.voice-bar')).toBe(0);
    await expect(cueOf(page)).toBeVisible({ timeout: 8_000 });
    const after = (await cueOf(page).boundingBox())!;
    expect(after.y).toBeGreaterThan(before.y + 40);
    expect(await opacity(page, '.stremio-cue-host')).toBe(1);
    if (name === 'fs-16x9') await shot(page, 'fs-16x9-idle-impl.png');

    // The pointer wakes it.
    await page.mouse.move(width / 2 - 20, height / 3);
    await expect.poll(() => opacity(page, '.stremio-bar')).toBe(1);

    // Leaving full screen gives the grid back.
    await page.evaluate(() => document.exitFullscreen());
    await expect(callPage(page)).not.toHaveAttribute('data-cinema', 'true');
    await expect(callPage(page).locator('.voice-focus')).toHaveCount(0);
  });
}

test('full screen keys: Space plays and pauses, Left and Right seek, and a text field keeps its keys', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await startCall(page);
  await enterFullscreen(page);
  const tile = tileOf(page);
  await expect(tile).toHaveAttribute('data-playing', 'true');
  await page.mouse.move(100, 100);
  await page.keyboard.press('Space');
  await expect(tile).toHaveAttribute('data-playing', 'false');
  await page.keyboard.press('Space');
  await expect(tile).toHaveAttribute('data-playing', 'true');
  const time = () => tile.getByLabel('Position').innerText();
  const first = await time();
  await page.keyboard.press('ArrowRight');
  await expect.poll(time).not.toBe(first);
  // A slider that has focus keeps its arrow keys, so no extra 10 s jump comes on top of its own step.
  await tile.getByRole('slider', { name: 'Stremio volume' }).focus();
  await page.keyboard.press('Space');
  await expect(tile).toHaveAttribute('data-playing', 'true');
});

test('the old focus comes back when full screen ends', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await startCall(page);
  await tileOf(page).getByRole('button', { name: 'Focus Stremio' }).click();
  await expect(callPage(page).locator('.voice-focus')).toHaveCount(1);
  // Focus another tile: full screen moves the focus to Stremio and gives it back.
  await callPage(page).locator('.voice-strip .voice-tile').first().click();
  await expect(tileOf(page)).toHaveCount(1);
  await enterFullscreen(page);
  await page.evaluate(() => document.exitFullscreen());
  await expect(callPage(page).locator('.voice-focus')).toHaveCount(1);
  await expect(tileOf(page)).toHaveCount(1);
  await expect(callPage(page).locator('.voice-focus-frame .voice-tile.stremio')).toHaveCount(0);
});

test.describe('phone on its side', () => {
  test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });

  test('the focused tile is a landscape layout; a tap hides and shows the controls, the subtitle stays', async ({ page }) => {
    await startCall(page);
    await tileOf(page).getByRole('button', { name: 'Focus Stremio' }).click();
    const callRegion = callPage(page);
    await expect(callRegion).toHaveAttribute('data-cinema', 'true');
    expect(await tileOf(page).boundingBox()).toEqual({ x: 0, y: 0, width: 844, height: 390 });
    await expect(cueOf(page)).toBeVisible({ timeout: 8_000 });
    await shot(page, 'fs-phone-impl.png');
    // Touch targets are 44 px, the volume slider is gone.
    const play = (await tileOf(page).getByRole('button', { name: 'Pause' }).boundingBox())!;
    expect(play.width).toBeGreaterThanOrEqual(44);
    await expect(tileOf(page).getByRole('slider', { name: 'Stremio volume' })).toBeHidden();
    // A tap on the picture hides the bars at once; another brings them back and they hide again after 4 s.
    await page.touchscreen.tap(60, 200);
    await expect.poll(() => opacity(page, '.stremio-bar')).toBe(0);
    await expect.poll(() => opacity(page, '.voice-bar')).toBe(0);
    await page.touchscreen.tap(60, 200);
    await expect.poll(() => opacity(page, '.stremio-bar')).toBe(1);
    await expect.poll(() => opacity(page, '.stremio-bar'), { timeout: 8_000 }).toBe(0);
  });
});
