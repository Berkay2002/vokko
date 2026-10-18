import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { channelIdOf, openStockTalk } from './helpers';
import { openChannel, openThreadFromPopout, panel } from './threadHelpers';

// Mention clicks and links on every surface that renders chat markdown: messages, pins, search results, topic dialog.
test.use({ viewport: { width: 1440, height: 900 } });

interface Ids { stock: string; general: string; alice: string; role: string | null; category: { id: string; name: string }; voice: { id: string; name: string } }

type W = {
  __vokko: {
    appStore: { getState(): {
      channels: Record<string, { id: string; name?: string; type: number; guild_id: string | null }>;
      users: Record<string, { id: string; username: string }>;
      guilds: Record<string, { id: string; roles: { id: string; name: string }[] }>;
    } };
    request(method: string, path: string, body?: unknown): Promise<{ id: string }>;
  };
};

// The pinned probe message, unpinned again after each test so pins do not pile up if a test run is reused.
let pinned: { channel: string; message: string } | null = null;
test.afterEach(async ({ page }) => {
  const p = pinned;
  pinned = null;
  if (!p || page.isClosed()) return;
  await page.evaluate(async ({ channel, message }) => {
    await (window as unknown as W).__vokko.request('DELETE', `/channels/${channel}/messages/pins/${message}`);
  }, p).catch(() => undefined);
});

/** Opens #stock-talk and posts one message carrying every kind of chip plus a link; pins it. */
async function setup(page: Page, topic?: string): Promise<Ids> {
  const stock = await openStockTalk(page);
  const found = await page.evaluate(async ({ stock, topic }) => {
    const w = window as unknown as W;
    const s = w.__vokko.appStore.getState();
    const general = Object.values(s.channels).find(c => c.name === 'general')!.id;
    const alice = Object.values(s.users).find(u => u.username === 'alice')!.id;
    const guild = s.guilds[s.channels[stock]!.guild_id!]!;
    const role = guild.roles.find(r => r.id !== guild.id)?.id ?? null;
    const category = Object.values(s.channels).find(c => c.type === 4 && c.guild_id === guild.id)!;
    const voice = Object.values(s.channels).find(c => c.type === 2 && c.name === 'AFK')!;
    const content = `mentionprobe <@${alice}> <#${general}> ${role ? `<@&${role}> ` : ''}<@999000000000001> <#999000000000002> <#${category.id}> <#${voice.id}> https://example.com/probe`;
    const msg = await w.__vokko.request('POST', `/channels/${stock}/messages`, { content });
    await w.__vokko.request('PUT', `/channels/${stock}/messages/pins/${msg.id}`);
    if (topic) await w.__vokko.request('PATCH', `/channels/${stock}`, { topic: topic.replace('ALICE', `<@${alice}>`).replace('GENERAL', `<#${general}>`) });
    return { stock, general, alice, role, category: { id: category.id, name: category.name! }, voice: { id: voice.id, name: voice.name! }, pinnedId: msg.id };
  }, { stock, topic });
  const { pinnedId, ...ids } = found;
  pinned = { channel: stock, message: pinnedId };
  await expect(page.locator('.chat-msg', { hasText: 'mentionprobe' }).first()).toBeVisible();
  return ids;
}

const chip = (scope: ReturnType<Page['locator']>, text: string) => scope.locator('.md-mention', { hasText: text }).first();
const card = (page: Page) => page.locator('.profile-card');

test('message: a user mention opens the profile card at the mention, a channel mention navigates', async ({ page }) => {
  const ids = await setup(page);
  const msg = page.locator('.chat-msg', { hasText: 'mentionprobe' }).first();
  await chip(msg, '@Alice').click();
  await expect(card(page)).toBeVisible();
  await expect(card(page)).toContainText('alice');
  // Only a card opened from inside a dialog goes above the modal layer.
  await expect(card(page)).not.toHaveClass(/above-modal/);
  const [c, m] = await Promise.all([card(page).boundingBox(), chip(msg, '@Alice').boundingBox()]);
  // Anchored at the mention: beside it and spanning its row.
  expect(c!.x >= m!.x + m!.width - 1 || c!.x + c!.width <= m!.x + 1).toBe(true);
  expect(c!.y <= m!.y + m!.height && c!.y + c!.height >= m!.y).toBe(true);
  await page.keyboard.press('Escape');
  await expect(card(page)).toHaveCount(0);

  await chip(msg, '#general').click();
  await expect.poll(() => channelIdOf(page)).toBe(ids.general);
});

test('message: unknown users and channels are plain pills, a role chip is not a link', async ({ page }) => {
  const ids = await setup(page);
  const msg = page.locator('.chat-msg', { hasText: 'mentionprobe' }).first();
  await expect(chip(msg, '@unknown-user')).not.toHaveAttribute('role', 'button');
  await expect(chip(msg, '#unknown-channel')).not.toHaveAttribute('role', 'button');
  await expect(chip(msg, '@unknown-user')).toHaveCSS('cursor', 'auto');
  await chip(msg, '#unknown-channel').click();
  await chip(msg, '@unknown-user').click();
  await expect(card(page)).toHaveCount(0);
  expect(channelIdOf(page)).toBe(ids.stock);
  await expect(chip(msg, '@Alice')).toHaveAttribute('role', 'button');
  await expect(chip(msg, '@Alice')).toHaveCSS('cursor', 'pointer');
  if (ids.role) {
    await expect(msg.locator('.md-mention-role')).not.toHaveAttribute('role', 'button');
    await msg.locator('.md-mention-role').click();
    await expect(card(page)).toHaveCount(0);
    expect(channelIdOf(page)).toBe(ids.stock);
  }
});

test('pins: user mention opens the card over the popout, channel mention navigates and closes the popout, links ask first', async ({ page }) => {
  const ids = await setup(page);
  const pins = () => page.getByRole('dialog', { name: 'Pinned Messages' });
  await page.getByRole('button', { name: 'Pinned Messages', exact: true }).click();
  await expect(pins().locator('.chat-pin', { hasText: 'mentionprobe' })).toBeVisible();

  await chip(pins(), '@Alice').click();
  await expect(card(page)).toBeVisible();
  // A real click inside the card must land on the card (not on something covering it) and must not close the popout under it.
  await card(page).locator('.profile-username').click();
  await expect(card(page)).toBeVisible();
  await expect(pins()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card(page)).toHaveCount(0);
  await expect(pins()).toBeVisible();

  const [popup] = await Promise.all([
    page.waitForEvent('popup', { timeout: 1500 }).catch(() => null),
    pins().locator('a.md-link').click(),
  ]);
  expect(popup).toBeNull();
  const leaving = page.getByRole('dialog', { name: 'Leaving Vokko' });
  await expect(leaving).toContainText('https://example.com/probe');
  await leaving.locator('.chat-modal-url').click();
  await expect(leaving).toBeVisible();
  await expect(pins()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(leaving).toHaveCount(0);
  await expect(pins()).toBeVisible();

  await chip(pins(), '#general').click();
  await expect.poll(() => channelIdOf(page)).toBe(ids.general);
  await expect(pins()).toHaveCount(0);
});

test('topic dialog: user mention opens the card above the dialog, channel mention closes it and navigates', async ({ page }) => {
  const ids = await setup(page, 'Read the rules, ask ALICE in GENERAL');
  const topic = page.locator('.channel-header-topic-open');
  await topic.click({ position: { x: 4, y: 4 } }); // the middle may be a link, which sits above the button
  const dialog = page.getByRole('dialog', { name: /stock-talk/ });
  await chip(dialog, '@Alice').click();
  await expect(card(page)).toBeVisible();
  await expect(card(page)).toHaveClass(/above-modal/);
  await card(page).locator('.profile-username').click();
  await expect(card(page)).toBeVisible();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card(page)).toHaveCount(0);
  await expect(dialog).toBeVisible();

  // Keyboard: the card takes focus from the dialog's trap, Tab cycles inside it, Escape gives focus back to the chip.
  await chip(dialog, '@Alice').focus();
  await page.keyboard.press('Enter');
  await expect(card(page)).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Alice' })).toBeVisible();
  const insideCard = () => page.evaluate(() => !!document.activeElement?.closest('.profile-card'));
  await expect.poll(insideCard).toBe(true);
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press('Tab');
    expect(await insideCard(), `Tab #${i + 1} stayed in the card`).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(card(page)).toHaveCount(0);
  await expect(chip(dialog, '@Alice')).toBeFocused();
  await expect(dialog).toBeVisible();

  await chip(dialog, '#general').click();
  await expect.poll(() => channelIdOf(page)).toBe(ids.general);
  await expect(dialog).toHaveCount(0);
});

test('search results: mentions work and a link asks before leaving', async ({ page }) => {
  const ids = await setup(page);
  const box = page.getByRole('combobox', { name: 'Search' });
  await box.click();
  await box.fill('mentionprobe');
  await box.press('Enter');
  const hit = page.locator('.search-panel .search-hit', { hasText: 'mentionprobe' }).first();
  await expect(hit).toBeVisible();

  await chip(hit, '@Alice').click();
  await expect(card(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card(page)).toHaveCount(0);

  const [popup] = await Promise.all([
    page.waitForEvent('popup', { timeout: 1500 }).catch(() => null),
    hit.locator('a.md-link').click(),
  ]);
  expect(popup).toBeNull();
  const leaving = page.getByRole('dialog', { name: 'Leaving Vokko' });
  await expect(leaving).toContainText('https://example.com/probe');
  await leaving.getByRole('button', { name: 'Cancel' }).click();
  await expect(leaving).toHaveCount(0);

  await chip(hit, '#general').click();
  await expect.poll(() => channelIdOf(page)).toBe(ids.general);
});

test('thread panel pins: user mention opens the card, channel mention navigates and closes the popout, links ask first', async ({ page }) => {
  const general = await openChannel(page, 'general');
  let stock = '';
  await openThreadFromPopout(page, 'gateway docs');
  const found = await page.evaluate(async () => {
    type TW = { __vokko: { appStore: { getState(): { threads: Record<string, { id: string; name?: string }>; channels: Record<string, { id: string; name?: string }>; users: Record<string, { id: string; username: string }> } };
      request(m: string, p: string, b?: unknown): Promise<{ id: string }> } };
    const w = window as unknown as TW;
    const s = w.__vokko.appStore.getState();
    const thread = Object.values(s.threads).find(t => t.name === 'gateway docs')!.id;
    const stock = Object.values(s.channels).find(c => c.name === 'stock-talk')!.id;
    const alice = Object.values(s.users).find(u => u.username === 'alice')!.id;
    const msg = await w.__vokko.request('POST', `/channels/${thread}/messages`, { content: `threadprobe <@${alice}> <#${stock}> https://example.com/thread` });
    await w.__vokko.request('PUT', `/channels/${thread}/messages/pins/${msg.id}`);
    return { alice, stock, thread, message: msg.id };
  });
  stock = found.stock;
  pinned = { channel: found.thread, message: found.message };
  expect(stock).not.toBe(general);
  const header = panel(page).locator('.thread-panel-header');
  await header.getByRole('button', { name: 'Pinned Messages' }).click();
  const pins = page.locator('.pins-popout-host').getByRole('dialog', { name: 'Pinned Messages' });
  await expect(pins.locator('.chat-pin', { hasText: 'threadprobe' })).toBeVisible();

  await chip(pins, '@Alice').click();
  await expect(card(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card(page)).toHaveCount(0);

  await pins.locator('a.md-link').click();
  const leaving = page.getByRole('dialog', { name: 'Leaving Vokko' });
  await expect(leaving).toContainText('https://example.com/thread');
  await page.keyboard.press('Escape');
  await expect(leaving).toHaveCount(0);
  await expect(pins).toBeVisible();

  await chip(pins, '#stock-talk').click();
  await expect.poll(() => channelIdOf(page)).toBe(stock);
  await expect(page.locator('.pins-popout-host')).toHaveCount(0);
});

test('a voice channel mention opens the voice page and does not join', async ({ page }) => {
  const ids = await setup(page);
  const msg = page.locator('.chat-msg', { hasText: 'mentionprobe' }).first();
  await chip(msg, `#${ids.voice.name}`).click();
  await expect.poll(() => channelIdOf(page)).toBe(ids.voice.id);
  await expect(page.getByRole('button', { name: 'Join Voice Channel' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Voice connection' })).toHaveCount(0);
  await expect(page.getByText('Voice Connected')).toHaveCount(0);
});

test('a category chip is a plain pill, a click does nothing', async ({ page }) => {
  const ids = await setup(page);
  const msg = page.locator('.chat-msg', { hasText: 'mentionprobe' }).first();
  const chipEl = chip(msg, `#${ids.category.name}`);
  await expect(chipEl).toBeVisible();
  await expect(chipEl).not.toHaveAttribute('role', 'button');
  await expect(chipEl).not.toHaveAttribute('tabindex', /.*/);
  await chipEl.click();
  expect(channelIdOf(page)).toBe(ids.stock);
});

test('keyboard: Enter and Space activate a chip', async ({ page }) => {
  const ids = await setup(page);
  const msg = page.locator('.chat-msg', { hasText: 'mentionprobe' }).first();
  await chip(msg, '@Alice').focus();
  await page.keyboard.press('Enter');
  await expect(card(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card(page)).toHaveCount(0);
  await chip(msg, '@Alice').focus();
  await page.keyboard.press('Space');
  await expect(card(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await chip(msg, '#general').focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => channelIdOf(page)).toBe(ids.general);
});

test('a modal opened over a normal profile card closes the card', async ({ page }) => {
  await setup(page);
  const msg = page.locator('.chat-msg', { hasText: 'mentionprobe' }).first();
  await chip(msg, '@Alice').click();
  await expect(card(page)).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('dialog', { name: /quick switcher|Where would you like to go/i })).toBeVisible();
  await expect(card(page)).toHaveCount(0);
});
