import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Gap audit 7, group B + D (mock backend): member menu Mention / Invite to Server, timed-out composer, "no longer in" notice,
// two-step emoji delete and invite revoke, contrast of the names under a voice channel. Shots go to SHOTS when it is set.

type Win = {
  __vokko: { request(method: string, path: string, body?: unknown): Promise<unknown>; appStore: { getState(): { route: { guildId: string | null; channelId: string | null }; channels: Record<string, { id: string; name?: string; guild_id: string | null }> } } };
  __vokkoMock: { requestAs(user: string, method: string, path: string, body?: unknown): unknown };
};

const SHOTS = process.env.SHOTS;
const VIEWS = [{ name: 'desktop', width: 1440, height: 900 }, { name: 'phone', width: 390, height: 844 }];
const shot = async (page: Page, name: string): Promise<void> => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}-${page.viewportSize()?.width ?? 0}.png` });
};

/** `list` keeps a phone on the channel list (where the voice users are) instead of opening the chat. */
async function openGeneral(page: Page, as = 'sam', list = false): Promise<void> {
  await page.goto(`/channels/@me?as=${as}&mockLatency=0`);
  await page.waitForFunction(() => Object.values((window as unknown as Win).__vokko.appStore.getState().channels).some(c => c.name === 'general' && c.guild_id));
  const target = await page.evaluate(() => {
    const c = Object.values((window as unknown as Win).__vokko.appStore.getState().channels).find(x => x.name === 'general' && x.guild_id)!;
    return `/channels/${c.guild_id}/${c.id}`;
  });
  await page.evaluate(path => { history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, target);
  if ((page.viewportSize()?.width ?? 0) < 500) {
    // The phone shows the channel list first; tapping the open channel shows the chat.
    await expect(page.locator('.app-frame')).toHaveClass(/nav-open/);
    if (list) return;
    await page.locator('a.channel-row[aria-current="page"]').first().tap();
    await page.locator('.chat-textarea').waitFor();
    await page.locator('.chat-msg').first().waitFor();
  } else await page.locator('.channel-header').getByRole('heading', { name: 'general', exact: true }).waitFor();
}

const guildOf = (page: Page) => page.evaluate(() => (window as unknown as Win).__vokko.appStore.getState().route.guildId!);

/** The person's user menu: right-click in the member list, or on a phone (no member list) on their name above a message. */
async function openPersonMenu(page: Page, name: string): Promise<void> {
  if ((page.viewportSize()?.width ?? 0) < 500) await page.locator('.chat-msg').getByText(name, { exact: true }).first().click({ button: 'right' });
  else await page.getByText(name, { exact: true }).last().click({ button: 'right' });
}

test.use({ screenshot: 'only-on-failure' });

for (const view of VIEWS) test.describe(view.name, () => {
  test.use({ viewport: { width: view.width, height: view.height }, hasTouch: view.name === 'phone', isMobile: view.name === 'phone' });

  test('Mention puts the name into the composer and focuses it', async ({ page }) => {
    await openGeneral(page);
    const box = page.locator('.chat-textarea');
    await box.fill('hi');
    await openPersonMenu(page, 'Alice');
    await expect(page.getByRole('menuitem', { name: 'Mention' })).toBeEnabled();
    await shot(page, 'member-menu');
    await page.getByRole('menuitem', { name: 'Mention' }).click();
    await expect(box).toHaveText('hi @Alice ');
    await expect(box).toBeFocused();
    // The caret lands a frame after the focus does; a person cannot type that fast.
    await expect.poll(() => page.evaluate(() => { const sel = window.getSelection()!; const field = document.querySelector('.chat-textarea')!; return sel.isCollapsed && sel.anchorNode === field && sel.anchorOffset === field.childNodes.length; })).toBe(true);
    await page.keyboard.type('look');
    if (view.name === 'phone') await page.getByRole('button', { name: 'Send message' }).tap();
    else await box.press('Enter');
    await expect(page.locator('.chat-msg').last()).toContainText('look');
    const sent = (await page.evaluate(() => (window as unknown as Win).__vokko.request('GET', `/channels/${(window as unknown as Win).__vokko.appStore.getState().route.channelId}/messages?limit=1`))) as { content: string }[];
    expect(sent[0]?.content).toMatch(/^hi <@\d+> look$/);
  });

  test('Invite to Server lists the servers this person is not in and DMs the link', async ({ page }) => {
    await openGeneral(page);
    // Alice is in Sam's server, so with only that server the item is not offered at all.
    if (view.name === 'desktop') {
      await openPersonMenu(page, 'Alice');
      await expect(page.getByRole('menuitem', { name: 'Invite to Server' })).toHaveCount(0);
      await page.keyboard.press('Escape');
    }
    await page.evaluate(() => (window as unknown as Win).__vokko.request('POST', '/guilds', { name: 'Side Club' }));
    await expect.poll(() => page.evaluate(() => Object.values((window as unknown as Win).__vokko.appStore.getState().channels).filter(c => c.name === 'general' && c.guild_id).length)).toBe(2);
    await openPersonMenu(page, 'Alice');
    await page.getByRole('menuitem', { name: 'Invite to Server' }).click();
    await shot(page, 'invite-submenu');
    await expect(page.getByRole('menuitem', { name: "Sam's server" })).toHaveCount(0);
    await page.getByRole('menuitem', { name: 'Side Club' }).click();
    await expect.poll(async () => {
      const dms = (await page.evaluate(() => (window as unknown as Win).__vokko.request('GET', '/users/@me/channels'))) as { id: string; recipients?: { username: string }[] }[];
      const dm = dms.find(c => c.recipients?.length === 1 && c.recipients[0]?.username === 'alice');
      if (!dm) return '';
      const latest = (await page.evaluate(c => (window as unknown as Win).__vokko.request('GET', `/channels/${c}/messages?limit=1`), dm.id)) as { content: string }[];
      return latest[0]?.content ?? '';
    }).toContain('/invite/');
  });

  test('a timed-out member sees when the timeout ends', async ({ page }) => {
    await openGeneral(page, 'nova');
    const guild = await guildOf(page);
    const nova = await page.evaluate(() => (window as unknown as Win).__vokko.request('GET', '/users/@me').then(u => (u as { id: string }).id));
    await page.evaluate(([g, id]) => (window as unknown as Win).__vokkoMock.requestAs('sam', 'PATCH', `/guilds/${g}/members/${id}`, { communication_disabled_until: new Date(Date.now() + 30 * 60_000).toISOString() }), [guild, nova]);
    const locked = page.locator('.chat-composer-locked');
    await expect(locked).toContainText(/timed out for (29|30) more minutes/);
    await expect(locked).not.toContainText('permission');
    await shot(page, 'timed-out');
    await page.evaluate(([g, id]) => (window as unknown as Win).__vokkoMock.requestAs('sam', 'PATCH', `/guilds/${g}/members/${id}`, { communication_disabled_until: new Date(Date.now() + 3 * 3_600_000).toISOString() }), [guild, nova]);
    await expect(locked).toContainText(/timed out until \d/);
  });

  test('being removed from a server says so, leaving does not', async ({ page }) => {
    await openGeneral(page, 'nova');
    const guild = await guildOf(page);
    const nova = await page.evaluate(() => (window as unknown as Win).__vokko.request('GET', '/users/@me').then(u => (u as { id: string }).id));
    await page.evaluate(([g, id]) => (window as unknown as Win).__vokkoMock.requestAs('sam', 'DELETE', `/guilds/${g}/members/${id}`), [guild, nova]);
    const dialog = page.getByRole('dialog', { name: "You're no longer in Sam's server" });
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(/\/channels\/@me/);
    await shot(page, 'guild-gone');
    await dialog.getByRole('button', { name: 'Okay' }).click();
    await expect(dialog).toHaveCount(0);

    // Own leave: no dialog.
    await page.goto('/channels/@me?as=carol&mockLatency=0');
    await page.waitForFunction(() => Object.values((window as unknown as Win).__vokko.appStore.getState().channels).some(c => c.name === 'general' && c.guild_id));
    await page.getByRole('link', { name: "Sam's server" }).first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Leave Server' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Leave Server' }).click();
    await expect(page.getByRole('link', { name: "Sam's server" })).toHaveCount(0);
    await page.waitForTimeout(500);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('deleting an emoji and revoking an invite ask first', async ({ page }) => {
    await openGeneral(page);
    if (view.name === 'phone') await page.getByRole('button', { name: 'Show Channels' }).tap();
    await page.locator('.guild-header-name-button').click();
    await page.getByRole('menuitem', { name: 'Server Settings' }).click();
    await page.getByRole('button', { name: 'Emoji', exact: true }).click();
    const rows = page.locator('.emoji-settings .emoji-row');
    await expect(rows).toHaveCount(4);
    const first = rows.first();
    const name = (await first.getByRole('button', { name: /^Delete / }).getAttribute('aria-label'))!.replace('Delete ', '');
    await first.getByRole('button', { name: `Delete ${name}` }).click();
    await expect(first.getByRole('button', { name: `Confirm delete ${name}` })).toBeFocused();
    await shot(page, 'emoji-confirm');
    await expect(rows).toHaveCount(4);
    await page.keyboard.press('Escape'); // cancels the step, the settings page stays
    await expect(first.getByRole('button', { name: `Confirm delete ${name}` })).toHaveCount(0);
    await expect(page.locator('.emoji-settings')).toBeVisible();
    await first.getByRole('button', { name: `Delete ${name}` }).click();
    await first.getByRole('button', { name: `Confirm delete ${name}` }).click();
    await expect(rows).toHaveCount(3);

    // Invite revoke asks the same way.
    const code = await page.evaluate(() => {
      const w = window as unknown as Win;
      return w.__vokko.request('POST', `/channels/${w.__vokko.appStore.getState().route.channelId}/invites`, { max_age: 86400, max_uses: 3 }).then(i => (i as { code: string }).code);
    });
    if (view.name === 'phone') await page.getByRole('button', { name: 'Back to sections' }).tap();
    await page.getByRole('button', { name: 'Invites', exact: true }).click();
    const invite = page.locator(`tr[data-code="${code}"]`);
    await invite.getByRole('button', { name: `Revoke invite ${code}` }).click();
    await expect(invite.getByRole('button', { name: `Confirm revoke invite ${code}` })).toBeFocused();
    await shot(page, 'invite-revoke');
    await page.keyboard.press('Escape');
    await expect(invite.getByRole('button', { name: `Confirm revoke invite ${code}` })).toHaveCount(0);
    await expect(invite).toHaveCount(1);
    await invite.getByRole('button', { name: `Revoke invite ${code}` }).click();
    await invite.getByRole('button', { name: `Confirm revoke invite ${code}` }).click();
    await expect(invite).toHaveCount(0);
  });

  test('names under a voice channel have readable contrast', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openGeneral(page, 'sam', true);
    await page.locator('.voice-user').first().waitFor();
    const results = await new AxeBuilder({ page }).include('.voice-users').withRules(['color-contrast']).analyze();
    expect(results.violations.map(v => v.nodes.map(n => n.html))).toEqual([]);
    await shot(page, 'voice-contrast');
  });
});
