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

// The hand-rolled pages (Roles, Onboarding, webhooks) go through the same guard as the shared bar: Esc is refused with a shake until
// the draft is reset or saved, and a clean page never blocks.
async function expectEscRefused(page: Page, dialog: ReturnType<Page['getByRole']>, bar: ReturnType<Page['locator']>): Promise<void> {
  await expect(bar).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(bar).toHaveAttribute('data-shake', /^[ab]$/);
}

test('server settings: a dirty role editor refuses Esc until Reset, then closes', async ({ page }) => {
  await openGuild(page);
  await openServerSettings(page, 'Roles');
  const dialog = page.getByRole('dialog', { name: /Server Settings/ });
  const bar = dialog.locator('.cs-savebar');
  await roleRow(page, 'Member').click();
  const name = dialog.getByRole('textbox', { name: 'Role Name' });
  await expect(bar).toHaveCount(0);
  await name.fill('Draft role');
  await expectEscRefused(page, dialog, bar);
  await expect(name).toHaveValue('Draft role');

  // Back and the other roles in the aside would drop the draft: refused with a shake too.
  const first = await bar.getAttribute('data-shake');
  await dialog.getByRole('button', { name: 'Back' }).click();
  await expect(bar).not.toHaveAttribute('data-shake', first!);
  const second = await bar.getAttribute('data-shake');
  await dialog.getByRole('navigation', { name: 'Roles' }).getByRole('button', { name: 'Moderator' }).click();
  await expect(bar).not.toHaveAttribute('data-shake', second!);
  await expect(name).toHaveValue('Draft role');

  await bar.getByRole('button', { name: 'Reset' }).click();
  await expect(bar).toHaveCount(0);
  await dialog.getByRole('navigation', { name: 'Roles' }).getByRole('button', { name: 'Moderator' }).click(); // clean: switches
  await expect(dialog.getByRole('heading', { level: 1 })).toHaveText('Edit Role - Moderator');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('server settings: dirty onboarding refuses Esc until saved, then closes', async ({ page }) => {
  await openGuild(page);
  await openServerSettings(page, 'Onboarding');
  const dialog = page.getByRole('dialog', { name: /Server Settings/ });
  const bar = dialog.locator('.cs-savebar');
  const rules = dialog.getByLabel(/^Rules \(one per line/);
  await expect(rules).toBeVisible();
  await expect(bar).toHaveCount(0);
  await rules.fill('Be kind.');
  await expectEscRefused(page, dialog, bar);
  await expect(rules).toHaveValue('Be kind.');

  await bar.getByRole('button', { name: 'Reset' }).click();
  await expect(bar).toHaveCount(0);
  await rules.fill('Be kind.');
  await bar.getByRole('button', { name: 'Save Changes' }).click();
  await expect(dialog.getByRole('status')).toHaveText('Saved');
  await expect(bar).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('server settings: a dirty webhook refuses Esc until saved, then closes', async ({ page }) => {
  await openGuild(page);
  await openServerSettings(page, 'Integrations');
  const dialog = page.getByRole('dialog', { name: /Server Settings/ });
  await dialog.getByRole('button', { name: 'New Webhook' }).click();
  const hooks = dialog.getByRole('list', { name: 'Webhooks' });
  const bar = hooks.locator('.cs-savebar');
  await expect(hooks).toContainText('New Webhook');
  await expect(bar).toHaveCount(0);
  await page.keyboard.press('Escape'); // a clean card does not block
  await expect(dialog).toHaveCount(0);

  await openServerSettings(page, 'Integrations');
  await hooks.getByRole('button', { name: /New Webhook/ }).first().click();
  await hooks.getByLabel('Name').fill('Deploys');
  await expectEscRefused(page, dialog, bar);
  await expect(hooks.getByLabel('Name')).toHaveValue('Deploys');

  await bar.getByRole('button', { name: 'Save Changes' }).click();
  await expect(hooks.locator('.apps-card-name')).toHaveText('Deploys');
  await expect(bar).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('quick switcher over a dirty settings frame refuses the jump and keeps the draft', async ({ page }) => {
  await openGuild(page);
  await openServerSettings(page, 'Server Profile');
  const dialog = page.getByRole('dialog', { name: /Server Settings/ });
  const bar = dialog.locator('.cs-savebar');
  const name = dialog.getByRole('textbox', { name: 'Server name' });
  const url = page.url();
  await name.fill('Draft server');
  await expect(bar).toBeVisible();
  await name.blur();

  const jump = async () => {
    await page.keyboard.press('ControlOrMeta+k');
    await page.locator('.quick-input').fill('random');
    await page.locator('.quick-row').first().click();
  };
  await jump();
  await expect(page.locator('.quick-input')).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(name).toHaveValue('Draft server');
  await expect(bar).toHaveAttribute('data-shake', /^[ab]$/);
  expect(page.url()).toBe(url);

  // Clean again: the same jump leaves the settings behind and navigates.
  await bar.getByRole('button', { name: 'Reset' }).click();
  await name.blur();
  await jump();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.channel-row.selected')).toContainText(/random/i);
});
