import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { channelIdOf, message, openDm, send } from './helpers';

type Win = { __vokko: { request(m: string, p: string, b?: unknown): Promise<unknown>; gateway: { dispatch(t: string, d: unknown): void } } };

const POSTER = '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="#3b4a6b"/>'
  + '<text x="640" y="380" font-size="64" fill="#fff" text-anchor="middle" font-family="sans-serif">Poster</text></svg>';
const PLAYER = '<!doctype html><body style="margin:0;background:#111;color:#fff;font:24px sans-serif;display:grid;place-items:center;height:100vh">Stub player</body>';

/** Stubs the poster and the player hosts (nothing reaches YouTube) and records every request to them. */
async function stubPlayers(page: Page): Promise<string[]> {
  const hits: string[] = [];
  await page.route('https://img.example/**', route => route.fulfill({ contentType: 'image/svg+xml', body: POSTER }));
  await page.route(/^https:\/\/(www\.youtube-nocookie\.com|www\.youtube\.com|youtube\.com)\//, route => { hits.push(route.request().url()); return route.fulfill({ contentType: 'text/html', body: PLAYER }); });
  return hits;
}

/** Sends a link and pushes a YouTube-shaped unfurl onto it, as the server would. */
async function sendUnfurled(page: Page, text: string, videoUrl: string): Promise<void> {
  await send(page, text);
  const m = message(page, text);
  await expect(m).not.toHaveClass(/pending/);
  const id = await m.getAttribute('data-message-id');
  await page.evaluate(async ([cid, id, videoUrl]) => {
    const w = window as unknown as Win;
    const list = await w.__vokko.request('GET', `/channels/${cid}/messages?limit=10`) as { id: string }[];
    w.__vokko.gateway.dispatch('MESSAGE_UPDATE', {
      ...list.find(x => x.id === id)!,
      embeds: [{
        type: 'video', title: 'A video', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', provider: { name: 'YouTube' },
        thumbnail: { url: 'https://img.example/poster.svg', width: 1280, height: 720 },
        video: { url: videoUrl, width: 1280, height: 720 },
      }],
    });
  }, [channelIdOf(page), id, videoUrl] as const);
}

test('a player embed shows its poster and plays in an iframe only after the click', async ({ page }) => {
  const hits = await stubPlayers(page);
  await openDm(page);
  await sendUnfurled(page, 'watch https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/embed/dQw4w9WgXcQ');
  const m = message(page, 'watch https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  const poster = m.getByRole('link', { name: 'Play video' });
  await expect(poster.locator('img')).toBeVisible();
  await expect(m.locator('iframe')).toHaveCount(0);
  const dir = process.env.VOKKO_SHOTS_DIR;
  if (dir) await page.screenshot({ path: `${dir}/player-before.png` });
  const box = await poster.locator('img').boundingBox();
  expect(hits).toEqual([]);

  await poster.click();
  const frame = m.locator('iframe.chat-embed-player');
  await expect(frame).toHaveAttribute('src', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1');
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
  await expect(frame).toHaveAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
  await expect(frame).toHaveAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
  await expect(page.frameLocator('iframe.chat-embed-player').getByText('Stub player')).toBeVisible();
  const after = await frame.boundingBox();
  expect(Math.abs(after!.width - box!.width)).toBeLessThan(2);
  expect(Math.abs(after!.height - box!.height)).toBeLessThan(2);
  await expect(page.getByRole('dialog', { name: /Leaving/ })).toHaveCount(0);
  if (dir) await page.screenshot({ path: `${dir}/player-after.png` });
});

test('a non-player video page keeps the poster that opens the link', async ({ page }) => {
  await stubPlayers(page);
  await openDm(page);
  await sendUnfurled(page, 'other https://videos.example/watch/1', 'https://videos.example/embed/1');
  const m = message(page, 'other https://videos.example/watch/1');
  await m.getByRole('link', { name: 'Open video' }).click();
  await expect(page.getByRole('dialog', { name: /Leaving/ })).toBeVisible();
  await expect(m.locator('iframe')).toHaveCount(0);
});

test('screenshot player embed at phone width', async ({ page }) => {
  const dir = process.env.VOKKO_SHOTS_DIR;
  test.skip(!dir, 'set VOKKO_SHOTS_DIR to capture screenshots');
  await page.setViewportSize({ width: 390, height: 844 });
  await stubPlayers(page);
  await openDm(page);
  await sendUnfurled(page, 'phone https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/embed/dQw4w9WgXcQ');
  const m = message(page, 'phone https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await expect(m.locator('.chat-embed-poster img')).toBeVisible();
  await page.screenshot({ path: `${dir}/player-before-390.png` });
  await m.getByRole('link', { name: 'Play video' }).click();
  await expect(page.frameLocator('iframe.chat-embed-player').getByText('Stub player')).toBeVisible();
  await page.screenshot({ path: `${dir}/player-after-390.png` });
});
