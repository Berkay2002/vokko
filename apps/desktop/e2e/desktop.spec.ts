import { expect, test } from '@playwright/test';

// Desktop-only settings and the update banner (mock mode; the Tauri adapters are no-ops in the browser).

test('Windows Settings are desktop only', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  await page.getByRole('button', { name: 'User Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'User Settings' });
  await expect(dialog.getByRole('button', { name: 'Keybinds' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Windows Settings' })).toHaveCount(0);
});

test('a downloaded update shows the restart banner', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  await expect(page.getByTestId('update-banner')).toHaveCount(0);
  await page.evaluate(() => {
    const w = window as unknown as { __vokko: { desktop: { useDesktopUpdate: { setState(s: unknown): void } } } };
    w.__vokko.desktop.useDesktopUpdate.setState({ status: { state: 'ready', version: '9.9.9' } });
  });
  const banner = page.getByTestId('update-banner');
  await expect(banner).toContainText('Update ready');
  await expect(banner).toContainText('9.9.9');
  await expect(banner.getByRole('button', { name: 'Restart to Update' })).toBeVisible();
});
