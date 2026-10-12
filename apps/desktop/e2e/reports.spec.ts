import { expect, test, type Page } from '@playwright/test';
import { pickOption } from './helpers';

// MOD-009: the Reports page of Server Settings lists the moderator queue; Resolve / Reopen move a report between filters (mock mode).

type Win = {
  __vokko: { request(method: string, path: string, body?: unknown): Promise<unknown> };
  __vokkoMock: { channelIdByName(name: string): string | null; say(channelId: string, username: string, content: string): string };
};

// Nova writes a message in #general and the owner (sam, a moderator) reports it, so the queue holds one open report.
async function seedReport(page: Page, content: string): Promise<void> {
  await page.evaluate(async text => {
    const w = window as unknown as Win;
    const channel = w.__vokkoMock.channelIdByName('general')!;
    const id = w.__vokkoMock.say(channel, 'nova', text);
    await w.__vokko.request('POST', `/channels/${channel}/messages/${id}/report`, { reason: 'spam' });
  }, content);
}

test('a moderator resolves a report: it leaves Open, shows under Resolved and can be reopened', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.locator('.chat-msg').first().waitFor();
  await seedReport(page, 'buy cheap followers now');

  await page.locator('.guild-header-name-button').click();
  await page.getByRole('menuitem', { name: 'Server Settings' }).click();
  const dialog = page.getByRole('dialog', { name: /Server Settings/ });
  await dialog.getByRole('button', { name: 'Reports', exact: true }).click();

  const row = dialog.getByRole('listitem').filter({ hasText: 'buy cheap followers now' });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Spam');
  await row.getByRole('button', { name: 'Resolve' }).click();
  await expect(row).toHaveCount(0);
  await expect(dialog.getByText('No open reports')).toBeVisible();

  await pickOption(page, dialog.getByRole('combobox', { name: 'Filter by status' }), 'Resolved');
  await expect(row).toHaveCount(1);

  await row.getByRole('button', { name: 'Reopen' }).click();
  await expect(row).toHaveCount(0);
  await expect(dialog.getByText('No resolved reports')).toBeVisible();

  await pickOption(page, dialog.getByRole('combobox', { name: 'Filter by status' }), 'Open');
  await expect(row).toHaveCount(1);
});
