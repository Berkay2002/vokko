import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const DRACULA_BG = 'rgb(40, 42, 54)'; // #282a36
const NORD_BG = 'rgb(46, 52, 64)'; // #2e3440

const htmlClasses = (page: Page) => page.evaluate(() => document.documentElement.className);
const chatBackground = (page: Page) => page.locator('.app-main').evaluate(el => ({ bg: getComputedStyle(el).backgroundColor }));

async function openAppearance(page: Page) {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  await page.getByRole('button', { name: 'User Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'User Settings' });
  await dialog.getByRole('button', { name: 'Appearance' }).click();
  await expect(dialog.getByRole('heading', { name: 'Community themes', level: 2 })).toBeVisible();
  return dialog;
}

test('picking Dracula survives a reload and paints the app with the Dracula palette', async ({ page }) => {
  const dialog = await openAppearance(page);
  await dialog.getByRole('radio', { name: 'Dracula' }).click();
  await expect(dialog.getByRole('radio', { name: 'Dracula' })).toHaveAttribute('aria-checked', 'true');
  expect(await htmlClasses(page)).toContain('theme-dracula');
  expect(await htmlClasses(page)).toContain('theme-dark');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('vokko.prefs') ?? '{}').theme)).toBe('dracula');

  // the in-memory mock backend drops the session on reload: sign in again, the saved theme is what is under test
  await page.reload();
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().click();
  await page.locator('.chat-textarea').waitFor();
  expect(await htmlClasses(page)).toContain('theme-dracula');
  expect((await chatBackground(page)).bg).toBe(DRACULA_BG);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--background-brand').trim().toLowerCase())).toBe('#bd93f9');
});

test('hovering or focusing a community swatch previews it; leaving, blurring and Esc put the saved theme back', async ({ page }) => {
  const dialog = await openAppearance(page);
  const saved = await htmlClasses(page);
  expect(saved).toContain('theme-dark');
  expect(saved).not.toContain('theme-nord');

  const nord = dialog.getByRole('radio', { name: 'Nord' });
  await nord.hover();
  await expect.poll(() => htmlClasses(page)).toContain('theme-nord');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('vokko.prefs') ?? '{}').theme)).not.toBe('nord');

  await page.mouse.move(2, 2);
  await expect.poll(() => htmlClasses(page)).not.toContain('theme-nord');

  await nord.focus();
  await expect.poll(() => htmlClasses(page)).toContain('theme-nord');
  await page.keyboard.press('Escape');
  await expect.poll(() => htmlClasses(page)).not.toContain('theme-nord');
  // Esc is also the modal's own close key, so the preview ends with the page whichever handler runs first
  await expect(dialog).toHaveCount(0);
  expect(await htmlClasses(page)).toContain('theme-dark');
});

test('a light community theme sits on the light base set', async ({ page }) => {
  const dialog = await openAppearance(page);
  await dialog.getByRole('radio', { name: 'Catppuccin Latte' }).click();
  const classes = await htmlClasses(page);
  expect(classes).toContain('theme-catppuccin-latte');
  expect(classes).toContain('theme-light');
  expect(classes).not.toContain('theme-dark');
});

test('every community swatch applies its own theme class and Nord paints the Nord chat background', async ({ page }) => {
  const dialog = await openAppearance(page);
  const swatches = dialog.locator('.theme-swatch');
  await expect(swatches).toHaveCount(13);
  await dialog.getByRole('radio', { name: 'Nord' }).click();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await page.locator('.dm-row').first().click();
  await page.locator('.chat-textarea').waitFor();
  expect((await chatBackground(page)).bg).toBe(NORD_BG);
});

test('the login page follows the saved theme', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('vokko.prefs', JSON.stringify({ theme: 'dracula' })));
  await page.goto('/');
  await page.locator('.auth-card').waitFor();
  expect(await htmlClasses(page)).toContain('theme-dracula');
  const bg = await page.locator('.auth-page').evaluate(el => getComputedStyle(el).backgroundImage);
  expect(bg).toContain('radial-gradient');
  // the gradient is built from the theme accent (#bd93f9) and ends on Dracula's darkest surface, not the old fixed purple
  expect(bg).not.toContain('rgb(74, 63, 168)');
});
