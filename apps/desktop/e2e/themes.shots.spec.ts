import { test } from '@playwright/test';
import type { Page } from '@playwright/test';
import path from 'node:path';
import { openStockTalk } from './helpers';

// vokko-themes acceptance screenshots: the channel view in every community theme, plus the picker and the login page.
// VOKKO_SHOTS_DIR=E:\...\artifacts\themes npx playwright test -c e2e/themes.config.ts themes.shots.spec.ts
const dir = process.env.VOKKO_SHOTS_DIR;
test.skip(!dir, 'set VOKKO_SHOTS_DIR to capture screenshots');

const IDS = [
  'dracula', 'gruvbox-dark', 'nord', 'catppuccin-mocha', 'tokyo-night', 'one-dark', 'solarized-dark', 'rose-pine', 'monokai',
  'catppuccin-latte', 'gruvbox-light', 'solarized-light', 'rose-pine-dawn',
];

const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(dir!, `${name}.png`) });
};

for (const id of IDS) {
  test(`channel view: ${id}`, async ({ page }) => {
    await page.addInitScript(theme => localStorage.setItem('vokko.prefs', JSON.stringify({ theme })), id);
    await openStockTalk(page);
    await shot(page, `channel-${id}`);
  });
}

test('appearance picker', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('vokko.prefs', JSON.stringify({ theme: 'dracula' })));
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  await page.getByRole('button', { name: 'User Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'User Settings' });
  await dialog.getByRole('button', { name: 'Appearance' }).click();
  await dialog.getByRole('radio', { name: 'Nord' }).hover();
  await shot(page, 'picker-hover-preview-nord');
});

test('login page', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('vokko.prefs', JSON.stringify({ theme: 'catppuccin-mocha' })));
  await page.goto('/');
  await page.locator('.auth-card').waitFor();
  await shot(page, 'login-catppuccin-mocha');
});
