import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const LABELS = [
  'Mint Apple', 'Citrus Sherbert', 'Retro Raincloud', 'Hanami', 'Sunrise', 'Cotton Candy', 'Lofi Vibes', 'Desert Khaki', 'Sunset',
  'Chroma Glow', 'Forest', 'Crimson', 'Midnight Blurple', 'Mars', 'Dusk', 'Under The Sea', 'Retro Storm', 'Neon Nights',
  'Strawberry Lemonade', 'Aurora', 'Sepia', 'Blurple Twilight',
];

const htmlClasses = (page: Page) => page.evaluate(() => document.documentElement.className);
const backgroundImage = (page: Page, selector: string) => page.locator(selector).first().evaluate(el => getComputedStyle(el).backgroundImage);

async function openAppearance(page: Page) {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  await page.getByRole('button', { name: 'User Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'User Settings' });
  await dialog.getByRole('button', { name: 'Appearance' }).click();
  await expect(dialog.getByRole('heading', { name: 'Colour themes', level: 2 })).toBeVisible();
  return dialog;
}

test('Colour themes sit above Community themes with all 22 gradients in picker order, each with a tooltip', async ({ page }) => {
  const dialog = await openAppearance(page);
  const headings = await dialog.getByRole('heading', { level: 2 }).allTextContents();
  expect(headings.indexOf('Colour themes')).toBeGreaterThanOrEqual(0);
  expect(headings.indexOf('Colour themes')).toBeLessThan(headings.indexOf('Community themes'));

  const group = dialog.getByRole('radiogroup', { name: 'Colour themes' });
  const swatches = group.locator('.theme-swatch');
  await expect(swatches).toHaveCount(22);
  expect(await swatches.evaluateAll(els => els.map(el => el.getAttribute('aria-label')))).toEqual(LABELS);
  expect(await swatches.evaluateAll(els => els.map(el => el.getAttribute('title')))).toEqual(LABELS);
  // a rounded square showing its own gradient
  const fill = swatches.nth(3).locator('.theme-swatch-fill');
  expect(await fill.evaluate(el => getComputedStyle(el).backgroundImage)).toContain('38.08deg');
  expect(await fill.evaluate(el => getComputedStyle(el).borderRadius)).not.toBe('50%');
});

test('picking Hanami survives a reload and paints the gradient on the app background', async ({ page }) => {
  const dialog = await openAppearance(page);
  await dialog.getByRole('radio', { name: 'Hanami' }).click();
  await expect(dialog.getByRole('radio', { name: 'Hanami' })).toHaveAttribute('aria-checked', 'true');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('vokko.prefs') ?? '{}').theme)).toBe('hanami');

  // the in-memory mock backend drops the session on reload: sign in again, the saved theme is what is under test
  await page.reload();
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().click();
  await page.locator('.chat-textarea').waitFor();

  const classes = await htmlClasses(page);
  expect(classes).toContain('custom-theme-background');
  expect(classes).toContain('theme-hanami');
  expect(classes).toContain('theme-light');
  expect(classes).not.toContain('theme-dark');

  // Discord's mechanism: the gradient is the app background, each pane a veil over it (white on a light base)
  for (const selector of ['.app-frame', '.sidebar', '.app-main']) {
    const image = await backgroundImage(page, selector);
    expect(image, selector).toContain('linear-gradient(38.08deg');
    expect(image, selector).toContain('rgb(239, 170, 179)'); // #efaab3, the first stop
    expect(image, selector).toContain('rgba(255, 255, 255,'); // the veil
  }
  expect(await page.locator('.app-main').evaluate(el => getComputedStyle(el).backgroundAttachment)).toContain('fixed');
});

test('a dark gradient veils with black; leaving gradient themes restores the solid background', async ({ page }) => {
  const dialog = await openAppearance(page);
  await dialog.getByRole('radio', { name: 'Sunset' }).click();
  expect(await htmlClasses(page)).toContain('custom-theme-background');
  expect(await htmlClasses(page)).toContain('theme-dark');
  const image = await backgroundImage(page, '.app-frame');
  expect(image).toContain('linear-gradient(141.68deg');
  expect(image).toContain('rgba(0, 0, 0,');

  await dialog.getByRole('radio', { name: 'Dark', exact: true }).click();
  expect(await htmlClasses(page)).not.toContain('custom-theme-background');
  expect(await backgroundImage(page, '.app-frame')).toBe('none');
});

test('hovering or focusing a gradient swatch previews it; leaving and Esc put the saved theme back', async ({ page }) => {
  const dialog = await openAppearance(page);
  const saved = await htmlClasses(page);
  expect(saved).not.toContain('custom-theme-background');

  const aurora = dialog.getByRole('radio', { name: 'Aurora' });
  await aurora.hover();
  await expect.poll(() => htmlClasses(page)).toContain('theme-aurora');
  expect(await htmlClasses(page)).toContain('custom-theme-background');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('vokko.prefs') ?? '{}').theme)).not.toBe('aurora');

  await page.mouse.move(2, 2);
  await expect.poll(() => htmlClasses(page)).not.toContain('theme-aurora');
  expect(await htmlClasses(page)).not.toContain('custom-theme-background');

  await aurora.focus();
  await expect.poll(() => htmlClasses(page)).toContain('theme-aurora');
  await page.keyboard.press('Escape');
  await expect.poll(() => htmlClasses(page)).not.toContain('theme-aurora');
  expect(await htmlClasses(page)).not.toContain('custom-theme-background');
});
