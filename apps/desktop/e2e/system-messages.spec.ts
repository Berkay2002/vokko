import { expect, test } from '@playwright/test';
import { openStockTalk } from './helpers';

// System rows (MSG-024) on the mock: pin (6) and join (7) are what the server posts into a channel; thread created (18) is covered in threads.spec.ts.

type Win = {
  __vokko: { request(method: string, path: string, body?: unknown): Promise<unknown> };
  __vokkoMock: { seedOnboardingGuild(owner?: string): { guildId: string; inviteCode: string; channels: Record<string, string> } };
};

test('pinning a message adds a pin row: pin icon in the gutter and the bold name', async ({ page }) => {
  await openStockTalk(page);
  const target = page.locator('.chat-msg').filter({ hasText: /\S/ }).last(); // on screen: an off-screen row would make the click scroll the list up
  await target.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Pin Message' }).click();
  await page.getByRole('dialog', { name: 'Pin this message?' }).getByRole('button', { name: 'Pin it' }).click();

  const row = page.locator('.chat-msg.system').filter({ hasText: 'pinned' }).last();
  await expect(row).toContainText('Sam pinned a message to this channel. See all pinned messages.');
  await expect(row.locator('.chat-system-icon.pin')).toBeVisible();
  await expect(row.locator('.chat-system-name')).toHaveText('Sam');
  const gutter = (await row.locator('.chat-msg-gutter').boundingBox())!;
  const icon = (await row.locator('.chat-system-icon').boundingBox())!;
  expect(icon.x).toBeLessThan(gutter.x + gutter.width); // the icon sits left of the text, in the gutter

  // The 17 px group gap above the row (dm-chat/22), the bold "a message" / "pinned messages" in the strong text colour and the muted verb.
  await expect(row).toHaveCSS('margin-top', '17px');
  const strong = await row.locator('.chat-system-name').evaluate(el => getComputedStyle(el).color);
  for (const link of ['a message', 'pinned messages']) {
    const el = row.getByRole('button', { name: link });
    await expect(el).toHaveCSS('font-weight', '600');
    await expect(el).toHaveCSS('color', strong);
  }
  await expect(row.locator('.chat-system-text')).not.toHaveCSS('color', strong);
});

test('a pin row: the name opens the profile card and "pinned messages" opens the pins popout', async ({ page }) => {
  await openStockTalk(page);
  const target = page.locator('.chat-msg').filter({ hasText: /\S/ }).last(); // on screen: an off-screen row would make the click scroll the list up
  await target.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Pin Message' }).click();
  await page.getByRole('dialog', { name: 'Pin this message?' }).getByRole('button', { name: 'Pin it' }).click();
  const row = page.locator('.chat-msg.system').filter({ hasText: 'pinned' }).last();

  await row.getByRole('button', { name: 'pinned messages' }).click();
  await expect(page.locator('.pins-popout-host')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.pins-popout-host')).toHaveCount(0);

  await row.locator('.chat-system-name').click();
  await expect(page.locator('.profile-card')).toBeVisible();
});

test('joining through an invite posts a join row from the new member in the server\'s system channel', async ({ page }) => {
  await openStockTalk(page);
  const seeded = await page.evaluate(() => (window as unknown as Win).__vokkoMock.seedOnboardingGuild('alice'));
  await page.evaluate(code => (window as unknown as Win).__vokko.request('POST', `/invites/${code}`), seeded.inviteCode);
  await page.evaluate(path => { history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, `/channels/${seeded.guildId}/${seeded.channels.general}`);

  const row = page.locator('.chat-msg.system');
  await expect(row).toHaveCount(1);
  await expect(row.locator('.chat-system-icon.join')).toBeVisible();
  await expect(row.locator('.chat-system-name')).toHaveText('Sam');
  await expect(row.locator('.chat-system-text')).toContainText(/joined the party|brought snacks|just showed up|just landed|Everyone welcome|Good to see you|hopped into|Glad you are here|slid into|Say hi to/);
});
