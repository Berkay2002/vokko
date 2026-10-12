import { expect, test } from '@playwright/test';
import { stays } from './helpers';

// A full reload on the mock used to make the settings sync see "another account" (the seed users got new ids every load) and
// reset the device's theme: Onyx came back as Dark and the DM chat area rendered grey. Seed users now keep their ids per tab.

type StoreWin = { __vokko: { appStore: { getState(): { channels: Record<string, { id: string; name?: string; guild_id: string | null }> } } } };

test('Onyx survives visiting a channel, a forum and a voice channel and then reloading into a DM', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('vokko.prefs', JSON.stringify({ theme: 'onyx' })));
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  for (const name of ['general', 'support']) {
    const path = await page.evaluate(n => {
      const c = Object.values((window as unknown as StoreWin).__vokko.appStore.getState().channels).find(x => x.name === n && x.guild_id)!;
      return `/channels/${c.guild_id}/${c.id}`;
    }, name);
    await page.evaluate(p => { history.pushState({}, '', p); window.dispatchEvent(new PopStateEvent('popstate')); }, path);
    await page.locator('.channel-header').getByRole('heading', { name, exact: true }).waitFor();
  }
  await page.getByRole('button', { name: 'General voice channel' }).click();

  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: /^alice/i }).first().click();
  await page.locator('.chat-msg').first().waitFor();

  const chatBackground = () => page.locator('.chat-view').evaluate(el => getComputedStyle(el).backgroundColor);
  const htmlClass = () => page.evaluate(() => document.documentElement.classList.contains('theme-onyx'));
  // The settings fetch lands after first paint, so hold the check for a while instead of reading once.
  await stays(htmlClass, true);
  await stays(chatBackground, 'rgb(0, 0, 0)');
});
