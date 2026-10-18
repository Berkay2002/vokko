import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { openStockTalk } from './helpers';

// DM rows during a gateway outage, the user panel's own status, the profile card's Member Since icons and the Create Your Server
// flow, against the mock backend. Screenshots are written when VOKKO_SHOTS_DIR is set (desktop 1440x900, phone 390x844).
const dir = process.env.VOKKO_SHOTS_DIR;
const shot = async (page: Page, name: string) => {
  if (!dir) return;
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
};

type Win = { __vokkoMock: { offline(on: boolean): void }; __vokko: { appStore: { getState(): { connection: string } } } };
const connection = (page: Page) => page.evaluate(() => (window as unknown as Win).__vokko.appStore.getState().connection);

async function home(page: Page) {
  await page.addInitScript(() => localStorage.setItem('vokko.notify.promptDismissed', '1'));
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await expect.poll(() => connection(page)).toBe('ready');
}

test('a DM row drops "In voice" while the gateway reconnects and shows it again once connected', async ({ page }) => {
  await home(page);
  const alice = page.locator('.dm-row', { hasText: 'Alice' });
  await expect(alice.locator('.dm-activity.voice')).toHaveText('In voice');
  await page.evaluate(() => (window as unknown as Win).__vokkoMock.offline(true));
  await expect(page.getByTestId('connection-banner')).toBeVisible({ timeout: 8000 });
  await expect(alice.locator('.dm-activity')).toHaveCount(0);
  await expect(alice).not.toHaveAttribute('aria-label', /in voice/);
  await shot(page, 'dm-rows-reconnecting');
  await page.evaluate(() => (window as unknown as Win).__vokkoMock.offline(false));
  await page.getByTestId('connection-banner').getByRole('button', { name: 'Reconnect now' }).click();
  await expect.poll(() => connection(page), { timeout: 8000 }).toBe('ready');
  await expect(alice.locator('.dm-activity.voice')).toHaveText('In voice');
});

test('the user panel shows the chosen status dot and custom status at once', async ({ page }) => {
  await home(page);
  const panel = page.locator('.user-panel-account');
  await expect(panel.locator('.status-badge')).toHaveAttribute('aria-label', 'online');
  await expect(panel.locator('.user-panel-sub-status')).toHaveText('Online');
  await panel.click();
  await page.getByRole('menuitem', { name: 'Online' }).click();
  await page.getByText('Do Not Disturb', { exact: true }).click();
  await expect(panel.locator('.status-badge')).toHaveAttribute('aria-label', 'dnd');
  await expect(panel.locator('.user-panel-sub-status')).toHaveText('Do Not Disturb');
  await panel.click();
  const note = page.getByPlaceholder('Add a status');
  await note.fill('Shipping 0.2');
  await note.press('Enter');
  await expect(panel.locator('.user-panel-sub-status')).toHaveText('Shipping 0.2');
  await shot(page, 'user-panel-status');
});

test('the profile card names the sources of its Member Since dates on hover', async ({ page }) => {
  await openStockTalk(page);
  await page.locator('.chat-msg:not(.grouped):not(.system)', { hasText: 'Bobby' }).last().locator('.chat-author').click();
  const card = page.locator('.profile-card');
  await expect(card.locator('.profile-since')).toBeVisible();
  // Focus moves into the card on open; a click-opened card must not pop the In voice info tooltip by itself.
  await page.waitForTimeout(400);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await card.getByRole('img', { name: 'Vokko' }).hover();
  await expect(page.getByRole('tooltip', { name: 'Vokko', exact: true })).toBeVisible();
  await card.getByRole('img', { name: "Sam's server" }).hover();
  await expect(page.getByRole('tooltip', { name: "Sam's server", exact: true })).toBeVisible();
  await shot(page, 'profile-member-since');
});

for (const [label, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]] as const) {
  test(`Create Your Server follows Discord's steps (${label})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await home(page);
    await page.getByRole('button', { name: 'Add a Server' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Start from a template')).toBeVisible();
    await expect(dialog.getByText('Have an invite already?')).toBeVisible();
    await shot(page, `create-server-1-${label}`);
    await dialog.getByRole('button', { name: 'Gaming' }).click();
    await expect(page.getByRole('dialog')).toContainText('Tell Us More About Your Server');
    await shot(page, `create-server-2-${label}`);
    await page.getByRole('dialog').getByRole('button', { name: 'For me and my friends' }).click();
    await expect(page.getByRole('dialog')).toContainText('Customize Your Server');
    await expect(page.getByRole('button', { name: 'Upload an icon' })).toBeVisible();
    await shot(page, `create-server-3-${label}`);
    await page.getByRole('dialog').getByRole('button', { name: 'Back' }).click();
    await expect(page.getByRole('dialog')).toContainText('Tell Us More About Your Server');
    await page.getByRole('dialog').getByRole('button', { name: 'Back' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Join a Server' }).click();
    await expect(page.getByRole('dialog')).toContainText('Invites should look like');
    await shot(page, `create-server-join-${label}`);
  });
}
