import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// Report a Problem: the title bar Help menu, Settings > Advanced and the voice popout's Upload Logs all open one dialog,
// which shows exactly what is sent (scrubbed log tail) and posts it (mock backend).
// Review screenshots are written only when VOKKO_SHOTS names a directory.
const SHOTS = process.env.VOKKO_SHOTS ?? '';
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Report a Problem' });

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

test('Help menu opens Report a Problem; the log preview is scrubbed and sending shows a reference', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('main', { name: 'Friends' }).waitFor();
  await page.evaluate(() => console.warn('reconnect failed', { Authorization: 'f00dfeedf00dfeedf00dfeedf00dfeedf00dfeed', content: 'private words' }));

  await page.getByRole('button', { name: 'Help' }).click();
  await expect(page.getByRole('menuitem', { name: 'Keybinds' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Report a Problem' }).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: 'Send Report' })).toBeDisabled();

  await dialog(page).getByLabel('What went wrong?').fill('My mic cut out after joining General.');
  await dialog(page).getByRole('button', { name: 'Show what is sent' }).click();
  const sent = dialog(page).locator('.report-problem-sent');
  await expect(sent).toContainText('reconnect failed');
  await expect(sent).toContainText('[redacted]');
  await expect(sent).not.toContainText('f00dfeed');
  await expect(sent).not.toContainText('private words');
  await shot(page, 'report-problem-desktop');

  await dialog(page).getByRole('button', { name: 'Send Report' }).click();
  const done = page.getByRole('dialog', { name: 'Report Sent' });
  await expect(done).toContainText('Your report was sent');
  await expect(done).toContainText(/Reference: \d+/);
  await shot(page, 'report-problem-sent');
  await done.getByRole('button', { name: 'Done' }).click();
  await expect(done).toHaveCount(0);
});

test('Settings > Advanced has Report a Problem under Support', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('button', { name: 'User Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'User Settings' });
  await settings.getByRole('button', { name: 'Advanced', exact: true }).click();
  await settings.getByRole('button', { name: 'Report a Problem' }).click();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  // the settings screen comes back under a closed dialog
  await expect(settings.getByRole('button', { name: 'Report a Problem' })).toBeVisible();
});

test('voice connection popout: Upload Logs opens the same dialog', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.getByRole('list', { name: 'Channels', exact: true }).waitFor();
  await page.locator('.sidebar-scroller').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.getByRole('button', { name: 'General voice channel' }).click();
  const card = page.getByRole('region', { name: 'Voice connection' });
  await expect(card.getByRole('status')).toHaveText('Voice Connected');
  await card.getByRole('button', { name: 'Connection details' }).click();
  await page.locator('.voice-quality-popout').getByRole('button', { name: 'Upload Logs' }).click();
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Show what is sent' }).click();
  // voice events are always kept for reports, also with debug logging off
  await expect(dialog(page).locator('.report-problem-sent')).toContainText('voice status');
});

test('phone width: the dialog fits', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('button', { name: 'User Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'User Settings' });
  await settings.getByRole('button', { name: 'Advanced', exact: true }).click();
  await settings.getByRole('button', { name: 'Report a Problem' }).click();
  await dialog(page).getByLabel('What went wrong?').fill('Video tiles stay black.');
  await dialog(page).getByRole('button', { name: 'Show what is sent' }).click();
  const box = await dialog(page).boundingBox();
  expect(box!.width).toBeLessThanOrEqual(390);
  await shot(page, 'report-problem-phone');
});
