import { expect, test, type Page } from '@playwright/test';

// Members page (Discord's member-safety table) against the mock seed: Sam's server has 65 members.
const SHOTS = process.env.VOKKO_SHOTS_DIR;

async function openServer(page: Page, as: string): Promise<string> {
  await page.goto(`/channels/@me?as=${as}&mockLatency=0`);
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.waitForURL(/\/channels\/\d+\/\d+/);
  return new URL(page.url()).pathname.split('/')[2] ?? '';
}

async function openMembers(page: Page): Promise<void> {
  await openServer(page, 'sam');
  await page.getByRole('link', { name: 'Members', exact: true }).click();
  await page.waitForURL(/\/member-safety/);
  await expect(page.getByRole('table', { name: 'Server members' }).locator('tbody tr')).toHaveCount(12);
}

const rows = (page: Page) => page.getByRole('table', { name: 'Server members' }).locator('tbody tr');
const footer = (page: Page) => page.locator('.mp-showing');

test('a moderator opens the Members page from the channel list', async ({ page }) => {
  await openMembers(page);
  await expect(page.getByRole('heading', { name: 'Members', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recent Members' })).toBeVisible();
  await expect(footer(page)).toContainText('members of 65');
  await expect(page.getByRole('combobox', { name: 'Members per page' })).toHaveText('12');
  await expect(page.getByRole('link', { name: 'Members', exact: true })).toHaveClass(/selected/);
  // Column headers and a row's cells.
  for (const name of ['Name', 'Member since', 'Joined Vokko', 'Join method', 'Roles', 'Signals']) await expect(page.getByRole('columnheader', { name })).toBeVisible();
  await expect(rows(page).first()).toContainText(/ago/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/members-page.png` });
});

test('search narrows the table and the footer counts the results', async ({ page }) => {
  await openMembers(page);
  await page.getByRole('searchbox', { name: 'Search by username or ID' }).fill('golden');
  await expect(page.getByRole('heading', { name: 'Search Results' })).toBeVisible();
  await expect(rows(page)).toHaveCount(7);
  for (const row of await rows(page).all()) await expect(row).toContainText('golden_');
  await expect(footer(page)).toHaveText('Showing 7 members');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/members-search.png` });
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(page.getByRole('heading', { name: 'Recent Members' })).toBeVisible();
  await expect(footer(page)).toContainText('members of 65');
});

test('sort and paging live in the URL', async ({ page }) => {
  await openMembers(page);
  const firstDefault = await rows(page).first().locator('.mp-username').textContent();

  await page.getByRole('button', { name: 'Page 2' }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.getByRole('button', { name: 'Page 2' })).toHaveAttribute('aria-current', 'page');
  await expect(rows(page)).toHaveCount(12);
  await expect(rows(page).first().locator('.mp-username')).not.toHaveText(firstDefault ?? '');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page).toHaveURL(/page=3/);

  await page.getByRole('button', { name: 'Sort' }).click();
  const sortMenu = page.getByRole('dialog', { name: 'Sort members' });
  await expect(sortMenu.getByRole('radio', { name: 'Member since (newest first)' })).toHaveAttribute('aria-checked', 'true');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/members-sort.png` });
  await sortMenu.getByRole('radio', { name: 'Member since (oldest first)' }).click();
  await expect(page).toHaveURL(/sort=2/);
  await expect(page).not.toHaveURL(/page=/);
  // Oldest member first: a year-old member. (A reload signs the mock out, so the URL round trip is covered in query.test.ts.)
  await expect(rows(page).first().getByRole('cell').nth(1)).toHaveText(/year/);
  await page.getByRole('button', { name: 'Page 2' }).click();
  await expect(page).toHaveURL(/page=2&sort=2/);
});

test('the role filter keeps members with that role', async ({ page }) => {
  await openMembers(page);
  await page.getByRole('button', { name: 'Filter by roles' }).click();
  const menu = page.getByRole('dialog', { name: 'Filter by roles' });
  await expect(menu.getByRole('checkbox').first()).toBeFocused();
  await menu.getByRole('checkbox', { name: 'Event Host' }).click();
  await expect(menu.getByRole('checkbox', { name: 'Event Host' })).toHaveAttribute('aria-checked', 'true');
  await expect(footer(page)).toContainText('members of 6');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/members-role-filter.png` });
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(page.getByRole('button', { name: 'Filter by roles' })).toBeFocused();
  await expect(rows(page)).toHaveCount(6);
  for (const row of await rows(page).all()) await expect(row.locator('.mp-roles')).not.toBeEmpty();
});

test('the row menu offers the member actions', async ({ page }) => {
  await openMembers(page);
  await rows(page).first().getByRole('button', { name: /^More actions for/ }).click();
  const menu = page.getByRole('menu');
  for (const name of ['Profile', 'Message', 'Change Nickname', 'Block', 'Open in Mod View', 'Copy User ID']) await expect(menu.getByRole('menuitem', { name })).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/members-row-menu.png` });
});

test('members without a moderation permission do not see the page', async ({ page }) => {
  const guildId = await openServer(page, 'bob');
  await expect(page.getByRole('link', { name: 'Events' }).or(page.locator('.cm-quicklink').first())).toBeVisible();
  await expect(page.getByRole('link', { name: 'Members', exact: true })).toHaveCount(0);
  await page.goto(`/channels/${guildId}/member-safety?as=bob&mockLatency=0`);
  await page.waitForURL(url => !url.pathname.includes('member-safety'));
  await expect(page.getByRole('table', { name: 'Server members' })).toHaveCount(0);
});
