import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// The call's Activities picker (search, Recent, a two-column card grid with pinned first, a modal with its own scroll, a full-height bottom sheet on a phone) and
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

test('Activities opens a picker: search on top, Watch Together, Stremio, Spotify first in two columns, the games after, scrolling inside', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await joinGeneral(page);
  await call(page).getByRole('button', { name: 'Activities', exact: true }).click();
  const shelf = page.getByRole('dialog', { name: 'Activities' });
  await expect(shelf).toBeVisible();
  await expect(shelf.getByRole('searchbox', { name: 'Search activities' })).toBeFocused();
  const menu = shelf.getByRole('menu', { name: 'Activities' });
  const cards = menu.getByRole('menuitem');
  await expect(cards.nth(0)).toContainText('Watch Together');
  await expect(cards.nth(1)).toContainText('Stremio');
  await expect(cards.nth(2)).toContainText('Spotify');
  await expect(menu.getByRole('menuitem', { name: /Chess/ })).toContainText('2-16 players');
  await expect(menu.getByRole('menuitem', { name: /Chess/ })).toContainText('Classic board game for two');
  await expect(menu.getByRole('menuitem', { name: /Chess/ }).locator('img')).toHaveAttribute('src', '/activities/chess.webp');
  // Nothing launched yet: no Recent row.
  await expect(shelf.getByRole('menu', { name: 'Recent' })).toHaveCount(0);
  // Two columns, and the list scrolls while the picker stays inside the window.
  const [a, b, c] = await Promise.all([0, 1, 2].map(i => cards.nth(i).boundingBox()));
  expect(a!.y).toBe(b!.y);
  expect(c!.y).toBeGreaterThan(b!.y);
  expect(c!.x).toBe(a!.x);
  const list = await shelf.locator('.activity-picker-scroll').evaluate(el => ({ scroll: el.scrollHeight, client: el.clientHeight }));
  expect(list.scroll).toBeGreaterThan(list.client);
  const box = (await shelf.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(900);
  await shot(page, 'activities-picker');

  // Search filters by name and description, and says so when nothing matches.
  const search = shelf.getByRole('searchbox', { name: 'Search activities' });
  await search.fill('chess');
  await expect(cards).toHaveCount(1);
  await search.fill('youtube');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('Watch Together');
  await search.fill('zzzz');
  await expect(menu).toHaveCount(0);
  await expect(shelf.getByRole('status')).toContainText('No activities match');
  await shot(page, 'activities-picker-search-empty');
  await search.fill('');
  await expect(cards.nth(3)).toBeVisible();

  // Arrow keys follow the two columns (Down from the search box enters the first card); Escape closes; a card runs its handler.
  await search.focus();
  await page.keyboard.press('ArrowDown');
  await expect(cards.nth(0)).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(cards.nth(1)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(cards.nth(3)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(cards.nth(2)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(cards.nth(0)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(search).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(shelf).toHaveCount(0);
  await call(page).getByRole('button', { name: 'Activities', exact: true }).click();
  await menu.getByRole('menuitem', { name: /Watch Together/ }).click();
  await expect(shelf).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: /Watch Together/ })).toBeVisible();
});

test('the Recent row lists what you launched, newest first, and Enter launches the focused card', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await joinGeneral(page);
  const bar = call(page).getByRole('button', { name: 'Activities', exact: true });
  const shelf = page.getByRole('dialog', { name: 'Activities' });
  const recent = shelf.getByRole('menu', { name: 'Recent' });
  await bar.click();
  await shelf.getByRole('menu', { name: 'Activities' }).getByRole('menuitem', { name: /Stremio/ }).click();
  await expect(shelf).toHaveCount(0);

  await bar.click();
  await expect(recent.getByRole('menuitem')).toHaveCount(1);
  await expect(recent.getByRole('menuitem', { name: 'Stremio' })).toBeVisible();
  // Enter on a focused card launches it (Watch Together opens its dialog), and it moves to the front of Recent.
  const watch = shelf.getByRole('menu', { name: 'Activities' }).getByRole('menuitem', { name: /Watch Together/ });
  await watch.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: /Watch Together/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: /Watch Together/ })).toHaveCount(0);

  await bar.click();
  await expect(recent.getByRole('menuitem')).toHaveCount(2);
  await expect(recent.getByRole('menuitem').nth(0)).toHaveAccessibleName('Watch Together');
  await expect(recent.getByRole('menuitem').nth(1)).toHaveAccessibleName('Stremio');
  await shot(page, 'activities-picker-recent');
  // A query hides the row (it filters the grid only).
  await shelf.getByRole('searchbox', { name: 'Search activities' }).fill('spot');
  await expect(recent).toHaveCount(0);
});

test('the voice panel in the sidebar opens the same picker', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await joinGeneral(page);
  await page.getByRole('region', { name: 'Voice connection' }).getByRole('button', { name: 'Start An Activity' }).click();
  const shelf = page.getByRole('dialog', { name: 'Activities' });
  await expect(shelf.getByRole('menu', { name: 'Activities' }).getByRole('menuitem').first()).toContainText('Watch Together');
  await page.keyboard.press('Escape');
  await expect(shelf).toHaveCount(0);
});

test('phone: the Activities picker is a full-height bottom sheet with one column', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.getByRole('button', { name: 'General voice channel' }).click();
  // On a phone the channel opens first; joining is a second step.
  await page.getByRole('button', { name: 'Join Voice' }).click();
  await call(page).getByRole('button', { name: 'Activities', exact: true }).click();
  const sheet = page.locator('.sheet', { has: page.getByRole('menu', { name: 'Activities' }) });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('searchbox', { name: 'Search activities' })).toBeVisible();
  const box = (await sheet.boundingBox())!;
  expect(box.height).toBeGreaterThan(800);
  await expect.poll(async () => { const m = (await sheet.boundingBox())!; return m.y + m.height; }).toBeLessThanOrEqual(844); // after its slide-in
  const cards = sheet.getByRole('menuitem');
  const [a, b] = await Promise.all([0, 1].map(i => cards.nth(i).boundingBox()));
  expect(b!.y).toBeGreaterThan(a!.y);
  expect(b!.x).toBe(a!.x);
  expect(a!.x + a!.width).toBeLessThanOrEqual(390);
  await shot(page, 'p-activities-picker');
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

  test('phone: the Inbox is a bottom sheet and the unread cards fit the window', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/channels/@me?as=sam&mockLatency=0');
    await page.locator('.user-panel').getByRole('button', { name: 'Inbox' }).click();
    await expect(page.getByRole('dialog', { name: 'Inbox' })).toHaveClass(/\bsheet\b/);
    const card = page.locator('.inbox-popout').getByTestId('inbox-unread').first();
    await expect(card).toBeVisible();
    const box = (await card.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await shot(page, 'p-inbox-unreads');
  });
});
