import { expect, test } from '@playwright/test';

test('User Settings is an inset modal over the app with one close button in the header', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  await page.getByRole('button', { name: 'User Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'User Settings' });
  await expect(dialog).toBeVisible();

  // inset from every edge, with the app still mounted behind it
  const box = (await dialog.boundingBox())!;
  const view = page.viewportSize()!;
  expect(box.x).toBeGreaterThan(20);
  expect(box.y).toBeGreaterThan(20);
  expect(view.width - (box.x + box.width)).toBeGreaterThan(20);
  expect(view.height - (box.y + box.height)).toBeGreaterThan(20);
  await expect(page.locator('.dm-row').first()).toBeAttached();

  // the header carries the section title and the only close control; there is no ESC pill
  await expect(dialog.getByRole('heading', { level: 1 })).toHaveText('My Account');
  await expect(dialog.getByRole('button', { name: 'Close' })).toHaveCount(1);
  await expect(dialog).not.toContainText('ESC');

  await dialog.getByRole('button', { name: 'Appearance' }).click();
  await expect(dialog.getByRole('heading', { level: 1 })).toHaveText('Appearance');

  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);

  await page.getByRole('button', { name: 'User Settings' }).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('My Account is one scrolling page: sub-items follow the sections and Display Name edits inline', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  await page.getByRole('button', { name: 'User Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'User Settings' });

  const subs = dialog.locator('.sm-sub');
  await expect(subs).toHaveText(['Account Info', 'Password & Security', 'Account Status']);
  await expect(subs.first()).toHaveAttribute('aria-current', 'location');
  await subs.nth(1).click();
  await expect(subs.nth(1)).toHaveAttribute('aria-current', 'location');
  await expect(dialog.getByRole('heading', { name: 'Password & Security', level: 2 })).toBeVisible();

  // another section collapses the sub-items again
  await dialog.getByRole('button', { name: 'Notifications' }).click();
  await expect(subs).toHaveCount(0);
  await dialog.getByRole('button', { name: 'My Account' }).click();

  const row = dialog.locator('.sm-row', { hasText: 'Display Name' });
  await row.getByRole('button', { name: 'Edit' }).click();
  await dialog.getByRole('textbox', { name: 'Display Name' }).fill('Sam Renamed');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(row.locator('.sm-row-value')).toHaveText('Sam Renamed');
  await expect(dialog.locator('.sm-profile-name')).toHaveText('Sam Renamed');
});
