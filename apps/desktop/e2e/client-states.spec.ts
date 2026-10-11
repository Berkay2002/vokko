import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import path from 'node:path';
import { composer, message, openDm } from './helpers';

// Client states: REST-004 (startup splash, connection / maintenance / update / offline banners) and CMP-011 (the composer styles
// markdown as you type), against the mock backend. Screenshots are written when VOKKO_SHOTS_DIR is set.
const dir = process.env.VOKKO_SHOTS_DIR;

type Win = {
  __vokkoMock: { offline(on: boolean): void; maintenance(message: string | null, startsAt?: string | null): void };
  __vokko: {
    desktop: { useDesktopUpdate: { setState(s: { status: unknown }): void } };
    appStore: { getState(): { connection: string } };
  };
};

const shot = async (page: Page, name: string, target?: Locator) => {
  if (!dir) return;
  await page.waitForTimeout(250);
  const file = path.join(dir, `${name}.png`);
  if (target) await target.screenshot({ path: file });
  else await page.screenshot({ path: file });
};

async function boot(page: Page) {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.waitForFunction(() => (window as unknown as Win).__vokko.appStore.getState().connection === 'ready');
}

const hasTopBanner = (page: Page) => page.evaluate(() => document.documentElement.classList.contains('has-top-banner'));

// ---- REST-004 -----------------------------------------------------------------------------------------------------------------------

test.describe('REST-004 banners', () => {
  test('connection lost: attempt count and countdown, Reconnect now, then a green "Connected" flash', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => (window as unknown as Win).__vokkoMock.offline(true));
    const banner = page.getByTestId('connection-banner');
    await expect(banner).toBeVisible({ timeout: 8000 });
    await expect(banner).toContainText('Connection lost');
    await expect(banner).toContainText(/attempt \d+/);
    await expect.poll(async () => Number(await banner.getAttribute('data-attempt'))).toBeGreaterThanOrEqual(1);
    expect(await hasTopBanner(page)).toBe(true);
    await shot(page, '03-connection-lost');
    await page.evaluate(() => (window as unknown as Win).__vokkoMock.offline(false));
    await banner.getByRole('button', { name: 'Reconnect now' }).click();
    const flash = page.getByTestId('connection-restored');
    await expect(flash).toContainText('Connected', { timeout: 8000 });
    await expect(banner).toHaveCount(0);
    await shot(page, '04-connection-restored');
    await expect(flash).toHaveCount(0, { timeout: 6000 });
    expect(await hasTopBanner(page)).toBe(false);
  });

  test('connection details dialog lists the client-side state', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => (window as unknown as Win).__vokkoMock.offline(true));
    const banner = page.getByTestId('connection-banner');
    await expect(banner).toBeVisible({ timeout: 8000 });
    await banner.getByRole('button', { name: 'Details' }).click();
    const status = page.getByTestId('connection-status');
    await expect(status).toContainText('Server connection');
    await expect(status).toContainText('Failed attempts');
    await shot(page, '05-connection-status');
    await page.keyboard.press('Escape');
    await page.evaluate(() => (window as unknown as Win).__vokkoMock.offline(false));
  });

  test('offline (navigator.onLine false) shows the offline banner and recovers', async ({ page, context }) => {
    await boot(page);
    await context.setOffline(true);
    const banner = page.getByTestId('connection-banner');
    await expect(banner).toBeVisible({ timeout: 6000 });
    await expect(banner).toContainText("You're offline");
    await shot(page, '06-offline');
    await context.setOffline(false);
    await expect(banner).toHaveCount(0, { timeout: 6000 });
  });

  test('maintenance banner from the status endpoint, dismissible and cleared with the notice', async ({ page }) => {
    await boot(page);
    await expect(page.getByTestId('maintenance-banner')).toHaveCount(0);
    await page.evaluate(() => (window as unknown as Win).__vokkoMock.maintenance('Vokko will be read-only for a few minutes while we upgrade the database.'));
    const banner = page.getByTestId('maintenance-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('read-only');
    expect(await hasTopBanner(page)).toBe(true);
    await shot(page, '07-maintenance');
    await banner.getByRole('button', { name: 'Dismiss' }).click();
    await expect(banner).toHaveCount(0);
    expect(await hasTopBanner(page)).toBe(false);
    await page.evaluate(() => (window as unknown as Win).__vokkoMock.maintenance(null));
  });

  test('desktop update: downloading, then ready with Restart to Update', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => (window as unknown as Win).__vokko.desktop.useDesktopUpdate.setState({ status: { state: 'downloading', version: '9.9.9', downloaded: 40, total: 100 } }));
    const downloading = page.getByTestId('update-downloading-banner');
    await expect(downloading).toContainText('9.9.9');
    await expect(downloading).toContainText('40%');
    await page.evaluate(() => (window as unknown as Win).__vokko.desktop.useDesktopUpdate.setState({ status: { state: 'ready', version: '9.9.9' } }));
    const ready = page.getByTestId('update-banner');
    await expect(ready).toContainText('9.9.9');
    await expect(ready.getByRole('button', { name: 'Restart to Update' })).toBeVisible();
    await shot(page, '08-update-ready');
  });

  test('a maintenance notice yields to the connection banner and comes back after', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => (window as unknown as Win).__vokkoMock.maintenance('Short maintenance window tonight.'));
    await expect(page.getByTestId('maintenance-banner')).toBeVisible();
    await page.evaluate(() => (window as unknown as Win).__vokkoMock.offline(true));
    await expect(page.getByTestId('connection-banner')).toBeVisible({ timeout: 8000 });
    await expect(page.getByTestId('maintenance-banner')).toHaveCount(0);
    await page.evaluate(() => (window as unknown as Win).__vokkoMock.offline(false));
    await page.getByTestId('connection-banner').getByRole('button', { name: 'Reconnect now' }).click();
    await expect(page.getByTestId('maintenance-banner')).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('REST-004 splash', () => {
  test('rotating tip while connecting; the slow link appears after 10 s and opens the status', async ({ page }) => {
    await page.addInitScript(() => {
      const real = window.setTimeout.bind(window);
      // the mock socket says Hello 15 ms after opening: hold it back so the splash stays on screen
      (window as unknown as { setTimeout: unknown }).setTimeout = (fn: TimerHandler, ms?: number, ...rest: unknown[]) => real(fn, ms === 15 ? 14_000 : ms, ...rest);
    });
    await page.goto('/channels/@me?as=sam&mockLatency=0');
    const splash = page.getByTestId('splash');
    await expect(splash).toBeVisible();
    const tip = page.getByTestId('splash-tip');
    const first = await tip.innerText();
    expect(first.length).toBeGreaterThan(10);
    await expect(splash.getByRole('button', { name: 'Taking too long?' })).toHaveCount(0);
    await expect.poll(() => tip.innerText(), { timeout: 8000 }).not.toBe(first);
    await shot(page, '01-splash');
    await expect(splash.getByRole('button', { name: 'Taking too long?' })).toBeVisible({ timeout: 8000 });
    await splash.getByRole('button', { name: 'Taking too long?' }).click();
    await expect(page.getByTestId('connection-status')).toBeVisible();
    await shot(page, '02-splash-slow-status');
  });
});

// ---- CMP-011 ------------------------------------------------------------------------------------------------------------------------

/** The editor's source text: lines joined by "\n", chips by their raw form (textContent alone would drop the newlines). */
const source = (page: Page) =>
  composer(page).evaluate(el => {
    const lines = [...el.children] as HTMLElement[];
    return lines.map(line => [...line.childNodes].map(n => (n as HTMLElement).dataset?.raw ?? n.textContent ?? '').join('')).join('\n');
  });

const caretOffset = (page: Page) =>
  page.evaluate(() => {
    const sel = document.getSelection();
    const root = document.querySelector('.chat-textarea')!;
    if (!sel || !sel.anchorNode || !root.contains(sel.anchorNode)) return -1;
    const range = document.createRange();
    range.selectNodeContents(root);
    range.setEnd(sel.anchorNode, sel.anchorOffset);
    const frag = range.cloneContents();
    // newlines between lines count one each
    const lines = [...frag.children];
    return lines.map(l => l.textContent ?? '').join('\n').length;
  });

test.describe('CMP-011 live markdown composer', () => {
  test.beforeEach(async ({ page }) => {
    await openDm(page);
  });

  test('is an accessible multiline textbox', async ({ page }) => {
    const box = composer(page);
    await expect(box).toHaveAttribute('role', 'textbox');
    await expect(box).toHaveAttribute('aria-multiline', 'true');
    await expect(page.getByRole('textbox', { name: /Message @alice/i })).toBeVisible();
    await expect(box).toHaveAttribute('data-empty', 'true');
    await box.click();
    await expect(box).toBeFocused();
  });

  test('inline styles appear while typing, with the syntax characters kept and dimmed', async ({ page }) => {
    const box = composer(page);
    await box.click();
    await box.pressSequentially('**bold** *it* __under__ ~~gone~~ `code` ||spoil||', { delay: 5 });
    await expect(box.locator('.le-b', { hasText: 'bold' })).toHaveCount(1);
    await expect(box.locator('.le-i', { hasText: 'it' })).toHaveCount(1);
    await expect(box.locator('.le-u', { hasText: 'under' })).toHaveCount(1);
    await expect(box.locator('.le-s', { hasText: 'gone' })).toHaveCount(1);
    await expect(box.locator('.le-c', { hasText: 'code' })).toHaveCount(1);
    await expect(box.locator('.le-sp', { hasText: 'spoil' })).toHaveCount(1);
    expect(await box.locator('.le-syn').count()).toBeGreaterThanOrEqual(10);
    // the text is still the plain markdown
    expect(await source(page)).toBe('**bold** *it* __under__ ~~gone~~ `code` ||spoil||');
    const weight = await box.locator('.le-b', { hasText: 'bold' }).evaluate(el => getComputedStyle(el).fontWeight);
    expect(Number(weight)).toBeGreaterThanOrEqual(600);
    const synWeight = await box.locator('.le-syn').first().evaluate(el => getComputedStyle(el).fontWeight);
    expect(Number(synWeight)).toBeLessThan(600);
    await shot(page, '10-composer-inline', page.locator('.chat-composer'));
  });

  test('blocks: quote, heading, subtext, list and a fenced code block with highlighting', async ({ page }) => {
    const box = composer(page);
    await box.click();
    const lines = ['> quoted', '# Heading', '-# small print', '- item', '```js', 'const answer = 42;', '```'];
    for (const [i, line] of lines.entries()) {
      await box.pressSequentially(line, { delay: 2 });
      if (i < lines.length - 1) await page.keyboard.press('Shift+Enter');
    }
    expect(await source(page)).toBe(lines.join('\n'));
    await expect(box.locator('.le-quote')).toHaveCount(1);
    await expect(box.locator('.le-head')).toHaveCount(1);
    await expect(box.locator('.le-sub')).toHaveCount(1);
    await expect(box.locator('.le-list')).toHaveCount(1);
    await expect(box.locator('.le-code-line')).toHaveCount(3);
    await expect(box.locator('.hljs-keyword', { hasText: 'const' })).toHaveCount(1);
    await shot(page, '11-composer-blocks', page.locator('.chat-composer'));
  });

  test('showcase: the whole markdown set in one draft, with emoji and timestamp chips', async ({ page }) => {
    const box = composer(page);
    await box.click();
    const lines = [
      '[vokko test] markdown showcase',
      '**bold** *italic* __underline__ ~~strike~~ ***bold italic*** ||spoiler||',
      '`inline code` [masked link](https://example.com) https://example.com',
      '-# subtext line',
      '# Heading 1',
      '## Heading 2',
      '### Heading 3',
      '- bullet one',
      '- bullet two',
      '1. first',
      '2. second',
      '```js',
      'const a = 1; // code',
      '```',
      ':smile: <t:1700000000:R> <t:1700000000:F>',
      '> block quote',
    ];
    for (const [i, line] of lines.entries()) {
      await box.pressSequentially(line, { delay: 1 });
      if (i < lines.length - 1) await page.keyboard.press('Shift+Enter');
    }
    expect(await source(page)).toBe(lines.join('\n'));
    await expect(box.locator('.le-atom-timestamp')).toHaveCount(2);
    await expect(box.locator('.le-atom-shortcode, .le-atom-emoji')).toHaveCount(1);
    await expect(box.locator('.le-quote')).toHaveCount(1);
    await expect(box.locator('.le-link')).toHaveCount(2);
    // the caret is at the end of the last line and Backspace takes a chip as one unit
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+Shift+z');
    expect(await source(page)).toBe(lines.join('\n'));
    await shot(page, '13-composer-showcase');
  });

  test('an emoji picked from the picker lands at the caret, not at the end', async ({ page }) => {
    const box = composer(page);
    await box.click();
    await box.pressSequentially('ab', { delay: 5 });
    await page.keyboard.press('ArrowLeft');
    await page.getByRole('button', { name: 'Select emoji' }).click();
    const picker = page.getByRole('dialog', { name: 'Expression picker' });
    await picker.getByRole('button', { name: /grinning face/i }).first().click();
    await expect.poll(() => source(page)).toMatch(/^a.+b$/);
    const inserted = (await source(page)).slice(1, -1);
    // typing carries on right after the emoji
    await box.pressSequentially('X', { delay: 5 });
    expect(await source(page)).toBe(`a${inserted}Xb`);
  });

  test('the emoji autocomplete previews the highlighted emoji and Tab inserts it', async ({ page }) => {
    const box = composer(page);
    await box.click();
    await box.pressSequentially('hi :smile', { delay: 10 });
    const panel = page.locator('.chat-autocomplete');
    await expect(panel.locator('.chat-autocomplete-item').first()).toBeVisible();
    await expect(panel.locator('.chat-autocomplete-preview')).toBeVisible();
    await box.press('ArrowDown');
    await expect(panel.locator('.chat-autocomplete-item.selected')).toHaveCount(1);
    await box.press('Tab');
    await expect(panel).toHaveCount(0);
    const text = await source(page);
    expect(text).not.toContain(':smile');
    expect(text.startsWith('hi ')).toBe(true);
    expect(text.length).toBeGreaterThan('hi '.length);
  });

  test('a GIF or a sticker is sent at once and the draft in the editor stays', async ({ page }) => {
    const box = composer(page);
    await box.click();
    await box.pressSequentially('keep me', { delay: 5 });
    await page.getByRole('button', { name: 'Open GIF picker' }).click();
    const gifs = page.getByRole('dialog', { name: 'Expression picker' }).getByRole('tabpanel', { name: 'GIFs' });
    await gifs.getByRole('textbox', { name: 'Search GIFs' }).fill('cat dance');
    await gifs.getByRole('button', { name: /^Send GIF:/ }).first().click();
    await expect(page.locator('.chat-msg', { has: page.locator('.media-gif') }).last()).toBeVisible();
    expect(await source(page)).toBe('keep me');
    await page.getByRole('button', { name: 'Open sticker picker' }).click();
    const stickers = page.getByRole('dialog', { name: 'Expression picker' }).getByRole('tabpanel', { name: 'Stickers' });
    await stickers.getByRole('button').first().click();
    await expect(page.locator('.chat-msg', { has: page.locator('img.media-sticker') }).last()).toBeVisible();
    await box.click();
    await box.pressSequentially('!', { delay: 5 });
    expect(await source(page)).toBe('keep me!');
  });

  test('Up on an empty draft edits the last own message; the composer works again afterwards', async ({ page }) => {
    const box = composer(page);
    await box.click();
    await box.pressSequentially('edit target', { delay: 5 });
    await box.press('Enter');
    await expect(message(page, 'edit target')).not.toHaveClass(/pending/);
    await box.press('ArrowUp');
    const editor = page.getByRole('textbox', { name: 'Edit message' });
    await expect(editor).toBeVisible();
    await editor.fill('edited text');
    await editor.press('Enter');
    await expect(message(page, 'edited text')).toBeVisible();
    await box.click();
    await box.pressSequentially('after **edit**', { delay: 5 });
    expect(await source(page)).toBe('after **edit**');
    await expect(box.locator('.le-b', { hasText: 'edit' })).toHaveCount(1);
  });

  test('Ctrl+K and Ctrl+/ work while the editor has focus and the draft survives', async ({ page }) => {
    const box = composer(page);
    await box.click();
    await box.pressSequentially('draft', { delay: 5 });
    await page.keyboard.press('Control+k');
    await expect(page.locator('.quick-input')).toBeFocused();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+/');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await source(page)).toBe('draft');
  });

  test('a chip is one unit for the caret and Backspace', async ({ page }) => {
    const box = composer(page);
    await box.click();
    await box.pressSequentially('a <t:1700000000:t> b', { delay: 5 });
    await expect(box.locator('.le-atom-timestamp')).toHaveCount(1);
    for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowLeft'); // before " b"
    await page.keyboard.press('Backspace');
    expect(await source(page)).toBe('a  b');
    await page.keyboard.press('Control+z');
    expect(await source(page)).toBe('a <t:1700000000:t> b');
    await expect(box.locator('.le-atom-timestamp')).toHaveCount(1);
  });

  test('masked links: label plain, url link-coloured, brackets dimmed', async ({ page }) => {
    const box = composer(page);
    await box.click();
    await box.pressSequentially('[Vokko](https://vokko.gg)', { delay: 5 });
    // exactly one link-coloured span, and it is the URL (the label stays body text)
    await expect(box.locator('.le-link')).toHaveCount(1);
    await expect(box.locator('.le-link')).toHaveText('https://vokko.gg');
    expect(await source(page)).toBe('[Vokko](https://vokko.gg)');
    await expect(box.locator('.le-syn').first()).toHaveText('[');
  });

  test('what is sent is the plain markdown and renders as a message', async ({ page }) => {
    const box = composer(page);
    await box.click();
    await box.pressSequentially('hello **there** `x`', { delay: 5 });
    await box.press('Enter');
    const sent = message(page, 'hello');
    await expect(sent).toBeVisible();
    await expect(sent.locator('strong')).toHaveText('there');
    await expect(sent.locator('.md-code')).toHaveText('x');
    // the box is empty again and ready for the next message
    await expect(box).toHaveAttribute('data-empty', 'true');
    expect(await source(page)).toBe('');
  });

  test('typing in the middle keeps the caret; arrows, Home/End and selection replace work', async ({ page }) => {
    const box = composer(page);
    await box.click();
    await box.pressSequentially('abcdef', { delay: 5 });
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await box.pressSequentially('XY', { delay: 5 });
    expect(await source(page)).toBe('abcdXYef');
    expect(await caretOffset(page)).toBe(6);
    await page.keyboard.press('Home');
    await box.pressSequentially('>', { delay: 5 });
    expect(await source(page)).toBe('>abcdXYef');
    await page.keyboard.press('End');
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Shift+ArrowLeft');
    await box.pressSequentially('Z', { delay: 5 });
    expect(await source(page)).toBe('>abcdXYZ');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    expect(await source(page)).toBe('>abcdX');
  });

  test('caret survives a restyle: typing the closing ** of a word in the middle of a line', async ({ page }) => {
    const box = composer(page);
    await box.click();
    await box.pressSequentially('one two three', { delay: 5 });
    // put the caret after "one " and wrap "two" in bold by typing the delimiters
    for (let i = 0; i < 'two three'.length; i++) await page.keyboard.press('ArrowLeft');
    await box.pressSequentially('**', { delay: 5 });
    for (let i = 0; i < 'two'.length; i++) await page.keyboard.press('ArrowRight');
    await box.pressSequentially('**', { delay: 5 });
    expect(await source(page)).toBe('one **two** three');
    await expect(box.locator('.le-b', { hasText: 'two' })).toHaveCount(1);
    expect(await caretOffset(page)).toBe('one **two**'.length);
    await box.pressSequentially('!', { delay: 5 });
    expect(await source(page)).toBe('one **two**! three');
  });

  test('undo and redo with the keyboard, in word-sized steps', async ({ page }) => {
    const box = composer(page);
    await box.click();
    await box.pressSequentially('hello', { delay: 5 });
    await box.pressSequentially(' ', { delay: 5 });
    await box.pressSequentially('world', { delay: 5 });
    expect(await source(page)).toBe('hello world');
    await page.keyboard.press('Control+z');
    expect(await source(page)).toBe('hello ');
    await page.keyboard.press('Control+z');
    expect(await source(page)).toBe('');
    await page.keyboard.press('Control+Shift+z');
    expect(await source(page)).toBe('hello ');
    await page.keyboard.press('Control+y');
    expect(await source(page)).toBe('hello world');
    // typing after an undo drops the redo stack
    await page.keyboard.press('Control+z');
    await box.pressSequentially('there', { delay: 5 });
    await page.keyboard.press('Control+y');
    expect(await source(page)).toBe('hello there');
  });

  test('undo restores a deleted selection and the caret', async ({ page }) => {
    const box = composer(page);
    await box.click();
    await box.pressSequentially('keep this', { delay: 5 });
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    expect(await source(page)).toBe('');
    await page.keyboard.press('Control+z');
    expect(await source(page)).toBe('keep this');
    // the selection that was deleted is selected again, like the browser's own undo
    expect(await page.evaluate(() => document.getSelection()?.toString())).toBe('keep this');
    await page.keyboard.press('ArrowRight');
    await box.pressSequentially('!', { delay: 5 });
    expect(await source(page)).toBe('keep this!');
  });

  test('paste inserts plain text only; HTML and line breaks do not leak into the DOM', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const box = composer(page);
    await box.click();
    await page.evaluate(async () => {
      const html = new Blob(['<b style="color:red">bold</b><div>second</div>'], { type: 'text/html' });
      const text = new Blob(['bold\nsecond **x**'], { type: 'text/plain' });
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': html, 'text/plain': text })]);
    });
    await box.pressSequentially('a ', { delay: 5 });
    await page.keyboard.press('Control+v');
    expect(await source(page)).toBe('a bold\nsecond **x**');
    expect(await box.locator('b, font, [style*="color"]').count()).toBe(0);
    await expect(box.locator('.le-b', { hasText: 'x' })).toHaveCount(1);
    expect(await caretOffset(page)).toBe('a bold\nsecond **x**'.length);
    await page.keyboard.press('Control+z');
    expect(await source(page)).toBe('a ');
  });

  test('copy gives the raw markdown, cut removes it', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const box = composer(page);
    await box.click();
    await box.pressSequentially('**bold** text', { delay: 5 });
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+x');
    expect(await source(page)).toBe('');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('**bold** text');
  });

  test('IME composition: the browser owns the DOM until it ends, then the model catches up', async ({ page }) => {
    const box = composer(page);
    await box.click();
    await box.pressSequentially('a ', { delay: 5 });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
    await expect(box).toContainText('に');
    await cdp.send('Input.imeSetComposition', { text: 'にほ', selectionStart: 2, selectionEnd: 2 });
    await expect(box).toContainText('にほ');
    await cdp.send('Input.insertText', { text: 'にほん' });
    await expect.poll(() => source(page)).toBe('a にほん');
    // typing carries on from the right place and styling still works
    await box.pressSequentially(' **x**', { delay: 5 });
    expect(await source(page)).toBe('a にほん **x**');
    await expect(box.locator('.le-b', { hasText: 'x' })).toHaveCount(1);
    await box.press('Enter');
    await expect(message(page, 'にほん')).toBeVisible();
  });

  test('IME composition inside a styled line does not duplicate or lose text', async ({ page }) => {
    const box = composer(page);
    await box.click();
    await box.pressSequentially('**bold**', { delay: 5 });
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'ね', selectionStart: 1, selectionEnd: 1 });
    await cdp.send('Input.insertText', { text: 'ね' });
    await expect.poll(() => source(page)).toBe('**bolねd**');
    await expect(box.locator('.le-b')).toHaveCount(1);
  });

  test('mentions picked from the autocomplete are chips and send as real mentions', async ({ page }) => {
    const box = composer(page);
    await box.click();
    await box.pressSequentially('hey @ali', { delay: 15 });
    await expect(page.getByRole('listbox', { name: 'Suggestions' })).toBeVisible();
    await box.press('Tab');
    await expect(box.locator('.le-men')).toContainText(/@alice/i);
    await shot(page, '12-composer-mention', page.locator('.chat-composer'));
    await box.pressSequentially('hi', { delay: 5 });
    await box.press('Enter');
    const sent = message(page, 'hey');
    await expect(sent.locator('.md-mention')).toContainText(/@alice/i);
  });

  test('a long draft grows to at most half the window and keeps the caret in view', async ({ page }) => {
    const box = composer(page);
    await box.click();
    for (let i = 0; i < 60; i++) {
      await page.keyboard.type(`line ${i}`);
      await page.keyboard.press('Shift+Enter');
    }
    await page.keyboard.type('the end');
    const info = await box.evaluate(el => ({ h: el.getBoundingClientRect().height, scrollable: el.scrollHeight > el.clientHeight, atEnd: el.scrollTop + el.clientHeight >= el.scrollHeight - 30, win: window.innerHeight }));
    expect(info.h).toBeLessThanOrEqual(info.win * 0.5 + 2);
    expect(info.scrollable).toBe(true);
    expect(info.atEnd).toBe(true);
  });

  test('the draft is kept per channel and undo does not cross channels', async ({ page }) => {
    const box = composer(page);
    await box.click();
    await box.pressSequentially('draft for alice', { delay: 5 });
    await page.getByRole('link', { name: /^(nova|kai|bob|dev)/i }).first().click();
    await expect(composer(page)).toHaveAttribute('data-empty', 'true');
    await page.getByRole('link', { name: /^alice/i }).first().click();
    await expect.poll(() => source(page)).toBe('draft for alice');
    await composer(page).click();
    await page.keyboard.press('Control+z');
    expect(await source(page)).toBe('draft for alice');
  });

  test('dragging a word inside the editor moves it without losing text, as one undo step', async ({ page }) => {
    const box = composer(page);
    await box.click();
    await box.pressSequentially('one two three', { delay: 5 });
    await page.keyboard.press('Home');
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight');
    const from = await page.evaluate(() => {
      const r = document.getSelection()!.getRangeAt(0).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    const to = await page.evaluate(() => {
      const root = document.querySelector('.chat-textarea')!;
      const range = document.createRange();
      range.selectNodeContents(root.lastElementChild!);
      const r = range.getBoundingClientRect();
      return { x: r.right + 2, y: r.top + r.height / 2 };
    });
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 10, from.y, { steps: 4 });
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => source(page)).toBe(' two threeone');
    await page.keyboard.press('Control+z');
    expect(await source(page)).toBe('one two three');
    await page.keyboard.press('Control+Shift+z');
    expect(await source(page)).toBe(' two threeone');
  });

  test('the Preview Markdown pref off falls back to a plain textarea', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.addInitScript(() => {
      if (!localStorage.getItem('vokko.prefs')) localStorage.setItem('vokko.prefs', JSON.stringify({ previewMarkdown: false }));
    });
    await openDm(page);
    const box = page.locator('textarea.chat-textarea');
    await expect(box).toBeVisible();
    await box.fill('**not styled**');
    await expect(page.locator('.le-b')).toHaveCount(0);
    await expect(box).toHaveValue('**not styled**');
    await box.press('Enter');
    await expect(message(page, 'not styled').locator('strong')).toHaveText('not styled');
    await context.close();
  });
});
