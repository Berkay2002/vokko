import { expect, test } from '@playwright/test';
import path from 'node:path';

// Profile editor screenshots for review (mock seed users only).
// $env:VOKKO_SHOTS_DIR='../../.private/artifacts/profile-editor'; npx playwright test -c e2e/profile-editor.config.ts profile-editor.shots.spec.ts
const dir = process.env.VOKKO_SHOTS_DIR;
test.skip(!dir, 'set VOKKO_SHOTS_DIR to capture screenshots');

test('profile editor screenshots', async ({ page }) => {
  const shot = async (name: string) => {
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(dir!, `${name}.png`) });
  };
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  await page.getByRole('button', { name: 'User Settings' }).click();
  await page.getByRole('dialog', { name: 'User Settings' }).locator('.sm-profile-edit').click();
  const editor = page.getByRole('dialog', { name: 'Edit Profile' });
  await expect(editor).toBeVisible();
  await shot('01-editor-top');

  // widgets on the board
  await editor.getByRole('button', { name: 'Add widget' }).click();
  await page.getByRole('menuitem', { name: 'Favourite game' }).click();
  await editor.getByRole('textbox', { name: 'Favourite game name' }).fill('Hades');
  await editor.getByRole('textbox', { name: "Why it's your favourite" }).fill('Every run feels different.');
  await editor.getByRole('textbox', { name: 'Add a tag' }).fill('roguelike');
  await page.keyboard.press('Enter');
  await editor.getByRole('button', { name: 'Add widget' }).click();
  await page.getByRole('menuitem', { name: 'Games I like' }).click();
  for (const game of ['Celeste', 'Hollow Knight', 'Outer Wilds']) {
    await editor.getByRole('button', { name: 'Add a game' }).click();
    await editor.getByRole('textbox', { name: 'Game name', exact: true }).fill(game);
    await page.keyboard.press('Enter');
  }
  await shot('02-board-widgets');

  // left column scrolled to the bottom with the theme panel open
  await editor.getByRole('button', { name: 'Profile theme' }).click();
  await editor.locator('.pe-left-body').evaluate(el => el.scrollTo({ top: el.scrollHeight }));
  await shot('03-left-column-scrolled');

  // avatar menu
  await editor.getByRole('button', { name: 'Edit avatar' }).click();
  await shot('04-avatar-menu');
  await page.keyboard.press('Escape');

  // inline display name edit
  await editor.getByRole('button', { name: 'Edit Display name' }).click();
  await shot('05-inline-name-edit');
  await page.keyboard.press('Escape');

  // profile switcher
  await editor.locator('.pe-switcher').click();
  await shot('06-profile-switcher');
});
