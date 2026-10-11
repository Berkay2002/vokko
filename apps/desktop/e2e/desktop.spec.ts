import { expect, test } from '@playwright/test';

// Invite page, desktop-only settings and the update banner (mock mode; the Tauri adapters are no-ops in the browser).

test('invite page: a member sees the server and continues to it', async ({ page }) => {
  await page.goto('/invite/vokkodev?as=sam&mockLatency=0');
  await expect(page.getByRole('heading', { name: "Sam's server" })).toBeVisible();
  await expect(page.getByText(/\d+ Members?/)).toBeVisible();
  await page.getByRole('button', { name: 'Continue to Server' }).click();
  await expect(page).toHaveURL(/\/channels\/\d+/);
});

test('invite page: a non-member accepts and lands in the server', async ({ page }) => {
  // bob leaves the seeded server first (client-side, the mock database is per page load), then opens the invite
  await page.goto('/channels/@me?as=bob&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  await page.evaluate(async () => {
    const v = (window as unknown as { __vokko: { request(m: string, p: string): Promise<unknown>; appStore: { getState(): { guilds: Record<string, unknown>; removeGuild(id: string): void } } } }).__vokko;
    const id = Object.keys(v.appStore.getState().guilds)[0]!;
    await v.request('DELETE', `/users/@me/guilds/${id}`);
    v.appStore.getState().removeGuild(id);
    history.pushState({}, '', '/invite/vokkodev');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await page.getByRole('button', { name: 'Accept Invite' }).click();
  await expect(page).toHaveURL(/\/channels\/\d+/);
  const guilds = await page.evaluate(() => Object.values((window as unknown as { __vokko: { appStore: { getState(): { guilds: Record<string, { name: string }> } } } }).__vokko.appStore.getState().guilds).map(g => g.name));
  expect(guilds).toContain("Sam's server");
});

test('invite page: a logged-out visitor keeps the code through login', async ({ page }) => {
  await page.goto('/invite/vokkodev?mockLatency=0');
  await page.getByRole('button', { name: 'Accept Invite' }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByRole('button', { name: 'Log In' }).click();
  await expect(page).toHaveURL(/\/invite\/vokkodev/);
  await expect(page.getByRole('heading', { name: "Sam's server" })).toBeVisible();
});

test('invite page: an unknown code says so', async ({ page }) => {
  await page.goto('/invite/nope?as=sam&mockLatency=0');
  await expect(page.getByRole('heading', { name: 'Invite Invalid' })).toBeVisible();
});

test('Windows Settings are desktop only', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  await page.getByRole('button', { name: 'User Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'User Settings' });
  await expect(dialog.getByRole('button', { name: 'Keybinds' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Windows Settings' })).toHaveCount(0);
});

test('a downloaded update shows the restart banner', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  await expect(page.getByTestId('update-banner')).toHaveCount(0);
  await page.evaluate(() => {
    const w = window as unknown as { __vokko: { desktop: { useDesktopUpdate: { setState(s: unknown): void } } } };
    w.__vokko.desktop.useDesktopUpdate.setState({ status: { state: 'ready', version: '9.9.9' } });
  });
  const banner = page.getByTestId('update-banner');
  await expect(banner).toContainText('Update ready');
  await expect(banner).toContainText('9.9.9');
  await expect(banner.getByRole('button', { name: 'Restart to Update' })).toBeVisible();
});
