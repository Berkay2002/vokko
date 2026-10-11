import { expect, test, type Page } from '@playwright/test';
import { openStockTalk } from './helpers';

// Rich presence ("Playing X") in the member list, DM list and profile card, and the desktop-only pieces staying out of the
// browser build (mock mode; the Tauri adapters are no-ops here).

type Hooks = {
  __vokko: {
    appStore: { getState(): { me: { id: string } | null; users: Record<string, unknown>; presences: Record<string, { activities?: { name: string; type: number }[] }> }; setState(s: unknown): void };
    gateway: { send(op: number, d: unknown): void };
  };
};

/** Gives every other user a Factorio session that started 12 minutes ago. */
async function everyonePlays(page: Page) {
  await page.evaluate(() => {
    const store = (window as unknown as Hooks).__vokko.appStore;
    const { me, users, presences } = store.getState();
    const next = { ...presences };
    for (const id of Object.keys(users)) {
      if (id === me?.id) continue;
      next[id] = { user_id: id, status: 'online', custom_status: null, activities: [{ name: 'Factorio', type: 0, timestamps: { start: Date.now() - 12 * 60_000 } }] } as never;
    }
    store.setState({ presences: next });
  });
}

test('the member list shows "Playing X" with the elapsed time', async ({ page }) => {
  await openStockTalk(page);
  await everyonePlays(page);
  const line = page.locator('.member-list [data-testid="activity-line"]').first();
  await expect(line).toContainText('Playing');
  await expect(line).toContainText('Factorio');
  await expect(line).toContainText('12m');
});

test('the profile card shows the game', async ({ page }) => {
  await openStockTalk(page);
  await everyonePlays(page);
  await page.locator('.member-row', { has: page.getByTestId('activity-line') }).first().click();
  const card = page.getByTestId('activity-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Playing');
  await expect(card).toContainText('Factorio');
});

test('the DM list shows the game of the other person', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  await everyonePlays(page);
  await expect(page.locator('.dm-row [data-testid="activity-line"]').first()).toContainText('Factorio');
});

test('presence update with activities is kept when absent and cleared by an empty list', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  const own = () =>
    page.evaluate(() => {
      const { me, presences } = (window as unknown as Hooks).__vokko.appStore.getState();
      return presences[me?.id ?? '']?.activities?.map(a => a.name) ?? [];
    });
  await page.evaluate(() => (window as unknown as Hooks).__vokko.gateway.send(3, { status: 'online', activities: [{ name: 'Terraria', type: 0, timestamps: { start: 1000 } }] }));
  await expect.poll(own).toEqual(['Terraria']);
  // absent keeps
  await page.evaluate(() => (window as unknown as Hooks).__vokko.gateway.send(3, { status: 'idle' }));
  await page.waitForTimeout(300);
  expect(await own()).toEqual(['Terraria']);
  // [] clears
  await page.evaluate(() => (window as unknown as Hooks).__vokko.gateway.send(3, { status: 'online', activities: [] }));
  await expect.poll(own).toEqual([]);
});

test('the browser build has no window controls and no Registered Games', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  await expect(page.getByTestId('window-controls')).toHaveCount(0);
  await page.getByRole('button', { name: 'User Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'User Settings' });
  await expect(dialog.getByRole('button', { name: 'Registered Games' })).toHaveCount(0);
  // Activity Privacy still exists, and its switch is not the live desktop one
  await dialog.getByRole('button', { name: 'Activity Privacy' }).click();
  await expect(dialog.getByRole('heading', { name: 'Activity Privacy' })).toBeVisible();
});
