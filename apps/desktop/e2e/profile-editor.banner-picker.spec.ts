import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import path from 'node:path';

// "Choose an image" for the banner (the banner tile and the card's banner menu): upload, Choose GIF and Recent banners, and an animated
// banner on the card, against the mock backend.
// Screenshots: $env:VOKKO_SHOTS_DIR='<dir>'; npx playwright test profile-editor.banner-picker.spec.ts

type Win = { __vokko: { appStore: { getState(): { me: { banner?: string | null; avatar: string | null } } } } };

const dir = process.env.VOKKO_SHOTS_DIR;
// 1x1 PNGs of two colours, so the two uploads are different files
const PNGS = [
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
];

async function openEditor(page: Page) {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  await page.getByRole('button', { name: 'User Settings' }).click();
  await page.getByRole('dialog', { name: 'User Settings' }).locator('.sm-profile-edit').click();
  const editor = page.getByRole('dialog', { name: 'Edit Profile' });
  await expect(editor).toBeVisible();
  return editor;
}

/** Screenshot for review when VOKKO_SHOTS_DIR is set, after the modal's fade-in. */
async function shot(page: Page, name: string) {
  if (!dir) return;
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
}

const banner = (page: Page) => page.evaluate(() => (window as unknown as Win).__vokko.appStore.getState().me.banner ?? null);

async function save(editor: ReturnType<Page['getByRole']>) {
  const bar = editor.locator('.cs-savebar');
  await bar.getByRole('button', { name: 'Save Changes' }).click();
  await expect(bar).toHaveCount(0);
}

test('the banner tile and the card banner menu open the same Choose an image modal', async ({ page }) => {
  const editor = await openEditor(page);
  await editor.getByRole('button', { name: 'Profile banner' }).click();
  const picker = page.getByRole('dialog', { name: 'Choose an image' });
  await expect(picker.getByRole('button', { name: 'Upload image' })).toBeEnabled();
  await expect(picker.getByRole('button', { name: 'Choose GIF' })).toBeEnabled();
  await expect(picker.getByRole('heading', { name: 'Recent banners' })).toBeVisible();
  await expect(picker).toContainText('Your last 6 banner uploads');
  await expect(picker).toContainText('Banners you set will show up here.');
  await expect(picker).not.toContainText(/nitro|upgrade|subscribe/i);
  await shot(page, 'banner-picker-empty');
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);

  await editor.getByRole('button', { name: 'Edit banner' }).click();
  await page.getByRole('menuitem', { name: 'Change banner', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Choose an image' }).getByRole('heading', { name: 'Recent banners' })).toBeVisible();
});

test('Upload image from the picker stages a file; recent banners list the last uploads newest first and set one again', async ({ page }) => {
  const editor = await openEditor(page);
  const urls: string[] = [];
  for (const [index, data] of PNGS.entries()) {
    await editor.getByTestId('pe-file-profile-banner').setInputFiles({ name: `b${index}.png`, mimeType: 'image/png', buffer: Buffer.from(data, 'base64') });
    await page.getByRole('dialog', { name: 'Edit Image' }).getByRole('button', { name: 'Apply' }).click();
    await save(editor);
    urls.push((await banner(page)) ?? '');
  }
  expect(urls[0]).not.toBe(urls[1]);

  await editor.getByRole('button', { name: 'Profile banner' }).click();
  const picker = page.getByRole('dialog', { name: 'Choose an image' });
  await expect(picker.locator('.pe-pk-recent')).toHaveCount(2);
  await expect(picker.locator('.pe-pk-recent img').nth(0)).toHaveAttribute('src', urls[1]!);
  await expect(picker.locator('.pe-pk-recent img').nth(1)).toHaveAttribute('src', urls[0]!);
  await shot(page, 'banner-picker-recent');

  await picker.getByRole('button', { name: 'Use recent banner 2' }).click();
  await expect(picker).toHaveCount(0);
  await save(editor);
  expect(await banner(page)).toBe(urls[0]);
  await editor.getByRole('button', { name: 'Profile banner' }).click();
  await expect(page.getByRole('dialog', { name: 'Choose an image' }).locator('.pe-pk-recent img').nth(0)).toHaveAttribute('src', urls[0]!);
  await page.keyboard.press('Escape');

  // Upload image closes the modal and opens the file chooser
  await editor.getByRole('button', { name: 'Profile banner' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('dialog', { name: 'Choose an image' }).getByRole('button', { name: 'Upload image' }).click();
  await chooser;
  await expect(page.getByRole('dialog', { name: 'Choose an image' })).toHaveCount(0);
});

test('Choose GIF stages the picked GIF as an animated banner that holds still under reduced motion and plays on hover', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const editor = await openEditor(page);
  await editor.getByRole('button', { name: 'Profile banner' }).click();
  await page.getByRole('dialog', { name: 'Choose an image' }).getByRole('button', { name: 'Choose GIF' }).click();
  const picker = page.getByRole('dialog', { name: 'Choose a GIF' });
  await picker.getByRole('textbox', { name: 'Search GIFs' }).fill('party');
  const first = picker.getByRole('button', { name: /^Use GIF as banner: / }).first();
  await expect(first).toBeVisible();
  await shot(page, 'banner-picker-gifs');
  await first.click();
  await expect(picker).toHaveCount(0);

  // staged like an upload: the card shows it as an animated image; under reduced motion that is its first frame until the pointer is on it
  const card = editor.getByTestId('pe-card').locator('.pe-card-banner');
  await expect(card.locator('canvas.pv-banner-img')).toBeVisible();
  await card.hover({ position: { x: 200, y: 40 } });
  await expect(card.locator('img.pv-banner-img')).toHaveAttribute('src', /^data:image\/svg\+xml.*\.gif$/);
  await expect(card.locator('canvas.pv-banner-img')).toHaveCount(0);
  await page.mouse.move(5, 5);
  await expect(card.locator('canvas.pv-banner-img')).toBeVisible();

  await save(editor);
  expect(await banner(page)).toMatch(/^data:image\/svg\+xml.*banner\.gif$/);
  await editor.getByRole('button', { name: 'Profile banner' }).click();
  await expect(page.getByRole('dialog', { name: 'Choose an image' }).locator('.pe-pk-recent')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await page.mouse.move(5, 5);
  await shot(page, 'banner-card-animated');
});
