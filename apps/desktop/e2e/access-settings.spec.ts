import { expect, test, type Page } from '@playwright/test';

// Server Settings > Access and the age gate against the in-memory mock (sam owns "Sam's server").

type Ch = { id: string; name?: string; guild_id: string | null; type: number };
type StoreWin = { __vokko: { appStore: { getState(): { channels: Record<string, Ch>; upsertChannel(c: unknown): void } } } };

async function start(page: Page): Promise<void> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.waitForFunction(() => Object.values((window as unknown as StoreWin).__vokko.appStore.getState().channels).some(c => c.name === 'general' && c.guild_id));
}

async function openChannel(page: Page, name: string): Promise<void> {
  const target = await page.evaluate(n => {
    const c = Object.values((window as unknown as StoreWin).__vokko.appStore.getState().channels).find(x => x.name === n && x.guild_id)!;
    return `/channels/${c.guild_id}/${c.id}`;
  }, name);
  await page.evaluate(path => { history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, target);
}

async function openAccess(page: Page): Promise<void> {
  await page.locator('.guild-header-name-button').click();
  await page.getByRole('menuitem', { name: 'Server Settings' }).click();
  await page.getByRole('button', { name: 'Access', exact: true }).click();
}

test('age-restricted server and rules channel are saved, and the gate shows once', async ({ page }) => {
  await start(page);
  await openChannel(page, 'general');
  await openAccess(page);
  await expect(page.getByRole('radio', { name: /Invite Only/ })).toBeChecked();
  // No server discovery yet: neither the Access option nor the rail's Explore button is offered.
  await expect(page.getByRole('radio', { name: /Discoverable/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Explore Discoverable Servers' })).toHaveCount(0);
  await page.getByRole('switch', { name: 'Age-Restricted Server' }).click();
  await page.getByRole('combobox', { name: 'Rules channel' }).click();
  await page.getByRole('option', { name: '# general' }).click();
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.getByRole('switch', { name: 'Age-Restricted Server' })).toBeChecked();

  await page.getByRole('dialog', { name: 'Server Settings' }).getByRole('button', { name: 'Close' }).click();
  await openAccess(page);
  await expect(page.getByRole('switch', { name: 'Age-Restricted Server' })).toBeChecked();
  await expect(page.getByRole('combobox', { name: 'Rules channel' })).toContainText('general');
  await page.getByRole('dialog', { name: 'Server Settings' }).getByRole('button', { name: 'Close' }).click();

  const gate = page.getByRole('region', { name: 'Age-Restricted Server' });
  await expect(gate).toBeVisible();
  await gate.getByRole('button', { name: 'Nevermind' }).click();
  await expect(page).toHaveURL(/\/channels\/@me/);
  // the URL changes before React commits the home view: reopening now would leave the old gate (and its focus) mounted
  await expect(gate).toHaveCount(0);

  await openChannel(page, 'general');
  await expect(gate).toBeVisible();
  await expect(gate.getByRole('button', { name: 'Continue' })).toBeFocused();
  await gate.getByRole('button', { name: 'Continue' }).click();
  await expect(gate).toHaveCount(0);
  await expect(page.locator('.chat-view')).toBeVisible();

  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.waitForFunction(() => Object.values((window as unknown as StoreWin).__vokko.appStore.getState().channels).some(c => c.name === 'general' && c.guild_id));
  await openChannel(page, 'general');
  await expect(page.locator('.chat-view')).toBeVisible();
  await expect(gate).toHaveCount(0);
});

test('an nsfw channel alone gates', async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    const store = (window as unknown as StoreWin).__vokko.appStore;
    const c = Object.values(store.getState().channels).find(x => x.name === 'general' && x.guild_id)!;
    store.getState().upsertChannel({ ...c, nsfw: true, topic: 'secret topic' });
  });
  await openChannel(page, 'general');
  const gate = page.getByRole('region', { name: 'Age-Restricted Channel' });
  await expect(gate).toBeVisible();
  const header = page.locator('.channel-header');
  await expect(header.getByRole('heading')).toBeVisible();
  await expect(header.getByRole('button', { name: 'Pinned Messages' })).toHaveCount(0);
  await expect(header.getByRole('button', { name: 'Threads' })).toHaveCount(0);
  await expect(header.getByLabel('Search')).toHaveCount(0);
  await expect(header.locator('.channel-header-topic')).toHaveCount(0);
  await gate.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('.chat-view')).toBeVisible();
  await expect(header.getByRole('button', { name: 'Pinned Messages' })).toBeVisible();
  await expect(header.getByRole('button', { name: 'Threads' })).toBeVisible();
  await expect(header.locator('.channel-header-topic')).toHaveText('secret topic');
});
