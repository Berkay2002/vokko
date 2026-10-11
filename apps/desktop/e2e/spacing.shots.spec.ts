import { test } from '@playwright/test';
import path from 'node:path';
import { openStockTalk } from './helpers';

// Message spacing presets side by side: VOKKO_SHOTS_DIR=E:\...\artifacts\themes npx playwright test -c e2e/themes.config.ts spacing.shots.spec.ts
const dir = process.env.VOKKO_SHOTS_DIR;
test.skip(!dir, 'set VOKKO_SHOTS_DIR to capture screenshots');

for (const [name, gap] of [['compact', 0], ['balanced', 16], ['roomy', 24]] as const) {
  test(`spacing: ${name}`, async ({ page }) => {
    await page.addInitScript(p => localStorage.setItem('vokko.prefs', JSON.stringify(p)), { theme: 'dark', messageSpacing: name, messageGroupGap: gap });
    await openStockTalk(page);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(dir!, `spacing-${name}.png`) });
  });
}
