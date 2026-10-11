import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { channelIdOf, message, openDm, send } from './helpers';

// MSG-014 / MOD-011: Pin and Unpin ask first ("Pin this message?"); Shift+click skips the question.

type Win = { __vokko: { request(method: string, path: string): Promise<unknown> } };

const PIN_TITLE = 'Pin this message?';
const PIN_BODY = 'This will pin the message to alice so everyone can find it later.';

const pinnedTexts = (page: Page) => page.evaluate(
  id => (window as unknown as Win).__vokko.request('GET', `/channels/${id}/messages/pins`) as Promise<{ items: { message: { content: string } }[] }>,
  channelIdOf(page),
).then(r => r.items.map(i => i.message.content));

async function openMenu(page: Page, text: string): Promise<void> {
  await message(page, text).click({ button: 'right' });
  await expect(page.getByRole('menu', { name: 'Message actions' })).toBeVisible();
}

test('Pin Message asks first: Cancel leaves it unpinned, "Pin it" pins it', async ({ page }) => {
  await openDm(page);
  await send(page, 'pin me politely');
  await message(page, 'pin me politely').waitFor();

  await openMenu(page, 'pin me politely');
  await page.getByRole('menuitem', { name: 'Pin Message' }).click();
  const dialog = page.getByRole('dialog', { name: PIN_TITLE });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(PIN_BODY)).toBeVisible();
  await expect(dialog.locator('.chat-pin-preview')).toContainText('pin me politely');
  await expect(dialog.locator('.chat-pin-preview .chat-author')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  expect(await pinnedTexts(page)).not.toContain('pin me politely');

  // Escape cancels too
  await openMenu(page, 'pin me politely');
  await page.getByRole('menuitem', { name: 'Pin Message' }).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(await pinnedTexts(page)).not.toContain('pin me politely');

  await openMenu(page, 'pin me politely');
  await page.getByRole('menuitem', { name: 'Pin Message' }).click();
  await dialog.getByRole('button', { name: 'Pin it' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => pinnedTexts(page)).toContain('pin me politely');
});

test('Enter confirms the pin', async ({ page }) => {
  await openDm(page);
  await send(page, 'pin me with enter');
  await message(page, 'pin me with enter').waitFor();

  await openMenu(page, 'pin me with enter');
  await page.getByRole('menuitem', { name: 'Pin Message' }).click();
  const dialog = page.getByRole('dialog', { name: PIN_TITLE });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => pinnedTexts(page)).toContain('pin me with enter');
});

test('Shift+click on Pin Message pins without the modal', async ({ page }) => {
  await openDm(page);
  await send(page, 'pin me fast');
  await message(page, 'pin me fast').waitFor();

  await openMenu(page, 'pin me fast');
  await page.getByRole('menuitem', { name: 'Pin Message' }).click({ modifiers: ['Shift'] });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => pinnedTexts(page)).toContain('pin me fast');
});

test('Unpin Message asks first and "Unpin" unpins; Shift+click skips the question', async ({ page }) => {
  await openDm(page);
  await send(page, 'unpin me politely');
  await message(page, 'unpin me politely').waitFor();
  await send(page, 'unpin me fast');
  await message(page, 'unpin me fast').waitFor();

  for (const text of ['unpin me politely', 'unpin me fast']) {
    await openMenu(page, text);
    await page.getByRole('menuitem', { name: 'Pin Message' }).click({ modifiers: ['Shift'] });
  }
  await expect.poll(() => pinnedTexts(page)).toEqual(expect.arrayContaining(['unpin me politely', 'unpin me fast']));

  await openMenu(page, 'unpin me politely');
  await page.getByRole('menuitem', { name: 'Unpin Message' }).click();
  const dialog = page.getByRole('dialog', { name: 'Unpin message?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Remove this message from the pinned list?')).toBeVisible();
  await expect(dialog.locator('.chat-pin-preview')).toContainText('unpin me politely');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  expect(await pinnedTexts(page)).toContain('unpin me politely');

  await openMenu(page, 'unpin me politely');
  await page.getByRole('menuitem', { name: 'Unpin Message' }).click();
  await dialog.getByRole('button', { name: 'Unpin' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => pinnedTexts(page)).not.toContain('unpin me politely');

  await openMenu(page, 'unpin me fast');
  await page.getByRole('menuitem', { name: 'Unpin Message' }).click({ modifiers: ['Shift'] });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => pinnedTexts(page)).not.toContain('unpin me fast');
});
