import { expect, test, type Locator, type Page } from '@playwright/test';
import { openStockTalk } from './helpers';

// Item 7 of gap-audit-6: search hits inside threads and forum posts are named after the thread and Jump opens it, with the hit flashing.
// Mock seed: forum #support has the post "Read this before posting" (reply "pinned for newcomers"); #general has the active thread
// "gateway docs" ("the resume section...") and the archived "replay buffer sizing" ("...a laptop that sleeps?").
// Screenshots go to $VOKKO_SHOTS_DIR when set.

const shot = async (page: Page, name: string) => { if (process.env.VOKKO_SHOTS_DIR) await page.screenshot({ path: `${process.env.VOKKO_SHOTS_DIR}/${name}.png` }); };
const box = (page: Page) => page.getByRole('combobox', { name: 'Search' });
const panel = (page: Page) => page.locator('.search-panel');
const threadPanel = (page: Page) => page.locator('.thread-panel');

/** Desktop: the Jump button; phone: a tap on the result (the button is not shown there). */
async function jump(page: Page, group: Locator, phone: boolean): Promise<void> {
  if (phone) await group.locator('.search-hit').first().tap({ position: { x: 200, y: 20 } });
  else await group.getByRole('button', { name: 'Jump' }).click();
}

async function run(page: Page, text: string): Promise<void> {
  await box(page).click();
  await box(page).fill(text);
  await box(page).press('Enter');
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).locator('.search-hit').first()).toBeVisible();
}

for (const [name, viewport] of [['1440', { width: 1440, height: 900 }], ['390', { width: 390, height: 844 }]] as const) {
  test.describe(name, () => {
    test.use({ viewport, ...(name === '390' ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });

    const openHome = (page: Page) => openStockTalk(page);

    test('a forum post and a thread are named after themselves, not "Unknown channel", and Jump opens them with the hit flashing', async ({ page }) => {
      await openHome(page);

      await run(page, 'newcomers');
      const group = panel(page).locator('.search-group').first();
      await expect(group.locator('.search-group-name')).toHaveText('Read this before posting');
      await expect(group.locator('.search-group-category')).toHaveText('support');
      await expect(panel(page)).not.toContainText('Unknown channel');
      await shot(page, `search-thread-group-${name}`);
      await jump(page, group, name === '390');
      await expect(threadPanel(page)).toBeVisible();
      await expect(threadPanel(page)).toHaveAttribute('aria-label', 'Thread: Read this before posting');
      const hit = threadPanel(page).locator('.chat-msg', { hasText: 'pinned for newcomers' });
      await expect(hit).toHaveClass(/flash/);
      await shot(page, `search-thread-jump-${name}`);
    });

    test('an archived thread is found, labelled and opened too', async ({ page }) => {
      await openHome(page);
      await run(page, 'sleeps');
      const group = panel(page).locator('.search-group').first();
      await expect(group.locator('.search-group-name')).toHaveText('replay buffer sizing');
      await expect(group.locator('.search-group-category')).toHaveText('general');
      await jump(page, group, name === '390');
      await expect(threadPanel(page)).toBeVisible();
      await expect(threadPanel(page).locator('.chat-msg', { hasText: 'laptop that sleeps' })).toHaveClass(/flash/);
    });

    test('a hit in a thread that is already open flashes in place', async ({ page }) => {
      await openHome(page);
      await run(page, 'resume section');
      const group = panel(page).locator('.search-group', { hasText: 'gateway docs' });
      await jump(page, group, name === '390');
      await expect(threadPanel(page).locator('.chat-msg', { hasText: 'resume section' })).toHaveClass(/flash/);
      // the thread is open now: a second search and Jump lands in it again
      if (name === '1440') {
        await run(page, 'resume section');
        await jump(page, panel(page).locator('.search-group', { hasText: 'gateway docs' }), false);
        await expect(threadPanel(page).locator('.chat-msg', { hasText: 'resume section' })).toHaveClass(/flash/);
      }
    });
  });
}
