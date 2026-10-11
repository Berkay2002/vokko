import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openStockTalk } from './helpers';

// Screenshots for the reference comparison (names follow .claude/reference/discord-2026-10-11/search/NN-*).
// Capture with VOKKO_SHOTS_DIR=<dir>; skipped otherwise.
test.use({ viewport: { width: 1440, height: 900 } });

const box = (page: Page) => page.getByRole('combobox', { name: 'Search' });
const panel = (page: Page) => page.locator('.search-panel');
const hits = (page: Page) => panel(page).locator('.search-hit');

test('search screenshots', async ({ page }) => {
  const dir = process.env.VOKKO_SHOTS_DIR;
  test.skip(!dir, 'set VOKKO_SHOTS_DIR to capture screenshots');
  const shot = async (name: string) => {
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${dir}/${name}.png` });
  };
  await openStockTalk(page);
  await box(page).click();
  await shot('01-focused-empty-popout');
  await box(page).fill('from:');
  await shot('02-from-users');
  await box(page).fill('has:');
  await shot('03-has-list');
  await box(page).fill('in:');
  await shot('04-in-channels');
  await box(page).fill('before:');
  await shot('05-before-date-picker');
  await box(page).fill('mentions:');
  await shot('06-mentions-users');
  await box(page).fill('morning');
  await shot('07-free-text-suggestion');
  await box(page).press('Enter');
  await expect(hits(page).first()).toBeVisible();
  await page.mouse.move(10, 10);
  await shot('08-results-panel');
  await hits(page).first().hover();
  await shot('09-result-hover-jump');
  await panel(page).getByRole('button', { name: 'Sort' }).click();
  await shot('10-sort-menu');
  await page.keyboard.press('Escape');
  await box(page).fill('zzzxqq');
  await box(page).press('Enter');
  await expect(panel(page).locator('.search-empty')).toBeVisible();
  await page.mouse.move(10, 10);
  await shot('14-no-results');
  await box(page).click();
  await box(page).press('Escape');
  await box(page).press('Escape');
  await shot('16-history-popout');
});
