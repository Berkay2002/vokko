import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openDm, openStockTalk } from './helpers';

// The composer box and the user panel (bottom-left) share the same top and bottom edge (Discord: both ~57px high, 8px from the window edge).
// LAYOUT_SHOTS=<dir> additionally saves a bottom strip of the window per case.

async function edges(page: Page) {
  const box = await page.locator('.chat-composer-box').boundingBox();
  const panel = await page.locator('.user-panel').boundingBox();
  if (!box || !panel) throw new Error('composer box or user panel missing');
  return { box, panel, boxBottom: box.y + box.height, panelBottom: panel.y + panel.height };
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.LAYOUT_SHOTS;
  if (!dir) return;
  const vp = page.viewportSize()!;
  await page.screenshot({ path: `${dir}/${name}.png`, clip: { x: 0, y: vp.height - 200, width: vp.width, height: 200 } });
}

async function checkAligned(page: Page, name: string): Promise<void> {
  const e = await edges(page);
  await shot(page, `${name}-empty`);
  expect(Math.abs(e.boxBottom - e.panelBottom)).toBeLessThanOrEqual(1);
  expect(Math.abs(e.box.y - e.panel.y)).toBeLessThanOrEqual(1);

  await page.locator('.chat-msg').last().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Reply' }).click();
  await expect(page.locator('.chat-reply-bar')).toBeVisible();
  const r = await edges(page);
  await shot(page, `${name}-reply`);
  expect(Math.abs(r.boxBottom - r.panelBottom)).toBeLessThanOrEqual(1);
}

// 780px is not covered: the shell has no narrow breakpoint, so the side panel squeezes the chat column to ~0px there (shell-owned, reported separately).
for (const width of [1440, 1100]) {
  test.describe(`${width}px wide`, () => {
    test.use({ viewport: { width, height: 900 } });

    test('guild channel: composer is aligned with the user panel', async ({ page }) => {
      await openStockTalk(page);
      await checkAligned(page, `guild-${width}`);
    });

    test('DM: composer is aligned with the user panel', async ({ page }) => {
      await openDm(page);
      await checkAligned(page, `dm-${width}`);
    });
  });
}
