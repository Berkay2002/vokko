import { expect, test, type Page } from '@playwright/test';

// Server Settings > Enable Community against the in-memory mock (sam owns "Sam's server"): wizard, overview, disable.

type Ch = { id: string; name?: string; guild_id: string | null };
type StoreWin = { __vokko: { appStore: { getState(): { channels: Record<string, Ch> } } } };

async function openCommunity(page: Page): Promise<void> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.waitForFunction(() => Object.values((window as unknown as StoreWin).__vokko.appStore.getState().channels).some(c => c.name === 'general' && c.guild_id));
  const target = await page.evaluate(() => {
    const c = Object.values((window as unknown as StoreWin).__vokko.appStore.getState().channels).find(x => x.name === 'general' && x.guild_id)!;
    return `/channels/${c.guild_id}/${c.id}`;
  });
  await page.evaluate(path => { history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, target);
  await page.locator('.guild-header-name-button').click();
  await page.getByRole('menuitem', { name: 'Server Settings' }).click();
  await page.getByRole('button', { name: 'Enable Community' }).first().click();
}

test('the wizard enables Community, the overview edits channels, Disable turns it off', async ({ page }) => {
  await openCommunity(page);
  const shot = process.env.COMMUNITY_SHOTS;
  const snap = async (name: string) => shot && (await page.screenshot({ path: `${shot}/${name}-${page.viewportSize()?.width}.png` }));
  await expect(page.getByRole('heading', { name: 'Are you building a community?' })).toBeVisible();
  await snap('1-pitch');
  await page.getByRole('button', { name: 'Enable Community' }).last().click();
  await expect(page.getByText('Verification level will be set to Low.')).toBeVisible();
  await snap('2-safety');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('combobox', { name: 'Rules channel' })).toContainText('Create a new channel');
  await snap('3-channels');
  await page.getByRole('button', { name: 'Enable Community' }).last().click();
  await expect(page.getByRole('heading', { name: 'Community Overview' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Rules or guidelines channel' })).toContainText('rules');
  await expect(page.getByRole('combobox', { name: 'Community updates channel' })).toContainText('community-updates');
  await snap('4-overview');
  await page.getByRole('button', { name: 'Disable Community' }).click();
  await page.getByRole('button', { name: 'Yes, disable Community' }).click();
  await expect(page.getByRole('heading', { name: 'Are you building a community?' })).toBeVisible();
});
