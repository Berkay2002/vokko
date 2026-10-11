import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openStockTalk } from './helpers';

// Message-area behaviour in the #stock-talk showcase channel of the mock seed (replies, mentions, server tags, context menu, timestamps).
test.use({ viewport: { width: 1280, height: 900 } });

// The row whose own text matches (not one that merely quotes it in a reply preview).
const row = (page: Page, text: string | RegExp) => page.locator('.chat-msg').filter({ has: page.locator('.chat-content', { hasText: text }) }).last();

/** The list is virtualised: scroll from the top until the row's text is rendered. */
async function reveal(page: Page, text: string | RegExp): Promise<void> {
  await scrollTop(page);
  const content = page.locator('.chat-content', { hasText: text });
  for (let i = 0; i < 40 && (await content.count()) === 0; i++) {
    await page.locator('.chat-scroller').evaluate(el => { el.scrollTop += 300; });
    await page.waitForTimeout(80);
  }
  await expect(content.last()).toBeVisible();
}

async function scrollTop(page: Page): Promise<void> {
  await page.locator('.chat-scroller').evaluate(el => { el.scrollTop = 0; });
  await page.waitForTimeout(300);
}

test.describe('replies', () => {
  test('click on the preview jumps to the original and flashes it', async ({ page }) => {
    await openStockTalk(page);
    await scrollTop(page);
    const reply = row(page, 'its a long way down then');
    await expect(reply.locator('.chat-reply')).toContainText('i hope it keeps sliding');
    await reply.locator('.chat-reply').click();
    await expect(row(page, 'i hope it keeps sliding, i want').first()).toHaveClass(/flash/);
  });

  test('deleted original shows the placeholder instead of a preview', async ({ page }) => {
    await openStockTalk(page);
    await reveal(page, 'lol happens');
    const preview = row(page, 'lol happens').locator('.chat-reply');
    await expect(preview).toContainText('Original message was deleted');
    await expect(preview).toHaveClass(/missing/);
  });

  test('attachment-only original reads "Click to see attachment"', async ({ page }) => {
    await openStockTalk(page);
    await scrollTop(page);
    await expect(row(page, 'nice chart').locator('.chat-reply')).toContainText('Click to see attachment');
  });
});

test('messages that mention me are highlighted, others are not', async ({ page }) => {
  await openStockTalk(page);
  await expect(row(page, 'did you see the filing')).toHaveClass(/mentioned/);
  await expect(row(page, '@everyone').first()).toHaveClass(/mentioned/);
  await expect(row(page, 'reading it now')).not.toHaveClass(/mentioned/);
  const shadow = await row(page, 'did you see the filing').evaluate(el => getComputedStyle(el).boxShadow);
  expect(shadow).toMatch(/ 2px 0px 0px 0px inset$/); // the 2px left bar
});

test('server tag shows next to the author and opens a popout', async ({ page }) => {
  await openStockTalk(page);
  await scrollTop(page);
  const tag = row(page, 'squeeze watch').locator('.chat-server-tag').first();
  await expect(tag).toHaveText(/VKO/);
  await tag.click();
  await expect(page.locator('.chat-tag-popout')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.chat-tag-popout')).toHaveCount(0);
});

test.describe('context menu', () => {
  const menuLabels = (page: Page) => page.locator('.chat-menu[aria-label="Message actions"] > .chat-menu-row-wrap > [role="menuitem"] .chat-menu-label').allTextContents();

  test('order on another member\'s message', async ({ page }) => {
    await openStockTalk(page);
    await row(page, 'did you see the filing').click({ button: 'right' });
    await expect(page.locator('.chat-menu-tile')).toHaveCount(4);
    expect(await menuLabels(page)).toEqual([
      'Add Reaction', 'Reply', 'Forward', 'Create Thread',
      'Copy Text', 'Pin Message', 'Bookmark Message', 'Create Reminder', 'Apps', 'Mark Unread', 'Copy Message Link', 'Read Aloud',
      'Delete Message', 'Copy Message ID',
    ]);
    await expect(page.locator('.chat-menu-item.danger')).toHaveText('Delete Message');
  });

  test('own message gets Edit Message after the separator', async ({ page }) => {
    await openStockTalk(page);
    await row(page, 'reading it now').click({ button: 'right' });
    const labels = await menuLabels(page);
    expect(labels.slice(0, 3)).toEqual(['Add Reaction', 'Edit Message', 'Reply']);
  });

  test('quick-reaction tile reacts', async ({ page }) => {
    await openStockTalk(page);
    const target = row(page, 'did you see the filing');
    await target.click({ button: 'right' });
    await page.locator('.chat-menu-tile').first().click();
    await expect(target.locator('.chat-reaction.me')).toHaveCount(1);
    await expect(page.locator('.chat-menu')).toHaveCount(0);
  });

  test('items without a server contract show a toast', async ({ page }) => {
    await openStockTalk(page);
    await row(page, 'did you see the filing').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Forward' }).click();
    await expect(page.locator('.chat-toast')).toContainText('Forwarding messages is coming soon');
  });

  test('Mark Unread brings the unread bar back and the channel stays unread', async ({ page }) => {
    await openStockTalk(page);
    await expect(page.locator('.chat-unread-bar')).toHaveCount(0);
    await row(page, 'morning all').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Mark Unread' }).click();
    await expect(page.locator('.chat-unread-bar')).toBeVisible();
    await page.waitForTimeout(3600); // longer than the 3 s ack debounce
    await expect(page.locator('.chat-unread-bar')).toBeVisible();
    await page.locator('.chat-unread-bar-mark').click();
    await expect(page.locator('.chat-unread-bar')).toHaveCount(0);
  });

  test('Delete Message on own message asks first and removes it', async ({ page }) => {
    await openStockTalk(page);
    await row(page, 'reading it now').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete Message' }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.locator('.chat-content', { hasText: 'reading it now' })).toHaveCount(0);
  });
});

test.describe('timestamps', () => {
  test.describe('English', () => {
    test.use({ locale: 'en-US' });
    test('older dates use the locale format, recent ones Today/Yesterday', async ({ page }) => {
      await openStockTalk(page);
      await scrollTop(page);
      await expect(row(page, 'squeeze watch').locator('.chat-timestamp').first()).toHaveText(/^\d{2}\/\d{2}\/\d{4} \d{1,2}:\d{2} [AP]M$/);
      await page.locator('.chat-scroller').evaluate(el => { el.scrollTop = el.scrollHeight; });
      await expect(row(page, 'reading it now').locator('.chat-timestamp').first()).toHaveText(/^Today at \d{1,2}:\d{2} [AP]M$/);
    });
  });
  test.describe('Swedish', () => {
    test.use({ locale: 'sv-SE' });
    test('uses ISO-like dates and Idag/Igår', async ({ page }) => {
      await openStockTalk(page);
      await scrollTop(page);
      await expect(row(page, 'squeeze watch').locator('.chat-timestamp').first()).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
      await page.locator('.chat-scroller').evaluate(el => { el.scrollTop = el.scrollHeight; });
      await expect(row(page, 'reading it now').locator('.chat-timestamp').first()).toHaveText(/^Idag kl\. \d{2}:\d{2}$/);
    });
  });
});
