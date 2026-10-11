import { expect, test, type Page } from '@playwright/test';
import { channelIdOf } from './helpers';

// Server admin parity on the mock backend: role reorder, ban with message history deletion, audit log filters.

type MockWin = { __vokkoMock: { say(channelId: string, username: string, content: string): string } };

async function openGuild(page: Page): Promise<void> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.locator('.chat-msg').first().waitFor();
}

async function openServerSettings(page: Page, section: string): Promise<void> {
  const dialog = page.getByRole('dialog', { name: /Server Settings/ });
  if (!(await dialog.isVisible())) {
    await page.locator('.guild-header-name-button').click();
    await page.getByRole('menuitem', { name: 'Server Settings' }).click();
  }
  await dialog.waitFor();
  await page.getByRole('button', { name: section, exact: true }).click();
}

const roleNames = (page: Page) => page.locator('.ss-role-list .ss-role-row-name').allInnerTexts();
const roleRow = (page: Page, name: string) => page.locator('.ss-role-row[data-role-id]').filter({ has: page.locator('.ss-role-row-name', { hasText: new RegExp(`^${name}$`) }) });

test('roles reorder by drag and by keyboard', async ({ page }) => {
  await openGuild(page);
  await openServerSettings(page, 'Roles');
  await expect.poll(() => roleNames(page)).toEqual(['Admin', 'Moderator', 'Member', 'Default Permissions (@everyone)']);

  // Keyboard: Alt+Up moves Member above Moderator.
  await roleRow(page, 'Member').focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => roleNames(page)).toEqual(['Admin', 'Member', 'Moderator', 'Default Permissions (@everyone)']);

  // Drag: Moderator back onto Member's slot.
  await roleRow(page, 'Moderator').dragTo(roleRow(page, 'Member'));
  await expect.poll(() => roleNames(page)).toEqual(['Admin', 'Moderator', 'Member', 'Default Permissions (@everyone)']);
});

test('ban with message history deletion removes the recent messages', async ({ page }) => {
  await openGuild(page);
  const channel = channelIdOf(page);
  await page.evaluate(id => (window as unknown as MockWin).__vokkoMock.say(id, 'nova', 'buy cheap coins now'), channel);
  await expect(page.locator('.chat-msg', { hasText: 'buy cheap coins now' })).toBeVisible();

  await openServerSettings(page, 'Members');
  await page.getByRole('button', { name: 'Actions for nova' }).click();
  await page.getByRole('menuitem', { name: 'Ban' }).click();
  const dialog = page.getByRole('dialog', { name: /Ban/ });
  await dialog.getByLabel('Delete message history').selectOption({ label: 'Previous hour' });
  await dialog.getByLabel('Reason for ban').fill('coin spam');
  await dialog.getByRole('button', { name: 'Ban', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.locator('.chat-msg', { hasText: 'buy cheap coins now' })).toHaveCount(0);

  await openServerSettings(page, 'Bans');
  await expect(page.locator('.ss-ban-reason', { hasText: 'coin spam' })).toBeVisible();
});

test('audit log lists actions and filters by action type', async ({ page }) => {
  await openGuild(page);
  await openServerSettings(page, 'Roles');
  await page.getByRole('button', { name: 'Create Role' }).first().click();
  await page.getByRole('tab', { name: 'Display' }).waitFor();
  await page.getByRole('button', { name: 'Back' }).click();

  await page.getByRole('button', { name: 'Members', exact: true }).click();
  await page.getByRole('button', { name: 'Actions for bob' }).click();
  await page.getByRole('menuitem', { name: 'Kick' }).click();
  await page.getByRole('dialog', { name: /Kick/ }).getByLabel('Reason for kick').fill('testing the log');
  await page.getByRole('dialog', { name: /Kick/ }).getByRole('button', { name: 'Kick', exact: true }).click();

  await openServerSettings(page, 'Audit Log');
  const entries = page.locator('.ss-audit-entry');
  await expect(entries).toHaveCount(2);
  await expect(entries.first()).toContainText('kicked');

  await page.getByLabel('Filter by action').selectOption({ label: 'Create Role' });
  await expect(entries).toHaveCount(1);
  await expect(entries.first()).toContainText('created the role new role');
  await entries.first().getByRole('button').click();
  await expect(entries.first().locator('.ss-audit-diff')).toContainText('new role');

  await page.getByLabel('Filter by action').selectOption({ label: 'Kick Member' });
  await expect(entries).toHaveCount(1);
  await entries.first().getByRole('button').click();
  await expect(entries.first()).toContainText('Reason: testing the log');

  await page.getByLabel('Filter by action').selectOption({ label: 'Ban Member' });
  await expect(page.getByText('No logs yet.')).toBeVisible();
});
