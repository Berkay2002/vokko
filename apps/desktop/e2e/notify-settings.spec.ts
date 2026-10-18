import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import path from 'node:path';
import { openChannel } from './threadHelpers';

// gap-audit 6 items 3, 4 and the member "Profile" item of 6, against the mock backend, at 1440x900 and 390x844.
// Run from apps/desktop: npx playwright test -c e2e/notify-settings.config.ts --workers=1
// Screenshots are written when VOKKO_SHOTS_DIR is set.
const dir = process.env.VOKKO_SHOTS_DIR;

type Win = {
  __vokko: {
    appStore: { getState(): { me: { id: string }; guilds: Record<string, { id: string; name: string }>; channels: Record<string, { id: string; guild_id: string | null; last_message_id?: string | null }>; members: Record<string, Record<string, { roles: string[] }>> }; setState(fn: (s: { guilds: Record<string, object> }) => object): void };
    request(method: string, path: string, body?: unknown): Promise<unknown>;
  };
  __vokkoMock: { say(channelId: string, username: string, content: string): string; channelIdByName(name: string): string | null };
};

const phone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 500;
const shot = async (page: Page, name: string) => {
  if (!dir) return;
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(dir, `${name}-${phone(page) ? 'phone' : 'desktop'}.png`) });
};

/** Opens #random of the demo server with everything read, so messages in #general count as unread mentions. */
async function start(page: Page) {
  await openChannel(page, 'random');
  await page.evaluate(async () => {
    const w = window as unknown as Win;
    for (const c of Object.values(w.__vokko.appStore.getState().channels)) if (c.last_message_id) await w.__vokko.request('POST', `/channels/${c.id}/messages/${c.last_message_id}/ack`);
  });
  await expect.poll(() => page.title()).toMatch(/^Vokko \| #random/);
}

const say = (page: Page, channel: string, text: string) =>
  page.evaluate(([c, t]) => { const m = (window as unknown as Win).__vokkoMock; return m.say(m.channelIdByName(c!)!, 'alice', t!); }, [channel, text] as const);

/** The server's dropdown (a bottom sheet on a phone, behind the channel list). */
async function openServerMenu(page: Page) {
  const name = page.locator('.guild-header-name-button');
  if (!(await name.isVisible())) await page.getByRole('button', { name: 'Show Channels' }).click();
  await name.click();
  return page;
}

test('server notification settings: the server default is the checked choice, titles follow the scope', async ({ page }) => {
  await start(page);
  const guildId = await page.evaluate(() => Object.values((window as unknown as Win).__vokko.appStore.getState().guilds)[0]!.id);

  // The dropdown's submenu: nothing chosen yet, so the server's default ("All Messages") is the checked radio.
  let menu = await openServerMenu(page);
  await menu.getByRole('menuitem', { name: 'Notification Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Notification Settings' });
  await expect(dialog.getByText('Server notification settings')).toBeVisible();
  await expect(dialog.getByRole('radio', { name: 'All Messages' })).toBeChecked();
  await expect(dialog.getByText('follow your account')).toBeVisible();
  await expect(dialog.getByText('saved on this device')).toHaveCount(0);
  await shot(page, 'notify-modal-default-all');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // A server whose Default Notification Settings say "Only @mentions" shows that one checked instead.
  await page.evaluate(id => (window as unknown as Win).__vokko.appStore.setState(s => ({ guilds: { ...s.guilds, [id]: { ...s.guilds[id], default_message_notifications: 1 } } })), guildId);
  menu = await openServerMenu(page);
  await menu.getByRole('menuitem', { name: 'Notification Settings' }).click();
  await expect(dialog.getByRole('radio', { name: 'Only @mentions' })).toBeChecked();
  await expect(dialog.getByRole('radio', { name: 'All Messages' })).not.toBeChecked();
  await shot(page, 'notify-modal-default-mentions');

  // Choosing a level sticks, and an explicit choice wins over the server default.
  await dialog.getByRole('radio', { name: 'Nothing' }).check();
  await expect(dialog.getByRole('radio', { name: 'Nothing' })).toBeChecked();
  await page.keyboard.press('Escape');

  // The right-click menu of the server in the rail shows the same choice.
  const rail = phone(page) ? page.locator('.guild-header-name-button') : page.getByRole('navigation', { name: 'Servers sidebar' }).getByRole('link', { name: /Sam's server/ });
  if (!phone(page)) {
    await rail.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Notification Settings' }).hover();
    await expect(page.getByRole('menuitemcheckbox', { name: 'Nothing' })).toHaveAttribute('aria-checked', 'true');
    await shot(page, 'notify-menu-nothing');
  }
});

test('suppress @everyone and role mentions keep them out of the badge and the tab title', async ({ page }) => {
  await start(page);
  const roleId = await page.evaluate(() => {
    const s = (window as unknown as Win).__vokko.appStore.getState();
    const guild = Object.values(s.guilds)[0]!;
    return s.members[guild.id]![s.me.id]!.roles.find(id => id !== guild.id)!;
  });

  // Nothing suppressed: @everyone and my role both count.
  await say(page, 'general', '@everyone standup');
  await expect.poll(() => page.title()).toMatch(/^\(1\) Vokko/);
  await say(page, 'general', `<@&${roleId}> docs`);
  await expect.poll(() => page.title()).toMatch(/^\(2\) Vokko/);
  await shot(page, 'badge-unsuppressed');

  // Suppress both from the server's menu, then read #general to start from zero.
  let menu = await openServerMenu(page);
  await menu.getByRole('menuitem', { name: 'Notification Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Notification Settings' });
  await dialog.getByRole('switch', { name: 'Suppress @everyone and @here' }).click();
  await dialog.getByRole('switch', { name: 'Suppress All Role @mentions' }).click();
  await shot(page, 'suppress-on');
  await page.keyboard.press('Escape');
  await page.evaluate(async () => {
    const w = window as unknown as Win;
    for (const c of Object.values(w.__vokko.appStore.getState().channels)) if (c.last_message_id) await w.__vokko.request('POST', `/channels/${c.id}/messages/${c.last_message_id}/ack`);
  });
  await expect.poll(() => page.title()).toMatch(/^Vokko \| #random/);

  await say(page, 'general', '@everyone again');
  await say(page, 'general', `<@&${roleId}> again`);
  await page.waitForTimeout(400);
  await expect.poll(() => page.title()).not.toMatch(/^\(/);

  // A name in the same breath still counts once.
  const meId = await page.evaluate(() => (window as unknown as Win).__vokko.appStore.getState().me.id);
  await say(page, 'general', `<@&${roleId}> @everyone <@${meId}>`);
  await expect.poll(() => page.title()).toMatch(/^\(1\) Vokko/);
  await shot(page, 'badge-suppressed-name-counts');

  // Switching suppression off again counts new ones.
  menu = await openServerMenu(page);
  await menu.getByRole('menuitem', { name: 'Notification Settings' }).click();
  await dialog.getByRole('switch', { name: 'Suppress @everyone and @here' }).click();
  await page.keyboard.press('Escape');
  await say(page, 'general', '@everyone back on');
  await expect.poll(() => page.title()).toMatch(/^\(2\) Vokko/);
});

test('the member menu Profile item opens the full profile', async ({ page }) => {
  test.skip(phone(page), 'the member list is a desktop panel; the phone path is the author tap (profile card, group D)');
  await openChannel(page, 'general');
  const row = page.locator('.member-list .member-row').filter({ hasText: 'alice' }).first();
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Profile', exact: true }).click();
  const dialog = page.getByRole('dialog').filter({ has: page.locator('.full-profile') });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/Mutual Friends?/).first()).toBeVisible();
  await shot(page, 'member-menu-full-profile');
});
