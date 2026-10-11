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

/** Scroll to the very start of the channel with the wheel (a programmatic scrollTop is treated as list growth and re-pins to the bottom). */
async function scrollTop(page: Page): Promise<void> {
  const scroller = page.locator('.chat-scroller');
  await scroller.hover();
  for (let i = 0; i < 15; i++) {
    await page.mouse.wheel(0, -4000);
    await page.waitForTimeout(250);
    const top = await scroller.evaluate(el => el.scrollTop);
    if (top === 0 && (await page.locator('.chat-list-spinner').count()) === 0) return;
  }
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
    // the badge is the curved reply arrow (like the other previews), not an alert icon
    await expect(preview.locator('svg.lucide-reply')).toHaveCount(1);
    await expect(preview.locator('svg.lucide-circle-alert')).toHaveCount(0);
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
  const bar = await row(page, 'did you see the filing').evaluate(el => { const c = getComputedStyle(el, '::before'); return { w: c.width, bg: c.backgroundColor }; });
  expect(bar.w).toBe('2px'); // the 2px left bar
  expect(bar.bg).toBe('rgb(234, 152, 0)'); // --text-feedback-warning
});

test('mention-of-me row tint is the mentioned-message token (8% alpha, 4% on hover)', async ({ page }) => {
  await openStockTalk(page);
  const mentioned = row(page, 'did you see the filing');
  await page.mouse.move(0, 0);
  await expect(mentioned).toHaveCSS('background-color', 'rgba(248, 163, 0, 0.08)');
  await mentioned.hover();
  await expect(mentioned).toHaveCSS('background-color', 'rgba(248, 163, 0, 0.04)');
});

test('guild channels show the per-server avatar on messages and reply previews', async ({ page }) => {
  await openStockTalk(page);
  const own = page.locator('.chat-msg:not(.grouped) .chat-msg-gutter .chat-avatar').first();
  await expect(own).not.toHaveAttribute('src', /server-avatar/);
  await page.evaluate(() => {
    type Store = { getState(): { members: Record<string, Record<string, { avatar?: string | null }>> }; setState(p: unknown): void };
    const store = (window as unknown as { __vokko: { appStore: Store } }).__vokko.appStore;
    const members = store.getState().members;
    const next = Object.fromEntries(Object.entries(members).map(([guild, byUser]) => [guild, Object.fromEntries(Object.entries(byUser).map(([id, m]) => [id, { ...m, avatar: 'https://example.test/server-avatar.png' }]))]));
    store.setState({ members: next });
  });
  await expect(own).toHaveAttribute('src', 'https://example.test/server-avatar.png');
  await scrollTop(page);
  const preview = page.locator('.chat-reply:not(.missing) .chat-reply-avatar').first();
  await expect(preview).toHaveAttribute('src', 'https://example.test/server-avatar.png');
});

test('several mentions in one group: only the mentioned lines are tinted, each with its own bar', async ({ page }) => {
  await openStockTalk(page);
  const last = page.locator('.chat-msg').last();
  await expect(last).toHaveClass(/mentioned/);
  const hello = row(page, /^hello$/);
  await expect(hello).not.toHaveClass(/mentioned/);
  await expect(page.locator('.chat-msg.mentioned.grouped').first()).toBeVisible();
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

test.describe('lightbox', () => {
  test('single image: author, actions, Escape closes', async ({ page }) => {
    await openStockTalk(page);
    await scrollTop(page);
    await page.locator('.chat-image').first().click();
    const box = page.getByRole('dialog');
    await expect(box).toBeVisible();
    await expect(box.locator('.chat-lightbox-name')).toContainText('Sam');
    for (const name of ['Zoom in', 'Forward', 'Open in Browser', 'More', 'Close']) await expect(box.getByRole(name === 'Open in Browser' ? 'link' : 'button', { name })).toBeVisible();
    await expect(box.getByRole('link', { name: 'Download' })).toHaveCount(0);
    await box.getByRole('button', { name: 'More' }).click();
    await expect(box.getByRole('menuitem', { name: 'Download' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(box.locator('.chat-lightbox-thumbs')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('three images: strip of thumbnails and arrow keys move between them', async ({ page }) => {
    await openStockTalk(page);
    await reveal(page, 'morning all');
    await row(page, 'morning all').locator('.chat-image').first().click();
    const strip = page.locator('.chat-lightbox-thumbs button');
    await expect(strip).toHaveCount(3);
    await expect(strip.first()).toHaveClass(/current/);
    await page.keyboard.press('ArrowRight');
    await expect(strip.nth(1)).toHaveClass(/current/);
  });
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
      'Delete Message', 'Report Message',
    ]);
    await expect(page.locator('.chat-menu-item.danger')).toHaveText(['Delete Message', 'Report Message']);
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

  test('Forward opens the destination dialog', async ({ page }) => {
    await openStockTalk(page);
    await row(page, 'did you see the filing').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Forward' }).click();
    await expect(page.getByRole('dialog', { name: 'Forward To' })).toBeVisible();
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

  test('menu opens at the pointer: top-left at the click, lifted above it when it would not fit below', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1200 });
    await openStockTalk(page);
    // the last row is always at the bottom of the window, whatever the message spacing preset puts above it
    const target = page.locator('.chat-msg').last();
    const box = (await target.boundingBox())!;
    // low in the window there is no room below for the ~640px menu but enough above: it flips up and ends at the pointer
    await target.click({ button: 'right', position: { x: 40, y: 8 } });
    const menu = page.locator('.chat-menu[aria-label="Message actions"]');
    const m1 = (await menu.boundingBox())!;
    expect(Math.abs(m1.x - (box.x + 40))).toBeLessThan(2);
    expect(Math.abs(m1.y + m1.height - (box.y + 8))).toBeLessThan(2);
    await page.keyboard.press('Escape');
    // a row near the top of the list has room below: the menu starts at the pointer
    await scrollTop(page);
    const first = page.locator('.chat-msg').first();
    const fb = (await first.boundingBox())!;
    await first.click({ button: 'right', position: { x: 60, y: 10 } });
    const m2 = (await menu.boundingBox())!;
    expect(Math.abs(m2.x - (fb.x + 60))).toBeLessThan(2);
    expect(Math.abs(m2.y - (fb.y + 10))).toBeLessThan(2);
  });

  test('Delete Message on own message asks first and removes it', async ({ page }) => {
    await openStockTalk(page);
    await row(page, 'reading it now').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete Message' }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.locator('.chat-content', { hasText: 'reading it now' })).toHaveCount(0);
  });
});

test('jump pill appears when scrolled far up, sits at the bottom centre and returns to the present', async ({ page }) => {
  await openStockTalk(page);
  await expect(page.locator('.chat-jump-bar')).toHaveCount(0);
  await scrollTop(page);
  const pill = page.locator('.chat-jump-bar');
  await expect(pill).toBeVisible();
  const list = (await page.locator('.chat-list').boundingBox())!;
  const p = (await pill.boundingBox())!;
  expect(Math.abs(p.x + p.width / 2 - (list.x + list.width / 2))).toBeLessThan(2);
  expect(list.y + list.height - (p.y + p.height)).toBeGreaterThan(8);
  await pill.getByRole('button', { name: 'Jump To Present' }).click();
  await expect(pill).toHaveCount(0);
});

test.describe('new-messages divider', () => {
  test('on a day boundary it is the day divider itself, red, with the NEW pill; sending clears it', async ({ page }) => {
    await openStockTalk(page);
    await row(page, '@everyone market opens').click({ button: 'right', position: { x: 160, y: 12 } });
    await page.getByRole('menuitem', { name: 'Mark Unread' }).click();
    const merged = page.locator('.chat-day-divider.unread');
    await expect(merged).toHaveCount(1);
    await expect(merged.locator('.chat-new-pill')).toHaveText('NEW');
    await expect(page.locator('.chat-new-divider')).toHaveCount(0);
    await expect(page.locator('.chat-unread-bar')).toBeVisible();
    // leaving the channel ends the banner, the divider stays for the visit
    await page.getByRole('textbox', { name: /Message #stock-talk/ }).fill('own send');
    await page.keyboard.press('Enter');
    await expect(page.locator('.chat-day-divider.unread')).toHaveCount(0);
    await expect(page.locator('.chat-unread-bar')).toHaveCount(0);
  });

  test('mid-day it is a plain red line with the pill', async ({ page }) => {
    await openStockTalk(page);
    await row(page, 'did you see the filing').click({ button: 'right', position: { x: 160, y: 12 } });
    await page.getByRole('menuitem', { name: 'Mark Unread' }).click();
    await expect(page.locator('.chat-new-divider .chat-new-pill')).toHaveText('NEW');
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
    test('uses ISO-like dates and a bare time today', async ({ page }) => {
      await openStockTalk(page);
      await scrollTop(page);
      await expect(row(page, 'squeeze watch').locator('.chat-timestamp').first()).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
      await page.locator('.chat-scroller').evaluate(el => { el.scrollTop = el.scrollHeight; });
      await expect(row(page, 'reading it now').locator('.chat-timestamp').first()).toHaveText(/^\d{2}:\d{2}$/);
    });
  });
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const png = (name: string) => ({ name, mimeType: 'image/png', buffer: PNG });
const settled = (page: Page) => expect(page.locator('.chat-tray-item.uploading')).toHaveCount(0);
const stockBox = (page: Page) => page.getByRole('textbox', { name: /Message #stock-talk/ });

test.describe('attachments', () => {
  test('tray Edit renames, adds alt text and a spoiler mark; the sent message carries all three', async ({ page }) => {
    await openStockTalk(page);
    await page.locator('input[type=file]').setInputFiles(png('chart.png'));
    const card = page.locator('.chat-tray-item');
    await expect(card).toHaveCount(1);
    await card.hover();
    await page.getByRole('button', { name: 'Edit chart.png' }).click();
    const dialog = page.getByRole('dialog', { name: 'Modify Attachment' });
    await dialog.getByLabel('Filename').fill('renamed.png');
    await dialog.getByLabel('Description (alt text)').fill('a one pixel chart');
    await dialog.getByLabel('Mark as spoiler').check();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.chat-tray-spoiler')).toBeVisible();
    await expect(page.locator('.chat-tray-name')).toHaveText('renamed.png');
    await settled(page);
    await stockBox(page).fill('look at this');
    await page.keyboard.press('Enter');
    const sent = row(page, 'look at this');
    await expect(sent.locator('.chat-image.spoiler')).toBeVisible();
    await expect(sent.locator('.chat-image img')).toHaveAttribute('alt', 'a one pixel chart');
    await expect(sent.locator('.chat-image')).toHaveAttribute('aria-label', 'Open image SPOILER_renamed.png');
  });

  test('Enter while a file is still uploading queues the send; it posts once the upload finishes', async ({ page }) => {
    await openStockTalk(page);
    await page.locator('input[type=file]').setInputFiles([png('a.png'), png('b.png')]);
    await expect(page.locator('.chat-tray-item.uploading')).toHaveCount(2);
    await stockBox(page).fill('queued behind uploads');
    await page.keyboard.press('Enter');
    const sent = row(page, 'queued behind uploads');
    // the queued message shows the "Uploading 2 files" card and the draft is cleared
    await expect(sent.locator('.chat-pending-upload')).toContainText('Uploading 2 files');
    await expect(sent).toHaveClass(/pending/);
    await expect(page.locator('.chat-tray-item')).toHaveCount(0);
    await expect(stockBox(page)).toHaveText('');
    // ...and turns into the real message with both images once the uploads are done
    await expect(sent.locator('.chat-pending-upload')).toHaveCount(0);
    await expect(sent).not.toHaveClass(/pending/);
    await expect(sent.locator('.chat-image')).toHaveCount(2);
    await expect(page.locator('.chat-content', { hasText: 'queued behind uploads' })).toHaveCount(1);
  });

  test('cancelling a send queued behind an upload posts nothing and aborts the upload', async ({ page }) => {
    await openStockTalk(page);
    await page.locator('input[type=file]').setInputFiles(png('abort.png'));
    await expect(page.locator('.chat-tray-item.uploading')).toHaveCount(1);
    await stockBox(page).fill('never posted');
    await page.keyboard.press('Enter');
    const sent = row(page, 'never posted');
    await expect(sent.locator('.chat-pending-upload')).toContainText('Uploading abort.png');
    await sent.getByRole('button', { name: 'Cancel Upload' }).click();
    await expect(page.locator('.chat-content', { hasText: 'never posted' })).toHaveCount(0);
    await page.waitForTimeout(1500); // longer than the mock upload: it must not post late
    await expect(page.locator('.chat-content', { hasText: 'never posted' })).toHaveCount(0);
  });

  test('Cancel in the modify dialog changes nothing', async ({ page }) => {
    await openStockTalk(page);
    await page.locator('input[type=file]').setInputFiles(png('keep.png'));
    await page.locator('.chat-tray-item').hover();
    await page.getByRole('button', { name: 'Edit keep.png' }).click();
    const dialog = page.getByRole('dialog', { name: 'Modify Attachment' });
    await dialog.getByLabel('Filename').fill('other.png');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('.chat-tray-name')).toHaveText('keep.png');
  });

  test('removing a sent image asks first; backdrop click cancels, confirming removes only the image', async ({ page }) => {
    await openStockTalk(page);
    await page.locator('input[type=file]').setInputFiles(png('gone.png'));
    await settled(page);
    await stockBox(page).fill('delete my image');
    await page.keyboard.press('Enter');
    const sent = row(page, 'delete my image');
    await sent.locator('.chat-image-wrap').hover();
    await sent.getByRole('button', { name: 'Remove Attachment From Message' }).click();
    const dialog = page.getByRole('dialog', { name: 'Are you sure?' });
    await expect(dialog).toContainText('permanently delete the attachment');
    await page.mouse.click(5, 100); // backdrop (clear of the permission banner pinned to the top edge)
    await expect(dialog).toHaveCount(0);
    await expect(sent.locator('.chat-image')).toHaveCount(1);
    await sent.locator('.chat-image-wrap').hover();
    await sent.getByRole('button', { name: 'Remove Attachment From Message' }).click();
    await page.getByRole('button', { name: 'Delete Attachment' }).click();
    // the message had text, so it stays, without the image
    await expect(sent.locator('.chat-image')).toHaveCount(0);
    await expect(row(page, 'delete my image')).toBeVisible();
  });

  test('two images are equal squares, four are a 2x2 of equal cells with the same overall width', async ({ page }) => {
    await openStockTalk(page);
    await page.locator('input[type=file]').setInputFiles([png('a.png'), png('b.png')]);
    await expect(page.locator('.chat-tray-item')).toHaveCount(2);
    await settled(page);
    await stockBox(page).fill('pair');
    await page.keyboard.press('Enter');
    const two = row(page, 'pair').locator('.chat-image-wrap');
    await expect(two).toHaveCount(2);
    const [a, b] = [(await two.nth(0).boundingBox())!, (await two.nth(1).boundingBox())!];
    expect(Math.abs(a.width - b.width)).toBeLessThan(1.5);
    expect(Math.abs(a.height - 273)).toBeLessThan(1.5);
    const total = b.x + b.width - a.x;
    await page.locator('input[type=file]').setInputFiles([png('1.png'), png('2.png'), png('3.png'), png('4.png')]);
    await expect(page.locator('.chat-tray-item')).toHaveCount(4);
    await settled(page);
    await stockBox(page).fill('quad');
    await page.keyboard.press('Enter');
    const four = row(page, 'quad').locator('.chat-image-wrap');
    await expect(four).toHaveCount(4);
    const boxes = await Promise.all([0, 1, 2, 3].map(async i => (await four.nth(i).boundingBox())!));
    for (const bx of boxes) { expect(Math.abs(bx.width - boxes[0]!.width)).toBeLessThan(1.5); expect(Math.abs(bx.height - 173)).toBeLessThan(1.5); }
    expect(Math.abs(boxes[1]!.x + boxes[1]!.width - boxes[0]!.x - total)).toBeLessThan(1.5);
    expect(boxes[2]!.y).toBeGreaterThan(boxes[0]!.y + 100);
  });

  test('an audio file shows its file card with a player', async ({ page }) => {
    await openStockTalk(page);
    await page.locator('input[type=file]').setInputFiles({ name: 'clip.ogg', mimeType: 'audio/ogg', buffer: Buffer.from('OggS') });
    await settled(page);
    await stockBox(page).fill('have a listen');
    await page.keyboard.press('Enter');
    const card = row(page, 'have a listen').locator('.chat-file.audio');
    await expect(card.locator('.chat-file-name')).toHaveText('clip.ogg');
    await expect(card.getByLabel('clip.ogg', { exact: true })).toHaveAttribute('controls', '');
  });
});

test.describe('emoji', () => {
  test('emoticons convert on send, not while typing, and not inside code', async ({ page }) => {
    await openStockTalk(page);
    await stockBox(page).fill('see you :)');
    await expect(stockBox(page)).toHaveText('see you :)');
    await page.keyboard.press('Enter');
    await expect(row(page, 'see you')).toContainText('see you 🙂');
    await stockBox(page).fill('use `:)` here');
    await page.keyboard.press('Enter');
    await expect(row(page, 'use').locator('.chat-content')).toContainText(':)');
  });

  test('hover shows the name tooltip, click opens the info popout', async ({ page }) => {
    await openStockTalk(page);
    await stockBox(page).fill('smile 🙂 please');
    await page.keyboard.press('Enter');
    const glyph = row(page, 'smile').locator('.md-emoji').first();
    await glyph.hover();
    const tip = page.locator('.chat-emoji-tip');
    await expect(tip).toContainText('Click to learn more');
    await expect(tip.locator('b')).toHaveText(':slight_smile:');
    await glyph.click();
    const pop = page.locator('.chat-emoji-pop');
    await expect(pop).toContainText('A standard emoji');
    const box = (await pop.boundingBox())!;
    expect(Math.round(box.width)).toBe(288);
    expect(Math.round(box.height)).toBe(106);
    await expect(tip).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(pop).toHaveCount(0);
  });
});

test('sending from far up lands on the new message, fully above the composer', async ({ page }) => {
  await openStockTalk(page);
  await page.locator('.chat-scroller').hover();
  for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, -1500); await page.waitForTimeout(200); }
  await stockBox(page).fill('landed at the bottom');
  await page.keyboard.press('Enter');
  const sent = row(page, 'landed at the bottom');
  await expect(sent).toBeVisible();
  await expect.poll(async () => {
    const m = (await sent.boundingBox())!;
    const c = (await page.locator('.chat-composer').boundingBox())!;
    return c.y - (m.y + m.height);
  }).toBeGreaterThanOrEqual(0);
});

test('a role mention highlights the row when I hold the role', async ({ page }) => {
  await openStockTalk(page);
  await reveal(page, 'can an admin sign off');
  await expect(row(page, 'can an admin sign off')).toHaveClass(/mentioned/);
});

test('inline edit has an emoji button that inserts at the caret, and the hint wording', async ({ page }) => {
  await openStockTalk(page);
  await row(page, 'reading it now').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit Message' }).click();
  const edit = page.locator('.chat-edit');
  await expect(edit.locator('.chat-edit-hint')).toHaveText('escape to cancel • enter to save');
  const area = edit.getByRole('textbox', { name: 'Edit message' });
  const original = await area.inputValue();
  await area.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(7, 7)); // after "reading"
  await edit.getByRole('button', { name: 'Select emoji' }).click();
  await page.getByRole('dialog', { name: 'Emoji picker' }).locator('.chat-emoji-cell').first().click();
  const after = await area.inputValue();
  expect(after.startsWith('reading')).toBe(true);
  expect(after.endsWith(original.slice(7))).toBe(true);
  expect(after.length).toBeGreaterThan(original.length);
  await area.press('Escape');
  await expect(edit).toHaveCount(0);
});

test('delete confirmation shows the shift-click PROTIP; Shift+click on Delete skips it', async ({ page }) => {
  await openStockTalk(page);
  await row(page, 'reading it now').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete Message' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('.chat-protip')).toContainText('hold down shift when clicking delete message');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(row(page, 'reading it now')).toBeVisible();
  await row(page, 'reading it now').hover();
  await page.keyboard.down('Shift');
  await page.mouse.move(10, 10);
  await row(page, 'reading it now').hover();
  await page.getByRole('button', { name: 'Delete', exact: true }).click({ modifiers: ['Shift'] });
  await page.keyboard.up('Shift');
  await expect(page.locator('.chat-content', { hasText: 'reading it now' })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('server tag popout shows member counts and created date, Go to Server navigates', async ({ page }) => {
  await openStockTalk(page);
  await scrollTop(page);
  await row(page, 'squeeze watch').locator('.chat-server-tag').first().click();
  const pop = page.locator('.chat-tag-popout');
  await expect(pop).toContainText(/\d+ online/);
  await expect(pop).toContainText(/\d+ members?/);
  await expect(pop).toContainText('Created:');
  await pop.getByRole('button', { name: 'Go to Server' }).click();
  await expect(pop).toHaveCount(0);
  const guildId = await page.evaluate(() => (window as unknown as { __vokko: { appStore: { getState(): { route: { guildId: string | null } } } } }).__vokko.appStore.getState().route.guildId);
  await expect(page).toHaveURL(new RegExp(`/channels/${guildId}`));
});

test('emoji autocomplete shows a footer preview of the highlighted emoji', async ({ page }) => {
  await openStockTalk(page);
  const box = page.locator('.chat-textarea');
  await box.click();
  await box.pressSequentially(':smile');
  const panel = page.locator('.chat-autocomplete');
  await expect(panel.locator('.chat-autocomplete-item').first()).toBeVisible();
  const preview = panel.locator('.chat-autocomplete-preview');
  await expect(preview).toBeVisible();
  await expect(preview.locator('.chat-autocomplete-preview-emoji')).not.toBeEmpty();
  expect(Math.round((await preview.boundingBox())!.height)).toBe(48);
  await box.press('ArrowDown');
  await expect(panel.locator('.chat-autocomplete-item.selected')).toHaveCount(1);
  await box.press('Escape');
});
