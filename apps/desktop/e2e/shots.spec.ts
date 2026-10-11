import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import path from 'node:path';
import { composer, message, openDm, send } from './helpers';

// Acceptance screenshots. Skipped unless VOKKO_SHOTS_DIR is set: VOKKO_SHOTS_DIR=E:\...\artifacts\chat npx playwright test e2e/shots.spec.ts
const dir = process.env.VOKKO_SHOTS_DIR;
test.skip(!dir, 'set VOKKO_SHOTS_DIR to capture screenshots');
test.describe.configure({ mode: 'serial' });

// The short wait lets popout/modal/lightbox enter animations settle before the frame is taken.
const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(dir!, `${name}.png`) });
};

const MARKDOWN = [
  '# Heading one',
  '**bold** *italic* __underline__ ~~strike~~ ||spoiler|| `inline code`',
  '> a block quote',
  '- first item',
  '- second item',
  '[masked link](https://example.com) and https://example.org/auto :tada:',
  '```ts',
  'const answer: number = 42;',
  '```',
].join('\n');

async function pngBase64(page: Page, w: number, h: number, hue: number): Promise<string> {
  return page.evaluate(([w, h, hue]) => {
    const c = document.createElement('canvas');
    c.width = w!; c.height = h!;
    const g = c.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, w!, h!);
    grad.addColorStop(0, `hsl(${hue}, 70%, 55%)`);
    grad.addColorStop(1, `hsl(${(hue! + 80) % 360}, 70%, 35%)`);
    g.fillStyle = grad; g.fillRect(0, 0, w!, h!);
    return c.toDataURL('image/png').split(',')[1]!;
  }, [w, h, hue] as const);
}

test('acceptance screenshots', async ({ page }) => {
  await openDm(page);
  const channelId = new URL(page.url()).pathname.split('/').filter(Boolean).pop()!;

  // 1. mixed history
  await page.evaluate(([id]) => {
    const m = (window as unknown as { __vokkoMock: { say(c: string, u: string, t: string, o?: { replyTo?: string }): string } }).__vokkoMock;
    m.say(id!, 'alice', 'hey, did you see the build go green?');
    m.say(id!, 'alice', 'also <@everyone> style mentions should not break anything');
  }, [channelId]);
  await expect(page.locator('.chat-msg').last()).toBeVisible();
  await shot(page, '01-dm-chat-mixed');

  // 2. every markdown feature
  await composer(page).fill(MARKDOWN);
  await composer(page).press('Enter');
  const md = message(page, 'Heading one');
  await expect(md).toBeVisible();
  await page.mouse.move(5, 5);
  await shot(page, '02-markdown');

  // 3. hover toolbar
  await md.hover();
  await shot(page, '03-hover-toolbar');

  // 4. context menu
  await md.click({ button: 'right', position: { x: 200, y: 20 } });
  await expect(page.getByRole('menu')).toBeVisible();
  await shot(page, '04-context-menu');
  await page.keyboard.press('Escape');

  // 5. inline edit
  await send(page, 'a message to edit');
  const target = message(page, 'a message to edit');
  await target.hover();
  await target.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByLabel('Edit message')).toBeFocused();
  await shot(page, '05-inline-edit');
  await page.getByLabel('Edit message').press('Escape');

  // 6. reply in progress + rendered reply
  await target.click({ button: 'right', position: { x: 200, y: 10 } });
  await page.getByRole('menuitem', { name: 'Reply' }).click();
  await composer(page).fill('replying to that');
  await shot(page, '06a-reply-in-progress');
  await composer(page).press('Enter');
  await expect(message(page, 'replying to that')).toBeVisible();
  await page.mouse.move(5, 5);
  await shot(page, '06b-reply-rendered');

  // 7. reactions + emoji picker
  await target.hover();
  await target.getByRole('button', { name: 'React with 👍' }).click();
  await target.hover();
  await target.getByRole('button', { name: 'React with 😂' }).click();
  await expect(target.locator('.chat-reaction.me')).toHaveCount(2);
  await target.hover();
  await target.locator('.chat-toolbar').getByRole('button', { name: 'Add Reaction' }).click();
  await expect(page.locator('.chat-emoji-picker')).toBeVisible();
  await shot(page, '07-reactions-emoji-picker');
  await page.keyboard.press('Escape');

  // 8. upload tray, then image attachment + lightbox
  const png = await pngBase64(page, 800, 500, 210);
  await page.locator('input[type=file]').setInputFiles([
    { name: 'sunset.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('some notes') },
  ]);
  await expect(page.locator('.chat-tray-item')).toHaveCount(2);
  await shot(page, '08-upload-tray');
  await expect(page.locator('.chat-tray-item.done')).toHaveCount(2, { timeout: 15_000 });
  await composer(page).fill('here is the picture');
  await composer(page).press('Enter');
  const withImage = message(page, 'here is the picture');
  await expect(withImage.locator('.chat-image img')).toBeVisible();
  await expect(withImage.locator('.chat-file')).toBeVisible();
  await shot(page, '09-image-attachment');
  await withImage.locator('.chat-image').click();
  await expect(page.locator('.chat-lightbox')).toBeVisible();
  await shot(page, '10-lightbox');
  await page.keyboard.press('Escape');

  // 11. typing indicator
  await page.evaluate(([id]) => {
    (window as unknown as { __vokkoMock: { typing(c: string, u: string): void } }).__vokkoMock.typing(id!, 'alice');
  }, [channelId]);
  await expect(page.locator('.chat-typing-text')).toBeVisible();
  await shot(page, '11-typing');

  // 12. autocomplete
  await composer(page).fill('hey @a');
  await expect(page.locator('.chat-autocomplete')).toBeVisible();
  await shot(page, '12a-autocomplete-mention');
  await composer(page).fill('nice :tad');
  await expect(page.locator('.chat-autocomplete')).toBeVisible();
  await shot(page, '12b-autocomplete-emoji');
  await composer(page).fill('');

  // 13. delete modal
  await target.hover();
  await target.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Delete Message' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await shot(page, '13-delete-modal');
  await page.getByRole('button', { name: 'Cancel' }).click();

  // 14. jump-to-present bar: seed a long history, scroll away from the bottom
  await page.evaluate(([id]) => {
    const m = (window as unknown as { __vokkoMock: { say(c: string, u: string, t: string): string } }).__vokkoMock;
    for (let i = 0; i < 80; i++) m.say(id!, 'alice', `filler message number ${i + 1}`);
  }, [channelId]);
  await page.locator('.chat-scroller').hover();
  await page.mouse.wheel(0, -3000);
  await expect(page.locator('.chat-jump-bar')).toBeVisible();
  await shot(page, '14-jump-to-present');
});
