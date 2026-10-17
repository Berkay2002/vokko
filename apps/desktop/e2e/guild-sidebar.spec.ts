import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// vokko-guild-sidebar (GLD-001/002/004/005/006/008/009/012): server header + dropdown, channel list states and drag-to-reorder,
// channel header toolbar + topic dialog, mark-as-read. Mock backend, sam (administrator of the demo server).
// Run from apps/desktop: npx playwright test -c e2e/guild-sidebar.config.ts

// Screenshots only when GUILD_SIDEBAR_SHOTS names a folder (a machine-specific default wrote into the tree elsewhere).
const SHOTS = process.env.GUILD_SIDEBAR_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

type Ch = { id: string; name?: string; guild_id: string | null; position: number; parent_id: string | null; type: number; topic: string | null; nsfw?: boolean };
type G = { id: string; name: string; banner?: string | null };
type Win = {
  __vokko: { appStore: { getState(): { channels: Record<string, Ch>; guilds: Record<string, G>; upsertChannel(c: Ch): void }; setState(fn: (s: { guilds: Record<string, G> }) => object): void } };
  __vokkoMock: { say(channelId: string, username: string, content: string): string; channelIdByName(name: string): string | null; rateLimit(count: number): void };
};

async function openChannel(page: Page, name: string): Promise<string> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.waitForFunction(n => Object.values((window as unknown as Win).__vokko.appStore.getState().channels).some(c => c.name === n && c.guild_id), name);
  const target = await page.evaluate(n => {
    const c = Object.values((window as unknown as Win).__vokko.appStore.getState().channels).find(x => x.name === n && x.guild_id)!;
    return `/channels/${c.guild_id}/${c.id}`;
  }, name);
  // A reload would re-seed the mock: navigate in-app.
  await page.evaluate(path => { history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, target);
  await page.locator('.channel-header').getByRole('heading', { name, exact: true }).waitFor();
  return target.split('/').pop()!;
}

const list = (page: Page) => page.getByRole('list', { name: 'Channels' });
const nameIs = (page: Page, name: string) => page.locator('.channel-name', { hasText: new RegExp(`^${name}$`) });
const row = (page: Page, name: string) => list(page).locator('a.channel-row', { has: nameIs(page, name) });
const rowWrap = (page: Page, name: string) => list(page).locator('li.channel-row-wrap', { has: page.locator('a.channel-row', { has: nameIs(page, name) }) });

/** Channel names of one category, in sidebar order. */
async function namesIn(page: Page, category: string): Promise<string[]> {
  const group = list(page).locator('li.category', { has: page.locator('.category-name', { hasText: category }) });
  return group.locator('a.channel-row .channel-name').allTextContents();
}

/** Mutates a channel in the client store (fields the mock seed has no UI to set, e.g. nsfw). */
async function patchChannel(page: Page, name: string, fields: Partial<Ch>): Promise<void> {
  await page.evaluate(([n, f]) => {
    const store = (window as unknown as Win).__vokko.appStore;
    const c = Object.values(store.getState().channels).find(x => x.name === n && x.guild_id)!;
    store.getState().upsertChannel({ ...c, ...(f as Partial<Ch>) });
  }, [name, fields] as const);
}

test('1. server header: dropdown items, per-server profile, hide muted, banner variant', async ({ page }) => {
  // Copy Server ID only shows in developer mode.
  await page.addInitScript(() => localStorage.setItem('vokko.prefs', JSON.stringify({ developerMode: true })));
  await openChannel(page, 'general');
  const header = page.locator('.guild-header');
  await header.getByRole('button', { name: "Sam's server" }).click();
  const menu = page.locator('.guild-menu');
  const labels = (await menu.getByRole('menuitem').allTextContents()).concat(await menu.getByRole('menuitemcheckbox').allTextContents());
  for (const label of ['Invite to Server', 'Server Settings', 'Create Channel', 'Create Category', 'Create Event', 'Notification Settings', 'Privacy Settings', 'Edit Per-server Profile', 'Hide Muted Channels', 'Copy Server ID']) {
    expect(labels).toContain(label);
  }
  // Nothing Vokko can't back is shown disabled any more (App Directory and Linked Roles are omitted).
  await expect(menu.locator('[aria-disabled="true"]')).toHaveCount(0);
  for (const omitted of ['App Directory', 'Linked Roles', 'Server Boost']) expect(labels).not.toContain(omitted);
  await shot(page, '01-server-dropdown');

  await menu.getByRole('menuitem', { name: 'Edit Per-server Profile' }).click();
  await expect(page.getByRole('heading', { name: 'Profiles' })).toBeVisible();
  // Opens on the per-server tab with this server picked.
  await expect(page.getByRole('tab', { name: 'Per-server profiles' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('combobox', { name: 'Server', exact: true })).toContainText("Sam's server");
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Profiles' })).toHaveCount(0);

  // Banner variant: the image fades in under a transparent header and fades out as the list scrolls.
  const banner = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="240"><defs><linearGradient id="g"><stop offset="0" stop-color="#3b5bdb"/><stop offset="1" stop-color="#e64980"/></linearGradient></defs><rect width="600" height="240" fill="url(#g)"/></svg>');
  await page.evaluate(url => {
    const store = (window as unknown as Win).__vokko.appStore;
    store.setState(s => {
      const [id, g] = Object.entries(s.guilds).find(([, x]) => x.name === "Sam's server")!;
      return { guilds: { ...s.guilds, [id]: { ...g, banner: url } } };
    });
  }, banner);
  await expect(page.locator('.guild-banner')).toBeVisible();
  await expect(header).toHaveClass(/over-banner/);
  await shot(page, '02-server-banner');
  await page.locator('.channel-scroller').evaluate(el => el.scrollTo({ top: 400 }));
  await expect(header).not.toHaveClass(/over-banner/);
  await expect(page.locator('.guild-banner')).toHaveCSS('opacity', '0');
});

test('2. channel list: hover actions, muted dimming + hide muted, nsfw icon, collapsed category keeps unread rows, drag to reorder', async ({ page }) => {
  await openChannel(page, 'general');
  await row(page, 'random').hover();
  await expect(row(page, 'random').getByRole('button', { name: 'Create Invite' })).toBeVisible();
  await expect(row(page, 'random').getByRole('button', { name: 'Edit Channel' })).toBeVisible();

  // mute #memes for 15 minutes: dimmed, then gone with Hide Muted Channels
  await row(page, 'memes').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Mute Channel' }).hover();
  await page.getByRole('menuitem', { name: 'For 15 Minutes' }).click();
  await expect(row(page, 'memes')).toHaveClass(/muted/);
  await patchChannel(page, 'dev-talk', { nsfw: true });
  await expect(row(page, 'dev-talk').getByRole('img', { name: 'Age-restricted' })).toBeVisible();
  await shot(page, '03-channel-states');
  await page.locator('.guild-header').getByRole('button', { name: "Sam's server" }).click();
  await page.locator('.guild-menu').getByRole('menuitemcheckbox', { name: 'Hide Muted Channels' }).click();
  await page.keyboard.press('Escape');
  await expect(row(page, 'memes')).toHaveCount(0);
  await page.locator('.guild-header').getByRole('button', { name: "Sam's server" }).click();
  await page.locator('.guild-menu').getByRole('menuitemcheckbox', { name: 'Hide Muted Channels' }).click();
  await page.keyboard.press('Escape');
  await expect(row(page, 'memes')).toHaveCount(1);

  // an unread channel stays visible under a collapsed category, next to the selected one
  const randomId = await page.evaluate(() => (window as unknown as Win).__vokkoMock.channelIdByName('random')!);
  await page.evaluate(id => (window as unknown as Win).__vokkoMock.say(id, 'alice', 'ping for the unread pill'), randomId);
  await expect(row(page, 'random')).toHaveClass(/unread/);
  await list(page).getByRole('button', { name: 'Text Channels' }).click();
  const collapsed = await namesIn(page, 'Text Channels');
  expect(collapsed).toEqual(expect.arrayContaining(['general', 'random']));
  expect(collapsed).not.toContain('memes'); // read and not selected: hidden while collapsed
  await shot(page, '04-collapsed-category-unread');
  await list(page).getByRole('button', { name: 'Text Channels' }).click();

  // drag #memes above #general: PATCH /guilds/{id}/channels, the sidebar follows CHANNEL_UPDATE
  const before = await namesIn(page, 'Text Channels');
  expect(before.indexOf('memes')).toBeGreaterThan(before.indexOf('general'));
  await rowWrap(page, 'memes').dragTo(rowWrap(page, 'general'), { targetPosition: { x: 40, y: 4 } });
  await expect.poll(async () => (await namesIn(page, 'Text Channels'))[0]).toBe('memes');
  // and into another category (Info), dropped on its header
  await rowWrap(page, 'memes').dragTo(list(page).locator('.category-header', { hasText: 'Info' }));
  await expect.poll(() => namesIn(page, 'Info')).toContain('memes');
  expect(await namesIn(page, 'Text Channels')).not.toContain('memes');
});

test('3. channel header: toolbar, muted bell, topic dialog, Edit Channel at the start of the channel', async ({ page }) => {
  await openChannel(page, 'dev-talk');
  const header = page.locator('.channel-header');
  for (const label of ['Threads', 'Notification Settings', 'Pinned Messages', /Member List/]) await expect(header.getByRole('button', { name: label })).toBeVisible();
  await expect(header.getByRole('button', { name: 'Search' }).or(header.getByRole('combobox')).or(header.getByLabel('Search')).first()).toBeVisible();

  await header.getByRole('button', { name: 'Notification Settings' }).click();
  await page.getByRole('menuitem', { name: 'Mute Channel' }).hover();
  await page.getByRole('menuitem', { name: 'For 1 Hour' }).click();
  await expect(header.getByRole('button', { name: 'Notification Settings' })).toHaveAttribute('aria-pressed', 'true');

  await header.getByRole('button', { name: /gateway protocol nerdery/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Rust, TypeScript and gateway protocol nerdery.');
  await shot(page, '05-topic-dialog');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // the start-of-channel header offers Edit Channel to managers (a fresh channel shows it at the top)
  await page.locator('.guild-header').getByRole('button', { name: "Sam's server" }).click();
  await page.locator('.guild-menu').getByRole('menuitem', { name: 'Create Channel' }).click();
  await page.getByRole('dialog').getByRole('textbox').first().fill('fresh-start');
  await page.getByRole('dialog').getByRole('button', { name: 'Create Channel' }).click();
  await page.locator('.channel-header').getByRole('heading', { name: 'fresh-start' }).waitFor();
  await expect(page.getByRole('button', { name: 'Edit Channel' }).last()).toBeVisible();
  await shot(page, '06-channel-start-edit');
});

test('4. channel menu: Mark As Read hits the ack route and clears the unread state', async ({ page }) => {
  await openChannel(page, 'general');
  const randomId = await page.evaluate(() => (window as unknown as Win).__vokkoMock.channelIdByName('random')!);
  await page.evaluate(id => (window as unknown as Win).__vokkoMock.say(id, 'alice', 'something to read'), randomId);
  await expect(row(page, 'random')).toHaveClass(/unread/);
  await row(page, 'random').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Mark As Read' }).click();
  await expect(row(page, 'random')).not.toHaveClass(/unread/);
});

test('5. keyboard reorder: Move Up / Move to Category from the context menu, announced; a failed move shows a toast and nothing moves', async ({ page }) => {
  await openChannel(page, 'general');
  const toast = page.locator('.chat-toasts');
  const before = await namesIn(page, 'Text Channels');
  const index = before.indexOf('memes');
  expect(index).toBeGreaterThan(0);

  // Shift+F10 opens the row's context menu from the keyboard (PR #30); Move Up sends the same PATCH as a drag.
  // Any scroll closes a context menu: wait until the message list has finished scrolling to the bottom.
  await page.evaluate(() => new Promise<void>(resolve => {
    let timer = setTimeout(done, 600);
    function done() { document.removeEventListener('scroll', bump, true); resolve(); }
    function bump() { clearTimeout(timer); timer = setTimeout(done, 600); }
    document.addEventListener('scroll', bump, true);
  }));
  await expect(async () => {
    await row(page, 'memes').focus();
    await page.keyboard.press('Shift+F10');
    await expect(page.getByRole('menuitem', { name: 'Move Up' })).toBeVisible({ timeout: 1000 });
  }).toPass();
  await shot(page, '07-move-menu');
  // arrows to Move Up, Enter selects
  const focused = () => page.locator('.context-menu-item.focused').first().textContent({ timeout: 1000 });
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('ArrowDown');
    if ((await focused())?.trim() === 'Move Up') break;
  }
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await namesIn(page, 'Text Channels')).indexOf('memes')).toBe(index - 1);
  await expect(toast).toContainText(`Moved memes above ${before[index - 1]}.`);
  // Read out once: the visual toast is aria-hidden and the shell announcer is the only live region holding the text.
  const said = `Moved memes above ${before[index - 1]}.`;
  await expect(page.locator('[role="status"], [role="alert"], [aria-live]:not([aria-live="off"])').filter({ hasText: said })).toHaveCount(1);
  await expect(page.getByTestId('announcer')).toHaveText(said);

  // the request is refused (429 here; a 403 takes the same path): the toast says so and the list stays as it was
  const settled = await namesIn(page, 'Text Channels');
  await row(page, 'memes').click({ button: 'right' });
  await page.evaluate(() => (window as unknown as Win).__vokkoMock.rateLimit(50)); // every call fails until reset (background calls would use up a single one)
  await page.getByRole('menuitem', { name: 'Move Down' }).click();
  await expect(toast).toContainText("Couldn't move the channel.");
  expect(await namesIn(page, 'Text Channels')).toEqual(settled);
  await page.evaluate(() => (window as unknown as Win).__vokkoMock.rateLimit(0));

  await row(page, 'memes').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to Category' }).hover();
  await page.getByRole('menuitem', { name: 'Info', exact: true }).click();
  await expect.poll(() => namesIn(page, 'Info')).toContain('memes');
  await expect(toast).toContainText('Moved memes to Info.');
});

test('6. channel row states (GLD-006): rest, hover, selected, unread with badge and muted against guild/spec.md', async ({ page }) => {
  await openChannel(page, 'general');
  const style = (name: string) => row(page, name).evaluate(a => {
    const css = (e: Element) => getComputedStyle(e);
    const cs = css(a), nameCs = css(a.querySelector('.channel-name')!), pill = getComputedStyle(a, '::before'), badge = a.querySelector('.count-badge');
    const rect = a.getBoundingClientRect(), icon = a.querySelector('.channel-icon')!.getBoundingClientRect();
    return {
      height: rect.height, padding: cs.padding, radius: cs.borderRadius, gap: cs.gap, bg: cs.backgroundColor, color: cs.color, opacity: cs.opacity,
      nameWeight: nameCs.fontWeight, nameSize: nameCs.fontSize, nameLine: nameCs.lineHeight, icon: [icon.width, icon.height],
      pill: pill.position === 'absolute' ? [pill.width, pill.height] : null, badge: badge ? [badge.getBoundingClientRect().height, css(badge).borderRadius, css(badge).fontWeight] : null,
    };
  });
  // A token resolved through the property it is used for (a colour, or the border radius).
  const token = (name: string, prop: 'color' | 'borderRadius' | 'backgroundColor' = 'color') => page.evaluate(([n, p]) => { const probe = document.createElement('i'); probe.style[p as 'color'] = `var(${n})`; document.body.append(probe); const c = getComputedStyle(probe)[p as 'color']; probe.remove(); return c; }, [name, prop] as const);
  const fill = await token('--interactive-background-hover', 'backgroundColor');
  const rest = await token('--channels-default'), text = await token('--text-default'), strong = await token('--text-strong');

  // rest: 32 high, padding 4/8, radius 8, 20 px icon, 8 gap, 16/24 w400 in --channels-default, no fill
  const idle = await style('memes');
  expect(idle).toMatchObject({ height: 32, padding: '4px 8px', radius: await token('--radius-sm', 'borderRadius'), gap: '8px', bg: 'rgba(0, 0, 0, 0)', color: rest, nameWeight: '400', nameSize: '16px', nameLine: '24px', icon: [20, 20], pill: null, badge: null, opacity: '1' });

  // hover: the 12 % fill and the text moves to --text-default
  await row(page, 'memes').hover();
  expect(await style('memes')).toMatchObject({ bg: fill, color: text, nameWeight: '400' });

  // selected: same fill, w500 --text-default
  await page.mouse.move(700, 400);
  expect(await style('general')).toMatchObject({ bg: fill, color: text, nameWeight: '500' });

  // unread: strong text at w600 with the 4x8 left pill; a mention adds the 16 px red count badge
  const randomId = await page.evaluate(() => (window as unknown as Win).__vokkoMock.channelIdByName('random')!);
  await page.evaluate(id => (window as unknown as Win).__vokkoMock.say(id, 'alice', 'something to read'), randomId);
  await expect(row(page, 'random')).toHaveClass(/unread/);
  expect(await style('random')).toMatchObject({ color: strong, nameWeight: '600', pill: ['4px', '8px'], bg: 'rgba(0, 0, 0, 0)' });
  await page.evaluate(id => (window as unknown as Win).__vokkoMock.say(id, 'alice', '@everyone look'), randomId);
  await expect(row(page, 'random').locator('.count-badge')).toBeVisible();
  expect((await style('random')).badge).toEqual([16, '8px', '700']);
  await row(page, 'random').hover();
  expect(await style('random')).toMatchObject({ bg: fill, color: strong, nameWeight: '600' });

  // muted: half opacity at rest, no unread pill even when something arrives
  await row(page, 'memes').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Mute Channel' }).hover();
  await page.getByRole('menuitem', { name: 'For 15 Minutes' }).click();
  await page.mouse.move(700, 400);
  const memesId = await page.evaluate(() => (window as unknown as Win).__vokkoMock.channelIdByName('memes')!);
  await page.evaluate(id => (window as unknown as Win).__vokkoMock.say(id, 'alice', 'quiet'), memesId);
  expect(await style('memes')).toMatchObject({ opacity: '0.5', color: rest, pill: null, nameWeight: '400' });
});

test('guild Privacy Settings: Direct Messages switch persists per server (GLD-012)', async ({ page }) => {
  await openChannel(page, 'general');
  const open = async () => {
    await page.locator('.guild-header').getByRole('button', { name: "Sam's server" }).click();
    await page.locator('.guild-menu').getByRole('menuitem', { name: 'Privacy Settings' }).click();
    return page.getByRole('dialog');
  };
  let dialog = await open();
  await expect(dialog.getByText('Allow direct messages from other members in this server.')).toBeVisible();
  await expect(dialog.getByText('This setting is applied to this server only. Friends can always message you.')).toBeVisible();
  const toggle = dialog.getByRole('switch', { name: 'Direct Messages' });
  await expect(toggle).toBeEnabled();
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await page.keyboard.press('Escape');
  dialog = await open();
  await expect(dialog.getByRole('switch', { name: 'Direct Messages' })).not.toBeChecked();
});

test('Hide Muted Channels brings a channel back when its timed mute lapses, without another update', async ({ page }) => {
  await page.clock.install();
  await openChannel(page, 'general');
  await page.clock.resume();
  await row(page, 'memes').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Mute Channel' }).hover();
  await page.getByRole('menuitem', { name: 'For 15 Minutes' }).click();
  await page.locator('.guild-header').getByRole('button', { name: "Sam's server" }).click();
  await page.locator('.guild-menu').getByRole('menuitemcheckbox', { name: 'Hide Muted Channels' }).click();
  await page.keyboard.press('Escape');
  await expect(row(page, 'memes')).toHaveCount(0);
  await page.clock.fastForward('16:00');
  await expect(row(page, 'memes')).toHaveCount(1);
});

test('channel topic toolbar wraps the selection in markdown and a second click unwraps it', async ({ page }) => {
  await openChannel(page, 'general');
  await row(page, 'random').hover();
  await row(page, 'random').getByRole('button', { name: 'Edit Channel' }).click();
  const topic = page.getByRole('textbox', { name: 'Channel topic' });
  await topic.fill('read the rules');
  await topic.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(9, 14));
  const toolbar = page.getByRole('toolbar', { name: 'Topic formatting' });
  await toolbar.getByRole('button', { name: 'Bold' }).click();
  await expect(topic).toHaveValue('read the **rules**');
  await toolbar.getByRole('button', { name: 'Spoiler' }).click();
  await expect(topic).toHaveValue('read the **||rules||**');
  await toolbar.getByRole('button', { name: 'Spoiler' }).click();
  await toolbar.getByRole('button', { name: 'Bold' }).click();
  await expect(topic).toHaveValue('read the rules');
});
