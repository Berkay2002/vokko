import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

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
  await expect(subs).toHaveText(['Account Info', 'Password & Security', 'Sign-in Methods', 'Account Status']);
  await expect(subs.first()).toHaveAttribute('aria-current', 'location');
  await subs.nth(1).click();
  // the last item takes over once the page has scrolled to its end, so only the count of current items is stable
  await expect(dialog.locator('.sm-sub[aria-current="location"]')).toHaveCount(1);
  await expect(dialog.getByRole('heading', { name: 'Password & Security', level: 2 })).toBeVisible();

  // another page shows its own sub-items (scroll-spy anchors of that page), never My Account's
  await dialog.getByRole('button', { name: 'Notifications' }).click();
  await expect(subs.first()).not.toHaveText('Account Info');
  await expect(dialog.getByRole('heading', { name: 'Notifications', level: 1 })).toBeVisible();
  await dialog.getByRole('button', { name: 'My Account' }).click();

  const row = dialog.locator('.sm-row', { hasText: 'Display Name' });
  await row.getByRole('button', { name: 'Edit' }).click();
  await dialog.getByRole('textbox', { name: 'Display Name' }).fill('Sam Renamed');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(row.locator('.sm-row-value')).toHaveText('Sam Renamed');
  await expect(dialog.locator('.sm-profile-name')).toHaveText('Sam Renamed');
});

async function openSettings(page: Page) {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  await page.getByRole('button', { name: 'User Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'User Settings' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('scrim click closes the modal; search finds pages by keyword, shows an empty state and clears', async ({ page }) => {
  const dialog = await openSettings(page);
  const search = dialog.getByRole('searchbox', { name: 'Search settings' });
  await search.fill('zzzz');
  await expect(dialog.getByText('No results found')).toBeVisible();
  await dialog.getByRole('button', { name: 'Clear search' }).click();
  await expect(dialog.getByText('No results found')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Voice & Video' })).toBeVisible();
  await search.fill('mic');
  await expect(dialog.getByRole('button', { name: 'Voice & Video' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Language & Time' })).toHaveCount(0);

  await page.locator('.sm-backdrop').click({ position: { x: 4, y: 4 } });
  await expect(dialog).toHaveCount(0);
});

test('unsaved changes on Profiles block Esc, the close button and page switches until reset', async ({ page }) => {
  const dialog = await openSettings(page);
  await dialog.getByRole('button', { name: 'Edit Profiles' }).click();
  await expect(dialog.getByRole('heading', { level: 1 })).toHaveText('Profiles');
  const bar = dialog.locator('.cs-savebar');
  await expect(bar).toHaveCount(0);
  await dialog.getByRole('textbox', { name: 'About me' }).fill('unsaved bio');
  await expect(bar).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(bar).toHaveAttribute('data-shake', /^[ab]$/);
  const first = await bar.getAttribute('data-shake');

  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeVisible();
  await expect(bar).not.toHaveAttribute('data-shake', first!);

  // shortcuts and the tab strip must not drop the draft either
  const second = await bar.getAttribute('data-shake');
  await page.keyboard.press('ControlOrMeta+i');
  await expect(page.locator('.inbox-popout')).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(bar).not.toHaveAttribute('data-shake', second!);
  await dialog.getByRole('tab', { name: 'Per-server profiles' }).click();
  await expect(dialog.getByRole('tab', { name: 'User Profile' })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByRole('textbox', { name: 'About me' })).toHaveValue('unsaved bio');

  await dialog.getByRole('button', { name: 'Appearance' }).click();
  await expect(dialog.getByRole('heading', { level: 1 })).toHaveText('Profiles');

  await bar.getByRole('button', { name: 'Reset' }).click();
  await expect(bar).toHaveCount(0);
  // a bar that returns after Reset starts calm, not shaking from the earlier refusals
  await dialog.getByRole('textbox', { name: 'About me' }).fill('again');
  await expect(bar).toBeVisible();
  await expect(bar).not.toHaveAttribute('data-shake', /./);
  await bar.getByRole('button', { name: 'Reset' }).click();
  await expect(bar).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('Time format changes message timestamps between 12 and 24 hour', async ({ page }) => {
  const dialog = await openSettings(page);
  await dialog.getByRole('button', { name: 'Language & Time' }).click();
  await dialog.getByRole('radio', { name: '24-hour' }).check();
  await page.keyboard.press('Escape');
  await page.locator('.dm-row').first().click();
  const stamp = page.locator('.chat-timestamp').first();
  await expect(stamp).toBeVisible();
  await expect(stamp).not.toHaveText(/[AP]M/i);

  await page.getByRole('button', { name: 'User Settings' }).click();
  await dialog.getByRole('button', { name: 'Language & Time' }).click();
  await dialog.getByRole('radio', { name: '12-hour' }).check();
  await page.keyboard.press('Escape');
  await expect(stamp).toHaveText(/[AP]M/i);
});

test('new pages render: Data & Privacy, Content & Social, Activity Privacy, Connected Apps, Advanced, Keybinds', async ({ page }) => {
  const dialog = await openSettings(page);
  const h1 = dialog.getByRole('heading', { level: 1 });
  for (const name of ['Data & Privacy', 'Content & Social', 'Activity Privacy', 'Connected Apps', 'Advanced', 'Keybinds']) {
    await dialog.getByRole('button', { name, exact: true }).click();
    await expect(h1).toHaveText(name);
  }
  await expect(dialog.getByRole('heading', { name: 'Default Keybinds', level: 2 })).toBeVisible();
});
