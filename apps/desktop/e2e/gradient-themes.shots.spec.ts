import { test } from '@playwright/test';
import path from 'node:path';
import { openStockTalk } from './helpers';

// Gradient colour themes, channel view each: VOKKO_SHOTS_DIR=E:\...\artifacts\themes npx playwright test -c e2e/themes.config.ts gradient-themes.shots.spec.ts
const dir = process.env.VOKKO_SHOTS_DIR;
test.skip(!dir, 'set VOKKO_SHOTS_DIR to capture screenshots');

const IDS = [
  'mint-apple', 'citrus-sherbert', 'retro-raincloud', 'hanami', 'sunrise', 'cotton-candy', 'lofi-vibes', 'desert-khaki', 'sunset',
  'chroma-glow', 'forest', 'crimson', 'midnight-blurple', 'mars', 'dusk', 'under-the-sea', 'retro-storm', 'neon-nights',
  'strawberry-lemonade', 'aurora', 'sepia', 'blurple-twilight',
];

for (const id of IDS) {
  test(`gradient: ${id}`, async ({ page }) => {
    await page.addInitScript(theme => localStorage.setItem('vokko.prefs', JSON.stringify({ theme })), id);
    await openStockTalk(page);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(dir!, `gradient-${id}.png`) });
  });
}

for (const id of ['sunset', 'hanami']) {
  test(`gradient settings modal: ${id}`, async ({ page }) => {
    await page.addInitScript(theme => localStorage.setItem('vokko.prefs', JSON.stringify({ theme })), id);
    await page.goto('/channels/@me?as=sam&mockLatency=0');
    await page.locator('.dm-row').first().waitFor();
    await page.getByRole('button', { name: 'User Settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'User Settings' });
    await dialog.getByRole('button', { name: 'Appearance' }).click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(dir!, `gradient-settings-${id}.png`) });
  });
}

test('gradient picker', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('vokko.prefs', JSON.stringify({ theme: 'hanami' })));
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  await page.getByRole('button', { name: 'User Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'User Settings' });
  await dialog.getByRole('button', { name: 'Appearance' }).click();
  await dialog.getByRole('radio', { name: 'Aurora' }).hover();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(dir!, 'gradient-picker.png') });
});
