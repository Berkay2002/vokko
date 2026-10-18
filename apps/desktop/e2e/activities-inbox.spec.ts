import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// The call's Activities shelf (cards, pinned first, scrolling inside a fixed height, a bottom sheet on a phone) and
// Inbox > Unreads (a card per channel with its newest unread messages, Mark as Read per channel and for all), on the mock seed.
// Review screenshots are written only when VOKKO_SHOTS names a directory.
const SHOTS = process.env.VOKKO_SHOTS ?? '';
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

const call = (page: Page) => page.getByRole('region', { name: /call$/ });

async function joinGeneral(page: Page): Promise<void> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.getByRole('button', { name: 'General voice channel' }).click();
  await expect(call(page).locator('.voice-tile')).toHaveCount(3);
}

test('Activities opens a shelf of cards: Watch Together, Stremio, Spotify first, the games after, scrolling inside', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await joinGeneral(page);
  await call(page).getByRole('button', { name: 'Activities', exact: true }).click();
  const shelf = page.getByRole('dialog', { name: 'Activities' });
  await expect(shelf).toBeVisible();
  const cards = shelf.getByRole('menu', { name: 'Activities' }).getByRole('menuitem');
  await expect(cards.nth(0)).toContainText('Watch Together');
  await expect(cards.nth(1)).toContainText('Stremio');
  await expect(cards.nth(2)).toContainText('Spotify');
  await expect(shelf.getByRole('menuitem', { name: /Chess/ })).toContainText('2-16 players');
  await expect(shelf.getByRole('menuitem', { name: /Chess/ }).locator('img')).toHaveAttribute('src', '/activities/chess.webp');
  // Three columns, and the grid scrolls while the shelf stays inside the window.
  const [a, b, c] = await Promise.all([0, 1, 2].map(i => cards.nth(i).boundingBox()));
  expect(a!.y).toBe(b!.y);
  expect(b!.y).toBe(c!.y);
  const grid = await shelf.getByRole('menu').evaluate(el => ({ scroll: el.scrollHeight, client: el.clientHeight }));
  expect(grid.scroll).toBeGreaterThan(grid.client);
  const box = (await shelf.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(900);
  await shot(page, 'activities-shelf');

  // Arrow keys move between cards; Escape closes; a card runs the old menu's handler and closes the shelf.
  await cards.nth(0).focus();
  await page.keyboard.press('ArrowDown');
  await expect(cards.nth(1)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(shelf).toHaveCount(0);
  await call(page).getByRole('button', { name: 'Activities', exact: true }).click();
  await shelf.getByRole('menuitem', { name: /Watch Together/ }).click();
  await expect(shelf).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: /Watch Together/ })).toBeVisible();
});

test('phone: the Activities shelf is a bottom sheet with two columns', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.getByRole('button', { name: 'General voice channel' }).click();
  // On a phone the channel opens first; joining is a second step.
  await page.getByRole('button', { name: 'Join Voice' }).click();
  await call(page).getByRole('button', { name: 'Activities', exact: true }).click();
  const sheet = page.locator('.sheet', { has: page.getByRole('menu', { name: 'Activities' }) });
  await expect(sheet).toBeVisible();
  const cards = sheet.getByRole('menuitem');
  const [a, b, c] = await Promise.all([0, 1, 2].map(i => cards.nth(i).boundingBox()));
  expect(a!.y).toBe(b!.y);
  expect(c!.y).toBeGreaterThan(a!.y);
  expect(b!.x + b!.width).toBeLessThanOrEqual(390);
  await shot(page, 'p-activities-shelf');
});

test.describe('Inbox > Unreads', () => {

  test('shows the newest unread messages per channel, marks one read, then all', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/channels/@me?as=sam&mockLatency=0');
    await page.getByRole('button', { name: 'Inbox' }).click();
    const inbox = page.locator('.inbox-popout');
    const cards = inbox.getByTestId('inbox-unread');
    await expect(cards.first()).toBeVisible();

    // A DM card previews Alice's unread message, a server card says where it is.
    const dm = inbox.getByRole('region', { name: /Alice.*Direct Message/ });
    await expect(dm).toContainText('left two comments, mostly nits');
    await expect(dm).not.toContainText('sure, looking now');
    const random = inbox.getByRole('region', { name: /^random, Sam's server/ });
    await expect(random).toContainText('popcorn');
    await expect(random.locator('.inbox-row-badge')).toHaveText('2');
    await expect(random.locator('.inbox-unread-type')).toBeVisible();
    await shot(page, 'inbox-unreads');

    const before = await cards.count();
    await random.getByRole('button', { name: 'Mark random as read' }).click();
    await expect(random).toHaveCount(0);
    await expect(cards).toHaveCount(before - 1);

    await inbox.getByRole('button', { name: 'Mark All as Read' }).click();
    await expect(cards).toHaveCount(0);
    await expect(inbox).toContainText("You're all caught up");
  });

  test('a preview jumps to its message', async ({ page }) => {
    await page.goto('/channels/@me?as=sam&mockLatency=0');
    await page.getByRole('button', { name: 'Inbox' }).click();
    await page.locator('.inbox-popout').getByRole('button', { name: /left two comments, mostly nits/ }).click();
    await expect(page.locator('.inbox-popout')).toHaveCount(0);
    await expect(page).toHaveURL(/\/channels\/@me\/\d+/);
  });

  test('phone: the unread cards fit the window', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/channels/@me?as=sam&mockLatency=0');
    await page.locator('.user-panel').getByRole('button', { name: 'Inbox' }).click();
    const card = page.locator('.inbox-popout').getByTestId('inbox-unread').first();
    await expect(card).toBeVisible();
    const box = (await card.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await shot(page, 'p-inbox-unreads');
  });
});
