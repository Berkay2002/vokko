import { expect, test, type Page } from '@playwright/test';

// Long calls (docs/perf.md, "Long calls"): watching and unwatching a stream over and over leaves no <video> behind, and a
// stream viewer that stops watching holds no picture. Mock backend, FakeTransport paints the stream.

type MockWin = { __vokkoMock: { channelIdByName(name: string): string | null; say(channelId: string, username: string, content: string): string; voice(user: string, channelId: string | null, opts?: { selfVideo?: boolean; selfStream?: boolean }): void } };

const call = (page: Page) => page.getByRole('region', { name: /call$/ });

test('ten watch / stop-watching cycles leave exactly the videos on screen', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.getByRole('button', { name: 'General voice channel' }).click();
  await expect(page.getByRole('region', { name: 'Voice connection' }).getByRole('status')).toHaveText('Voice Connected');
  await page.evaluate(() => {
    const m = (window as unknown as MockWin).__vokkoMock;
    const general = m.channelIdByName('General');
    m.voice('alice', general, { selfStream: true });
    m.voice('bob', general, { selfVideo: true });
  });
  const alice = call(page).locator('.voice-tile.stream', { hasText: 'Alice' });
  await expect(call(page).locator('video[data-source="camera"]')).toHaveCount(1);
  for (let i = 0; i < 10; i++) {
    await alice.getByRole('button', { name: 'Watch Stream' }).click();
    await expect(alice.locator('video[data-source="screen"]')).toBeVisible();
    await page.keyboard.press('Escape'); // back to the grid, where the quality menu lives on the tile
    await alice.getByRole('button', { name: 'Stream quality' }).click();
    await page.getByRole('menuitem', { name: 'Stop Watching' }).click();
    await expect(alice.locator('video')).toHaveCount(0);
  }
  // Bob's camera is the only picture left anywhere in the page.
  await expect(page.locator('video')).toHaveCount(1);
});

test('a menu on a stream tile stays open while the call chat follows new messages', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.getByRole('button', { name: 'General voice channel' }).click();
  await expect(page.getByRole('region', { name: 'Voice connection' }).getByRole('status')).toHaveText('Voice Connected');
  const general = await page.evaluate(() => {
    const m = (window as unknown as MockWin).__vokkoMock;
    const id = m.channelIdByName('General')!;
    m.voice('alice', id, { selfStream: true });
    for (let k = 0; k < 40; k++) m.say(id, 'bob', `before ${k}`);
    return id;
  });
  const alice = call(page).locator('.voice-tile.stream', { hasText: 'Alice' });
  await alice.getByRole('button', { name: 'Watch Stream' }).click();
  await page.keyboard.press('Escape');
  await call(page).getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Show Chat' }).click();
  const chat = page.getByRole('complementary', { name: /chat$/ });
  await expect(chat.locator('.chat-content', { hasText: 'before 39' })).toBeVisible();
  await alice.getByRole('button', { name: 'Stream quality' }).click();
  const stop = page.getByRole('menuitem', { name: 'Stop Watching' });
  await expect(stop).toBeVisible();
  for (let k = 0; k < 5; k++) {
    await page.evaluate(({ id, k }) => (window as unknown as MockWin).__vokkoMock.say(id, 'bob', `after ${k}`), { id: general, k });
    await expect(chat.locator('.chat-content', { hasText: `after ${k}` })).toBeVisible();
  }
  await expect(stop).toBeVisible();
});
