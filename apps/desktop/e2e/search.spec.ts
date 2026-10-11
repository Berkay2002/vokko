import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { channelIdOf, openDm, openStockTalk, send } from './helpers';

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
  await expect(panel(page).locator('.search-group-name')).toHaveText(['general', 'stock-talk']);

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
  await expect(panel(page).locator('.search-panel-count')).toHaveText('No results');
  await expect(panel(page).locator('.search-empty-text')).toContainText('couldn');
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.locator('.member-list')).toBeVisible();
});

test('sort menu flips the order and relevance appears with text', async ({ page }) => {
  await openStockTalk(page);
  await run(page, 'morning');
  await expect(hits(page).first()).toContainText('morning ☕');
  await panel(page).getByRole('button', { name: 'Sort' }).click();
  await page.getByRole('option', { name: 'Oldest' }).click();
  await expect(hits(page).first()).toContainText('morning all, three charts');
  await panel(page).getByRole('button', { name: 'Sort' }).click();
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

test('DM search is scoped to the conversation and the panel replaces the profile panel', async ({ page }) => {
  await openDm(page, 'alice');
  await send(page, 'zebra crossing ahead');
  await send(page, 'second zebra here');
  await expect(box(page)).toHaveAttribute('placeholder', 'Search');
  await run(page, 'zebra');
  await expect(panel(page).locator('.search-panel-count')).toHaveText('2 results');
  await expect(panel(page).locator('.search-group-name')).toHaveCount(1);
  await expect(page.locator('aside.dm-profile')).toHaveCount(0);
  await hits(page).first().getByRole('button', { name: 'Jump' }).click({ force: true });
  await expect(page.locator('.chat-msg').filter({ has: page.locator('.chat-content', { hasText: 'second zebra here' }) }).last()).toHaveClass(/flash/);
});

test('axe: suggestions popout and results panel have no violations besides the known muted-text contrast finding', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openStockTalk(page);
  await box(page).click();
  const scan = async (include: string) => (await new AxeBuilder({ page }).include(include).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze()).violations;
  const popout = await scan('.search-popout');
  await box(page).fill('morning');
  await box(page).press('Enter');
  await expect(hits(page).first()).toBeVisible();
  const results = await scan('.search-panel');
  const unexpected = [...popout, ...results].filter(v => v.id !== 'color-contrast').map(v => `${v.id}: ${v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`);
  for (const v of [...popout, ...results]) if (v.id === 'color-contrast') info.annotations.push({ type: 'known-issue', description: `A11Y-07 muted text tokens [${v.nodes.length} node(s)]` });
  expect(unexpected).toEqual([]);
});
