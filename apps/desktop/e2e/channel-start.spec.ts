import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

type StoreWin = { __vokko: { appStore: { getState(): { channels: Record<string, { id: string; name?: string; guild_id: string | null }> } } } };

/** Signs in as `who` and opens #random (a short channel, so its start-of-channel header is on screen). */
async function openRandom(page: Page, who: string): Promise<void> {
  await page.goto(`/channels/@me?as=${who}&mockLatency=0`);
  await page.waitForFunction(() => Object.values((window as unknown as StoreWin).__vokko.appStore.getState().channels).some(c => c.name === 'random'));
  const target = await page.evaluate(() => {
    const c = Object.values((window as unknown as StoreWin).__vokko.appStore.getState().channels).find(x => x.name === 'random')!;
    return `/channels/${c.guild_id}/${c.id}`;
  });
  // A reload would re-seed the mock and drop the session: navigate in-app.
  await page.evaluate(path => { history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, target);
  await page.locator('.chat-start').waitFor();
}

test('the channel owner sees Edit Channel under the welcome text and it opens the channel settings', async ({ page }) => {
  await openRandom(page, 'sam');
  const start = page.locator('.chat-start');
  await expect(start.getByRole('heading', { name: 'Welcome to #random!' })).toBeVisible();
  const button = start.getByRole('button', { name: 'Edit Channel' });
  await expect(button).toBeVisible();
  const text = (await start.locator('p').first().boundingBox())!;
  expect((await button.boundingBox())!.y).toBeGreaterThanOrEqual(text.y + text.height);
  await button.click();
  await expect(page.getByRole('dialog', { name: /Channel Settings/ })).toBeVisible();
});

test('a plain member does not see Edit Channel', async ({ page }) => {
  await openRandom(page, 'bob');
  await page.locator('.chat-msg').first().waitFor(); // member, roles and messages are in the store before the absence means anything
  await expect(page.locator('.chat-start').getByRole('button', { name: 'Edit Channel' })).toHaveCount(0);
});
