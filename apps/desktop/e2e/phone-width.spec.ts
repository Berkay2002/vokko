import { expect, test, type Locator, type Page } from '@playwright/test';
import { openChannel } from './threadHelpers';

// Phone width (390x844, styles/responsive.css <= 767px): screens that ran off the right edge. Each test checks that what the
// user needs is inside the window. VOKKO_SHOTS_DIR saves a screenshot per screen.

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

const W = 390;
const SHOTS = process.env.VOKKO_SHOTS_DIR;
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };

type StoreWin = { __vokko: { appStore: { getState(): { channels: Record<string, { id: string; name?: string; guild_id: string | null }> } } } };

/** Fully inside the window horizontally (1px for subpixel rounding). */
async function inside(l: Locator): Promise<void> {
  const b = (await l.boundingBox())!;
  expect(b.x).toBeGreaterThanOrEqual(-1);
  expect(b.x + b.width).toBeLessThanOrEqual(W + 1);
}

async function home(page: Page): Promise<void> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.waitForFunction(() => Object.values((window as unknown as StoreWin).__vokko.appStore.getState().channels).some(c => c.name === 'stock-talk'));
}

/** Opens #stock-talk's chat (the list page first, then a tap on the channel), as mobile.spec.ts does. */
async function openStockTalk(page: Page): Promise<void> {
  await home(page);
  const target = await page.evaluate(() => {
    const c = Object.values((window as unknown as StoreWin).__vokko.appStore.getState().channels).find(x => x.name === 'stock-talk')!;
    return `/channels/${c.guild_id}/${c.id}`;
  });
  await page.evaluate(path => { history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, target);
  await page.locator('a.channel-row[aria-current="page"]').first().tap();
  await page.locator('.chat-msg').first().waitFor();
}

test('search: the results are a full-width page; a tap on a result jumps to it in the chat', async ({ page }) => {
  await openStockTalk(page);
  const box = page.getByRole('combobox', { name: 'Search' });
  await box.tap();
  await box.fill('morning');
  await box.press('Enter');
  const panel = page.locator('.search-panel');
  await expect(panel.locator('.search-panel-count')).toHaveText('3 results');
  await expect(page.locator('.channel-chat')).toBeHidden();
  await inside(panel);
  for (const b of await panel.locator('.search-panel-btn').all()) await inside(b);
  for (const h of await panel.locator('.search-hit').all()) await inside(h);
  await inside(panel.locator('.search-hit .chat-image-grid').first());
  await shot(page, 'search-390');
  await panel.locator('.search-hit').filter({ hasText: 'three charts from the weekend scan' }).tap({ position: { x: 200, y: 20 } });
  await expect(panel).toHaveCount(0);
  await expect(page.locator('.chat-msg.flash, .chat-msg[class*="flash"]').first()).toBeVisible();
});

async function serverSettings(page: Page, section: string): Promise<Locator> {
  await openStockTalk(page);
  await page.getByRole('button', { name: 'Show Channels' }).tap();
  await page.locator('.sidebar').getByRole('button', { name: /Sam's server/ }).tap();
  await page.getByRole('menuitem', { name: /Server Settings/ }).tap();
  const dialog = page.getByRole('dialog', { name: /Server Settings/ });
  await dialog.getByRole('button', { name: section, exact: true }).tap();
  return dialog;
}

test.describe('tables', () => {
  test('server settings Members: stacked rows with the roles and the actions on screen, the toolbar wraps', async ({ page }) => {
    const dialog = await serverSettings(page, 'Members');
    const rows = dialog.locator('.ss-members-table tbody tr');
    await expect(rows.first()).toBeVisible();
    await inside(dialog.locator('.ss-toolbar'));
    for (const s of await dialog.locator('.ss-toolbar > *').all()) await inside(s);
    for (const r of (await rows.all()).slice(0, 5)) {
      await inside(r);
      for (const c of await r.locator('td:nth-child(5) .ss-chip-row > *').all()) await inside(c);
    }
    expect(await rows.first().locator('td:nth-child(3)').evaluate(el => getComputedStyle(el, '::before').content)).toBe('"Member since "');
    await shot(page, 'server-settings-members-390');
  });

  test('server settings Invites: every invite shows its expiry and a revoke button on screen', async ({ page }) => {
    const dialog = await serverSettings(page, 'Invites');
    const rows = dialog.locator('.invite-table tbody tr');
    await expect(rows.first()).toBeVisible();
    for (const r of await rows.all()) {
      await inside(r);
      await inside(r.locator('.invite-revoke'));
      await inside(r.locator('td[data-label="Expires"]'));
    }
    expect(await rows.first().locator('td[data-label="Uses"]').evaluate(el => getComputedStyle(el, '::before').content)).toBe('"Uses "');
    await shot(page, 'server-settings-invites-390');
  });

  test('Members page: the card fits the window, only the table scrolls sideways with the name pinned', async ({ page }) => {
    await openStockTalk(page);
    await page.getByRole('button', { name: 'Show Channels' }).tap();
    await page.getByRole('link', { name: 'Members', exact: true }).tap();
    await page.waitForURL(/\/member-safety/);
    const table = page.getByRole('table', { name: 'Server members' });
    await expect(table.locator('tbody tr')).toHaveCount(12);
    await shot(page, 'member-list-390');
    for (const sel of ['.mp-card', '.mp-search', '.mp-sort-btn', '.mp-pager']) await inside(page.locator(sel));
    const wrap = page.locator('.mp-table-wrap');
    expect(await wrap.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
    await wrap.evaluate(el => { el.scrollLeft = el.scrollWidth; });
    await inside(table.locator('tbody tr').first().getByRole('button', { name: /More actions/ }));
    await inside(table.locator('tbody tr').first().locator('.mp-col-name'));
    await shot(page, 'member-list-390-scrolled');
  });
});

test('account card: the avatar stays inside the pill, the Inbox opens as a bottom sheet', async ({ page }) => {
  await home(page);
  const panel = page.locator('.user-panel');
  const card = (await panel.boundingBox())!;
  const avatar = (await panel.locator('.user-panel-account .avatar').first().boundingBox())!;
  expect(avatar.x).toBeGreaterThanOrEqual(card.x);
  expect(avatar.y).toBeGreaterThanOrEqual(card.y - 1);
  expect(avatar.y + avatar.height).toBeLessThanOrEqual(card.y + card.height + 1);
  await panel.getByRole('button', { name: 'Inbox' }).tap();
  const inbox = page.locator('.inbox-popout');
  await expect(inbox).toBeVisible();
  // Like every other menu at phone width it is a bottom sheet (sheet.css), not a popout anchored to the card.
  await expect(page.getByRole('dialog', { name: 'Inbox' })).toHaveClass(/\bsheet\b/);
  await inside(inbox);
  await shot(page, 'inbox-390');
  await page.keyboard.press('Escape');
  await shot(page, 'home-dm-list-390');
});

test('friends: every tab is on screen (they wrap under the title) and Add Friend is a header icon', async ({ page }) => {
  await home(page);
  await page.locator('.sidebar').getByText('Friends', { exact: true }).first().tap();
  const header = page.locator('.friends-header');
  for (const name of ['Online', 'All', 'Pending', 'Suggestions', 'Blocked']) await inside(header.getByRole('tab', { name: new RegExp(`^${name}`) }));
  await expect(header.getByRole('tab', { name: 'Add Friend' })).toBeHidden();
  await inside(header.getByRole('button', { name: 'Add Friend' }));
  await shot(page, 'friends-390');
  await header.getByRole('button', { name: 'Add Friend' }).tap();
  await expect(header.getByRole('button', { name: 'Add Friend' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.add-friend-input')).toBeVisible();
  await inside(page.locator('.add-friend-input'));
  // the username field keeps the full width; Send Friend Request sits under it
  const field = (await page.getByRole('textbox', { name: 'Username' }).boundingBox())!;
  const send = (await page.getByRole('button', { name: 'Send Friend Request' }).boundingBox())!;
  expect(field.width).toBeGreaterThan(300);
  expect(send.y).toBeGreaterThanOrEqual(field.y + field.height);
  await shot(page, 'add-friend-390');
  await header.getByRole('tab', { name: 'Blocked' }).tap();
  await expect(header.getByRole('tab', { name: 'Blocked' })).toHaveAttribute('aria-selected', 'true');
});

test('a tap on a message author\'s name or avatar opens the profile sheet', async ({ page }) => {
  await openStockTalk(page);
  const row = page.locator('.chat-msg:not(.grouped):not(.system)').last();
  const sheet = page.getByRole('dialog', { name: 'Profile' });
  await row.locator('.chat-author').tap();
  await expect(sheet).toBeVisible();
  await expect(page.locator('.message-menu, [role=menu]')).toHaveCount(0);
  await shot(page, 'author-sheet-390');
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await row.locator('.chat-avatar-btn').tap();
  await expect(sheet).toBeVisible();
});

test('a thread and a forum post take the whole screen, split view or not', async ({ page }) => {
  await openChannel(page, 'general');
  const thread = page.locator('.thread-panel');
  await page.getByRole('button', { name: 'general, details' }).tap();
  await page.locator('.details-page').getByRole('tab', { name: 'Threads' }).tap();
  await page.locator('.details-page').getByRole('button', { name: /gateway docs/ }).tap();
  await expect(thread).toBeVisible();
  expect((await thread.boundingBox())!.width).toBe(W);
  await expect(page.locator('.channel-chat')).toBeHidden();
  await shot(page, 'thread-390');
  await thread.getByRole('button', { name: 'Close thread' }).tap();

  await openChannel(page, 'support');
  await page.locator('.forum-post-open').first().tap();
  await expect(thread).toBeVisible();
  expect((await thread.boundingBox())!.width).toBe(W);
  await expect(page.locator('.channel-chat')).toBeHidden();
  await shot(page, 'forum-post-390');
});

test('a thread\'s header replaces the channel\'s: back, name, overflow; the forum sort is an icon with a sheet', async ({ page }) => {
  await openChannel(page, 'general');
  const thread = page.locator('.thread-panel');
  await page.getByRole('button', { name: 'general, details' }).tap();
  await page.locator('.details-page').getByRole('tab', { name: 'Threads' }).tap();
  await page.locator('.details-page').getByRole('button', { name: /gateway docs/ }).tap();
  await expect(page.locator('.channel-header')).toBeHidden();
  const header = thread.locator('.thread-panel-header');
  await expect(header.getByRole('heading', { name: 'gateway docs' })).toBeVisible();
  await expect(header.getByRole('button')).toHaveCount(2); // back and overflow (Sam already joined)
  await inside(header.getByRole('button', { name: 'Thread actions' }));
  await header.getByRole('button', { name: 'Thread actions' }).tap();
  const sheet = page.getByRole('dialog', { name: 'Menu' });
  await expect(sheet.getByRole('menuitem', { name: 'Notification Settings' })).toBeVisible();
  await page.waitForTimeout(400); // the sheet's slide-in
  await shot(page, 'thread-menu-390');
  await sheet.getByRole('menuitem', { name: 'Pinned Messages' }).tap();
  await expect(page.getByRole('dialog', { name: 'Pinned Messages' })).toBeVisible();
  await page.keyboard.press('Escape');
  await header.getByRole('button', { name: 'Close thread' }).tap();
  await expect(thread).toHaveCount(0);
  await expect(page.locator('.channel-header')).toBeVisible();

  await openChannel(page, 'support');
  await expect(page.locator('.forum-sort')).toHaveCount(0);
  const sortBtn = page.getByRole('button', { name: 'Sort posts' });
  await inside(sortBtn);
  await shot(page, 'forum-390');
  await sortBtn.tap();
  await page.getByRole('menuitemcheckbox', { name: 'Date Posted' }).tap();
  await sortBtn.tap();
  await expect(page.getByRole('menuitemcheckbox', { name: 'Date Posted' })).toHaveAttribute('aria-checked', 'true');
});

test('settings opened at a section show that page; back returns to the section list', async ({ page }) => {
  await home(page);
  await page.locator('.user-panel-account').tap();
  await page.getByRole('dialog', { name: 'User profile' }).getByRole('menuitem', { name: 'Edit Profile' }).tap();
  const settings = page.getByRole('dialog', { name: 'User Settings' });
  await expect(settings.locator('.sm-title')).toHaveText('Profiles');
  await expect(settings.getByRole('tab', { name: 'User Profile' })).toBeVisible();
  await page.goBack();
  await expect(settings.getByRole('button', { name: 'My Account', exact: true })).toBeVisible();
  // without a section, Server Settings still starts at the section list
  await openStockTalk(page);
  await page.getByRole('button', { name: 'Show Channels' }).tap();
  await page.locator('.sidebar').getByRole('button', { name: /Sam's server/ }).tap();
  await page.getByRole('menuitem', { name: /Server Settings/ }).tap();
  const server = page.getByRole('dialog', { name: /Server Settings/ });
  await expect(server.getByRole('button', { name: 'Members', exact: true })).toBeVisible();
});

test('My Account: rows stay inside the window; Keybinds is left out like on Discord mobile', async ({ page }) => {
  await home(page);
  await page.getByRole('button', { name: 'User Settings' }).first().tap();
  const settings = page.getByRole('dialog', { name: 'User Settings' });
  await expect(settings.getByRole('button', { name: 'Keybinds', exact: true })).toHaveCount(0);
  await settings.getByRole('button', { name: 'My Account', exact: true }).tap();
  await expect(settings.getByRole('button', { name: 'Enable Authenticator App' })).toBeVisible();
  for (const el of await settings.locator('.sm-row, .sm-row > *').all()) await inside(el);
  await shot(page, 'my-account-390');
});

test('channel permissions: the role list stacks above the permissions and every tri-state switch is on screen', async ({ page }) => {
  await openStockTalk(page);
  await page.getByRole('button', { name: 'Show Channels' }).tap();
  await page.locator('a.channel-row[aria-current="page"]').getByRole('button', { name: 'Edit Channel' }).tap();
  const dialog = page.getByRole('dialog', { name: /Channel Settings/ });
  await dialog.getByRole('button', { name: 'Permissions', exact: true }).tap();
  await dialog.getByRole('button', { name: 'Advanced Permissions' }).tap();
  const targets = dialog.locator('.cs-targets');
  const perms = dialog.locator('.cs-perms');
  await expect(perms.locator('.cs-tri').first()).toBeVisible();
  expect((await perms.boundingBox())!.y).toBeGreaterThan((await targets.boundingBox())!.y);
  expect((await perms.boundingBox())!.width).toBeGreaterThan(300);
  for (const t of await perms.locator('.cs-tri').all()) await inside(t);
  for (const r of await perms.locator('.cs-perm-row').all()) await inside(r);
  await shot(page, 'channel-permissions-390');
});

test('server settings Roles: the editor is full width with a Back to the list, its permission switches on screen', async ({ page }) => {
  const dialog = await serverSettings(page, 'Roles');
  await dialog.locator('.ss-role-row.ss-role-draggable').first().tap();
  const editor = dialog.locator('.ss-roles-editor');
  await expect(editor).toBeVisible();
  expect((await editor.boundingBox())!.width).toBeGreaterThan(330);
  await expect(dialog.locator('.ss-aside-row').first()).toBeHidden();
  await inside(dialog.getByRole('button', { name: 'Back', exact: true }));
  await editor.getByRole('tab', { name: 'Permissions' }).tap();
  const rows = editor.getByRole('tabpanel').locator('.switch-row');
  await expect(rows.first()).toBeVisible();
  for (const r of (await rows.all()).slice(0, 12)) await inside(r);
  for (const sw of await editor.locator('.switch').all()) await inside(sw);
  await shot(page, 'role-editor-390');
  await dialog.getByRole('button', { name: 'Back', exact: true }).tap();
  await expect(dialog.locator('.ss-role-list')).toBeVisible();
});

test('Accessibility: the preview scrolls with the page, inline rows stack, sliders label only their ends', async ({ page }) => {
  await home(page);
  await page.getByRole('button', { name: 'User Settings' }).first().tap();
  const settings = page.getByRole('dialog', { name: 'User Settings' });
  await settings.getByRole('button', { name: 'Accessibility', exact: true }).tap();
  await expect(settings.locator('.a11y-preview')).toBeVisible();
  expect(await settings.locator('.a11y-sticky').evaluate(el => getComputedStyle(el).position)).toBe('static');
  for (const l of await settings.locator('.a11y-field .field-label').all()) expect((await l.boundingBox())!.width).toBeGreaterThanOrEqual(120);
  for (const el of await settings.locator('.a11y-field, .a11y-field-control, .ms').all()) await inside(el);
  const slider = settings.locator('.ms').first();
  await slider.scrollIntoViewIfNeeded();
  expect(await slider.locator('.ms-label:visible').count()).toBeLessThanOrEqual(3);
  await shot(page, 'accessibility-390');
});

// The same screens at desktop width: the phone rules must not leak (and the members dates stay on one line).
test.describe('desktop 1440', () => {
  test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });

  test('search panel, friends tabs, members dates and invites keep the desktop layout', async ({ page }) => {
    await page.goto('/channels/@me?as=sam&mockLatency=0');
    await expect(page.locator('.friends-tab.add-friend-tab')).toBeVisible();
    await expect(page.locator('.friends-add-icon')).toBeHidden();
    await shot(page, 'friends-1440');
    await page.getByRole('link', { name: /^Sam's server/ }).click();
    await page.locator('.chat-msg').first().waitFor();
    const box = page.getByRole('combobox', { name: 'Search' });
    await box.click();
    await box.fill('morning');
    await box.press('Enter');
    await expect(page.locator('.search-panel-count')).toHaveText('3 results');
    expect((await page.locator('.search-panel').boundingBox())!.width).toBeLessThan(430);
    await expect(page.locator('.channel-chat')).toBeVisible();
    await shot(page, 'search-1440');
    await page.getByRole('button', { name: 'Clear search' }).click();
    await page.locator('.guild-header-name-button').click();
    await page.getByRole('menuitem', { name: 'Server Settings' }).click();
    const dialog = page.getByRole('dialog', { name: /Server Settings/ });
    await dialog.getByRole('button', { name: 'Members', exact: true }).click();
    await expect(dialog.locator('.ss-members-table thead')).toBeVisible();
    const date = dialog.locator('.ss-members-table tbody tr').first().locator('td').nth(2);
    expect(await date.evaluate(el => getComputedStyle(el).whiteSpace)).toBe('nowrap');
    await shot(page, 'server-settings-members-1440');
    await dialog.getByRole('button', { name: 'Invites', exact: true }).click();
    await expect(dialog.locator('.invite-table thead')).toBeVisible();
    await shot(page, 'server-settings-invites-1440');
  });

  test('channel permissions and the role editor keep their side-by-side panes', async ({ page }) => {
    await page.goto('/channels/@me?as=sam&mockLatency=0');
    await page.getByRole('link', { name: /^Sam's server/ }).click();
    await page.locator('.chat-msg').first().waitFor();
    await page.locator('a.channel-row[aria-current="page"]').hover();
    await page.locator('a.channel-row[aria-current="page"]').getByRole('button', { name: 'Edit Channel' }).click();
    const channel = page.getByRole('dialog', { name: /Channel Settings/ });
    await channel.getByRole('button', { name: 'Permissions', exact: true }).click();
    await channel.getByRole('button', { name: 'Advanced Permissions' }).click();
    const targets = (await channel.locator('.cs-targets').boundingBox())!;
    const perms = (await channel.locator('.cs-perms').boundingBox())!;
    expect(perms.x).toBeGreaterThan(targets.x + targets.width - 1);
    await shot(page, 'channel-permissions-1440');
    await page.keyboard.press('Escape');
    await page.locator('.guild-header-name-button').click();
    await page.getByRole('menuitem', { name: 'Server Settings' }).click();
    const server = page.getByRole('dialog', { name: /Server Settings/ });
    await server.getByRole('button', { name: 'Roles', exact: true }).click();
    await server.locator('.ss-role-row.ss-role-draggable').first().click();
    await expect(server.locator('.ss-aside-row').first()).toBeVisible();
    await shot(page, 'role-editor-1440');
  });
});
