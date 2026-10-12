import { expect, test, type Page } from '@playwright/test';
import { channelIdOf, pickOption } from './helpers';

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

// The members table holds the seeded crowd (65 rows): find the row by search, like a moderator would, so the actions
// menu isn't opened mid-scroll (the smooth scroll that brings a far row into view closes it).
async function memberActions(page: Page, username: string): Promise<void> {
  await page.getByRole('searchbox', { name: 'Search by username or id' }).fill(username);
  await page.getByRole('button', { name: `Actions for ${username}` }).click();
}

// Cosmetic roles the members-page seed adds below Member (mock/seed.ts seedMemberCrowd).
const CROWD_ROLES = ['Helper', 'Artist', 'Developer', 'Event Host'];
const roleNames = (page: Page) => page.locator('.ss-role-list .ss-role-row-name').allInnerTexts();
const roleRow = (page: Page, name: string) => page.locator('.ss-role-row[data-role-id]').filter({ has: page.locator('.ss-role-row-name', { hasText: new RegExp(`^${name}$`) }) });

test('roles reorder by drag and by keyboard', async ({ page }) => {
  await openGuild(page);
  await openServerSettings(page, 'Roles');
  await expect.poll(() => roleNames(page)).toEqual(['Admin', 'Moderator', 'Member', ...CROWD_ROLES, 'Default Permissions (@everyone)']);

  // Keyboard: Alt+Up moves Member above Moderator.
  await roleRow(page, 'Member').focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => roleNames(page)).toEqual(['Admin', 'Member', 'Moderator', ...CROWD_ROLES, 'Default Permissions (@everyone)']);

  // Drag: Moderator back onto Member's slot.
  await roleRow(page, 'Moderator').dragTo(roleRow(page, 'Member'));
  await expect.poll(() => roleNames(page)).toEqual(['Admin', 'Moderator', 'Member', ...CROWD_ROLES, 'Default Permissions (@everyone)']);
});

test('ban with message history deletion removes the recent messages', async ({ page }) => {
  await openGuild(page);
  const channel = channelIdOf(page);
  await page.evaluate(id => (window as unknown as MockWin).__vokkoMock.say(id, 'nova', 'buy cheap coins now'), channel);
  await expect(page.locator('.chat-msg', { hasText: 'buy cheap coins now' })).toBeVisible();

  await openServerSettings(page, 'Members');
  await memberActions(page, 'nova');
  await page.getByRole('menuitem', { name: 'Ban' }).click();
  const dialog = page.getByRole('dialog', { name: /Ban/ });
  await pickOption(page, dialog.getByRole('combobox', { name: 'Delete message history' }), 'Previous hour');
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
  await memberActions(page, 'bob');
  await page.getByRole('menuitem', { name: 'Kick' }).click();
  await page.getByRole('dialog', { name: /Kick/ }).getByLabel('Reason for kick').fill('testing the log');
  await page.getByRole('dialog', { name: /Kick/ }).getByRole('button', { name: 'Kick', exact: true }).click();

  await openServerSettings(page, 'Audit Log');
  const entries = page.locator('.ss-audit-entry');
  await expect(entries).toHaveCount(2);
  await expect(entries.first()).toContainText('kicked');

  await pickOption(page, page.getByRole('combobox', { name: 'Filter by action' }), 'Create Role');
  await expect(entries).toHaveCount(1);
  await expect(entries.first()).toContainText('created the role new role');
  await entries.first().getByRole('button').click();
  await expect(entries.first().locator('.ss-audit-diff')).toContainText('new role');

  await pickOption(page, page.getByRole('combobox', { name: 'Filter by action' }), 'Kick Member');
  await expect(entries).toHaveCount(1);
  await entries.first().getByRole('button').click();
  await expect(entries.first()).toContainText('Reason: testing the log');

  await pickOption(page, page.getByRole('combobox', { name: 'Filter by action' }), 'Ban Member');
  await expect(page.getByText('No logs yet.')).toBeVisible();
});

test('server settings: an unsaved name blocks Esc, Close, page switches and Mod+I with a shake until Reset', async ({ page }) => {
  await openGuild(page);
  await openServerSettings(page, 'Server Profile');
  const dialog = page.getByRole('dialog', { name: /Server Settings/ });
  const bar = dialog.locator('.cs-savebar');
  const name = dialog.getByRole('textbox', { name: 'Server name' });
  const original = await name.inputValue();
  await expect(bar).toHaveCount(0);

  // A clean frame is never blocked: switching pages works with no shake.
  await dialog.getByRole('button', { name: 'Engagement', exact: true }).click();
  await expect(dialog.getByRole('heading', { level: 1 })).toHaveText('Engagement');
  await dialog.getByRole('button', { name: 'Server Profile', exact: true }).click();

  await name.fill('Draft server');
  await expect(bar).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(bar).toHaveAttribute('data-shake', /^[ab]$/);
  const first = await bar.getAttribute('data-shake');

  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeVisible();
  await expect(bar).not.toHaveAttribute('data-shake', first!);

  const second = await bar.getAttribute('data-shake');
  await dialog.getByRole('button', { name: 'Roles', exact: true }).click();
  await expect(dialog.getByRole('heading', { level: 1 })).toHaveText('Server Profile');
  await expect(name).toHaveValue('Draft server');
  await expect(bar).not.toHaveAttribute('data-shake', second!);
  await expect(bar).toHaveCSS('animation-name', /^sm-shake-[ab]$/);

  // Mod+I is a modal shortcut (it replaces the open modal), so the guard has to refuse it too.
  const third = await bar.getAttribute('data-shake');
  await page.keyboard.press('ControlOrMeta+i');
  await expect(page.locator('.inbox-popout')).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(bar).not.toHaveAttribute('data-shake', third!);
  await expect(name).toHaveValue('Draft server');

  // Delete Server is a dialog: it parks the frame with the draft intact, then hands it back.
  await dialog.getByRole('button', { name: 'Delete Server' }).click();
  const confirm = page.getByRole('dialog', { name: /Delete/ });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(name).toHaveValue('Draft server');

  await bar.getByRole('button', { name: 'Reset' }).click();
  await expect(bar).toHaveCount(0);
  await expect(name).toHaveValue(original);
  await dialog.getByRole('button', { name: 'Roles', exact: true }).click();
  await expect(dialog.getByRole('heading', { level: 1 })).toHaveText('Roles');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});
