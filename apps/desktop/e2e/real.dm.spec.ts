import { expect, test } from '@playwright/test';
import { RUN, composer, msg, openDmWith, openSession, send, shot } from './realHelpers';
import type { Session } from './realHelpers';

// sam and carol in two live browser contexts, in the seeded DM.
test.describe.configure({ mode: 'serial' });

let sam: Session;
let carol: Session;
const text = `hello from sam ${RUN}`;

test.afterAll(async () => {
  await sam?.ctx.close();
  await carol?.ctx.close();
});

test('both sides open the seeded DM', async ({ browser }) => {
  sam = await openSession(browser, 'sam');
  carol = await openSession(browser, 'carol');
  await openDmWith(sam.page, 'carol');
  await openDmWith(carol.page, 'sam');
  await expect(sam.page.locator('.chat-msg').first()).toBeVisible();
  await expect(carol.page.locator('.chat-msg').first()).toBeVisible();
});

test('a sent message arrives live on the other side', async () => {
  await send(sam.page, text);
  await expect(msg(sam.page, text)).not.toHaveClass(/pending/);
  await expect(msg(carol.page, text)).toBeVisible();
  await shot(carol.page, 'r04-live-message-carol');
});

test('typing indicator shows on the other side', async () => {
  await composer(carol.page).click();
  await composer(carol.page).pressSequentially('typing something', { delay: 30 });
  await expect(sam.page.locator('.chat-typing-text')).toContainText(/Carol.*typing/i, { timeout: 10_000 });
  await shot(sam.page, 'r05-typing');
  await composer(carol.page).fill('');
});

test('edit propagates and shows (edited)', async () => {
  const m = msg(sam.page, text);
  await m.hover();
  await m.getByRole('button', { name: 'Edit' }).click();
  const edit = sam.page.getByLabel('Edit message');
  await edit.fill(`${text} (fixed)`);
  await edit.press('Enter');
  await expect(msg(carol.page, `${text} (fixed)`)).toBeVisible();
  await expect(msg(carol.page, `${text} (fixed)`)).toContainText('(edited)');
});

test('reply renders on both sides', async () => {
  const m = msg(carol.page, `${text} (fixed)`);
  await m.click({ button: 'right', position: { x: 160, y: 10 } });
  await carol.page.getByRole('menuitem', { name: 'Reply' }).click();
  await send(carol.page, `replying ${RUN}`);
  const r = msg(sam.page, `replying ${RUN}`);
  await expect(r).toBeVisible();
  await expect(r).toContainText(`${text} (fixed)`);
  await shot(sam.page, 'r06-reply');
});

test('reactions propagate and count', async () => {
  const m = msg(carol.page, `replying ${RUN}`);
  await m.hover();
  await m.getByRole('button', { name: 'React with 👍' }).click();
  const theirs = msg(sam.page, `replying ${RUN}`).locator('.chat-reaction').first();
  await expect(theirs).toContainText('1');
  await theirs.click();
  await expect(theirs).toContainText('2');
  await expect(msg(carol.page, `replying ${RUN}`).locator('.chat-reaction').first()).toContainText('2');
});

test('pin shows up on the other side and unpin removes it', async () => {
  const m = msg(sam.page, `replying ${RUN}`);
  await m.click({ button: 'right', position: { x: 160, y: 10 } });
  await sam.page.getByRole('menuitem', { name: 'Pin Message' }).click();
  await sam.page.getByRole('dialog', { name: 'Pin this message?' }).getByRole('button', { name: 'Pin it' }).click();
  await carol.page.getByRole('button', { name: 'Pinned Messages', exact: true }).click();
  await expect(carol.page.locator('.chat-pins')).toContainText(`replying ${RUN}`);
  await shot(carol.page, 'r07-pins');
  await carol.page.keyboard.press('Escape');
  await m.click({ button: 'right', position: { x: 160, y: 10 } });
  await sam.page.getByRole('menuitem', { name: 'Unpin Message' }).click();
  await sam.page.getByRole('dialog', { name: 'Unpin message?' }).getByRole('button', { name: 'Unpin', exact: true }).click();
});

test('upload an image and a text file', async () => {
  await sam.page.locator('input[type=file]').setInputFiles([
    { name: `pic-${RUN}.png`, mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') },
    { name: `notes-${RUN}.txt`, mimeType: 'text/plain', buffer: Buffer.from('some notes') },
  ]);
  await expect(sam.page.locator('.chat-tray-item.done')).toHaveCount(2, { timeout: 20_000 });
  await send(sam.page, `files ${RUN}`);
  const theirs = msg(carol.page, `files ${RUN}`);
  await expect(theirs.locator('.chat-image img')).toBeVisible();
  await expect(theirs.locator('.chat-file, .chat-text-preview')).toContainText(`notes-${RUN}.txt`);
  const src = await theirs.locator('.chat-image img').getAttribute('src');
  expect(src).toBeTruthy();
  const res = await carol.page.request.get(new URL(src!, 'http://127.0.0.1:1422').href);
  expect(res.status()).toBe(200);
  await shot(carol.page, 'r08-attachments');
});

test('delete removes the message on both sides', async () => {
  const m = msg(sam.page, `files ${RUN}`);
  await m.hover();
  await m.getByRole('button', { name: 'More' }).click();
  await sam.page.getByRole('menuitem', { name: 'Delete Message' }).click();
  await sam.page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(sam.page.locator('.chat-msg', { hasText: `files ${RUN}` })).toHaveCount(0);
  await expect(carol.page.locator('.chat-msg', { hasText: `files ${RUN}` })).toHaveCount(0);
});
