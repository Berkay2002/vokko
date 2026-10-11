import { expect, test, type Page } from '@playwright/test';
import { pickOption } from './helpers';

// Server folders on the rail and invite link settings (mock mode; docs/api.md "Invites and user settings").

type Win = { __vokko: { request(method: string, path: string, body?: unknown): Promise<unknown> } };

async function openHome(page: Page): Promise<void> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: "Sam's server" }).waitFor();
}

async function createGuilds(page: Page, names: string[]): Promise<void> {
  for (const name of names) {
    await page.evaluate(n => (window as unknown as Win).__vokko.request('POST', '/guilds', { name: n }), name);
    await page.getByRole('link', { name }).waitFor();
  }
}

const rail = (page: Page) => page.getByRole('navigation', { name: 'Servers sidebar' });

test('dragging a server onto another makes a folder that collapses, renames and survives a reconnect', async ({ page }) => {
  await openHome(page);
  await createGuilds(page, ['Alpha', 'Beta']);
  const nav = rail(page);

  await nav.getByRole('link', { name: 'Beta' }).dragTo(nav.getByRole('link', { name: 'Alpha' }));

  // The new folder opens with both servers inside it, in drop order.
  const folder = nav.locator('.rail-folder');
  await expect(folder).toHaveCount(1);
  await expect(folder.getByRole('button', { name: /^Folder Alpha, Beta$/ })).toHaveAttribute('aria-expanded', 'true');
  await expect(folder.getByRole('link')).toHaveCount(2);
  expect(await folder.getByRole('link').evaluateAll(links => links.map(l => l.getAttribute('aria-label')))).toEqual(['Alpha', 'Beta']);

  // Stored on the server: the settings carry the folder and the rail order.
  const settings = (await page.evaluate(() => (window as unknown as Win).__vokko.request('GET', '/users/@me/guild-layout'))) as { guild_folders: { guild_ids: string[]; name: string | null }[] };
  expect(settings.guild_folders).toHaveLength(1);
  expect(settings.guild_folders[0]!.guild_ids).toHaveLength(2);

  // Collapse: the servers hide behind the folder tile with its mini icons.
  await folder.getByRole('button', { name: /^Folder/ }).click();
  await expect(folder.getByRole('link')).toHaveCount(0);
  await expect(folder.locator('.rail-folder-mini')).toHaveCount(2);

  // Folder settings: rename and recolour.
  await folder.getByRole('button', { name: /^Folder/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Folder Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Folder Settings' });
  await dialog.getByLabel('Folder Name').fill('Projects');
  await dialog.getByRole('radio', { name: '#3ba55c' }).click();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(nav.getByRole('button', { name: 'Folder Projects' })).toBeVisible();

  // A fresh READY (reconnect) brings the same folder back.
  await page.evaluate(() => (window as unknown as { __vokkoMock: { dropConnections(): void } }).__vokkoMock.dropConnections());
  await expect(nav.getByRole('button', { name: 'Folder Projects' })).toBeVisible();
  const saved = (await page.evaluate(() => (window as unknown as Win).__vokko.request('GET', '/users/@me/guild-layout'))) as { guild_folders: { name: string | null; color: number | null }[] };
  expect(saved.guild_folders[0]).toMatchObject({ name: 'Projects', color: 0x3ba55c });
});

test('the invite modal creates a limited invite and lists friends to send it to', async ({ page }) => {
  await openHome(page);
  await page.getByRole('link', { name: "Sam's server" }).click();
  await page.getByRole('button', { name: 'Invite People' }).click();
  const dialog = page.getByRole('dialog', { name: /Invite friends to/ });
  await expect(dialog.locator('#invite-link')).toHaveValue(/^vokko\.gg\/[a-z0-9]+$/);
  await expect(dialog.getByRole('list', { name: 'Friends' }).getByRole('listitem').first()).toBeVisible();
  await expect(dialog).toContainText('Your invite link expires in 7 days.');

  await dialog.getByRole('button', { name: 'Edit invite link.' }).click();
  const settings = page.getByRole('dialog', { name: 'Server invite link settings' });
  // A backdrop click while a dropdown is open closes only the dropdown, not the dialog.
  await settings.getByRole('combobox', { name: 'Expire After' }).click();
  await expect(settings.getByRole('listbox', { name: 'Expire After' })).toBeVisible(); // portalled inside the aria-modal dialog
  await page.mouse.click(5, 5);
  await expect(page.getByRole('listbox', { name: 'Expire After' })).toHaveCount(0);
  await expect(settings).toBeVisible();
  await pickOption(page, settings.getByRole('combobox', { name: 'Expire After' }), '30 minutes');
  await pickOption(page, settings.getByRole('combobox', { name: 'Max Number of Uses' }), '5 uses');
  await settings.getByRole('button', { name: 'Generate a New Link' }).click();

  const main = page.getByRole('dialog', { name: /Invite friends to/ });
  await expect(main).toContainText('Your invite link expires in 30 minutes or after 5 uses.');
  const code = (await main.locator('#invite-link').inputValue()).replace('vokko.gg/', '');
  const invite = (await page.evaluate(c => (window as unknown as Win).__vokko.request('GET', `/invites/${c}`), code)) as { code: string; expires_at: string };
  expect(invite.code).toBe(code);
  expect(Date.parse(invite.expires_at) - Date.now()).toBeLessThanOrEqual(30 * 60_000);

  // Sending to a friend posts the link in their DM.
  const first = main.getByRole('list', { name: 'Friends' }).getByRole('button').first();
  await first.click();
  await expect(main.getByRole('list', { name: 'Friends' }).getByRole('button').first()).toHaveText('Sent');

  // Server Settings > Invites lists it with its uses and can revoke it.
  await page.keyboard.press('Escape');
  await rail(page).getByRole('link', { name: "Sam's server" }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Server Settings' }).click();
  await page.getByRole('navigation', { name: 'Server settings sections' }).getByRole('button', { name: 'Invites', exact: true }).click();
  const row = page.locator(`tr[data-code="${code}"]`);
  await expect(row).toContainText('0/5');
  await row.getByRole('button', { name: `Revoke invite ${code}` }).click();
  await expect(row).toHaveCount(0);
});
