import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Shell visual parity round (mac-shell-visual): help action, download apps, row heights, tooltip type, DM tag chips,
// user-panel popout, friend More menu, empty states, pins popout, DM profile banner.

async function home(page: Page): Promise<void> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
}

const box = (page: Page, selector: string) => page.locator(selector).first().evaluate(e => ({ h: e.getBoundingClientRect().height, w: e.getBoundingClientRect().width }));
const font = (page: Page, selector: string) => page.locator(selector).last().evaluate(e => { const c = getComputedStyle(e); return `${c.fontSize}/${c.lineHeight}/${c.fontWeight}`; });

test('Help opens the keybinds page', async ({ page }) => {
  await home(page);
  await page.getByRole('button', { name: 'Help' }).click();
  await expect(page.locator('.sm-side').getByText('Keybinds').first()).toBeVisible();
});

test('Download Desktop App tile opens an info dialog and closes on Escape', async ({ page }) => {
  await home(page);
  await page.getByRole('button', { name: 'Download Desktop App' }).click();
  await expect(page.getByRole('dialog', { name: 'Download Desktop App' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Download for Windows' })).toHaveAttribute('href', '/downloads/Vokko-windows-setup.exe');
  await expect(page.getByRole('link', { name: 'Download for macOS' })).toHaveAttribute('href', '/downloads/Vokko-mac.dmg');
  await expect(page.getByRole('link', { name: 'Download for Linux' })).toHaveAttribute('href', '/downloads/Vokko-linux.AppImage');
  await expect(page.getByRole('link', { name: 'Linux .deb package (Debian, Ubuntu)' })).toHaveAttribute('href', '/downloads/Vokko-linux.deb');
  await expect(page.getByText('Privacy & Security and choose Open Anyway')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Download Desktop App' })).toHaveCount(0);
});

test('nav row is 40 px and DM row 44 px with no gap; DM rows show the server tag', async ({ page }) => {
  await home(page);
  expect((await box(page, '.nav-row-wrap')).h).toBe(40);
  const rows = page.locator('.dm-row-wrap');
  expect((await box(page, '.dm-row-wrap')).h).toBe(44);
  const [a, b] = [await rows.nth(0).boundingBox(), await rows.nth(1).boundingBox()];
  expect(b!.y - a!.y).toBe(44);
  const bob = page.locator('.dm-row', { hasText: /^Bob\s*GG/ }); // the activity subtitle ("In voice") follows
  await expect(bob.locator('.chat-server-tag')).toHaveText('GG');
  await bob.click();
  await expect(page).toHaveURL(/\/channels\/@me\/\d+$/);
});

test('tooltips are 14/18 w500, the rail variant 16/20 w600', async ({ page }) => {
  await home(page);
  await page.getByRole('link', { name: 'Alice' }).first().click();
  await page.locator('.chat-textarea').waitFor();
  await page.getByRole('button', { name: 'Pinned Messages', exact: true }).hover();
  await expect(page.locator('.tooltip')).toBeVisible();
  expect(await font(page, '.tooltip')).toBe('14px/18px/500');
  await page.getByRole('button', { name: 'Add a Server' }).hover();
  await expect(page.locator('.tooltip', { hasText: 'Add a Server' })).toBeVisible();
  expect(await font(page, '.tooltip')).toBe('16px/20px/600');
});

test('user-panel popout: profile card, status submenu, switch accounts, copy ID, edit profile', async ({ page, context }) => {
  // Copy User ID is a developer-mode item (Settings > Advanced).
  await page.addInitScript(() => localStorage.setItem('vokko.prefs', JSON.stringify({ developerMode: true })));
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await home(page);
  await page.locator('.user-panel-account').click();
  await expect(page.locator('.user-panel-account')).toHaveAttribute('aria-haspopup', 'dialog');
  const card = page.getByRole('dialog', { name: 'User profile' });
  await expect(card).toHaveClass(/user-popout/);
  await expect(card.locator('.profile-name')).toHaveText('Sam');
  expect(Math.round((await box(page, '.user-popout .profile-banner')).h)).toBe(105);
  await expect(card.getByText('Orbs')).toHaveCount(0);

  await card.getByRole('menuitem', { name: 'Online' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Do Not Disturb' }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator('.user-panel-sub-status')).toHaveText('Do Not Disturb');

  await page.locator('.user-panel-account').click();
  await card.getByRole('menuitem', { name: 'Switch Accounts' }).click();
  await expect(page.getByRole('menuitem', { name: 'Log Out' })).toBeVisible();
  await page.keyboard.press('Escape');

  await card.getByRole('menuitem', { name: 'Copy User ID' }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  const myId = await page.evaluate(() => (window as unknown as { __vokko: { appStore: { getState(): { me: { id: string } } } } }).__vokko.appStore.getState().me.id);
  expect(copied).toBe(myId);

  await page.locator('.user-panel-account').click();
  await card.getByRole('menuitem', { name: 'Edit Profile' }).click();
  await expect(page.locator('.sm-side')).toBeVisible();
});

test('friend More menu: calls are unavailable, Remove Friend removes the row', async ({ page }) => {
  await home(page);
  const row = page.locator('.people-row', { hasText: 'Alice' });
  await row.hover();
  await row.getByRole('button', { name: 'More' }).click();
  await expect(page.getByRole('menuitem', { name: 'Start Video Call' })).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('menuitem', { name: 'Start Voice Call' })).toHaveAttribute('aria-disabled', 'true');
  await page.getByRole('menuitem', { name: 'Remove Friend' }).click();
  const dialog = page.getByRole('dialog', { name: "Remove 'Alice'" });
  // Cancel keeps the friend; only the dialog's Remove Friend sends the DELETE
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.people-row', { hasText: 'Alice' })).toHaveCount(1);
  await row.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Remove Friend' }).click();
  await dialog.getByRole('button', { name: 'Remove Friend' }).click();
  await expect(page.locator('.people-row', { hasText: 'Alice' })).toHaveCount(0);
});

test('empty friend lists show the illustration and text', async ({ page }) => {
  await home(page);
  await page.getByRole('tab', { name: 'Blocked' }).click();
  const empty = page.locator('.people-empty');
  await expect(empty).toContainText("You haven't blocked anyone.");
  await expect(empty.locator('svg')).toBeVisible();
});

test('empty pins popout is 420x371 with a tip footer; DM profile banner is 105 px', async ({ page }) => {
  await home(page);
  await page.getByRole('link', { name: 'Alice' }).first().click();
  await page.locator('.chat-textarea').waitFor();
  await page.getByRole('button', { name: 'Pinned Messages', exact: true }).click();
  const pins = page.locator('.chat-pins.empty');
  await expect(pins).toBeVisible();
  const size = await box(page, '.chat-pins.empty');
  expect(size).toEqual({ w: 420, h: 371 });
  await expect(pins.locator('.chat-pins-tip')).toContainText('PRO TIP');
  expect((await box(page, '.dm-profile-banner')).h).toBe(105);
});
