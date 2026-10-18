import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import path from 'node:path';

// "Choose an image" (the avatar tile's picker): upload, Choose GIF and Recent avatars, against the mock backend.
// Screenshots: $env:VOKKO_SHOTS_DIR='<dir>'; npx playwright test -c e2e/profile-editor.config.ts profile-editor.avatar-picker.spec.ts

type Win = { __vokko: { appStore: { getState(): { me: { avatar: string | null } } } } };

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
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
}

const avatar = (page: Page) => page.evaluate(() => (window as unknown as Win).__vokko.appStore.getState().me.avatar);

async function save(editor: ReturnType<Page['getByRole']>) {
  const bar = editor.locator('.cs-savebar');
  await bar.getByRole('button', { name: 'Save Changes' }).click();
  await expect(bar).toHaveCount(0);
}

test('the card preview avatar menu opens the same picker', async ({ page }) => {
  const editor = await openEditor(page);
  await editor.getByRole('button', { name: 'Edit avatar' }).click();
  await page.getByRole('menuitem', { name: 'Change avatar', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Choose an image' });
  await expect(picker.getByRole('button', { name: 'Choose GIF' })).toBeEnabled();
  await expect(picker.getByRole('heading', { name: 'Recent avatars' })).toBeVisible();
});

test('the picker offers Upload image, Choose GIF and recent avatars, and nothing paid', async ({ page }) => {
  const editor = await openEditor(page);
  await editor.getByRole('button', { name: 'Avatar', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Choose an image' });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Upload image' })).toBeEnabled();
  await expect(picker.getByRole('button', { name: 'Choose GIF' })).toBeEnabled();
  await expect(picker.getByRole('heading', { name: 'Recent avatars' })).toBeVisible();
  await expect(picker).toContainText('Your last 6 avatar uploads');
  await expect(picker).toContainText('Avatars you set will show up here.');
  await expect(picker).not.toContainText(/nitro|upgrade|subscribe/i);
  await expect(picker.locator('.pe-pk-recent')).toHaveCount(0);
  await shot(page, 'avatar-picker-empty');
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
});

test('recent avatars list the last uploads newest first and set one again', async ({ page }) => {
  const editor = await openEditor(page);
  const urls: string[] = [];
  for (const [index, data] of PNGS.entries()) {
    await editor.getByTestId('pe-file-avatar').setInputFiles({ name: `a${index}.png`, mimeType: 'image/png', buffer: Buffer.from(data, 'base64') });
    await page.getByRole('dialog', { name: 'Edit Image' }).getByRole('button', { name: 'Apply' }).click();
    await save(editor);
    urls.push((await avatar(page)) ?? '');
  }
  expect(urls[0]).not.toBe(urls[1]);

  await editor.getByRole('button', { name: 'Avatar', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Choose an image' });
  await expect(picker.locator('.pe-pk-recent')).toHaveCount(2);
  await expect(picker.locator('.pe-pk-recent img').nth(0)).toHaveAttribute('src', urls[1]!);
  await expect(picker.locator('.pe-pk-recent img').nth(1)).toHaveAttribute('src', urls[0]!);
  await shot(page, 'avatar-picker-recent');

  await picker.getByRole('button', { name: 'Use recent avatar 2' }).click();
  await expect(picker).toHaveCount(0);
  await expect(editor.getByRole('button', { name: 'Avatar', exact: true }).locator('img')).toHaveAttribute('src', urls[0]!);
  await save(editor);
  expect(await avatar(page)).toBe(urls[0]);

  // setting it again moved it to the top
  await editor.getByRole('button', { name: 'Avatar', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Choose an image' }).locator('.pe-pk-recent img').nth(0)).toHaveAttribute('src', urls[0]!);
});

test('Choose GIF searches the GIF provider and stages the picked GIF as the avatar', async ({ page }) => {
  const editor = await openEditor(page);
  await editor.getByRole('button', { name: 'Avatar', exact: true }).click();
  await page.getByRole('dialog', { name: 'Choose an image' }).getByRole('button', { name: 'Choose GIF' }).click();
  const picker = page.getByRole('dialog', { name: 'Choose a GIF' });
  await expect(picker).toBeVisible();
  await picker.getByRole('textbox', { name: 'Search GIFs' }).fill('party');
  const first = picker.getByRole('button', { name: /^Use GIF as avatar: / }).first();
  await expect(first).toBeVisible();
  await shot(page, 'avatar-picker-gifs');
  await first.click();
  await expect(picker).toHaveCount(0);

  // staged like an upload: the tile and the card preview show it, Save claims it, and it heads the recent list
  const tile = editor.getByRole('button', { name: 'Avatar', exact: true }).locator('img');
  await expect(tile).toHaveAttribute('src', /^data:image\/svg\+xml/);
  await save(editor);
  expect(await avatar(page)).toMatch(/^data:image\/svg\+xml/);
  await editor.getByRole('button', { name: 'Avatar', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Choose an image' }).locator('.pe-pk-recent')).toHaveCount(1);
});
