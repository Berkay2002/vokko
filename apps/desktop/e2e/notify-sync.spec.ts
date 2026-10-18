import { expect, test, type Page } from '@playwright/test';
import { openChannel } from './threadHelpers';

// Notification settings synced per account (gap audit #11): mutes and levels live in the server's user guild settings, and a change on
// another device shows here at once. The one-time upload of old per-device values is covered by notify/guildSettingsSync.test.ts
// (in the mock, ids change on every reload, so a spec cannot seed an older build's local state).

type Mock = { __vokkoMock: { requestAs(u: string, m: string, p: string, b?: unknown): unknown } };
const asSam = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(([m, p, b]) => (window as unknown as Mock).__vokkoMock.requestAs('sam', m as string, p as string, b), [method, path, body] as const);
const row = (page: Page, id: string) => page.locator(`a.channel-row[href$="/${id}"]`);
const guildOf = (page: Page) => page.evaluate(() => location.pathname.split('/')[2]!);

test('muting saves to the account, and a change from another device applies here at once', async ({ page }) => {
  await openChannel(page, 'general');
  const random = await page.evaluate(() => (window as unknown as { __vokkoMock: { channelIdByName(n: string): string | null } }).__vokkoMock.channelIdByName('random')!);
  const guild = await guildOf(page);
  await asSam(page, 'PATCH', `/users/@me/guilds/${guild}/settings`, { channel_overrides: { [random]: { muted: true, mute_config: null } } });
  await expect(row(page, random)).toHaveClass(/muted/);

  // Another device unmutes it: the row updates without a reload.
  await asSam(page, 'PATCH', `/users/@me/guilds/${guild}/settings`, { channel_overrides: { [random]: { muted: false } } });
  await expect(row(page, random)).not.toHaveClass(/muted/);

  // Muting here saves to the account.
  await row(page, random).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Mute Channel' }).hover();
  await page.getByRole('menuitem', { name: 'For 1 Hour' }).click();
  await expect(row(page, random)).toHaveClass(/muted/);
  type Saved = { channel_overrides: { channel_id: string; muted: boolean; mute_config: { end_time: string } | null }[] };
  const override = async () => ((await asSam(page, 'GET', `/users/@me/guilds/${guild}/settings`)) as Saved).channel_overrides.find(o => o.channel_id === random);
  await expect.poll(async () => (await override())?.muted).toBe(true);
  expect(Date.parse((await override())!.mute_config!.end_time) - Date.now()).toBeGreaterThan(55 * 60_000);
});
