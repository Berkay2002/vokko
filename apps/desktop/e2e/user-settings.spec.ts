import { expect, test, type Page } from '@playwright/test';
import { message, openDm, pickOption, send } from './helpers';

// Settings > Chat, Notifications, Keybinds, Language & Time, Streamer Mode, Advanced, Data & Privacy, and the account sync behind them.
// The mock has one in-memory server per page, so "the second client" is the `settingsFromOtherDevice` hook: it saves as another device
// of the same account would (PATCH + USER_SETTINGS_UPDATE to every session).

type MockWin = {
  __vokkoMock: {
    settingsOf(username: string): { version: number; settings: Record<string, unknown> };
    settingsFromOtherDevice(username: string, settings: Record<string, unknown>, opts?: { silent?: boolean }): { version: number };
  };
};

const blob = (page: Page) => page.evaluate(() => (window as unknown as MockWin).__vokkoMock.settingsOf('sam'));
const otherDevice = (page: Page, settings: Record<string, unknown>, silent = false) =>
  page.evaluate(([s, quiet]) => (window as unknown as MockWin).__vokkoMock.settingsFromOtherDevice('sam', s as Record<string, unknown>, { silent: quiet as boolean }), [settings, silent] as const);

async function home(page: Page): Promise<void> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  // The account blob is loaded right after READY.
  await page.waitForFunction(() => (window as unknown as MockWin).__vokkoMock.settingsOf('sam') !== null);
}

async function openSettings(page: Page, section: string) {
  await page.getByRole('button', { name: 'User Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'User Settings' });
  await dialog.getByRole('button', { name: section, exact: true }).click();
  await expect(dialog.getByRole('heading', { level: 1 })).toHaveText(section);
  return dialog;
}

async function closeSettings(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'User Settings' });
  await dialog.getByRole('button', { name: 'Close' }).click();
  // The modal closes after its exit animation.
  await expect(dialog).toHaveCount(0);
}

test('a change is pushed to the account and another device\'s change applies live, conflicts merge', async ({ page }) => {
  await home(page);
  const dialog = await openSettings(page, 'Advanced');
  const devMode = dialog.getByRole('switch', { name: 'Developer Mode' });
  await expect(devMode).toHaveAttribute('aria-checked', 'false');

  // local → account (debounced PATCH)
  await devMode.click();
  await expect.poll(async () => (await blob(page)).settings.developer_mode).toBe(true);

  // another device → this client, while the page is open
  await otherDevice(page, { developer_mode: null, locale: 'en-GB' });
  await expect(devMode).toHaveAttribute('aria-checked', 'false');
  await dialog.getByRole('button', { name: 'Language & Time', exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: 'Language' })).toHaveText('English, UK');

  // a change saved elsewhere that this client never heard about: the next PATCH gets 409, the server's key wins, ours is re-applied
  await otherDevice(page, { locale: 'en-US', theme: 'onyx' }, true);
  await dialog.getByRole('radio', { name: '24-hour' }).click();
  await expect.poll(async () => (await blob(page)).settings).toMatchObject({ locale: 'en-US', theme: 'onyx', time_format: '24' });
  await expect(dialog.getByRole('combobox', { name: 'Language' })).toHaveText('English, US');
  await expect(page.locator('html')).toHaveClass(/theme-onyx/);

  // device-local prefs never reach the account
  expect(Object.keys((await blob(page)).settings)).not.toContain('output_volume');
});

test('a hidden spoiler is a visible block on the chat background in every base theme', async ({ page }) => {
  await openDm(page);
  await send(page, 'plot twist ||the butler||');
  const spoiler = message(page, 'plot twist').locator('.md-spoiler');
  await expect(spoiler).toHaveAttribute('role', 'button');
  for (const theme of ['onyx', 'dark', 'ash', 'light']) {
    const [hidden, chat] = await spoiler.evaluate((el, t) => {
      const html = document.documentElement;
      html.className = html.className.replace(/\btheme-\w+/g, '') + ` theme-${t}`;
      return [getComputedStyle(el).backgroundColor, getComputedStyle(el.closest('.chat-view')!).backgroundColor];
    }, theme);
    expect(hidden, theme).not.toBe(chat);
  }
});

test('Chat: spoilers, link media and thread split view follow the switches', async ({ page }) => {
  await openDm(page);
  await send(page, 'plot twist ||the butler||');
  await expect(message(page, 'plot twist').locator('.md-spoiler')).not.toHaveAttribute('data-revealed', 'true');

  const dialog = await openSettings(page, 'Chat');
  await dialog.getByRole('radio', { name: /^Always/ }).click();
  for (const name of ['When posted as links to the web', 'Open threads in split view', 'Show emoji suggestions when you type :emoji:']) {
    const sw = dialog.getByRole('switch', { name });
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
  }
  await closeSettings(page);
  await expect(message(page, 'plot twist').locator('.md-spoiler')).toHaveAttribute('data-revealed', 'true');

  // :emoji: autocomplete is off: typing :smi lists nothing
  await page.locator('.chat-textarea').fill(':smi');
  await expect(page.locator('.chat-autocomplete')).toHaveCount(0);

  await expect.poll(async () => (await blob(page)).settings).toMatchObject({ spoiler_content: 'always', inline_embed_media: false, thread_split_view: false, emoji_autocomplete: false });
});

test('Notifications: permission state, per-sound switches and Disable all', async ({ page }) => {
  await home(page);
  const dialog = await openSettings(page, 'Notifications');
  await expect(dialog.locator('.notify-permission')).not.toHaveText('Checking permission…');
  await expect(dialog.getByRole('switch', { name: 'Enable taskbar flashing' })).toBeDisabled(); // browser build
  await dialog.getByRole('switch', { name: 'User join' }).click();
  await expect.poll(async () => (await blob(page)).settings.disabled_sounds).toEqual(['user-join']);
  await dialog.getByRole('button', { name: 'Disable all sounds' }).click();
  for (const name of ['Message', 'Mention and direct message', 'User join', 'User leave']) await expect(dialog.getByRole('switch', { name, exact: true })).toHaveAttribute('aria-checked', 'false');
  await expect(dialog.getByRole('button', { name: 'Enable all sounds' })).toBeVisible();
  await expect.poll(async () => ((await blob(page)).settings.disabled_sounds as string[] | undefined)?.length).toBe(4);
  // a disabled sound does not play (the preview button still does)
  expect(await page.evaluate(() => (window as unknown as { __vokko: { sounds: { playSound(k: string, at: number): boolean } } }).__vokko.sounds.playSound('message', Date.now() + 10_000))).toBe(false);
  await expect(dialog.getByText('Email notifications are not available on this server')).toBeVisible();
});

test('Keybinds: rebinding moves the action, conflicts are refused, reset restores the defaults', async ({ page }) => {
  await home(page);
  const dialog = await openSettings(page, 'Keybinds');
  await expect(dialog.getByRole('heading', { name: 'Default Keybinds' })).toBeVisible();

  await dialog.getByRole('button', { name: /^Keybind for Quick switcher/ }).click();
  await page.keyboard.press('ControlOrMeta+J');
  await expect(dialog.getByRole('heading', { name: 'Custom Keybinds' })).toBeVisible();

  // Ctrl+I already toggles the inbox: recording it for Toggle mute is refused
  await dialog.getByRole('button', { name: /^Keybind for Toggle mute/ }).click();
  await page.keyboard.press('ControlOrMeta+I');
  await expect(dialog.getByRole('alert')).toContainText('Ctrl+I is already used by "Toggle inbox"');

  await closeSettings(page);
  await page.keyboard.press('ControlOrMeta+K');
  await expect(page.locator('.quick-switcher')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+J');
  await expect(page.locator('.quick-switcher')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await blob(page)).settings.keybinds as { action: string; keys: string }[]).toContainEqual({ action: 'quickSwitcher', keys: 'Ctrl+J' });

  const again = await openSettings(page, 'Keybinds');
  await again.getByRole('button', { name: 'Reset to defaults' }).click();
  await expect(again.getByRole('heading', { name: 'Default Keybinds' })).toBeVisible();
  await expect.poll(async () => (await blob(page)).settings.keybinds).toBeUndefined();
});

test('Language & Time: the locale and the time format drive timestamps', async ({ page }) => {
  await openDm(page);
  await send(page, 'what time is it');
  const stamp = message(page, 'what time is it').locator('time').first();
  const dialog = await openSettings(page, 'Language & Time');
  await pickOption(page, dialog.getByRole('combobox', { name: 'Language' }), 'English, US');
  await expect(dialog.getByTestId('time-preview')).toContainText('9:24 PM');
  await dialog.getByRole('radio', { name: '24-hour' }).click();
  await expect(dialog.getByTestId('time-preview')).toContainText('21:24');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US-u-hc-h23');
  await closeSettings(page);
  await expect(stamp).not.toContainText(/AM|PM/);
});

test('Streamer Mode: personal info and invite links are blurred, options need the mode', async ({ page }) => {
  await home(page);
  const dialog = await openSettings(page, 'Streamer Mode');
  await expect(dialog.getByRole('switch', { name: 'Hide personal information' })).toBeDisabled();
  await expect(dialog.getByRole('switch', { name: 'Automatically enable/disable' })).toBeDisabled(); // desktop only
  await dialog.getByRole('switch', { name: 'Enable Streamer Mode' }).click();
  await expect(dialog.getByRole('switch', { name: 'Hide personal information' })).toBeEnabled();
  await closeSettings(page);
  await expect(page.locator('html')).toHaveClass(/streamer-hide-personal/);
  const filter = await page.locator('.user-panel-sub-username').evaluate(el => getComputedStyle(el).filter);
  expect(filter).toContain('blur');
  await expect.poll(async () => (await blob(page)).settings.streamer_mode).toBe(true);
  const account = await openSettings(page, 'My Account');
  await expect(account.locator('.sm-row', { hasText: 'Email' }).locator('.personal-info')).toHaveCSS('filter', /blur/);
  await closeSettings(page);

  // personal info off: the username is readable again
  const again = await openSettings(page, 'Streamer Mode');
  await again.getByRole('switch', { name: 'Hide personal information' }).click();
  await closeSettings(page);
  expect(await page.locator('.user-panel-sub-username').evaluate(el => getComputedStyle(el).filter)).toBe('none');
});

test('Advanced: developer mode adds Copy ID to menus; hardware acceleration is desktop only', async ({ page }) => {
  await home(page);
  await page.locator('.dm-row').first().click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Copy Channel ID' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  const dialog = await openSettings(page, 'Advanced');
  await expect(dialog.getByRole('switch', { name: 'Hardware Acceleration' })).toBeDisabled();
  await dialog.getByRole('switch', { name: 'Developer Mode' }).click();
  await closeSettings(page);
  await page.locator('.dm-row').first().click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Copy Channel ID' })).toBeVisible();
});

test('Content & Social and Data & Privacy: privacy keys sync and Request Data downloads once per day', async ({ page }) => {
  await home(page);
  const dialog = await openSettings(page, 'Content & Social');
  await dialog.getByRole('switch', { name: 'Direct messages' }).click();
  await dialog.getByRole('switch', { name: 'Message requests' }).click();
  await expect(dialog.getByRole('switch', { name: 'Server members' })).toBeDisabled();
  await dialog.getByRole('switch', { name: 'Everyone' }).click();
  await expect(dialog.getByRole('switch', { name: 'Server members' })).toBeEnabled();
  await expect.poll(async () => (await blob(page)).settings).toMatchObject({ dms_from_server_members: false, message_requests: true, friend_requests_everyone: false });

  await dialog.getByRole('button', { name: 'Data & Privacy', exact: true }).click();

  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Request Data' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^vokko-data-sam-\d{4}-\d{2}-\d{2}\.json$/);
  await expect(dialog.getByRole('status')).toContainText('Downloaded your data');

  await dialog.getByRole('button', { name: 'Request Data' }).click();
  await expect(dialog.getByRole('alert')).toContainText('once every 24 hours');
});
