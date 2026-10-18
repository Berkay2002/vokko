import { expect, test } from '@playwright/test';
import type { CDPSession, Locator, Page } from '@playwright/test';
import { composer, openStockTalk } from './helpers';

// gap audit 7, items 1, 2 and 11: the media and link context menu, the image viewer's zoom, pan, pinch and swipe, and the viewer's alt text.
// Mock backend, Vite on port 1504 (e2e/gap7-media.config.ts). SHOTS=dir saves screenshots of each state.
const SHOTS = process.env.SHOTS;
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}-${page.viewportSize()!.width}.png` }); };

/** A solid-colour PNG of the given size, drawn in the page. */
async function png(page: Page, name: string, w: number, h: number, color: string) {
  const b64 = await page.evaluate(([cw, ch, fill]) => {
    const c = document.createElement('canvas');
    c.width = cw as number; c.height = ch as number;
    const g = c.getContext('2d')!;
    g.fillStyle = fill as string; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#fff'; g.fillRect(10, 10, 40, 40);
    return c.toDataURL('image/png').split(',')[1]!;
  }, [w, h, color]);
  return { name, mimeType: 'image/png', buffer: Buffer.from(b64!, 'base64') };
}

/** Sends a message with the files and returns its row. `alt` is the description of the first file. */
async function sendFiles(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[], text: string, alt?: string): Promise<Locator> {
  await page.locator('input[type=file]').setInputFiles(files);
  await expect(page.locator('.chat-tray-item')).toHaveCount(files.length);
  if (alt) {
    await page.locator('.chat-tray-item').first().hover();
    await page.getByRole('button', { name: `Edit ${files[0]!.name}` }).click();
    const modify = page.getByRole('dialog', { name: 'Modify Attachment' });
    await modify.getByLabel('Description (alt text)').fill(alt);
    await modify.getByRole('button', { name: 'Save' }).click();
  }
  await expect(page.locator('.chat-tray-item.uploading')).toHaveCount(0);
  await composer(page).fill(text);
  const sendButton = page.getByRole('button', { name: 'Send message' }); // phone: Enter is a new line
  if (await sendButton.count()) await sendButton.click();
  else await page.keyboard.press('Enter');
  const row = page.locator('.chat-msg').filter({ has: page.locator('.chat-content', { hasText: text }) }).last();
  await expect(row).not.toHaveClass(/pending/);
  return row;
}

const menu = (page: Page) => page.locator('.chat-menu[aria-label="Message actions"], .sheet-message');
const labels = (page: Page) => menu(page).first().locator('[role="menuitem"] .chat-menu-label, [role="menuitem"] .sheet-row-label').allTextContents();
const viewImg = (page: Page) => page.locator('.chat-lightbox-stage img');
const scaleOf = (img: Locator) => img.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a);
const offsetOf = (img: Locator) => img.evaluate(el => { const m = new DOMMatrix(getComputedStyle(el).transform); return { x: m.e, y: m.f }; });

test.describe('desktop 1440x900', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write', 'notifications'] });

  test('right click on a picture: Copy Image, Save Image, Open Original, Copy Link above the message items', async ({ page }) => {
    await openStockTalk(page);
    const row = await sendFiles(page, [await png(page, 'chart.png', 400, 300, '#2a6')], 'one chart');
    await row.locator('.chat-image').click({ button: 'right' });
    const items = await labels(page);
    expect(items.slice(0, 4)).toEqual(['Copy Image', 'Save Image', 'Open Original', 'Copy Link']);
    expect(items).toContain('Add Reaction');
    expect(items).toContain('Reply');
    await shot(page, 'ctx-image');

    await menu(page).getByRole('menuitem', { name: 'Copy Image' }).click();
    await expect.poll(() => page.evaluate(async () => (await navigator.clipboard.read())[0]?.types ?? [])).toContain('image/png');

    await row.locator('.chat-image').click({ button: 'right' });
    await menu(page).getByRole('menuitem', { name: 'Copy Link' }).click();
    const url = await row.locator('.chat-image').getAttribute('data-src');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
  });

  test('Save Image downloads the file under its own name', async ({ page }) => {
    await openStockTalk(page);
    const row = await sendFiles(page, [await png(page, 'saved-chart.png', 300, 200, '#a42')], 'save me');
    await row.locator('.chat-image').click({ button: 'right' });
    const download = page.waitForEvent('download');
    await menu(page).getByRole('menuitem', { name: 'Save Image' }).click();
    expect((await download).suggestedFilename()).toBe('saved-chart.png');
    // the viewer's Download goes the same way
    await row.locator('.chat-image').click();
    await page.getByRole('dialog').getByRole('button', { name: 'More' }).click();
    const again = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: 'Download' }).click();
    expect((await again).suggestedFilename()).toBe('saved-chart.png');
  });

  test('Copy Image falls back to the link where the clipboard has no picture support', async ({ page }) => {
    await page.addInitScript(() => { delete (window as unknown as { ClipboardItem?: unknown }).ClipboardItem; });
    await openStockTalk(page);
    const row = await sendFiles(page, [await png(page, 'plain.png', 200, 200, '#46a')], 'no pictures here');
    await row.locator('.chat-image').click({ button: 'right' });
    await menu(page).getByRole('menuitem', { name: 'Copy Image' }).click();
    await expect(page.locator('.chat-toast')).toContainText('The link was copied instead');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await row.locator('.chat-image').getAttribute('data-src'));
    await shot(page, 'copy-image-fallback');
  });

  test('right click on a link: Open Link and Copy Link; plain text keeps just the message menu', async ({ page }) => {
    await openStockTalk(page);
    const row = await sendFiles(page, [await png(page, 'l.png', 100, 100, '#555')], 'see https://example.com/some/page now');
    const link = row.locator('a[href^="https://example.com"]');
    await link.click({ button: 'right' });
    expect((await labels(page)).slice(0, 2)).toEqual(['Open Link', 'Copy Link']);
    await shot(page, 'ctx-link');
    await menu(page).getByRole('menuitem', { name: 'Copy Link' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('https://example.com/some/page');

    await link.click({ button: 'right' });
    await menu(page).getByRole('menuitem', { name: 'Open Link' }).click();
    await expect(page.getByRole('dialog')).toContainText('example.com'); // the same leave-Vokko step as a click on the link
    await page.keyboard.press('Escape');

    await row.locator('.chat-content').click({ button: 'right', position: { x: 2, y: 2 } });
    expect((await labels(page))[0]).toBe('Add Reaction');
  });

  test('a picture behind its SPOILER cover gets only the message menu', async ({ page }) => {
    await openStockTalk(page);
    const row = await sendFiles(page, [await png(page, 'SPOILER_x.png', 200, 200, '#933')], 'hidden');
    await row.locator('.chat-image').click({ button: 'right' });
    expect((await labels(page))[0]).toBe('Add Reaction');
  });

  test('right click on an audio file: Save Audio and Copy Link', async ({ page }) => {
    await openStockTalk(page);
    const wav = Buffer.from('UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=', 'base64');
    const row = await sendFiles(page, [{ name: 'tone.wav', mimeType: 'audio/wav', buffer: wav }], 'a tone');
    await row.locator('audio.chat-audio').click({ button: 'right' });
    expect((await labels(page)).slice(0, 2)).toEqual(['Save Audio', 'Copy Link']);
  });

  test('viewer: Ctrl+wheel zooms at the pointer, drag pans without un-zooming, click and arrow keys reset', async ({ page }) => {
    await openStockTalk(page);
    const row = await sendFiles(page, [await png(page, 'a.png', 1600, 900, '#c63'), await png(page, 'b.png', 900, 900, '#36c')], 'two pictures', 'the first chart');
    await row.locator('.chat-image').first().click();
    const img = viewImg(page);
    await expect(page.getByRole('dialog', { name: 'the first chart' })).toBeVisible();
    await expect(img).toHaveAttribute('alt', 'the first chart'); // item 11: the sender's description, not the file name
    await shot(page, 'viewer');
    const box = (await img.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

    await page.keyboard.down('Control');
    for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -120);
    await page.keyboard.up('Control');
    await expect.poll(() => scaleOf(img)).toBeGreaterThan(1.5);
    await expect(page.getByRole('button', { name: 'Zoom out' })).toHaveAttribute('aria-pressed', 'true');
    await shot(page, 'viewer-zoomed');

    const before = await offsetOf(img);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 80, box.y + box.height / 2 - 50, { steps: 6 });
    await page.mouse.up();
    const after = await offsetOf(img);
    expect(after.x).toBeLessThan(before.x - 40); // dragged left...
    expect(await scaleOf(img)).toBeGreaterThan(1.5); // ...and the click that ends a drag did not toggle the zoom off

    await img.click(); // a plain click toggles
    await expect.poll(() => scaleOf(img)).toBe(1);
    await img.click();
    await expect.poll(() => scaleOf(img)).toBeGreaterThan(1.5);
    await page.keyboard.press('ArrowRight'); // arrows leave the zoom behind
    await expect(page.locator('.chat-lightbox-thumbs button').nth(1)).toHaveClass(/current/);
    await expect.poll(() => scaleOf(img)).toBe(1);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('viewer: a plain wheel never scrolls the chat behind it', async ({ page }) => {
    await openStockTalk(page);
    const row = await sendFiles(page, [await png(page, 'w.png', 800, 600, '#7a3')], 'wheel test');
    await row.locator('.chat-image').click();
    const scroller = page.locator('.chat-scroller');
    const top = await scroller.evaluate(el => el.scrollTop);
    await viewImg(page).hover();
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(200);
    expect(await scroller.evaluate(el => el.scrollTop)).toBe(top);
  });
});

test.describe('phone 390x844', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, permissions: ['clipboard-read', 'clipboard-write'] });

  type Pt = { x: number; y: number; id: number };
  const touch = (cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', points: Pt[]) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : points.map(p => ({ x: p.x, y: p.y, id: p.id })) });

  test('long press on a picture opens the sheet with Copy Image first', async ({ page }) => {
    await openStockTalk(page);
    const row = await sendFiles(page, [await png(page, 'chart.png', 400, 300, '#2a6')], 'phone chart');
    await row.scrollIntoViewIfNeeded();
    const box = (await row.locator('.chat-image').boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const p = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 0 };
    await touch(cdp, 'touchStart', [p]);
    await page.waitForTimeout(700);
    await touch(cdp, 'touchEnd', []);
    await expect(page.locator('.sheet-message')).toBeVisible();
    expect((await labels(page)).slice(0, 4)).toEqual(['Copy Image', 'Save Image', 'Open Original', 'Copy Link']);
    await expect(page.getByRole('dialog', { name: /Open image|chart/ })).toHaveCount(0); // the press did not also open the viewer
    await shot(page, 'sheet-image');
  });

  test('viewer: pinch zooms, one finger pans, swipe changes picture, the page behind does not scroll', async ({ page }) => {
    await openStockTalk(page);
    const row = await sendFiles(page, [await png(page, 'a.png', 1600, 900, '#c63'), await png(page, 'b.png', 900, 900, '#36c')], 'phone pair');
    await row.locator('.chat-image').first().click();
    const img = viewImg(page);
    await expect(img).toBeVisible();
    expect(await page.locator('.chat-lightbox-stage').evaluate(el => getComputedStyle(el).touchAction)).toBe('none');
    const cdp = await page.context().newCDPSession(page);
    const b = (await img.boundingBox())!;
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2;

    // pinch out: two fingers move apart
    await touch(cdp, 'touchStart', [{ x: cx - 20, y: cy, id: 0 }, { x: cx + 20, y: cy, id: 1 }]);
    for (let i = 1; i <= 8; i++) await touch(cdp, 'touchMove', [{ x: cx - 20 - i * 12, y: cy, id: 0 }, { x: cx + 20 + i * 12, y: cy, id: 1 }]);
    await touch(cdp, 'touchEnd', []);
    await expect.poll(() => scaleOf(img)).toBeGreaterThan(1.5);
    await shot(page, 'viewer-pinched');

    // one finger pans the zoomed picture
    const before = await offsetOf(img);
    await touch(cdp, 'touchStart', [{ x: cx, y: cy, id: 0 }]);
    for (let i = 1; i <= 6; i++) await touch(cdp, 'touchMove', [{ x: cx - i * 15, y: cy, id: 0 }]);
    await touch(cdp, 'touchEnd', []);
    expect((await offsetOf(img)).x).toBeLessThan(before.x - 30);
    expect(await scaleOf(img)).toBeGreaterThan(1.5);

    // double-tap-free reset, then a left swipe goes to the next picture
    await page.getByRole('button', { name: 'Zoom out' }).click();
    await expect.poll(() => scaleOf(img)).toBe(1);
    await touch(cdp, 'touchStart', [{ x: cx + 80, y: cy, id: 0 }]);
    for (let i = 1; i <= 8; i++) await touch(cdp, 'touchMove', [{ x: cx + 80 - i * 20, y: cy + 2, id: 0 }]);
    await touch(cdp, 'touchEnd', []);
    await expect(page.locator('.chat-lightbox-thumbs button').nth(1)).toHaveClass(/current/);
    // a vertical drag changes nothing and the chat behind stays put
    const scroller = page.locator('.chat-scroller');
    const top = await scroller.evaluate(el => el.scrollTop);
    await touch(cdp, 'touchStart', [{ x: cx, y: cy, id: 0 }]);
    for (let i = 1; i <= 8; i++) await touch(cdp, 'touchMove', [{ x: cx, y: cy + i * 20, id: 0 }]);
    await touch(cdp, 'touchEnd', []);
    await expect(page.locator('.chat-lightbox-thumbs button').nth(1)).toHaveClass(/current/);
    expect(await scroller.evaluate(el => el.scrollTop)).toBe(top);
    await shot(page, 'viewer-swiped');
  });
});
