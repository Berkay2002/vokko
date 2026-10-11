import { test } from '@playwright/test';
import type { Page } from '@playwright/test';
import path from 'node:path';
import { openStockTalk } from './helpers';

// vokko-messages acceptance screenshots at the user's window size (1489x1097 CSS px, 1.25 scaling = their 1861x1371 shots), Swedish locale.
// VOKKO_SHOTS_DIR=E:\...\artifacts\messages npx playwright test -c e2e/messages.config.ts messages.shots.spec.ts
const dir = process.env.VOKKO_SHOTS_DIR;
test.skip(!dir, 'set VOKKO_SHOTS_DIR to capture screenshots');
test.use({ viewport: { width: 1489, height: 1097 }, deviceScaleFactor: 1.25, locale: 'sv-SE' });

const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(dir!, `${name}.png`) });
};

// The user's Discord is Onyx; the app picks it up from the persisted prefs.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('vokko.prefs', JSON.stringify({ theme: 'onyx' })); });
});

const row = (page: Page, text: string | RegExp) => page.locator('.chat-msg').filter({ has: page.locator('.chat-content', { hasText: text }) }).last();

/** Scroll to the very start of the channel with the wheel (a programmatic scrollTop is treated as list growth and re-pins to the bottom). */
async function toTop(page: Page): Promise<void> {
  const scroller = page.locator('.chat-scroller');
  await scroller.hover();
  for (let i = 0; i < 15; i++) {
    await page.mouse.wheel(0, -4000);
    await page.waitForTimeout(250);
    const top = await scroller.evaluate(el => el.scrollTop);
    if (top === 0 && (await page.locator('.chat-list-spinner').count()) === 0) return;
  }
}

test('channel: replies, image, mention, server tag', async ({ page }) => {
  await openStockTalk(page);
  await shot(page, '01-channel-bottom');
  await toTop(page);
  await shot(page, '02-channel-top');
  // scrolled far up: the "viewing older messages" pill at the bottom centre
  await page.mouse.wheel(0, 1500);
  await page.waitForTimeout(300);
  await shot(page, '09-jump-pill');
});

test('unread: banner and red divider, right-click placement', async ({ page }) => {
  await openStockTalk(page);
  await row(page, 'morning all').click({ button: 'right', position: { x: 160, y: 12 } });
  await page.getByRole('menuitem', { name: 'Mark Unread' }).click();
  await shot(page, '10-unread-banner-divider');
  // a menu opened near the top of the list starts at the pointer, one near the bottom is lifted to fit
  await page.mouse.move(700, 40);
  await page.locator('.chat-msg').nth(1).click({ button: 'right', position: { x: 60, y: 8 } });
  await shot(page, '11-context-menu-at-pointer');
});

test('overlays: toolbar, context menu, tag popout, lightbox', async ({ page }) => {
  await openStockTalk(page);
  const target = row(page, 'did you see the filing');
  await target.hover();
  await shot(page, '03-hover-toolbar');
  await target.click({ button: 'right' });
  await shot(page, '04-context-menu-others');
  await page.keyboard.press('Escape');
  await toTop(page);
  await page.locator('.chat-server-tag').first().click();
  await shot(page, '05-tag-popout');
  await page.keyboard.press('Escape');
  await page.locator('.chat-image').first().click();
  await shot(page, '06-lightbox');
  await page.keyboard.press('Escape');
  // three images in one message: arrows plus a strip of thumbnails
  const grid = page.locator('.chat-msg').filter({ has: page.locator('.chat-image-grid.three') }).last();
  for (let i = 0; i < 40 && (await grid.count()) === 0; i++) { await page.locator('.chat-scroller').evaluate(el => { el.scrollTop += 300; }); await page.waitForTimeout(80); }
  await grid.scrollIntoViewIfNeeded();
  await shot(page, '07-image-grid');
  await grid.locator('.chat-image').first().click();
  await shot(page, '08-lightbox-multi');
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const png = (name: string) => ({ name, mimeType: 'image/png', buffer: PNG });
const box = (page: Page) => page.getByRole('textbox', { name: /#stock-talk/ });

test('attachments: tray, modify dialog, pending card, grids, own hover, delete confirm', async ({ page }) => {
  await openStockTalk(page);
  const input = page.locator('input[type=file]');
  await input.setInputFiles([png('chart-one.png'), png('chart-two.png')]);
  await page.locator('.chat-tray-item.done').nth(1).waitFor();
  await page.locator('.chat-tray-item').first().hover();
  await shot(page, '12-tray-two-images');
  await page.getByRole('button', { name: 'Edit chart-one.png' }).click();
  await shot(page, '13-modify-attachment');
  await page.getByRole('button', { name: 'Cancel' }).click();
  // a slow server so the "uploading" card is visible
  await page.evaluate(() => localStorage.setItem('vokko.mock.latency', '4000'));
  await box(page).fill('two charts');
  await page.keyboard.press('Enter');
  await page.locator('.chat-pending-upload').waitFor();
  await shot(page, '14-pending-upload');
  await page.evaluate(() => localStorage.setItem('vokko.mock.latency', '0'));
  await row(page, 'two charts').locator('.chat-image-wrap').first().waitFor();
  await page.locator('.chat-pending-upload').waitFor({ state: 'detached' });
  await shot(page, '15-two-image-grid');
  await input.setInputFiles([png('a.png'), png('b.png'), png('c.png'), png('d.png')]);
  await page.locator('.chat-tray-item.done').nth(3).waitFor();
  await shot(page, '16-tray-four-images');
  await box(page).fill('four charts');
  await page.keyboard.press('Enter');
  const four = row(page, 'four charts');
  await four.locator('.chat-image-wrap').nth(3).waitFor();
  await four.locator('.chat-image-wrap').first().hover();
  await shot(page, '17-four-image-grid-own-hover');
  await four.getByRole('button', { name: 'Remove Attachment From Message' }).first().click();
  await shot(page, '18-delete-attachment-confirm');
});

test('emoji: hover tooltip, info popout, jumbo, emoticon on send, reply to image', async ({ page }) => {
  await openStockTalk(page);
  await box(page).fill('hello :)');
  await shot(page, '19-emoticon-typing');
  await page.keyboard.press('Enter');
  const hello = row(page, 'hello');
  await hello.locator('.md-emoji').first().hover();
  await shot(page, '20-emoji-tooltip');
  await hello.locator('.md-emoji').first().click();
  await shot(page, '21-emoji-popout');
  await page.keyboard.press('Escape');
  await box(page).fill('🔥');
  await page.keyboard.press('Enter');
  await page.locator('.md-jumbo').last().waitFor();
  await shot(page, '22-jumbo-emoji');
  await toTop(page);
  // "nice chart" replies to an attachment-only message: jump to it, then reply to that row
  await row(page, 'nice chart').locator('.chat-reply').click();
  const target = page.locator('.chat-msg.flash').first();
  await target.waitFor();
  await target.click({ button: 'right', position: { x: 30, y: 10 } });
  await page.getByRole('menuitem', { name: 'Reply' }).click();
  await shot(page, '23-replying-to-image');
  await box(page).fill('thanks');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  await shot(page, '24-reply-to-image-sent');
});
