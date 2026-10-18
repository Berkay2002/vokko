import { expect, test, type Page } from '@playwright/test';

// Server Settings > Server Template against the in-memory mock (sam owns "Sam's server"): generate, sync when dirty,
// preview on /template/:code, create a server from it, and the Create Your Server modal's template code entry.

type Ch = { id: string; name?: string; guild_id: string | null };
type StoreWin = { __vokko: { appStore: { getState(): { channels: Record<string, Ch>; guilds: Record<string, { name: string }> } } } };

const shots = process.env.TEMPLATE_SHOTS;
if (process.env.TEMPLATE_PHONE) test.use({ viewport: { width: 390, height: 844 } });
const snap = async (page: Page, name: string) => shots && (await page.screenshot({ path: `${shots}/${name}-${page.viewportSize()?.width}.png` }));

async function openTemplateSettings(page: Page): Promise<void> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.waitForFunction(() => Object.values((window as unknown as StoreWin).__vokko.appStore.getState().channels).some(c => c.name === 'general' && c.guild_id));
  const target = await page.evaluate(() => {
    const c = Object.values((window as unknown as StoreWin).__vokko.appStore.getState().channels).find(x => x.name === 'general' && x.guild_id)!;
    return `/channels/${c.guild_id}/${c.id}`;
  });
  await page.evaluate(path => { history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, target);
  await page.locator('.guild-header-name-button').click();
  await page.getByRole('menuitem', { name: 'Server Settings' }).click();
  await page.getByRole('button', { name: 'Server Template' }).first().click();
}

test('generate, sync, preview and use a server template', async ({ page }) => {
  await openTemplateSettings(page);
  await expect(page.getByText('Templates will copy:')).toBeVisible();
  await page.getByRole('textbox', { name: 'Template Title' }).fill('Sam Club');
  await page.getByRole('textbox', { name: 'Template Description' }).fill('A place for spell nerds');
  await snap(page, '1-generate');
  await page.getByRole('button', { name: 'Generate Template' }).click();
  const link = page.getByRole('textbox', { name: 'Template link' });
  await expect(link).toHaveValue(/\/template\/[A-Za-z0-9]{12}$/);
  const code = (await link.inputValue()).split('/').pop()!;
  await expect(page.getByText('This template has unsynced changes.')).toHaveCount(0);

  // Editing the title shows the save bar.
  await page.getByRole('textbox', { name: 'Template Title' }).fill('Sam Club 2');
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.getByRole('button', { name: 'Save Changes' })).toHaveCount(0);

  // A change to the server makes the template dirty; Sync clears it.
  await page.evaluate(async () => {
    const w = window as unknown as StoreWin & { __vokko: { request(method: string, path: string, body?: unknown): Promise<unknown> } };
    const general = Object.values(w.__vokko.appStore.getState().channels).find(x => x.name === 'general' && x.guild_id)!;
    await w.__vokko.request('PATCH', `/channels/${general.id}`, { topic: 'spells only' });
  });
  await expect(page.getByText('This template has unsynced changes.')).toBeVisible();
  await snap(page, '2-unsynced');
  await page.getByRole('button', { name: 'Sync Template' }).click();
  await expect(page.getByText('This template has unsynced changes.')).toHaveCount(0);
  await snap(page, '3-generated');

  await page.getByRole('button', { name: 'Preview Template' }).click();
  await expect(page).toHaveURL(new RegExp(`/template/${code}$`));
  await expect(page.getByRole('heading', { name: 'Sam Club 2' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Channels', exact: true })).toContainText('general');
  await snap(page, '4-landing');
  await page.getByLabel('Server name').fill('Copied club');
  await page.getByRole('button', { name: 'Create Server' }).click();
  await expect(page).toHaveURL(/\/channels\/\d+\/\d+$/);
  await expect(page.locator('.guild-header-name-button')).toContainText('Copied club');

  // Create Your Server > Create My Own > Use a template.
  await page.getByRole('button', { name: 'Add a Server' }).click();
  await page.getByRole('button', { name: 'Create My Own' }).click();
  await page.getByRole('button', { name: 'Use a template' }).click();
  await page.getByLabel('Template link').fill(`https://vokko.example/template/${code}`);
  await page.getByRole('button', { name: 'Find Template' }).click();
  await expect(page.getByLabel('Template preview')).toContainText('Sam Club 2');
  await snap(page, '5-modal');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('From the template Sam Club 2')).toBeVisible();
  await page.getByLabel('Server name').fill('Second copy');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('.guild-header-name-button')).toContainText('Second copy');
});

test('an unknown template code shows the invalid card', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.waitForFunction(() => Object.keys((window as unknown as StoreWin).__vokko.appStore.getState().guilds).length > 0);
  await page.evaluate(() => { history.pushState({}, '', '/template/nope'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await expect(page.getByRole('heading', { name: 'Template Invalid' })).toBeVisible();
});
