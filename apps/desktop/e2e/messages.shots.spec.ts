import { test } from '@playwright/test';
import type { Page } from '@playwright/test';
import path from 'node:path';
import { openStockTalk } from './helpers';

// vokko-messages acceptance screenshots at the user's window size (1489x1097 CSS px, 1.25 scaling = their 1861x1371 shots).
// VOKKO_SHOTS_DIR=E:\...\artifacts\messages npx playwright test -c e2e/messages.config.ts messages.shots.spec.ts
const dir = process.env.VOKKO_SHOTS_DIR;
test.skip(!dir, 'set VOKKO_SHOTS_DIR to capture screenshots');
test.use({ viewport: { width: 1489, height: 1097 }, deviceScaleFactor: 1.25 });

const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(dir!, `${name}.png`) });
};

// The user's Discord is Onyx; the app picks it up from the persisted prefs.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('vokko.prefs', JSON.stringify({ theme: 'onyx' })); });
});

test('channel: replies, image, mention, server tag', async ({ page }) => {
  await openStockTalk(page);
  await shot(page, '01-channel-bottom');
  await page.locator('.chat-scroller').evaluate(el => { el.scrollTop = 0; });
  await shot(page, '02-channel-top');
});
