import { expect, test, type Page } from '@playwright/test';
import { openStockTalk } from './helpers';

// App names and icons (docs/api.md "App icons"): the desktop shell is faked (isTauri + invoke), the mock backend stands in for the server.
// With APP_ICON_SHOTS=<dir> the run also saves the three review screenshots there.

// Neutral stand-ins (a blue disc, an orange square), not the brand icons of the apps named below.
const ICONS: Record<string, string> = {"chrome.exe": "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", "claude.exe": "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"};
const SHOTS = process.env.APP_ICON_SHOTS;

type Hooks = {
  __vokko: {
    appStore: { getState(): { me: { id: string } | null; users: Record<string, unknown>; presences: Record<string, { activities?: { name: string; app?: boolean; assets?: { large_image?: string } }[] }> }; setState(s: unknown): void };
  };
};

/** The shell: Chrome and Claude are running, and `desktop_app_info` answers with their real names and icons. */
async function fakeDesktop(page: Page) {
  await page.addInitScript(icons => {
    const w = window as unknown as Record<string, unknown>;
    w.isTauri = true;
    const names: Record<string, string> = { 'chrome.exe': 'Google Chrome', 'claude.exe': 'Claude' };
    const processes = [
      { name: 'chrome.exe', startedAt: Date.now() - 12 * 60_000, system: false, pathKnown: true },
      { name: 'claude.exe', startedAt: Date.now() - 5 * 60_000, system: false, pathKnown: true },
    ];
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
      transformCallback: () => 1,
      invoke: async (command: string, args?: { exe?: string }) => {
        if (command === 'desktop_list_processes') return processes;
        if (command === 'desktop_take_pending_links') return [];
        if (command === 'desktop_update_status') return { state: 'disabled' };
        if (command === 'desktop_app_info') {
          const key = (args?.exe ?? '').toLowerCase();
          return names[key] ? { name: names[key], icon: icons[key] } : null;
        }
        return null;
      },
    };
  }, ICONS);
}

test('added apps show their real name and icon, and the icon follows the activity everywhere', async ({ page }) => {
  await fakeDesktop(page);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();

  await page.getByRole('button', { name: 'User Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'User Settings' });
  await dialog.getByRole('button', { name: 'Registered Apps' }).click();
  await expect(dialog.getByRole('heading', { name: 'App Detection' })).toBeVisible();
  await expect(dialog.getByText('Game Detection')).toHaveCount(0);
  await expect(dialog.getByTestId('detected-game')).toContainText('No app detected');

  await dialog.getByRole('button', { name: 'Add chrome.exe' }).click();
  await dialog.getByRole('button', { name: 'Add claude.exe' }).click();
  const added = dialog.getByRole('list', { name: 'Added apps' });
  await expect(added).toContainText('Google Chrome');
  await expect(added).toContainText('Claude');
  await expect(added.getByTestId('activity-app-icon')).toHaveCount(2);
  // Chrome started first, so it is the detected app, with its own icon
  await expect(dialog.getByTestId('detected-game')).toContainText('Google Chrome');
  await expect(dialog.getByTestId('detected-game').getByTestId('activity-app-icon')).toBeVisible();
  if (SHOTS) await dialog.screenshot({ path: `${SHOTS}/settings-app-detection.png` });

  // the icon went up while sharing, and the own presence carries the asset the mock backend now holds
  const asset = () =>
    page.evaluate(() => {
      const { me, presences } = (window as unknown as Hooks).__vokko.appStore.getState();
      return presences[me?.id ?? '']?.activities?.[0]?.assets?.large_image ?? null;
    });
  // an app the user added goes out marked as an app
  const ownFlag = () => page.evaluate(() => { const { me, presences } = (window as unknown as Hooks).__vokko.appStore.getState(); return presences[me?.id ?? '']?.activities?.[0]?.app ?? null; });
  await expect.poll(asset, { timeout: 25_000 }).toMatch(/^app:[0-9a-f]{64}$/);
  expect(await ownFlag()).toBe(true);
  const image = (await asset())!;

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 900 });
  // every other user plays Chrome with that icon
  await page.evaluate(large_image => {
    const store = (window as unknown as Hooks).__vokko.appStore;
    const { me, users, presences } = store.getState();
    const next = { ...presences };
    for (const id of Object.keys(users)) {
      if (id === me?.id) continue;
      next[id] = { user_id: id, status: 'online', custom_status: null, activities: [{ name: 'Google Chrome', type: 0, timestamps: { start: Date.now() - 12 * 60_000 }, assets: { large_image }, app: true }] } as never;
    }
    store.setState({ presences: next });
  }, image);

  const column = page.getByRole('complementary', { name: 'Active Now' });
  await expect(column.getByTestId('activity-app-icon').first()).toBeVisible();
  await expect(column.getByTestId('activity-line').first()).toHaveText(/^Using Google Chrome/);
  if (SHOTS) {
    await column.screenshot({ path: `${SHOTS}/active-now.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/active-now-mobile.png` });
    await page.setViewportSize({ width: 1440, height: 900 });
  }

  // an icon the server does not have falls back to the pad
  await page.evaluate(() => {
    const store = (window as unknown as Hooks).__vokko.appStore;
    const { me, users, presences } = store.getState();
    const next = { ...presences };
    for (const id of Object.keys(users)) if (id !== me?.id) next[id] = { ...(next[id] as object), activities: [{ name: 'Factorio', type: 0, assets: { large_image: `app:${'f'.repeat(64)}` } }] } as never;
    store.setState({ presences: next });
  });
  await expect(column.getByTestId('activity-line').first()).toHaveText(/^Playing Factorio/);
  await expect(column.getByTestId('activity-app-icon')).toHaveCount(0);
});

test('the profile popout shows the app icon', async ({ page }) => {
  await openStockTalk(page);
  const image = await page.evaluate(async png => {
    const { request } = (window as unknown as { __vokko: { request(m: string, p: string, b?: unknown): Promise<{ asset: string }> } }).__vokko;
    return (await request('POST', '/app-icons', { png })).asset;
  }, ICONS['chrome.exe']!);
  expect(image).toMatch(/^app:[0-9a-f]{64}$/);
  await page.evaluate(large_image => {
    const store = (window as unknown as Hooks).__vokko.appStore;
    const { me, users, presences } = store.getState();
    const next = { ...presences };
    for (const id of Object.keys(users)) {
      if (id === me?.id) continue;
      next[id] = { user_id: id, status: 'online', custom_status: null, activities: [{ name: 'Google Chrome', type: 0, timestamps: { start: Date.now() - 12 * 60_000 }, assets: { large_image }, app: true }] } as never;
    }
    store.setState({ presences: next });
  }, image);
  await page.locator('.member-row', { has: page.getByTestId('activity-line') }).first().click();
  const card = page.getByTestId('activity-card').first();
  await expect(card).toBeVisible();
  await expect(card).toContainText('Using an app');
  await expect(card.getByTestId('activity-app-icon')).toBeVisible();
  if (SHOTS) {
    await card.screenshot({ path: `${SHOTS}/profile-activity-card.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/profile-popout-mobile.png` });
  }
});
