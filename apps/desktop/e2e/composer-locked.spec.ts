import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { composer } from './helpers';
import { openChannel } from './threadHelpers';

// CMP-014: the composer's locked state and the message menu in a channel the viewer cannot post in. The mock seed makes #announcements
// read-only for @everyone (Moderators post): bob is a plain Member, alice a Moderator, sam the owner.

const NOTE = 'You do not have permission to send messages in this channel.';
const COMPOSER_BUTTONS = ['Attach a file', 'Open GIF picker', 'Open sticker picker', 'Select emoji', 'Apps'];
const row = (page: Page) => page.locator('.channel-chat .chat-msg').first();

async function menuOf(page: Page) {
  await row(page).click({ button: 'right', position: { x: 200, y: 10 } });
  const menu = page.getByRole('menu', { name: 'Message actions' });
  await expect(menu).toBeVisible();
  return menu;
}

test('a member sees the locked bar in a read-only channel: no textbox, no composer buttons', async ({ page }) => {
  await openChannel(page, 'announcements', 'bob');
  await row(page).waitFor();
  const bar = page.locator('.chat-composer-locked');
  await expect(bar).toHaveText(NOTE);
  await expect(composer(page)).toHaveCount(0);
  await expect(page.getByRole('textbox')).toHaveCount(0);
  for (const name of COMPOSER_BUTTONS) await expect(page.locator('.chat-composer').getByRole('button', { name })).toHaveCount(0);
});

test('Reply is missing from the menu and the hover toolbar, Create Thread and the other items stay', async ({ page }) => {
  await openChannel(page, 'announcements', 'bob');
  await row(page).hover();
  const toolbar = row(page).getByRole('toolbar', { name: 'Message actions' });
  await expect(toolbar.getByRole('button', { name: 'Add Reaction' })).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Reply' })).toHaveCount(0);
  await expect(toolbar.getByRole('button', { name: 'Create Thread' })).toBeVisible(); // the server only needs CREATE_PUBLIC_THREADS and READ_MESSAGE_HISTORY

  const menu = await menuOf(page);
  await expect(menu.getByRole('menuitem', { name: 'Reply' })).toHaveCount(0);
  for (const name of ['Create Thread', 'Add Reaction', 'Forward', 'Copy Message Link', 'Copy Message ID']) await expect(menu.getByRole('menuitem', { name })).toBeVisible();
});

test('a normal channel keeps the composer, Reply and Create Thread', async ({ page }) => {
  await openChannel(page, 'general', 'bob');
  await row(page).waitFor();
  await expect(composer(page)).toBeVisible();
  await expect(page.locator('.chat-composer-locked')).toHaveCount(0);
  for (const name of COMPOSER_BUTTONS) await expect(page.locator('.chat-composer').getByRole('button', { name })).toBeVisible();
  const menu = await menuOf(page);
  await expect(menu.getByRole('menuitem', { name: 'Reply' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Create Thread' })).toBeVisible();
});

test('a Moderator (role overwrite) and the owner can post in the read-only channel', async ({ page }) => {
  for (const as of ['alice', 'sam']) {
    await openChannel(page, 'announcements', as);
    await expect(composer(page)).toBeVisible();
    await expect(page.locator('.chat-composer-locked')).toHaveCount(0);
  }
});
