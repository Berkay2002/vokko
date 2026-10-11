import { expect, test } from '@playwright/test';
import { composer, message, openDm, send } from './helpers';

test('send, edit, reply, react and delete against the mock backend', async ({ page }) => {
  await openDm(page);

  // send
  await send(page, 'hello from **e2e**');
  const sent = message(page, 'hello from e2e');
  await expect(sent).toBeVisible();
  await expect(sent.locator('strong')).toHaveText('e2e');
  await expect(sent).not.toHaveClass(/pending/);

  // edit: hover toolbar → Edit, change, Enter
  await sent.hover();
  await sent.getByRole('button', { name: 'Edit' }).click();
  const editor = page.getByLabel('Edit message');
  await editor.fill('hello edited');
  await editor.press('Enter');
  // The reply later embeds "hello edited" in its preview, so pin the locator to the message without a reply preview.
  const edited = page.locator('.chat-msg', { hasText: 'hello edited' }).filter({ hasNot: page.locator('.chat-reply') });
  await expect(edited).toBeVisible();
  await expect(edited.getByText('(edited)')).toBeVisible();

  // reply: own messages have Reply in the context menu (the hover toolbar shows it only on others' messages)
  await edited.click({ button: 'right', position: { x: 200, y: 10 } });
  await page.getByRole('menuitem', { name: 'Reply' }).click();
  await expect(page.locator('.chat-reply-bar')).toContainText('Replying to');
  await send(page, 'this is a reply');
  const reply = message(page, 'this is a reply');
  await expect(reply).toBeVisible();
  await expect(reply.locator('.chat-reply')).toContainText('hello edited');

  // react: quick reaction from the toolbar, pill shows count 1 and my state; click again removes it
  await edited.hover();
  await edited.getByRole('button', { name: 'React with 👍' }).click();
  const pill = edited.locator('.chat-reaction.me');
  await expect(pill).toContainText('1');
  await pill.click();
  await expect(edited.locator('.chat-reaction')).toHaveCount(0);

  // delete: More → Delete Message → confirm modal
  await reply.hover();
  await reply.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Delete Message' }).click();
  await expect(page.getByRole('dialog')).toContainText('Are you sure you want to delete this message?');
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('.chat-msg', { hasText: 'this is a reply' })).toHaveCount(0);
  await expect(composer(page)).toBeVisible();
});

test('upload limits show the Discord-style modals', async ({ page }) => {
  await openDm(page);
  const input = page.locator('input[type=file]');
  await input.setInputFiles({ name: 'huge.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(26 * 1024 * 1024) });
  await expect(page.getByRole('dialog')).toContainText('Your files are too powerful');
  await page.getByRole('button', { name: 'Okay' }).click();
  await expect(page.locator('.chat-tray-item')).toHaveCount(0);

  const files = Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.txt`, mimeType: 'text/plain', buffer: Buffer.from(`file ${i}`) }));
  await input.setInputFiles(files);
  await expect(page.getByRole('dialog')).toContainText('You can only upload 10 files at a time');
  await expect(page.locator('.chat-tray-item')).toHaveCount(10);
});

test('ArrowUp in an empty composer edits the last own message; empty edit asks to delete', async ({ page }) => {
  await openDm(page);
  await send(page, 'edit me with arrow up');
  await expect(message(page, 'edit me with arrow up')).toBeVisible();
  await composer(page).press('ArrowUp');
  const editor = page.getByLabel('Edit message');
  await expect(editor).toBeFocused();
  await editor.fill('');
  await editor.press('Enter');
  await expect(page.getByRole('dialog')).toContainText('Delete Message');
});
