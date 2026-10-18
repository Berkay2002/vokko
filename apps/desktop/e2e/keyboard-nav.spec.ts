import { expect, test, type Page } from '@playwright/test';
import { channelIdOf, composer, openDm, send } from './helpers';

// Message list keyboard navigation (Discord parity): one tab stop for the list, arrows move it, hotkeys act on the focused message.
test.use({ viewport: { width: 1440, height: 900 } });

const focusedId = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.messageId ?? null);
const rowIds = (page: Page) => page.locator('.chat-msg[data-message-id]').evaluateAll(els => els.map(e => (e as HTMLElement).dataset.messageId!));
const say = (page: Page, channelId: string, text: string) =>
  page.evaluate(([c, t]) => (window as unknown as { __vokkoMock: { say(c: string, u: string, t: string): void } }).__vokkoMock.say(c!, 'alice', t!), [channelId, text]);

/** Sends `text` and waits for the server copy (a pending row takes no hotkeys). */
async function sendConfirmed(page: Page, text: string): Promise<void> {
  await send(page, text);
  await expect(page.locator('.chat-msg:not(.pending)', { hasText: text })).toBeVisible();
}

/** Enters the list from the scroller: Up lands on the tab stop (the newest message). */
async function enterList(page: Page): Promise<void> {
  await page.locator('.chat-scroller').focus();
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.chat-msg:focus')).toHaveCount(1);
}

test('arrows, Home/End move one tab stop through the messages; Escape returns to the composer', async ({ page }) => {
  await openDm(page);
  await sendConfirmed(page, 'newest line');
  await enterList(page);
  const ids = await rowIds(page);
  expect(await focusedId(page)).toBe(ids[ids.length - 1]);
  await expect(page.locator('.chat-msg[tabindex="0"]')).toHaveCount(1);
  const focused = page.locator('.chat-msg:focus');
  await expect(focused).toHaveAttribute('role', 'article');
  await expect(focused).toHaveAttribute('aria-label', /^Sam, .*newest line$/i);
  await expect(page.getByRole('list', { name: /^Messages in/ })).toHaveCount(1);

  await page.keyboard.press('ArrowUp');
  expect(await focusedId(page)).toBe(ids[ids.length - 2]);
  // The tab stop moved with the focus.
  await expect(page.locator(`.chat-msg[data-message-id="${ids[ids.length - 2]}"]`)).toHaveAttribute('tabindex', '0');
  await page.keyboard.press('ArrowDown');
  expect(await focusedId(page)).toBe(ids[ids.length - 1]);
  await page.keyboard.press('Home');
  const first = await focusedId(page);
  expect(ids.indexOf(first!)).toBeLessThan(ids.length - 2);
  await page.keyboard.press('End');
  expect(await focusedId(page)).toBe(ids[ids.length - 1]);
  await page.keyboard.press('PageUp');
  expect(ids.indexOf((await focusedId(page))!)).toBeLessThan(ids.length - 1);

  await page.keyboard.press('Escape');
  await expect(composer(page)).toBeFocused();
});

test('focus stays on the same message when a new one arrives', async ({ page }) => {
  await openDm(page);
  await enterList(page);
  await page.keyboard.press('ArrowUp');
  const before = await focusedId(page);
  await say(page, channelIdOf(page), 'a fresh reply from alice');
  await expect(page.locator('.chat-msg', { hasText: 'a fresh reply from alice' })).toBeVisible();
  expect(await focusedId(page)).toBe(before);
  await page.keyboard.press('End');
  await expect(page.locator('.chat-msg:focus')).toContainText('a fresh reply from alice');
});

test('hotkeys on a focused message: E edits, R replies, + reacts, P pins, Delete asks, Mod+C copies', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openDm(page);
  await sendConfirmed(page, 'my keyboard line');
  await enterList(page);

  await page.keyboard.press('e');
  await expect(page.getByRole('textbox', { name: 'Edit message' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.chat-edit')).toHaveCount(0);

  await enterList(page);
  await page.keyboard.press('ControlOrMeta+c');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('my keyboard line');

  await page.keyboard.press('+');
  await expect(page.getByRole('dialog', { name: 'Emoji picker' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Emoji picker' })).toHaveCount(0);

  await enterList(page);
  await page.keyboard.press('p');
  await expect(page.getByRole('dialog', { name: 'Pin this message?' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();

  await enterList(page);
  await page.keyboard.press('Delete');
  await expect(page.getByRole('dialog', { name: 'Delete Message' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();

  // R on alice's message: the composer shows the reply bar.
  await enterList(page);
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.chat-msg:focus')).not.toContainText('my keyboard line');
  await page.keyboard.press('r');
  await expect(page.locator('.chat-msg.replying')).toHaveCount(1);
});

test('Up in an empty composer still edits the last message, Alt+Down from a message still switches channel', async ({ page }) => {
  await openDm(page);
  await sendConfirmed(page, 'edit me with up');
  await composer(page).press('ArrowUp');
  await expect(page.getByRole('textbox', { name: 'Edit message' })).toBeFocused();
  await page.keyboard.press('Escape');

  await enterList(page);
  const from = page.url();
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(() => page.url()).not.toBe(from);
});

test('focus goes back to the message after an edit, a reaction picker or a delete dialog', async ({ page }) => {
  await openDm(page);
  await sendConfirmed(page, 'keep focus one');
  await sendConfirmed(page, 'keep focus two');
  const row = (text: string) => page.locator('.chat-msg', { hasText: text });
  await enterList(page);
  await expect(row('keep focus two')).toBeFocused();

  // Edit: cancelled with Escape, then saved with Enter.
  await page.keyboard.press('e');
  await expect(page.getByRole('textbox', { name: 'Edit message' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(row('keep focus two')).toBeFocused();
  await page.keyboard.press('e');
  await page.keyboard.type(' edited');
  await page.keyboard.press('Enter');
  await expect(page.locator('.chat-edit')).toHaveCount(0);
  await expect(row('keep focus two edited')).toBeFocused();

  // Reaction picker closed with Escape.
  await page.keyboard.press('+');
  await expect(page.getByRole('dialog', { name: 'Emoji picker' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(row('keep focus two edited')).toBeFocused();

  // Delete dialog: Cancel keeps the message focused, confirming moves to the neighbour (no next one here: the previous).
  await page.keyboard.press('Delete');
  await page.getByRole('dialog', { name: 'Delete Message' }).getByRole('button', { name: 'Cancel' }).click();
  await expect(row('keep focus two edited')).toBeFocused();
  await page.keyboard.press('Delete');
  await page.getByRole('dialog', { name: 'Delete Message' }).getByRole('button', { name: 'Delete' }).click();
  await expect(row('keep focus two')).toHaveCount(0);
  await expect(row('keep focus one')).toBeFocused();

  // An edit started from the composer (Up) still ends in the composer.
  await composer(page).press('ArrowUp');
  await page.keyboard.press('Escape');
  await expect(composer(page)).toBeFocused();
});
