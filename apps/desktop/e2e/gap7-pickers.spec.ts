import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

// gap-audit-7 group C against the mock backend: GIF Recent, sticker Favorites and Recent. Screenshots go to $VOKKO_SHOTS_DIR when set.
// Run: npx playwright test -c e2e/gap7-pickers.config.ts --workers=1

const SHOTS = process.env.VOKKO_SHOTS_DIR;
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

type StoreWin = { __vokko: { appStore: { getState(): { channels: Record<string, { id: string; name?: string; guild_id: string | null }> } } } };

const VIEWPORTS = [
  { name: '1440', size: { width: 1440, height: 900 } },
  { name: '390', size: { width: 390, height: 844 } },
] as const;

async function openGeneral(page: Page): Promise<void> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.waitForFunction(() => Object.values((window as unknown as StoreWin).__vokko.appStore.getState().channels).some(c => c.name === 'general' && c.guild_id));
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.getByRole('list', { name: 'Channels' }).getByRole('link', { name: /^general\b/ }).first().click(); // the phone shows the channel list first
  await page.locator('.chat-textarea').waitFor();
}

/** The phone has no GIF or sticker button: its picker opens from the emoji button and switches tabs. */
async function openPicker(page: Page, tab: 'GIFs' | 'Stickers') {
  await page.getByRole('button', { name: 'Select emoji' }).click();
  await page.getByRole('tab', { name: tab }).click();
}

for (const vp of VIEWPORTS) {
  test.describe(vp.name, () => {
    test.use({ viewport: vp.size });

    test('sticker picker: star a sticker for Favorites, a sent one lands in Recent, the star is a tab stop', async ({ page }) => {
      await openGeneral(page);
      await openPicker(page, 'Stickers');
      const picker = page.locator('.chat-expression-picker');
      await expect(picker.getByRole('region', { name: 'Favorites' })).toHaveCount(0);
      await expect(picker.getByRole('region', { name: 'Recent' })).toHaveCount(0);

      // The star is the next tab stop after its sticker.
      const first = picker.locator('.media-sticker-item').first();
      const name = (await first.locator('.media-sticker-cell').getAttribute('aria-label'))!;
      await first.locator('.media-sticker-cell').focus();
      await page.keyboard.press('Tab');
      await expect(first.getByRole('button', { name: `Add ${name} to favorites` })).toBeFocused();
      await page.keyboard.press('Enter');
      const favorites = picker.getByRole('region', { name: 'Favorites' });
      await expect(favorites.getByRole('button', { name, exact: true })).toHaveCount(1);
      await expect(favorites.getByRole('button', { name: `Remove ${name} from favorites` })).toHaveAttribute('aria-pressed', 'true');
      await shot(page, `stickers-favorites-${vp.name}`);

      // Sending one puts it in Recent; the picker closes after a send, so open it again.
      await favorites.getByRole('button', { name, exact: true }).click();
      await expect(page.locator('.chat-msg').last().locator('img').first()).toBeVisible();
      await openPicker(page, 'Stickers');
      await expect(picker.getByRole('region', { name: 'Recent' }).getByRole('button', { name, exact: true })).toHaveCount(1);
      await shot(page, `stickers-recent-${vp.name}`);

      // A search shows results only; unstarring removes the Favorites row.
      await picker.getByLabel('Search stickers').fill(name.slice(0, 3));
      await expect(picker.getByRole('region', { name: 'Favorites' })).toHaveCount(0);
      await picker.getByLabel('Clear search').click();
      await picker.getByRole('region', { name: 'Favorites' }).getByRole('button', { name: `Remove ${name} from favorites` }).click();
      await expect(picker.getByRole('region', { name: 'Favorites' })).toHaveCount(0);
    });

    test('GIF picker: a sent GIF shows up under Recent', async ({ page }) => {
      await openGeneral(page);
      await openPicker(page, 'GIFs');
      const picker = page.locator('.chat-expression-picker');
      await expect(picker.getByRole('button', { name: 'Trending GIFs' })).toBeVisible();
      await expect(picker.getByRole('button', { name: 'Recent' })).toHaveCount(0);
      await picker.getByRole('button', { name: 'Trending GIFs' }).click();
      const gif = picker.locator('.media-gif-pick').first();
      const label = (await gif.getAttribute('aria-label'))!;
      await gif.click();

      await openPicker(page, 'GIFs');
      await shot(page, `gif-home-${vp.name}`);
      await picker.getByRole('button', { name: 'Recent' }).click();
      await expect(picker.locator('.media-panel-title')).toHaveText('Recent');
      await expect(picker.getByRole('button', { name: label })).toHaveCount(1);
      // the existing star is still there and reachable
      await expect(picker.locator('.media-gif-star').first()).toHaveAttribute('aria-pressed', 'false');
      await shot(page, `gif-recent-${vp.name}`);
    });
  });
}
