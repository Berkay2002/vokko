import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import path from 'node:path';

// Group DM management (seed: Sam owns a group with Nova and Bob): leaving asks first, Edit Group renames, the member list shows
// everyone including yourself and lets the owner remove people. Screenshots are written when VOKKO_SHOTS_DIR is set.
const dir = process.env.VOKKO_SHOTS_DIR;
const shot = async (page: Page, name: string) => {
  if (!dir) return;
  await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished)));
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
};

// A 1x1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const groupRow =(page: Page) => page.locator('.dm-row-wrap').filter({ hasText: '3 members' });

test('the X on a group row asks before leaving; 1:1 DMs keep closing silently', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  const row = groupRow(page);
  await row.hover();
  await row.getByRole('button', { name: 'Leave Group' }).click();
  const dialog = page.getByRole('dialog', { name: "Leave 'Nova, Bob'" });
  await expect(dialog).toContainText("You won't be able to rejoin this group unless you are re-invited.");
  await shot(page, 'leave-group-1440');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toBeVisible();

  // The context menu's Leave Group asks too; confirming leaves.
  await row.getByRole('link').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Leave Group' }).click();
  await dialog.getByRole('button', { name: 'Leave Group' }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toHaveCount(0);

  const bob = page.locator('.dm-row-wrap').filter({ has: page.getByRole('link', { name: /^Bob\b/ }) });
  await bob.hover();
  await bob.getByRole('button', { name: 'Close DM' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(bob).toHaveCount(0);
});

test('Edit Group renames the group; the member list shows yourself and the owner removes a member', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await groupRow(page).getByRole('link').click();
  await expect(page.getByRole('textbox', { name: 'Message Nova, Bob' })).toBeVisible();

  const members = page.locator('aside.group-members');
  await expect(members.getByRole('heading')).toHaveText('Members — 3');
  await expect(members.getByRole('listitem')).toHaveText([/Bob/, /Nova/, /Sam/]);
  await expect(members.getByRole('listitem').filter({ hasText: 'Sam' }).getByRole('img', { name: 'Group Owner' })).toBeVisible();
  await shot(page, 'group-members-1440');

  await page.locator('.channel-header-name-edit').click();
  const edit = page.getByRole('dialog', { name: 'Edit Group' });
  await edit.getByLabel('Group name').fill('Movie Night');
  await shot(page, 'edit-group-1440');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(edit).toBeHidden();
  await expect(page.locator('.channel-header-name')).toHaveText('Movie Night');
  await expect(page.getByRole('textbox', { name: 'Message Movie Night' })).toBeVisible();

  // An icon: picked in Edit Group, then shown in the header and the DM list.
  await page.locator('.channel-header-name-edit').click();
  await edit.locator('input[type=file]').setInputFiles({ name: 'icon.png', mimeType: 'image/png', buffer: Buffer.from(PNG, 'base64') });
  await expect(edit.getByRole('button', { name: 'Remove Icon' })).toBeVisible();
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(edit).toBeHidden();
  await expect(page.locator('.channel-header img.group-icon')).toBeVisible();
  await expect(page.locator('.dm-row-wrap img.group-icon')).toBeVisible();
  await shot(page, 'group-icon-1440');

  const bob = members.getByRole('listitem').filter({ hasText: 'Bob' });
  await bob.hover();
  await bob.getByRole('button', { name: 'Remove Bob from group' }).click();
  await expect(members.getByRole('heading')).toHaveText('Members — 2');
  await expect(members.getByRole('listitem')).toHaveText([/Nova/, /Sam/]);
});

test('phone: Details lists the group members with Leave Group, and Edit Group sits in the bar', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await groupRow(page).getByRole('link').click();
  await page.getByRole('button', { name: 'Nova, Bob, details' }).click();
  const details = page.getByRole('region', { name: 'Details' });
  await expect(details.locator('aside.group-members').getByRole('listitem')).toHaveCount(3);
  await expect(details.getByRole('button', { name: 'Leave Group' })).toBeVisible();
  await shot(page, 'group-details-390');
  await details.getByRole('button', { name: 'Edit Group' }).click();
  await expect(page.getByRole('dialog', { name: 'Edit Group' })).toBeVisible();
  await shot(page, 'edit-group-390');
});
