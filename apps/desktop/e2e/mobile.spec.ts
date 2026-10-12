import { expect, test, type Page } from '@playwright/test';
import { composer } from './helpers';

// Phone browsers (styles/responsive.css <= 767px, touch handling in chat/MessageItem.tsx). Chromium with touch emulation:
// real taps (touchscreen) and a CDP long press, no mouse. Safe-area insets and the on-screen keyboard cannot be shown headless.

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

/** The page itself must not scroll sideways (clipped overflow inside a container is checked per screen where it matters). */
async function noHorizontalScroll(page: Page): Promise<void> {
  const over = await page.evaluate(() => document.scrollingElement!.scrollWidth - window.innerWidth);
  expect(over).toBeLessThanOrEqual(0);
}

/** Holds a finger at (x, y) for `ms` without moving (CDP, so no mouse events are involved). */
async function longPress(page: Page, x: number, y: number, ms = 700): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await page.waitForTimeout(ms);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** A point at the right edge of the nth message row (clear of mentions and links) that is fully on screen (the list is windowed and bottom-anchored). */
async function visibleRow(page: Page, nth: number): Promise<{ x: number; y: number }> {
  const rows: { x: number; y: number }[] = [];
  for (const l of await page.locator('.chat-msg .chat-msg-body').all()) {
    const b = await l.boundingBox();
    if (b && b.y > 120 && b.y + b.height < 720) rows.push({ x: b.x + b.width - 12, y: b.y + b.height / 2 });
  }
  expect(rows.length).toBeGreaterThan(nth);
  return rows[nth];
}

type StoreWin = { __vokko: { appStore: { getState(): { channels: Record<string, { id: string; name?: string; type: number; guild_id: string | null }> } } } };

/** The phone flow: Home shows the list page, a server in the rail keeps it open, tapping the open channel shows the chat. */
async function openStockTalk(page: Page): Promise<void> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.waitForFunction(() => Object.values((window as unknown as StoreWin).__vokko.appStore.getState().channels).some(c => c.name === 'stock-talk'));
  const target = await page.evaluate(() => {
    const c = Object.values((window as unknown as StoreWin).__vokko.appStore.getState().channels).find(x => x.name === 'stock-talk')!;
    return `/channels/${c.guild_id}/${c.id}`;
  });
  await page.evaluate(path => { history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, target); // a reload re-seeds the mock
  await expect(page.locator('.app-frame')).toHaveClass(/nav-open/);
  await page.locator('a.channel-row[aria-current="page"]').first().tap();
  await page.locator('.chat-textarea').waitFor();
  await page.locator('.chat-msg').first().waitFor();
  await page.waitForTimeout(400);
}

test.describe('Home', () => {
  test('Home shows the list page, Friends is a page from it with a back arrow', async ({ page }) => {
    await page.goto('/channels/@me?as=sam&mockLatency=0');
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('.server-rail')).toBeVisible();
    await expect(page.locator('.active-now')).toBeHidden();
    await page.locator('.sidebar').getByText('Friends', { exact: true }).first().tap();
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(page.locator('.friends-tab').first()).toBeVisible();
    await page.getByRole('button', { name: 'Show Channels' }).tap();
    await expect(page.locator('.sidebar')).toBeVisible();
    await noHorizontalScroll(page);
  });
});

test.describe('message actions by touch', () => {
  test('a tap shows the toolbar of that message only, a tap elsewhere hides it', async ({ page }) => {
    await openStockTalk(page);
    await expect(page.locator('.chat-toolbar')).toHaveCount(0);
    const a = await visibleRow(page, 0);
    await page.touchscreen.tap(a.x, a.y);
    await expect(page.locator('.chat-msg.touch-open .chat-toolbar')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add Reaction' })).toBeVisible();
    const b = await visibleRow(page, 1);
    await page.touchscreen.tap(b.x, b.y);
    await expect(page.locator('.chat-msg.touch-open')).toHaveCount(1);
    await expect(page.locator('.chat-msg.touch-open .chat-toolbar')).toBeVisible();
    await page.touchscreen.tap(200, 60); // the channel header
    await expect(page.locator('.chat-msg.touch-open')).toHaveCount(0);
  });

  test('the toolbar replies by touch', async ({ page }) => {
    await openStockTalk(page);
    const m = await visibleRow(page, 0);
    await page.touchscreen.tap(m.x, m.y);
    await page.locator('.chat-msg.touch-open').getByRole('button', { name: 'Reply' }).tap();
    await expect(page.locator('.chat-msg.replying')).toHaveCount(1);
  });

  test('a long press opens the message menu and stays open', async ({ page }) => {
    await openStockTalk(page);
    const p = await visibleRow(page, 0);
    await longPress(page, p.x, p.y);
    await expect(page.getByRole('menu')).toBeVisible();
    await page.waitForTimeout(400);
    await expect(page.getByRole('menu')).toBeVisible();
  });

  test('scrolling does not open the menu', async ({ page }) => {
    await openStockTalk(page);
    const p = await visibleRow(page, 0);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p.x, y: p.y + 60 }] });
    await page.waitForTimeout(700);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page.getByRole('menu')).toHaveCount(0);
  });
});

test.describe('details page', () => {
  test('the header name opens members, pins and threads on a page of their own', async ({ page }) => {
    await openStockTalk(page);
    // the secondary toolbar buttons are not in the header any more
    for (const name of ['Show Member List', 'Pinned Messages', 'Threads', 'Notification Settings']) await expect(page.getByRole('button', { name })).toBeHidden();
    await page.getByRole('button', { name: 'stock-talk, details' }).tap();
    const details = page.locator('.details-page');
    await expect(details).toBeVisible();
    await expect(details.locator('.details-topic')).toHaveText('Charts, takes and bad ideas.');
    const box = (await details.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await expect(details.locator('.member-list')).toBeVisible();
    const list = (await details.locator('.member-list').boundingBox())!;
    expect(list.width).toBeGreaterThan(300);
    await details.getByRole('tab', { name: 'Pins' }).tap();
    await expect(details.locator('.chat-pins')).toBeVisible();
    await details.getByRole('tab', { name: 'Threads' }).tap();
    await expect(details.locator('.threads-popout')).toBeVisible();
    await noHorizontalScroll(page);
    await details.getByRole('button', { name: 'Back' }).tap();
    await expect(details).toHaveCount(0);
    await expect(composer(page)).toBeVisible();
  });

  test('a DM shows the profile there, with call buttons and search in the header', async ({ page }) => {
    await page.goto('/channels/@me?as=sam&mockLatency=0');
    await page.locator('.dm-row').first().tap();
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Start Voice Call' })).toBeVisible();
    await page.locator('.channel-header-details').tap();
    await expect(page.locator('.details-page .dm-profile')).toBeVisible();
    await page.getByRole('button', { name: 'Back' }).tap();
    await expect(page.locator('.details-page')).toHaveCount(0);
  });
});

test.describe('settings', () => {
  test('server settings: section list first, then one page, back returns', async ({ page }) => {
    await openStockTalk(page);
    await page.getByRole('button', { name: 'Show Channels' }).tap();
    await page.locator('.sidebar').getByRole('button', { name: /Sam's server/ }).tap();
    await page.getByRole('menuitem', { name: /Server Settings/ }).tap();
    const dialog = page.getByRole('dialog', { name: /Server Settings/ });
    await expect(dialog.getByRole('button', { name: 'Roles' })).toBeVisible();
    await expect(dialog.locator('.fss-content')).toBeHidden();
    await dialog.getByRole('button', { name: 'Roles' }).tap();
    await expect(dialog.locator('.fss-sidebar')).toBeHidden();
    await expect(dialog.getByRole('button', { name: 'Back to sections' })).toBeVisible();
    const box = (await dialog.locator('.fss-content').boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(390);
    await dialog.getByRole('button', { name: 'Back to sections' }).tap();
    await expect(dialog.getByRole('button', { name: 'Roles' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Close' }).tap();
    await expect(dialog).toHaveCount(0);
  });
});

test.describe('voice', () => {
  async function join(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'Show Channels' }).tap();
    await page.locator('.sidebar-scroller').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await page.getByRole('button', { name: 'General voice channel' }).tap();
    await expect(page.locator('.voice-panel.in-call')).toBeAttached();
  }

  test('in a text channel the call card stays in the drawer and never covers the messages', async ({ page }) => {
    await openStockTalk(page);
    const textChannel = new URL(page.url()).pathname;
    await join(page);
    await page.waitForFunction(path => location.pathname !== path, textChannel); // joining opens the call view
    await expect(page.locator('.app-frame')).not.toHaveClass(/nav-open/); // the drawer closes on that navigation
    await page.evaluate(path => { history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, textChannel);
    await expect(composer(page)).toBeVisible();
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(page.locator('.voice-panel')).toBeHidden();
    await page.getByRole('button', { name: 'Show Channels' }).tap();
    await expect(page.locator('.voice-panel')).toBeVisible();
  });

  test('the call view keeps a 40px+ disconnect button on a 360px phone', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await openStockTalk(page);
    await join(page);
    const hangup = page.getByRole('button', { name: 'Leave voice channel' });
    await expect(hangup).toBeVisible();
    const b = (await hangup.boundingBox())!;
    expect(b.width).toBeGreaterThanOrEqual(40);
    expect(b.height).toBeGreaterThanOrEqual(40);
    expect(b.x + b.width).toBeLessThanOrEqual(360);
    await noHorizontalScroll(page);
  });
});

test.describe('channel header', () => {
  for (const width of [390, 360]) {
    test(`${width}px: the name is not covered, the search opens over the toolbar`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await openStockTalk(page);
      const name = page.locator('.channel-header-name');
      const toolbar = (await page.locator('.channel-header-toolbar').boundingBox())!;
      const n = (await name.boundingBox())!;
      expect(n.x + n.width).toBeLessThanOrEqual(toolbar.x + 1);
      expect(toolbar.x + toolbar.width).toBeLessThanOrEqual(width);
      const input = page.getByRole('combobox', { name: 'Search' });
      expect((await input.boundingBox())!.width).toBeGreaterThanOrEqual(30);
      await input.tap();
      const open = (await page.locator('.header-search').boundingBox())!;
      expect(open.width).toBeGreaterThan(width - 120);
      expect(open.x + open.width).toBeLessThanOrEqual(width);
      expect(await input.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
    });
  }
});

test('the viewport meta opts into the safe area without disabling pinch zoom', async ({ page }) => {
  await openStockTalk(page);
  const content = await page.locator('meta[name=viewport]').getAttribute('content');
  expect(content).toContain('viewport-fit=cover');
  expect(content).not.toMatch(/maximum-scale|user-scalable/);
  // env(safe-area-inset-*) is 0 in headless chromium: the frame must not be inset there
  const frame = (await page.locator('.app-frame').boundingBox())!;
  expect(frame).toMatchObject({ x: 0, y: 0 });
  expect(frame.width).toBe(page.viewportSize()!.width);
});

test.describe('fits the window', () => {
  test('the image gallery and the pins / inbox popovers stay inside a 360px window', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await openStockTalk(page);
    const grid = page.locator('.chat-image-grid.three').first();
    await grid.scrollIntoViewIfNeeded();
    const g = (await grid.boundingBox())!;
    expect(g.x + g.width).toBeLessThanOrEqual(360);
    expect(g.width).toBeGreaterThan(200);
    // no title bar on a phone: the Inbox is the bell on the account card of the list page
    await expect(page.locator('.title-bar')).toBeHidden();
    await page.getByRole('button', { name: 'Show Channels' }).tap();
    await page.getByRole('button', { name: 'Inbox' }).tap();
    const b = (await page.locator('.inbox-popout').boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(360);
    expect(b.y).toBeGreaterThanOrEqual(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('.inbox-popout')).toHaveCount(0);
  });

  test('the list page is full width and the open channel in it returns to the chat', async ({ page }) => {
    await openStockTalk(page);
    await page.getByRole('button', { name: 'Show Channels' }).tap();
    await expect(page.locator('.app-frame')).toHaveClass(/nav-open/);
    const sidebar = (await page.locator('.sidebar').boundingBox())!;
    expect(sidebar.x + sidebar.width).toBe(390);
    await page.locator('a.channel-row[aria-current="page"]').first().tap();
    await expect(page.locator('.app-frame')).not.toHaveClass(/nav-open/);
  });
});

test('text fields are 16px so iOS does not zoom on focus', async ({ page }) => {
  await openStockTalk(page);
  await page.getByRole('button', { name: 'stock-talk, details' }).tap();
  await page.getByRole('tab', { name: 'Threads' }).tap();
  const input = page.locator('.details-page input').first();
  await expect(input).toBeVisible();
  expect(await input.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
  // the text field ends before the magnifier
  const field = (await input.boundingBox())!;
  const icon = (await page.locator('.details-page .threads-search svg').boundingBox())!;
  expect(field.x + field.width).toBeLessThanOrEqual(icon.x);
  await page.keyboard.press('Escape');
  // "N online" starts with a green dot (status-online token)
  const dot = await page.locator('.channel-header-online').evaluate(el => getComputedStyle(el, '::before').backgroundColor);
  expect(dot).not.toBe('rgba(0, 0, 0, 0)');
  expect(await composer(page).evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
});

test.describe('touch targets', () => {
  test('small icon buttons get a hit area of about 40px (the pseudo-element), the toolbar buttons are finger sized', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await openStockTalk(page);
    // [button, distance from its centre that is outside the drawn button but inside the 40px area]
    for (const [name, d] of [['Select emoji', 18], ['Show Channels', 18]] as const) {
      const b = (await page.getByRole('button', { name }).first().boundingBox())!;
      const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
      const hit = async (x: number, y: number) => page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.closest('button')?.getAttribute('aria-label') ?? null, [x, y]);
      expect(await hit(cx, cy + d)).toBe(name);
      expect(await hit(cx, cy - d)).toBe(name);
    }
    const row = await visibleRow(page, 0);
    await page.touchscreen.tap(row.x, row.y);
    const btn = (await page.locator('.chat-msg.touch-open .chat-toolbar-btn').first().boundingBox())!;
    expect(btn.width).toBeGreaterThanOrEqual(36);
    expect(btn.height).toBeGreaterThanOrEqual(40);
    const bar = (await page.locator('.chat-msg.touch-open .chat-toolbar').boundingBox())!;
    expect(bar.x).toBeGreaterThanOrEqual(0);
    expect(bar.x + bar.width).toBeLessThanOrEqual(360);
  });

  test('channel rows in the drawer are 40px tall', async ({ page }) => {
    await openStockTalk(page);
    await page.getByRole('button', { name: 'Show Channels' }).tap();
    const row = (await page.locator('.channel-row').first().boundingBox())!;
    expect(row.height).toBeGreaterThanOrEqual(40);
  });
});

test('a dialog title does not run under the close button', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await openStockTalk(page);
  await page.getByRole('button', { name: 'Show Channels' }).tap();
  await page.getByRole('button', { name: 'Download Desktop App' }).evaluate(b => b.click());
  const title = (await page.locator('.modal-title').boundingBox())!;
  const close = (await page.locator('.modal-close').boundingBox())!;
  expect(title.x + title.width).toBeLessThanOrEqual(close.x);
});

