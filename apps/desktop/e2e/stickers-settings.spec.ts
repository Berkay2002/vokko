import { expect, test } from '@playwright/test';

// Server Settings > Stickers against the in-memory mock (sam owns "Sam's server", seeded with three stickers).

type StoreWin = { __vokko: { appStore: { getState(): { channels: Record<string, { id: string; name?: string; guild_id: string | null }> } } } };

// 1x1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

test('upload, edit and delete a sticker in Server Settings', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.waitForFunction(() => Object.values((window as unknown as StoreWin).__vokko.appStore.getState().channels).some(c => c.name === 'general' && c.guild_id));
  const target = await page.evaluate(() => {
    const c = Object.values((window as unknown as StoreWin).__vokko.appStore.getState().channels).find(x => x.name === 'general' && x.guild_id)!;
    return `/channels/${c.guild_id}/${c.id}`;
  });
  await page.evaluate(path => { history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, target);
  await page.locator('.guild-header-name-button').click();
  await page.getByRole('menuitem', { name: 'Server Settings' }).click();
  await page.getByRole('button', { name: 'Stickers', exact: true }).click();
  const settings = page.locator('.emoji-settings');
  const list = settings.getByRole('region', { name: 'Stickers' });
  await expect(list.locator('li')).toHaveCount(3);
  await expect(list.getByRole('heading')).toContainText('3 of 60');

  await expect(settings.locator('input[type=file]')).toBeHidden(); // an Upload button, not the native file control
  const shots = process.env.VOKKO_SHOTS;
  if (shots) await page.screenshot({ path: `${shots}/stickers-1440.png` });
  await settings.getByLabel('Sticker file').setInputFiles({ name: 'probe.png', mimeType: 'image/png', buffer: PNG });
  if (shots) {
    await page.screenshot({ path: `${shots}/stickers-picked-1440.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${shots}/stickers-picked-390.png` });
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  await settings.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(settings.getByRole('alert')).toHaveText('The name must be 2-30 characters.'); // checked before anything is uploaded
  await settings.getByLabel('Sticker name').fill('probe');
  await settings.getByLabel('Sticker tags').fill('test,probe');
  await settings.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(list.locator('li', { hasText: 'probe' })).toHaveCount(1);
  await expect(list.getByRole('heading')).toContainText('4 of 60');

  await list.getByRole('button', { name: 'Edit probe' }).click();
  await expect(list.getByLabel('Name of probe')).toBeFocused();
  await list.getByLabel('Name of probe').fill('probe2');
  await list.getByLabel('Description of probe').fill('a test sticker');
  await list.getByRole('button', { name: 'Save' }).click();
  await expect(list.locator('li', { hasText: 'probe2' })).toContainText('a test sticker');
  // clearing the description sends null
  await list.getByRole('button', { name: 'Edit probe2' }).click();
  await list.getByLabel('Description of probe2').fill('');
  await list.getByRole('button', { name: 'Save' }).click();
  await expect(list.locator('li', { hasText: 'probe2' })).not.toContainText('a test sticker');

  // Escape on the confirm cancels it; focus sits on it so the keyboard can answer
  await list.getByRole('button', { name: 'Delete probe2' }).click();
  await expect(list.getByRole('button', { name: 'Confirm delete probe2' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(list.getByRole('button', { name: 'Confirm delete probe2' })).toHaveCount(0);

  await list.getByRole('button', { name: 'Delete probe2' }).click();
  await list.getByRole('button', { name: 'Confirm delete probe2' }).click();
  await expect(list.locator('li')).toHaveCount(3);
  await expect(list.locator('li', { hasText: 'probe2' })).toHaveCount(0);
});
