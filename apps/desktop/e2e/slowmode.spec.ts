import { expect, test, type Page } from '@playwright/test';
import { composer, message, pickOption, send } from './helpers';
import { openChannel } from './threadHelpers';

// Slowmode (gap audit #10): Channel Settings sets rate_limit_per_user; members get a countdown after sending and cannot send while it runs,
// moderators and the owner are immune. bob is a plain Member, sam the owner of the mock server.

const setSlowmode = (page: Page, channelId: string, seconds: number) =>
  page.evaluate(([id, s]) => (window as unknown as { __vokkoMock: { requestAs(u: string, m: string, p: string, b?: unknown): unknown } }).__vokkoMock
    .requestAs('sam', 'PATCH', `/channels/${id}`, { rate_limit_per_user: s }), [channelId, seconds] as const);

test('the owner sets slowmode in Channel Settings and is immune to it', async ({ page }) => {
  const id = await openChannel(page, 'general', 'sam');
  await expect(page.locator('.chat-slowmode')).toHaveCount(0);
  await page.locator(`.channel-row-wrap:has(a[href$="/${id}"])`).hover();
  await page.getByRole('button', { name: 'Edit Channel' }).first().click();
  const dialog = page.getByRole('dialog', { name: /Channel Settings/ });
  await pickOption(page, dialog.getByRole('combobox', { name: 'Slowmode' }), '10s');
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(dialog.getByText('Saved.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.chat-slowmode')).toHaveText('Slowmode is enabled');
  await send(page, 'owner one');
  await send(page, 'owner two');
  await expect(message(page, 'owner two')).toBeVisible();
  await expect(page.locator('.chat-slowmode-time')).toHaveCount(0);
});

test('a member gets a countdown after sending and the draft waits for it', async ({ page }) => {
  const id = await openChannel(page, 'general', 'bob');
  await setSlowmode(page, id, 10);
  await expect(page.locator('.chat-slowmode')).toContainText('Slowmode is enabled');
  await send(page, 'member one');
  await expect(message(page, 'member one')).toBeVisible();
  await expect(page.locator('.chat-slowmode-time')).toHaveText(/^0:(09|10)$/);
  await send(page, 'member two');
  await expect(composer(page)).toHaveText('member two');
  await expect(page.locator('.chat-msg', { hasText: 'member two' })).toHaveCount(0);

  // Turned off: the indicator goes and the waiting draft can be sent.
  await setSlowmode(page, id, 0);
  await expect(page.locator('.chat-slowmode')).toHaveCount(0);
  await composer(page).press('Enter');
  await expect(message(page, 'member two')).toBeVisible();
});
