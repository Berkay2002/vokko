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

test('channel settings: an unsaved name blocks Esc, Close and page switches with a shake until Reset', async ({ page }) => {
  await openRandom(page, 'sam');
  await page.locator('.chat-start').getByRole('button', { name: 'Edit Channel' }).click();
  const dialog = page.getByRole('dialog', { name: /Channel Settings/ });
  const bar = dialog.locator('.cs-savebar');
  await expect(bar).toHaveCount(0);
  await dialog.getByRole('textbox', { name: 'Channel name' }).fill('random-draft');
  await expect(bar).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(bar).toHaveAttribute('data-shake', /^[ab]$/);
  const first = await bar.getAttribute('data-shake');

  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeVisible();
  await expect(bar).not.toHaveAttribute('data-shake', first!);

  const second = await bar.getAttribute('data-shake');
  await dialog.getByRole('button', { name: 'Permissions' }).click();
  await expect(dialog.getByRole('heading', { level: 1 })).toHaveText('Overview');
  await expect(dialog.getByRole('textbox', { name: 'Channel name' })).toHaveValue('random-draft');
  await expect(bar).not.toHaveAttribute('data-shake', second!);
  await expect(bar).toHaveCSS('animation-name', /^sm-shake-[ab]$/);

  // Mod+I is a modal shortcut (it replaces the open modal), so the guard has to refuse it too
  await page.keyboard.press('ControlOrMeta+i');
  await expect(page.locator('.inbox-popout')).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Channel name' })).toHaveValue('random-draft');

  await bar.getByRole('button', { name: 'Reset' }).click();
  await expect(bar).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Permissions' }).click();
  await expect(dialog.getByRole('heading', { level: 1 })).toHaveText('Channel Permissions');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});
