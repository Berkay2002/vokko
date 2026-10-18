import { expect, test, type Page } from '@playwright/test';
import { openStockTalk } from './helpers';

// Set VOKKO_SHOTS to a directory to also save screenshots there.
const SHOTS = process.env.VOKKO_SHOTS;
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };

const NOTES = Array.from({ length: 30 }, (_, i) => `note line ${i + 1}`).join('\n');
const CODE = `use std::fs;
use std::io;

/// Reads a file and prints it.
fn main() -> io::Result<()> {
    let content = fs::read_to_string("hello.txt")?;
    println!("{}", content);
    Ok(())
}
`;

async function sendFiles(page: Page) {
  await openStockTalk(page);
  await page.locator('input[type=file]').setInputFiles([
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from(NOTES) },
    { name: 'code.rs', mimeType: '', buffer: Buffer.from(CODE) },
  ]);
  await expect(page.locator('.chat-tray-item.uploading')).toHaveCount(0);
  const box = page.getByRole('textbox', { name: /Message #stock-talk/ });
  await box.fill('two text files');
  await page.keyboard.press('Enter');
  const msg = page.locator('.chat-msg').filter({ has: page.locator('.chat-content', { hasText: 'two text files' }) }).last();
  await expect(msg).not.toHaveClass(/pending/);
  return msg;
}

test('text and code attachments preview inline: collapse/expand, whole-file modal, download', async ({ page }) => {
  const msg = await sendFiles(page);
  const previews = msg.locator('.chat-text-preview');
  await expect(previews).toHaveCount(2);
  const notes = previews.filter({ hasText: 'notes.txt' });
  const code = previews.filter({ hasText: 'code.rs' });

  // collapsed: the first 6 lines, Rust highlighted
  const notesCode = notes.getByLabel('Preview of notes.txt');
  await expect(notesCode).toContainText('note line 6');
  await expect(notesCode).not.toContainText('note line 7');
  await expect(code.locator('.hljs-keyword').first()).toHaveText('use');
  await msg.scrollIntoViewIfNeeded();
  await shot(page, 'collapsed-1440');

  // expand / collapse
  await notes.getByRole('button', { name: 'Expand' }).click();
  await expect(notesCode).toContainText('note line 30');
  await notes.getByRole('button', { name: 'Collapse' }).click();
  await expect(notesCode).not.toContainText('note line 7');

  // view whole file: modal with line numbers
  await code.getByRole('button', { name: 'View whole file' }).click();
  const dialog = page.getByRole('dialog', { name: 'code.rs' });
  await expect(dialog.getByRole('region', { name: 'Contents of code.rs' })).toContainText('Ok(())');
  await expect(dialog.locator('.chat-text-modal-gutter')).toHaveText(Array.from({ length: 9 }, (_, i) => i + 1).join('\n'));
  await page.waitForTimeout(300); // modal-in animation
  await shot(page, 'modal-1440');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // download keeps the file name
  const download = page.waitForEvent('download');
  await code.getByRole('link', { name: 'Download code.rs' }).click();
  expect((await download).suggestedFilename()).toBe('code.rs');
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  test('preview fits the phone width', async ({ page }) => {
    test.skip(!SHOTS, 'screenshots only');
    await page.setViewportSize({ width: 1440, height: 900 }); // send from the desktop layout, then shrink
    const msg = await sendFiles(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(msg.locator('.chat-text-preview')).toHaveCount(2);
    await msg.locator('.chat-text-preview').first().scrollIntoViewIfNeeded();
    await shot(page, 'collapsed-390');
  });
});
