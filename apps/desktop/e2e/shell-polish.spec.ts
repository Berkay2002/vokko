import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { stays } from './helpers';

// Shell polish round (mac-shell-polish): voice row hooks, channel list under the user panel, topic dialog, friend More menu.

async function openGuild(page: Page): Promise<void> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  await page.getByRole('link', { name: "Sam's server" }).click();
  await page.locator('.guild-sidebar .channel-row').first().waitFor();
}

test('muting a voice channel keeps the sidebar rendered (no hook-order crash)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await openGuild(page);
  const rows = page.locator('.guild-sidebar .channel-row');
  const before = await rows.count();
  const voice = page.locator('.channel-row.voice', { hasText: 'Gaming' });
  await voice.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Mute Channel' }).click();
  await page.getByRole('menuitem', { name: 'For 15 Minutes' }).click();
  await expect(voice).toHaveClass(/muted/);
  await expect(rows).toHaveCount(before);
  await expect(page.locator('.guild-sidebar')).toBeVisible();
  expect(errors).toEqual([]);
});

// Windows at 100 / 150 / 200 % zoom: the CSS viewport shrinks by the zoom factor, as browser zoom does. The last case is the
// app's own chat font-size pref (root font-size 150 %).
const ZOOMS = [
  { name: '100%', viewport: { width: 1440, height: 900 }, dsf: 1, fontSize: 16 },
  { name: '150%', viewport: { width: 960, height: 600 }, dsf: 1.5, fontSize: 16 },
  { name: '200%', viewport: { width: 800, height: 450 }, dsf: 2, fontSize: 16 },
  { name: 'font size 24', viewport: { width: 1440, height: 900 }, dsf: 1, fontSize: 24 },
];

for (const zoom of ZOOMS) {
  test(`channel list and rail end above the floating user panel at ${zoom.name}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: zoom.viewport, deviceScaleFactor: zoom.dsf, colorScheme: 'dark' });
    const page = await context.newPage();
    await page.addInitScript(size => localStorage.setItem('vokko.prefs', JSON.stringify({ fontSize: size })), zoom.fontSize);
    await openGuild(page);
    const scroller = page.locator('.channel-scroller');
    await scroller.evaluate(e => { e.scrollTop = e.scrollHeight; });
    const m = await page.evaluate(() => {
      const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
      const rows = [...document.querySelectorAll('.channel-scroller .channel-row-wrap')];
      const scrollerEl = document.querySelector('.channel-scroller')!;
      return {
        panel: r('.user-panel').toJSON(),
        scroller: r('.channel-scroller').toJSON(),
        rail: r('.server-rail').toJSON(),
        lastRow: rows[rows.length - 1].getBoundingClientRect().toJSON(),
        scrolls: scrollerEl.scrollHeight > scrollerEl.clientHeight,
      };
    });
    expect(m.scrolls).toBe(true);
    // Discord: the scroller ends 16 px under the panel top (margin-bottom panel height - 8, padding-bottom 16).
    expect(m.scroller.bottom - m.panel.top).toBeCloseTo(16, 0);
    expect(m.scroller.bottom).toBeLessThan(m.panel.bottom);
    expect(m.rail.bottom).toBeCloseTo(m.scroller.bottom, 0);
    // Scrolled to the end, the last row stops above the panel instead of running under it.
    expect(m.lastRow.bottom).toBeLessThanOrEqual(m.panel.top);
    expect(m.panel.top - m.lastRow.bottom).toBeLessThan(24);
    await context.close();
  });
}

test('in a call the list ends above the call card, not under it', async ({ page }) => {
  await openGuild(page);
  await page.getByRole('button', { name: 'General voice channel' }).click();
  await expect(page.getByRole('region', { name: 'Voice connection' }).getByRole('status')).toHaveText('Voice Connected');
  await page.locator('.channel-scroller').evaluate(e => { e.scrollTop = e.scrollHeight; });
  const m = await page.evaluate(() => {
    const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
    const rows = [...document.querySelectorAll('.channel-scroller .channel-row-wrap')];
    return { card: r('.voice-panel').toJSON(), scroller: r('.channel-scroller').toJSON(), rail: r('.server-rail').toJSON(), lastRow: rows[rows.length - 1].getBoundingClientRect().toJSON() };
  });
  expect(m.lastRow.bottom).toBeLessThanOrEqual(m.card.top);
  expect(m.card.top - m.lastRow.bottom).toBeLessThan(24);
});

test('the header topic opens a dialog that renders the topic as markdown (link, channel mention, emoji)', async ({ page }) => {
  await openGuild(page);
  await page.getByRole('link', { name: /^stock-talk/ }).first().click();
  await page.locator('.chat-textarea').waitFor();
  await page.evaluate(async () => {
    type W = { __vokko: { appStore: { getState(): { channels: Record<string, { id: string; name?: string }> } }; request(m: string, p: string, b?: unknown): Promise<unknown> } };
    const w = window as unknown as W;
    const stock = Object.values(w.__vokko.appStore.getState().channels).find(c => c.name === 'stock-talk')!;
    const general = Object.values(w.__vokko.appStore.getState().channels).find(c => c.name === 'general')!;
    await w.__vokko.request('PATCH', `/channels/${stock.id}`, { topic: `Read **the rules** at https://example.com/rules then see <#${general.id}> :smile: ${'and a long tail of words '.repeat(12)}` });
  });
  const topic = page.locator('.channel-header-topic-open');
  // The PATCH resolves before the gateway CHANNEL_UPDATE reaches the store, so the seeded one-line topic is visible until then.
  await expect(topic).toHaveAccessibleName(/^Channel topic: Read the rules at https:\/\/example\.com\/rules then see #general/);
  // The header renders the topic as inline markdown on one line: no asterisks, a link, a channel chip.
  const line = page.locator('.channel-header-topic-text');
  await expect(line.locator('strong')).toHaveText('the rules');
  await expect(line).not.toContainText('**');
  await expect(line.locator('p, h1, h2, h3')).toHaveCount(0);
  // The header cuts the topic, never the channel name.
  const cut = await page.evaluate(() => {
    const t = document.querySelector('.channel-header-topic-text')!;
    const n = document.querySelector('.channel-header-name')!;
    return { topic: t.scrollWidth > t.clientWidth, name: n.scrollWidth > n.clientWidth };
  });
  expect(cut).toEqual({ topic: true, name: false });
  await expect(topic).toHaveAttribute('aria-haspopup', 'dialog');
  // A link in the header asks first and does not also open the topic dialog.
  await line.locator('a.md-link').click();
  await expect(page.getByRole('dialog', { name: 'Leaving Vokko' })).toContainText('https://example.com/rules');
  await page.getByRole('dialog', { name: 'Leaving Vokko' }).getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await topic.click();
  const dialog = page.getByRole('dialog', { name: /stock-talk/ });
  await expect(dialog.locator('strong')).toHaveText('the rules');
  await expect(dialog.locator('a.md-link')).toHaveAttribute('href', 'https://example.com/rules');
  await expect(dialog.locator('.md-mention')).toHaveText('#general');
  await expect(dialog.getByRole('img', { name: /smile/ })).toBeVisible();
  // Links ask first, like in the chat.
  await dialog.locator('a.md-link').click();
  const leaving = page.getByRole('dialog', { name: 'Leaving Vokko' });
  await expect(leaving).toBeVisible();
  await expect(leaving).toContainText('https://example.com/rules');
  await leaving.getByRole('button', { name: 'Cancel' }).click();
  await expect(leaving).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('channel header toolbar: 32 px buttons at a 40 px pitch, search 244x32 with radius 8, focus ring and filter popout; Threads opens the thread list', async ({ page }) => {
  await openGuild(page);
  await page.getByRole('link', { name: /^stock-talk/ }).first().click();
  const header = page.locator('.channel-header');
  const search = header.locator('.header-search');
  await expect(search).toBeVisible();
  const buttons = await header.locator('.toolbar-button').evaluateAll(els => els.map(e => e.getBoundingClientRect()).map(r => ({ x: r.x, w: r.width, h: r.height })));
  buttons.forEach(b => (expect(b.w).toBeCloseTo(32, 0), expect(b.h).toBeCloseTo(32, 0)));
  buttons.slice(1).forEach((b, i) => expect(b.x - buttons[i]!.x).toBeCloseTo(40, 0));
  const box = (await search.boundingBox())!;
  expect(box.width).toBeCloseTo(244, 0);
  expect(box.height).toBeCloseTo(32, 0);
  expect(buttons.at(-1)!.x + 32 + 8).toBeCloseTo(box.x, 0);
  await expect(search).toHaveCSS('border-radius', '8px');

  await header.getByRole('combobox', { name: 'Search' }).click();
  await expect(search).toHaveCSS('outline-style', 'solid');
  await expect(page.getByRole('listbox', { name: 'Search suggestions' })).toBeVisible();
  await page.keyboard.press('Escape');

  await header.getByRole('button', { name: 'Threads', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Threads' })).toBeVisible();
});

test('friend row right-click menu: Message, Remove Friend, Block, Copy User ID; Block moves the friend to Blocked', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(() => localStorage.setItem('vokko.prefs', JSON.stringify({ developerMode: true }))); // Copy User ID is a developer-mode item
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  await page.getByRole('tab', { name: 'All' }).click();
  const row = page.locator('.people-row', { hasText: 'Alice' });
  await row.click({ button: 'right' });
  const labels = await page.getByRole('menuitem').allTextContents();
  expect(labels).toEqual(['Message', 'Remove Friend', 'Block', 'Copy User ID']);
  await page.getByRole('menuitem', { name: 'Copy User ID' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^\d+$/);
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Block' }).click();
  // Cancel keeps the friend; only the dialog's Block sends the PUT
  const dialog = page.getByRole('dialog', { name: 'Block Alice' });
  await expect(dialog).toContainText('Are you sure you want to block Alice?');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await stays(() => row.count(), 1);
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Block' }).click();
  await dialog.getByRole('button', { name: 'Block' }).click();
  await expect(row).toHaveCount(0);
  await page.getByRole('tab', { name: 'Blocked' }).click();
  await expect(page.locator('.people-row', { hasText: 'Alice' })).toHaveCount(1);
});
