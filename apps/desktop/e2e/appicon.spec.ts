import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const IDS = ['default', 'gradient', 'flame', 'pastel', 'galaxy', 'mono', 'inverted', 'outline'];
const LABELS = ['Default', 'Gradient', 'Flame', 'Pastel', 'Galaxy', 'Mono', 'Inverted', 'Outline'];
const SHOT_DIR = process.env.VOKKO_SHOT_DIR;

async function openAppearance(page: Page) {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  await page.getByRole('button', { name: 'User Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'User Settings' });
  await dialog.getByRole('button', { name: 'Appearance' }).click();
  await expect(dialog.getByRole('heading', { name: 'App Icon', level: 2 })).toBeVisible();
  return dialog;
}

const savedIcon = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('vokko.prefs') ?? '{}').appIcon);

test('the App Icon picker shows every variant and the choice survives a reload', async ({ page }) => {
  const dialog = await openAppearance(page);
  const picker = dialog.getByRole('radiogroup', { name: 'App icon' });
  await expect(picker.getByRole('radio')).toHaveCount(IDS.length);
  for (const label of LABELS) await expect(picker.getByRole('radio', { name: label })).toBeVisible();
  // every tile paints its SVG
  await expect.poll(() => picker.locator('img').evaluateAll(imgs => imgs.every(img => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await expect(picker.getByRole('radio', { name: 'Default' })).toHaveAttribute('aria-checked', 'true');

  if (SHOT_DIR) await picker.screenshot({ path: `${SHOT_DIR}/app-icon-picker.png` });

  await picker.getByRole('radio', { name: 'Flame' }).click();
  await expect(picker.getByRole('radio', { name: 'Flame' })).toHaveAttribute('aria-checked', 'true');
  await expect(picker.getByRole('radio', { name: 'Default' })).toHaveAttribute('aria-checked', 'false');
  expect(await savedIcon(page)).toBe('flame');

  // the in-memory mock backend drops the session on reload: sign in again, the saved icon is what is under test
  await page.reload();
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  await page.getByRole('button', { name: 'User Settings' }).click();
  const again = page.getByRole('dialog', { name: 'User Settings' });
  await again.getByRole('button', { name: 'Appearance' }).click();
  await expect(again.getByRole('radiogroup', { name: 'App icon' }).getByRole('radio', { name: 'Flame' })).toHaveAttribute('aria-checked', 'true');
});

test('an unknown saved icon falls back to the default', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('vokko.prefs', JSON.stringify({ appIcon: 'nitro-gold' })));
  const dialog = await openAppearance(page);
  await expect(dialog.getByRole('radiogroup', { name: 'App icon' }).getByRole('radio', { name: 'Default' })).toHaveAttribute('aria-checked', 'true');
});
