import { expect, test, type Page } from '@playwright/test';
import { stays } from './helpers';

// MOD-009: Block and Remove Friend from the user, member and DM context menus ask first and act only on confirm (mock mode).

const SHOTS = process.env.VOKKO_SHOTS_DIR;

type Win = { __vokko: { request(method: string, path: string, body?: unknown): Promise<unknown> } };

const relationshipOf = async (page: Page, username: string): Promise<number | undefined> => {
  const all = (await page.evaluate(() => (window as unknown as Win).__vokko.request('GET', '/users/@me/relationships'))) as { type: number; user: { username: string } }[];
  return all.find(r => r.user.username === username)?.type;
};

const FRIEND = 1;
const BLOCKED = 2;

test('Block from the member list asks first, also for someone who is not a friend', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: "Sam's server" }).click();
  const row = page.locator('.member-list .member-row', { hasText: 'Nova' });
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Block' }).click();
  const dialog = page.getByRole('dialog', { name: 'Block Nova' });
  await expect(dialog).toContainText('Are you sure you want to block Nova?');
  if (SHOTS) await dialog.screenshot({ path: `${SHOTS}/MOD-009-block-confirm.png` });
  const before = await relationshipOf(page, 'nova');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await stays(() => relationshipOf(page, 'nova'), before);

  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Block' }).click();
  await dialog.getByRole('button', { name: 'Block' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => relationshipOf(page, 'nova')).toBe(BLOCKED);
});

test('Remove Friend from a DM row menu asks first', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  const row = page.locator('.dm-row[aria-label^="Bob,"]');
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Remove Friend' }).click();
  const dialog = page.getByRole('dialog', { name: "Remove 'Bob'" });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await stays(() => relationshipOf(page, 'bob'), FRIEND);

  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Remove Friend' }).click();
  await dialog.getByRole('button', { name: 'Remove Friend' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => relationshipOf(page, 'bob')).toBeUndefined();
});

test('the Block dialog names a member by the nickname they have in the server, or their name without one', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: "Sam's server" }).click();
  // Seed fillers, neither a friend nor in a request: amber_fox has no nickname, misty_fox is "fox-4" in this server.
  for (const [row, name] of [['amber_fox', 'amber_fox'], ['fox-4', 'fox-4']] as const) {
    const member = page.locator('.member-list .member-row', { hasText: row });
    await member.scrollIntoViewIfNeeded(); // a scroll after the menu opens would close it
    await member.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Block' }).click();
    const dialog = page.getByRole('dialog', { name: `Block ${name}` });
    await expect(dialog).toContainText(`Are you sure you want to block ${name}?`);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
  }
});
