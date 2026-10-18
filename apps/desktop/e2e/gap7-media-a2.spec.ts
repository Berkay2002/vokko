import { expect, test } from '@playwright/test';
import type { CDPSession, Locator, Page } from '@playwright/test';
import { composer, openDm, openStockTalk, send } from './helpers';

// gap audit 7, items 6, 8 and 4: SPOILER covers on video, audio, file cards and the viewer's thumbnails, link-preview pictures in the image
// viewer, and removing link previews. Mock backend, Vite on port 1504 (e2e/gap7-media.config.ts). SHOTS=dir saves screenshots of each state.
const SHOTS = process.env.SHOTS;
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}-${page.viewportSize()!.width}.png` }); };

type Embed = Record<string, unknown>;
type MockWin = { __vokkoMock: { setEmbeds(channelId: string, messageId: string, embeds: Embed[]): void; say(channelId: string, user: string, text: string): string } };

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#3a7"/><circle cx="320" cy="180" r="90" fill="#fff"/></svg>';
const stubImages = (page: Page) => page.route('https://img.example/**', route => route.fulfill({ contentType: 'image/svg+xml', body: SVG }));

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

/** Sends a message with the files and returns its row. */
async function sendFiles(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[], text: string): Promise<Locator> {
  await page.locator('input[type=file]').setInputFiles(files);
  await expect(page.locator('.chat-tray-item')).toHaveCount(files.length);
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
const channelOf = (page: Page) => new URL(page.url()).pathname.split('/').filter(Boolean).pop()!;

/** Gives the message link previews, as the server's unfurler would. */
async function unfurl(page: Page, row: Locator, embeds: Embed[]) {
  const id = (await row.getAttribute('data-message-id'))!;
  const channel = channelOf(page);
  await page.evaluate(([c, m, e]) => (window as unknown as MockWin).__vokkoMock.setEmbeds(c as string, m as string, e as Embed[]), [channel, id, embeds] as const);
  return id;
}

const richEmbed = (url: string, extra: Embed = {}): Embed => ({ type: 'rich', title: 'A post', url, description: 'Words', ...extra });
const MP4 = Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex');
const MP3 = Buffer.from('4944330300000000000a', 'hex');

/** The state of a message as the API serves it. */
const fetchMessage = (page: Page, id: string) => page.evaluate(async ([cid, mid]) => {
  const list = await (window as unknown as { __vokko: { request(m: string, p: string): Promise<{ id: string; flags?: number; embeds: unknown[] }[]> } }).__vokko.request('GET', `/channels/${cid}/messages?limit=30`);
  const m = list.find(x => x.id === mid)!;
  return { flags: m.flags ?? 0, embeds: m.embeds.length };
}, [channelOf(page), id] as const);

test.describe('desktop 1440x900', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('a SPOILER video is blurred without controls until clicked, and offers no Save Video while covered', async ({ page }) => {
    await openStockTalk(page);
    const row = await sendFiles(page, [{ name: 'SPOILER_clip.mp4', mimeType: 'video/mp4', buffer: MP4 }], 'spoiler video');
    const video = row.locator('video.chat-video');
    await expect(video).toHaveClass(/spoiler/);
    await expect(video).not.toHaveAttribute('controls', /.*/);
    await shot(page, 'spoiler-video-covered');
    await row.locator('.chat-video-wrap').click({ button: 'right' });
    expect(await labels(page)).not.toContain('Save Video');
    await page.keyboard.press('Escape');
    await row.getByRole('button', { name: 'Reveal spoiler video' }).click();
    await expect(row.locator('video.chat-video')).not.toHaveClass(/spoiler/);
    await expect(row.locator('video.chat-video')).toHaveAttribute('controls', /.*/);
    await row.locator('video.chat-video').click({ button: 'right' });
    expect((await labels(page)).slice(0, 2)).toEqual(['Save Video', 'Copy Link']);
    await shot(page, 'spoiler-video-revealed');
  });

  test('a SPOILER file card shows no name, size, link or player until clicked', async ({ page }) => {
    await openStockTalk(page);
    const row = await sendFiles(page, [{ name: 'SPOILER_song.mp3', mimeType: 'audio/mpeg', buffer: MP3 }], 'spoiler song');
    const card = row.locator('.chat-file');
    await expect(card).toHaveClass(/spoiler/);
    await expect(row.locator('audio, .chat-file-name, .chat-file-download')).toHaveCount(0);
    await expect(row).not.toContainText('song.mp3');
    await shot(page, 'spoiler-audio-covered');
    await card.click({ button: 'right' });
    expect(await labels(page)).not.toContain('Save Audio');
    await page.keyboard.press('Escape');
    await card.click();
    await expect(row.locator('.chat-file-name')).toHaveText('song.mp3'); // without the SPOILER_ prefix
    await expect(row.locator('audio.chat-audio')).toHaveCount(1);
    await shot(page, 'spoiler-audio-revealed');
  });

  test('the viewer blurs an unrevealed SPOILER picture and its thumbnail; clicking it reveals the picture in the chat too', async ({ page }) => {
    await openStockTalk(page);
    const row = await sendFiles(page, [await png(page, 'open.png', 600, 400, '#c63'), await png(page, 'SPOILER_hidden.png', 600, 400, '#36c')], 'viewer spoiler');
    await row.locator('.chat-image').first().click();
    const dialog = page.getByRole('dialog');
    const thumbs = dialog.locator('.chat-lightbox-thumbs img');
    await expect(thumbs.nth(0)).not.toHaveClass(/spoiler/);
    await expect(thumbs.nth(1)).toHaveClass(/spoiler/);
    await expect(dialog.getByRole('button', { name: 'More' })).toBeVisible();
    await page.keyboard.press('ArrowRight');
    const img = dialog.locator('.chat-lightbox-stage img');
    await expect(img).toHaveClass(/spoiler/);
    await expect(dialog).toHaveAttribute('aria-label', 'SPOILER_hidden.png');
    await expect(dialog.getByRole('button', { name: 'Reveal spoiler' })).toBeVisible();
    for (const name of ['More', 'Zoom in', 'Open in Browser']) await expect(dialog.getByRole('button', { name }).or(dialog.getByRole('link', { name }))).toHaveCount(0);
    await shot(page, 'viewer-spoiler-covered');
    await dialog.getByRole('button', { name: 'Reveal spoiler' }).click();
    await expect(img).not.toHaveClass(/spoiler/);
    await expect(thumbs.nth(1)).not.toHaveClass(/spoiler/);
    await expect(dialog.getByRole('button', { name: 'More' })).toBeVisible();
    await shot(page, 'viewer-spoiler-revealed');
    await page.keyboard.press('Escape');
    await expect(row.locator('.chat-image.spoiler')).toHaveCount(0);
    // Next from a revealed picture to a second covered one lands on the cover, not on the picture
    const second = await sendFiles(page, [await png(page, 'one.png', 300, 300, '#a42'), await png(page, 'SPOILER_two.png', 300, 300, '#42a')], 'second pair');
    await second.locator('.chat-image').first().click();
    await dialog.getByRole('button', { name: 'Next' }).click();
    await expect(img).toHaveClass(/spoiler/);
  });

  test('a link inside an unrevealed ||spoiler|| gives no link menu and no URL; revealed, it does', async ({ page }) => {
    await openStockTalk(page);
    await send(page, 'hidden ||https://example.org/secret-page|| text');
    const row = page.locator('.chat-msg', { hasText: 'hidden' }).last();
    const cover = row.locator('.md-spoiler[role="button"]');
    await expect(cover).toBeVisible();
    await shot(page, 'spoiler-link-covered');
    await cover.click({ button: 'right' });
    expect((await labels(page)).join('|')).not.toMatch(/Open Link|Copy Link/);
    await page.keyboard.press('Escape');
    await cover.click();
    await row.locator('a[href^="https://example.org"]').click({ button: 'right' });
    expect((await labels(page)).slice(0, 2)).toEqual(['Open Link', 'Copy Link']);
  });

  test('link-preview pictures open in the image viewer: the large image, the thumbnail and a bare image link', async ({ page }) => {
    await stubImages(page);
    await openStockTalk(page);
    const row = await sendFiles(page, [await png(page, 'x.png', 50, 50, '#555')], 'preview https://example.org/post');
    await unfurl(page, row, [richEmbed('https://example.org/post', { image: { url: 'https://img.example/large.svg', width: 640, height: 360 } })]);
    await shot(page, 'embed-image');
    await row.locator('.chat-embed-media-btn').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('.chat-lightbox-stage img')).toHaveAttribute('src', 'https://img.example/large.svg');
    await expect(dialog.getByRole('button', { name: 'Forward' })).toHaveCount(0); // a link preview's picture is not a file of the message
    await expect(dialog.getByRole('button', { name: 'Zoom in' })).toBeVisible();
    await shot(page, 'embed-image-viewer');
    await page.keyboard.press('Escape');

    await unfurl(page, row, [richEmbed('https://example.org/post', { thumbnail: { url: 'https://img.example/thumb.svg', width: 80, height: 80 } })]);
    await row.locator('.chat-embed-thumb').click();
    await expect(dialog.locator('.chat-lightbox-stage img')).toHaveAttribute('src', 'https://img.example/thumb.svg');
    await page.keyboard.press('Escape');

    await unfurl(page, row, [{ type: 'image', url: 'https://img.example/bare.svg', thumbnail: { url: 'https://img.example/bare.svg', width: 640, height: 360 } }]);
    await row.locator('.chat-embed-image-only').click();
    await expect(dialog.locator('.chat-lightbox-stage img')).toHaveAttribute('src', 'https://img.example/bare.svg');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('the author removes link previews with the X: one PATCH with SUPPRESS_EMBEDS, and the cards stay gone', async ({ page }) => {
    await stubImages(page);
    await openStockTalk(page);
    const row = await sendFiles(page, [await png(page, 'y.png', 50, 50, '#555')], 'remove me https://example.org/post');
    const id = await unfurl(page, row, [richEmbed('https://example.org/post', { image: { url: 'https://img.example/large.svg', width: 640, height: 360 } })]);
    await expect(row.locator('.chat-embed-rich')).toHaveCount(1);
    await row.locator('.chat-embed-rich').hover();
    await expect(row.getByRole('button', { name: 'Remove embed' })).toBeVisible();
    await shot(page, 'embed-x');
    await row.getByRole('button', { name: 'Remove embed' }).click();
    await expect(row.locator('.chat-embed')).toHaveCount(0);
    expect(await fetchMessage(page, id)).toEqual({ flags: 4, embeds: 0 });
    await shot(page, 'embed-removed');
  });

  test('a message update that carries SUPPRESS_EMBEDS hides the cards even when embeds are still in it', async ({ page }) => {
    await openStockTalk(page);
    const row = await sendFiles(page, [await png(page, 'z.png', 50, 50, '#555')], 'late update https://example.org/post');
    const id = (await row.getAttribute('data-message-id'))!;
    await page.evaluate(async ([cid, mid]) => {
      const w = window as unknown as { __vokko: { request(m: string, p: string): Promise<{ id: string }[]>; gateway: { dispatch(t: string, d: unknown): void } } };
      const list = await w.__vokko.request('GET', `/channels/${cid}/messages?limit=30`);
      w.__vokko.gateway.dispatch('MESSAGE_UPDATE', { ...list.find(x => x.id === mid)!, flags: 4, embeds: [{ type: 'rich', title: 'Stale', url: 'https://example.org/post' }] });
    }, [channelOf(page), id] as const);
    await page.waitForTimeout(300);
    await expect(row.locator('.chat-embed')).toHaveCount(0);
  });

  test('Remove All Embeds in the message menu removes every preview', async ({ page }) => {
    await openStockTalk(page);
    const row = await sendFiles(page, [await png(page, 'm.png', 50, 50, '#555')], 'menu https://example.org/a https://example.org/b');
    const id = await unfurl(page, row, [richEmbed('https://example.org/a'), richEmbed('https://example.org/b', { title: 'Second' })]);
    await expect(row.locator('.chat-embed-rich')).toHaveCount(2);
    await row.locator('.chat-content').click({ button: 'right', position: { x: 2, y: 2 } });
    await shot(page, 'embed-menu');
    await menu(page).getByRole('menuitem', { name: 'Remove All Embeds' }).click();
    await expect(row.locator('.chat-embed')).toHaveCount(0);
    expect(await fetchMessage(page, id)).toEqual({ flags: 4, embeds: 0 });
    await row.locator('.chat-content').click({ button: 'right', position: { x: 2, y: 2 } });
    expect(await labels(page)).not.toContain('Remove All Embeds'); // already removed
  });

  test('a moderator gets the X on someone else\'s message; in a DM the other person does not', async ({ page }) => {
    const channel = await openStockTalk(page); // sam owns this server
    const said = await page.evaluate(([c]) => (window as unknown as MockWin).__vokkoMock.say(c as string, 'alice', 'from alice https://example.org/post'), [channel] as const);
    const row = page.locator(`.chat-msg[data-message-id="${said}"]`);
    await expect(row).toBeVisible();
    await page.evaluate(([c, m]) => (window as unknown as MockWin).__vokkoMock.setEmbeds(c as string, m as string, [{ type: 'rich', title: 'A post', url: 'https://example.org/post' }]), [channel, said] as const);
    await row.locator('.chat-embed-rich').hover();
    await row.getByRole('button', { name: 'Remove embed' }).click();
    await expect(row.locator('.chat-embed')).toHaveCount(0);
    expect(await fetchMessage(page, said)).toEqual({ flags: 4, embeds: 0 });

    await openDm(page, 'alice');
    const dmChannel = channelOf(page);
    const theirs = await page.evaluate(([c]) => (window as unknown as MockWin).__vokkoMock.say(c as string, 'alice', 'dm https://example.org/dm'), [dmChannel] as const);
    await page.evaluate(([c, m]) => (window as unknown as MockWin).__vokkoMock.setEmbeds(c as string, m as string, [{ type: 'rich', title: 'DM post', url: 'https://example.org/dm' }]), [dmChannel, theirs] as const);
    const dmRow = page.locator(`.chat-msg[data-message-id="${theirs}"]`);
    await expect(dmRow.locator('.chat-embed-rich')).toHaveCount(1);
    await dmRow.locator('.chat-embed-rich').hover();
    await expect(dmRow.getByRole('button', { name: 'Remove embed' })).toHaveCount(0);
    await dmRow.locator('.chat-content').click({ button: 'right', position: { x: 2, y: 2 } });
    expect(await labels(page)).not.toContain('Remove All Embeds');
  });
});

test.describe('phone 390x844', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

  const touch = (cdp: CDPSession, type: 'touchStart' | 'touchEnd', x = 0, y = 0) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 0 }] });

  test('long press on a covered SPOILER video opens only the message sheet', async ({ page }) => {
    await openStockTalk(page);
    const row = await sendFiles(page, [{ name: 'SPOILER_clip.mp4', mimeType: 'video/mp4', buffer: MP4 }], 'phone spoiler video');
    await row.scrollIntoViewIfNeeded();
    await shot(page, 'spoiler-video-covered');
    const box = (await row.locator('.chat-video-wrap').boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    await touch(cdp, 'touchStart', box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(700);
    await touch(cdp, 'touchEnd');
    await expect(page.locator('.sheet-message')).toBeVisible();
    expect(await labels(page)).not.toContain('Save Video');
    expect(await labels(page)).toContain('Reply');
    await expect(row.locator('video.chat-video')).toHaveClass(/spoiler/); // the press did not reveal it
    await shot(page, 'sheet-spoiler-video');
  });

  test('a covered SPOILER file card is tapped open', async ({ page }) => {
    await openStockTalk(page);
    const row = await sendFiles(page, [{ name: 'SPOILER_song.mp3', mimeType: 'audio/mpeg', buffer: MP3 }], 'phone spoiler song');
    await row.scrollIntoViewIfNeeded();
    await shot(page, 'spoiler-audio-covered');
    await row.locator('.chat-file').tap();
    await expect(row.locator('.chat-file-name')).toHaveText('song.mp3');
    await shot(page, 'spoiler-audio-revealed');
  });

  test('on a touch screen the embed X is always there, and a preview picture opens the viewer', async ({ page }) => {
    await stubImages(page);
    await openStockTalk(page);
    const row = await sendFiles(page, [await png(page, 'p.png', 50, 50, '#555')], 'phone preview https://example.org/post');
    const id = await unfurl(page, row, [richEmbed('https://example.org/post', { image: { url: 'https://img.example/large.svg', width: 640, height: 360 } })]);
    await row.scrollIntoViewIfNeeded();
    await expect(row.getByRole('button', { name: 'Remove embed' })).toBeVisible();
    await shot(page, 'embed-x');
    await row.locator('.chat-embed-media-btn').tap();
    await expect(page.getByRole('dialog').locator('.chat-lightbox-stage img')).toHaveAttribute('src', 'https://img.example/large.svg');
    await shot(page, 'embed-image-viewer');
    await page.getByRole('button', { name: 'Close' }).tap();
    await row.getByRole('button', { name: 'Remove embed' }).tap();
    await expect(row.locator('.chat-embed')).toHaveCount(0);
    expect(await fetchMessage(page, id)).toEqual({ flags: 4, embeds: 0 });
    await shot(page, 'embed-removed');
  });

  test('the viewer covers an unrevealed SPOILER picture on the phone', async ({ page }) => {
    await openStockTalk(page);
    const row = await sendFiles(page, [await png(page, 'a.png', 600, 400, '#c63'), await png(page, 'SPOILER_b.png', 600, 400, '#36c')], 'phone viewer spoiler');
    await row.locator('.chat-image').first().tap();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Next' }).tap();
    await expect(dialog.locator('.chat-lightbox-stage img')).toHaveClass(/spoiler/);
    await shot(page, 'viewer-spoiler-covered');
    await dialog.getByRole('button', { name: 'Reveal spoiler' }).tap();
    await expect(dialog.locator('.chat-lightbox-stage img')).not.toHaveClass(/spoiler/);
  });
});
