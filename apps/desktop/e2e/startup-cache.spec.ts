import { expect, test } from '@playwright/test';

// Restart cache (src/cache/startupCache.ts): a start at `/` reopens the last channel from IndexedDB before READY, stale until
// READY arrives. The mock holds READY back with localStorage `vokko.mock.readyDelay`. Mock ids are minted per page load, so after
// the real READY the cached channel no longer exists and the app falls back to Home; the real server keeps ids and stays put.

test('a restart shows the last channel from the cache, stale until READY', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  const first = page.locator('.chat-msg').first();
  await first.waitFor();
  const lastText = (await page.locator('.chat-msg').last().innerText()).slice(0, 40);
  // saved 3 s after the channel opens
  await expect.poll(() => page.evaluate(() => localStorage.getItem('vokko.cache.owner')), { timeout: 6000 }).not.toBeNull();

  await page.evaluate(() => localStorage.setItem('vokko.mock.readyDelay', '1500'));
  await page.goto('/');
  await expect(page).toHaveURL(/\/channels\/\d+\/\d+$/);
  await expect(page.locator('.chat-msg').last()).toContainText(lastText.split('\n')[0]!.slice(0, 10));
  await expect(page.getByRole('status').filter({ hasText: 'Connecting…' })).toBeVisible();
  // READY replaces the cached state and the composer comes back
  await expect(page.getByRole('status').filter({ hasText: 'Connecting…' })).toHaveCount(0, { timeout: 5000 });
  const marks = await page.evaluate(() => performance.getEntriesByType('mark').map(m => [m.name, Math.round(m.startTime)]));
  const at = Object.fromEntries(marks) as Record<string, number>;
  expect(at['vokko:first-messages']).toBeLessThan(at['vokko:ready']!);
});

test('signing out deletes the cache', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.locator('.chat-msg').first().waitFor();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('vokko.cache.owner')), { timeout: 6000 }).not.toBeNull();
  // what clearSession does to the store (sign-out, or a token the server rejects)
  await page.evaluate(() => (window as unknown as { __vokko: { appStore: { setState(s: object): void } } }).__vokko.appStore.setState({ token: null }));
  await expect.poll(() => page.evaluate(() => localStorage.getItem('vokko.cache.owner'))).toBeNull();
  const left = await page.evaluate(
    () =>
      new Promise<number>(resolve => {
        const req = indexedDB.open('vokko-startup-cache', 1);
        req.onsuccess = () => {
          const count = req.result.transaction('snapshots').objectStore('snapshots').count();
          count.onsuccess = () => resolve(count.result);
        };
      }),
  );
  expect(left).toBe(0);
});
