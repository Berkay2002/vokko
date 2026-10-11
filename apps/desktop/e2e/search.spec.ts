import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { channelIdOf, openStockTalk } from './helpers';

// Message search against the mock backend (same route and semantics as the server): filter suggestions, chips, results panel, jump.
test.use({ viewport: { width: 1440, height: 900 } });

const box = (page: Page) => page.getByRole('combobox', { name: 'Search' });
const panel = (page: Page) => page.locator('.search-panel');
const hits = (page: Page) => panel(page).locator('.search-hit');

async function run(page: Page, text: string): Promise<void> {
  await box(page).click();
  await box(page).fill(text);
  await box(page).press('Enter');
  await expect(panel(page)).toBeVisible();
}

test('typing from: suggests members, picking one makes a chip, results show and Jump flashes the message', async ({ page }) => {
  await openStockTalk(page);
  await box(page).click();
  await expect(page.getByRole('listbox', { name: 'Search suggestions' })).toContainText('From a specific user');
  await box(page).fill('from:');
  await box(page).fill('from:ali');
  await page.getByRole('option', { name: /Alice/ }).click();
  await expect(page.locator('.search-chip[data-kind="from"]')).toContainText('Alice');
  await box(page).fill('charts');
  await box(page).press('Enter');

  await expect(panel(page)).toBeVisible();
  await expect(panel(page).locator('.search-panel-count')).toHaveText('1 result');
  await expect(hits(page)).toHaveCount(1);
  await expect(hits(page).first()).toContainText('three charts from the weekend scan');
  await expect(page.locator('.member-list')).toHaveCount(0);

  await hits(page).first().hover();
  await hits(page).first().getByRole('button', { name: 'Jump' }).click();
  const target = page.locator('.chat-msg').filter({ has: page.locator('.chat-content', { hasText: 'three charts from the weekend scan' }) }).last();
  await expect(target).toHaveClass(/flash/);
  await expect(panel(page)).toBeVisible();
});

test('results group by channel, highlight the word, and Jump opens the other channel', async ({ page }) => {
  const stock = await openStockTalk(page);
  await run(page, 'morning');
  await expect(panel(page).locator('.search-panel-count')).toHaveText('3 results');
  await expect(panel(page).locator('.search-group-title')).toHaveText(['general', 'stock-talk']);

  const painted = await page.evaluate(() => (CSS as unknown as { highlights: Map<string, { size: number }> }).highlights.get('search-hit')?.size ?? 0);
  expect(painted).toBeGreaterThanOrEqual(3);

  await hits(page).filter({ hasText: 'morning everyone' }).getByRole('button', { name: 'Jump' }).click({ force: true });
  await expect.poll(() => channelIdOf(page)).not.toBe(stock);
  const target = page.locator('.chat-msg').filter({ has: page.locator('.chat-content', { hasText: 'morning everyone' }) }).last();
  await expect(target).toHaveClass(/flash/);
  await expect(panel(page)).toBeVisible();
});

test('no results, then the clear button brings the member list back', async ({ page }) => {
  await openStockTalk(page);
  await run(page, 'zzzxqq');
  await expect(panel(page).locator('.search-empty-title')).toHaveText('No results');
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.locator('.member-list')).toBeVisible();
});

test('sort menu flips the order and relevance appears with text', async ({ page }) => {
  await openStockTalk(page);
  await run(page, 'morning');
  await expect(hits(page).first()).toContainText('morning ☕');
  await panel(page).getByRole('button', { name: /Newest/ }).click();
  await page.getByRole('option', { name: 'Oldest' }).click();
  await expect(hits(page).first()).toContainText('morning all, three charts');
  await panel(page).getByRole('button', { name: /Oldest/ }).click();
  await expect(page.getByRole('option', { name: 'Most relevant' })).toBeVisible();
});

test('has: and date filters narrow the results', async ({ page }) => {
  await openStockTalk(page);
  await box(page).click();
  await box(page).fill('has:');
  await page.getByRole('option', { name: 'image' }).click();
  await box(page).press('Enter');
  await expect(panel(page)).toBeVisible();
  const withImages = await hits(page).count();
  expect(withImages).toBeGreaterThanOrEqual(2);

  // before: today (calendar) keeps only messages from earlier days.
  await box(page).click();
  await box(page).fill('before:');
  const today = await page.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  await page.locator(`.search-calendar-day[data-date="${today}"]`).click();
  await expect(page.locator('.search-chip[data-kind="before"]')).toBeVisible();
  await box(page).press('Enter');
  await expect(panel(page).locator('.search-panel-count')).toContainText('result');
  await expect(hits(page).first()).toBeVisible();
});

test('in: restricts a guild search to one channel and the chip can be removed with Backspace', async ({ page }) => {
  await openStockTalk(page);
  await box(page).click();
  await box(page).fill('in:gen');
  await page.getByRole('option', { name: 'general' }).click();
  await expect(page.locator('.search-chip[data-kind="in"]')).toContainText('general');
  await box(page).fill('morning');
  await box(page).press('Enter');
  await expect(panel(page).locator('.search-panel-count')).toHaveText('2 results');
  await box(page).click();
  await box(page).fill('');
  await box(page).press('Backspace');
  await expect(page.locator('.search-chip')).toHaveCount(0);
});
