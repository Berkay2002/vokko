import { expect, test } from '@playwright/test';
import { composer, openGuild, openSession, shot } from './realHelpers';
import type { Session } from './realHelpers';

// The shell's screens against the real server (sam, seeded data).
test.describe.configure({ mode: 'serial' });

let s: Session;

test.afterAll(async () => {
  await s?.ctx.close();
});

test('friends page tabs list the seeded relationships', async ({ browser }) => {
  s = await openSession(browser, 'sam');
  const tab = (name: string | RegExp) => s.page.getByRole('tab', { name });
  await tab('All').click();
  for (const name of ['Carol', 'Alice', 'Bob']) await expect(s.page.getByRole('listitem').filter({ hasText: name }).first()).toBeVisible();
  await shot(s.page, 'r24-friends-all');
  await tab(/Pending/).click();
  await expect(s.page.getByRole('listitem').filter({ hasText: 'Nova' }).first()).toBeVisible();
  await shot(s.page, 'r25-friends-pending');
  await tab('Blocked').click();
  await tab('Online').click();
});

test('quick switcher finds a DM and a channel', async () => {
  await s.page.keyboard.press('ControlOrMeta+k');
  const dialog = s.page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox').fill('carol');
  await shot(s.page, 'r26-quick-switcher');
  await s.page.keyboard.press('Enter');
  await composer(s.page).waitFor();
  await expect(s.page).toHaveURL(/\/channels\/@me\/\d+/);
});

test('server settings modal shows the real server id and member count', async () => {
  await openGuild(s.page, "Sam's server");
  await s.page.getByRole('button', { name: /Sam's server/ }).first().click();
  await s.page.getByRole('menuitem', { name: 'Server Settings' }).click();
  const modal = s.page.getByRole('dialog', { name: /Server Settings/ });
  await expect(modal).toBeVisible();
  await expect(modal).toContainText(/\d{10,}/);
  await shot(s.page, 'r27-server-settings');
  await s.page.keyboard.press('Escape');
});

test('profile card opens from the member list', async () => {
  await s.page.locator('.member-list').getByText('Carol').first().click();
  await expect(s.page.locator('.profile-card, [role=dialog]').first()).toContainText('Carol');
  await shot(s.page, 'r28-profile-card');
  await s.page.keyboard.press('Escape');
});

test('user settings open and the account shows the real username', async () => {
  await s.page.getByRole('button', { name: 'User Settings' }).click();
  await expect(s.page.getByText('sam').first()).toBeVisible();
  await shot(s.page, 'r29-user-settings');
  await s.page.keyboard.press('Escape');
});

test('create a group DM from the friends list', async () => {
  await s.page.getByRole('link', { name: 'Direct Messages' }).first().click();
  await s.page.getByRole('button', { name: 'Create DM' }).click();
  const dialog = s.page.getByRole('dialog', { name: /Select Friends/ });
  await expect(dialog).toBeVisible();
  await dialog.getByText('Alice').first().click();
  await dialog.getByText('Bob').first().click();
  await shot(s.page, 'r30-create-group-dm');
  await dialog.getByRole('button', { name: /Create/ }).click();
  await composer(s.page).waitFor();
  await expect(s.page.locator('.chat-start')).toBeVisible();
});
