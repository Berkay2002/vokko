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
  test('a tap shows no toolbar: touch has no hover toolbar, the long press sheet is the way in', async ({ page }) => {
    await openStockTalk(page);
    const a = await visibleRow(page, 0);
    await page.touchscreen.tap(a.x, a.y);
    await page.waitForTimeout(200);
    await expect(page.locator('.chat-toolbar:visible')).toHaveCount(0);
    await expect(page.locator('.sheet')).toHaveCount(0);
  });

  test('the long press sheet replies by touch', async ({ page }) => {
    await openStockTalk(page);
    const m = await visibleRow(page, 0);
    await longPress(page, m.x, m.y);
    await page.waitForTimeout(300);
    await page.getByRole('menuitem', { name: 'Reply' }).tap();
    await expect(page.locator('.chat-msg.replying')).toHaveCount(1);
    await expect(page.locator('.sheet')).toHaveCount(0);
  });

  test('a long press opens the message actions as a bottom sheet and it stays open', async ({ page }) => {
    await openStockTalk(page);
    const p = await visibleRow(page, 0);
    await longPress(page, p.x, p.y);
    const sheet = page.getByRole('dialog', { name: 'Message actions' });
    await expect(sheet).toBeVisible();
    await page.waitForTimeout(500);
    await expect(sheet).toBeVisible();
    const b = (await page.locator('.sheet').boundingBox())!;
    expect(b.x).toBe(0);
    expect(b.width).toBe(390);
    expect(b.y + b.height).toBe(844);
    await expect(page.getByRole('group', { name: 'Quick reactions' }).getByRole('button')).toHaveCount(5);
    for (const name of ['Reply', 'Copy Text', 'Pin Message']) await expect(page.getByRole('menuitem', { name })).toBeVisible();
    // a tap on the backdrop closes it
    await page.touchscreen.tap(195, 40);
    await expect(page.locator('.sheet')).toHaveCount(0);
  });

  test('a row with a submenu drills down inside the sheet and back', async ({ page }) => {
    await openStockTalk(page);
    const p = await visibleRow(page, 0);
    await longPress(page, p.x, p.y);
    await page.waitForTimeout(400);
    await page.getByRole('menuitem', { name: 'Create Reminder' }).tap();
    await expect(page.getByText('Remind me', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Create Reminder' }).tap();
    await expect(page.getByRole('menuitem', { name: 'Reply' })).toBeVisible();
  });

  test('a quick reaction reacts and closes the sheet', async ({ page }) => {
    await openStockTalk(page);
    const p = await visibleRow(page, 0);
    await longPress(page, p.x, p.y);
    await page.waitForTimeout(400);
    await page.getByRole('group', { name: 'Quick reactions' }).getByRole('button').first().tap();
    await expect(page.locator('.sheet')).toHaveCount(0);
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

  test('the section lists are grouped rows: 50px rows in rounded cards, drill-down to a page', async ({ page }) => {
    await page.goto('/channels/@me?as=sam&mockLatency=0');
    await page.locator('.dm-row').first().waitFor({ state: 'attached' });
    await page.getByRole('button', { name: /User Settings/ }).first().tap();
    const dialog = page.getByRole('dialog', { name: /User Settings/ });
    const rows = dialog.locator('.sm-item');
    await expect(rows.first()).toBeVisible();
    for (const row of await rows.all()) {
      if (!(await row.isVisible())) continue;
      expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(48);
    }
    const card = dialog.locator('.sm-group > div').first();
    expect(await card.evaluate(e => getComputedStyle(e).borderTopLeftRadius)).toBe('16px');
    await expect(dialog.locator('.sm-subs')).toBeHidden(); // sub-items belong to the wide layout
    await rows.nth(1).tap();
    await expect(dialog.locator('.sm-side')).toBeHidden();
    await dialog.getByRole('button', { name: 'Back to sections' }).tap();
    await expect(rows.first()).toBeVisible();
    await noHorizontalScroll(page);
  });
});

test.describe('voice', () => {
  async function join(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'Show Channels' }).tap();
    await page.locator('.sidebar-scroller').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await page.getByRole('button', { name: 'General voice channel' }).tap();
    // A tap opens the channel's preview; the call starts with its Join button.
    await expect(page.locator('.voice-panel.in-call')).toHaveCount(0);
    await page.getByRole('button', { name: 'Join Voice' }).tap();
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

  test('tapping a voice channel shows the preview with a wide Join button, the call is a single control row, chat covers the call', async ({ page }) => {
    await openStockTalk(page);
    await page.getByRole('button', { name: 'Show Channels' }).tap().catch(() => undefined);
    await page.locator('.sidebar-scroller').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await page.getByRole('button', { name: 'General voice channel' }).tap();
    const joinButton = page.getByRole('button', { name: 'Join Voice' });
    await expect(joinButton).toBeVisible();
    await expect(page.locator('.voice-panel.in-call')).toHaveCount(0);
    const jb = (await joinButton.boundingBox())!;
    expect(jb.width).toBeGreaterThan(300);
    expect(jb.height).toBeGreaterThanOrEqual(44);
    await joinButton.tap();
    const bar = page.locator('.voice-bar');
    await expect(bar).toBeVisible();
    const ys = await bar.locator('.voice-bar-button:visible, .voice-hangup').evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().top)));
    expect(new Set(ys).size).toBe(1);
    // The chat icon in the header opens the call's text chat as its own full-width screen over the call, with its composer and a close button.
    await page.getByRole('button', { name: /Show Chat|Open Chat/ }).first().tap();
    const chat = page.getByRole('complementary', { name: /chat$/ });
    await expect(chat).toBeVisible();
    const call = (await page.locator('.voice-page').boundingBox())!;
    expect(await chat.boundingBox()).toEqual(call);
    expect(call.width).toBe(390);
    await expect(chat.locator('.chat-textarea')).toBeVisible();
    await noHorizontalScroll(page);
    await chat.getByRole('button', { name: 'Close Chat' }).tap();
    await expect(chat).toHaveCount(0);
    await expect(bar).toBeVisible();
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
    await longPress(page, row.x, row.y);
    await page.waitForTimeout(400);
    // sheet rows and reaction tiles are finger sized, and the sheet stays inside the window
    const reply = (await page.getByRole('menuitem', { name: 'Reply' }).boundingBox())!;
    expect(reply.height).toBeGreaterThanOrEqual(48);
    const tile = (await page.getByRole('group', { name: 'Quick reactions' }).getByRole('button').first().boundingBox())!;
    expect(tile.width).toBeGreaterThanOrEqual(44);
    expect(tile.height).toBeGreaterThanOrEqual(44);
    const bar = (await page.locator('.sheet').boundingBox())!;
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


test.describe('composer', () => {
  test('a pill with +, the field and one emoji button; the emoji picker docks under the composer and the composer stays above it', async ({ page }) => {
    await openStockTalk(page);
    await expect(page.getByRole('button', { name: 'Open GIF picker' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Open sticker picker' })).toBeHidden();
    await page.getByRole('button', { name: 'Select emoji' }).tap();
    await expect(page.getByRole('dialog', { name: 'Emoji, GIFs and stickers' })).toBeVisible();
    await page.waitForTimeout(300); // the slide-in
    const s = (await page.locator('.sheet').boundingBox())!;
    expect(s.x).toBe(0);
    expect(s.width).toBe(390);
    expect(s.y + s.height).toBe(844);
    expect(s.height).toBeGreaterThan(844 * 0.45);
    expect(s.height).toBeLessThan(844 * 0.55);
    // the composer is above the sheet, the chat shrank instead of going under it
    const c = (await page.locator('.chat-composer-box').boundingBox())!;
    expect(c.y + c.height).toBeLessThanOrEqual(s.y);
    await page.locator('.sheet .chat-emoji-cell').first().tap();
    await expect(page.locator('.sheet')).toHaveCount(0);
    await expect(composer(page)).toHaveAttribute('data-empty', 'false');
    await expect(page.locator('html')).not.toHaveClass(/sheet-docked/);
  });

  test('"+" opens a sheet with the attach actions; a tap on the backdrop closes it', async ({ page }) => {
    await openStockTalk(page);
    await page.getByRole('button', { name: 'Attach a file' }).tap();
    await expect(page.getByRole('dialog', { name: 'Attach' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Upload a File' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Use Apps' })).toBeVisible();
    await page.waitForTimeout(400); // the slide-in, and the tap guard right after opening
    const s = (await page.locator('.sheet').boundingBox())!;
    expect(s.y + s.height).toBe(844);
    await page.touchscreen.tap(195, 60);
    await expect(page.locator('.sheet')).toHaveCount(0);
  });
});

test.describe('menus as sheets', () => {
  test('a long press on a channel row opens its menu as a bottom sheet; a tap on a row of it acts and closes', async ({ page }) => {
    await openStockTalk(page);
    await page.getByRole('button', { name: 'Show Channels' }).tap();
    const row = (await page.locator('a.channel-row').nth(1).boundingBox())!;
    await longPress(page, row.x + row.width / 2, row.y + row.height / 2);
    await expect(page.locator('.sheet')).toBeVisible();
    await expect(page.locator('.context-menu')).toHaveCount(0);
    await page.waitForTimeout(400); // the slide-in
    const s = (await page.locator('.sheet').boundingBox())!;
    expect(s.y + s.height).toBe(844);
    await expect(page.locator('.sheet .sheet-title')).toHaveText(/^# /); // header: the channel's name
    // the finger lifting after the press did not follow the row's link
    await expect(page.locator('.app-frame')).toHaveClass(/nav-open/);
    await page.waitForTimeout(400);
    // a row with a submenu drills down inside the sheet (back returns); a leaf row acts and closes it
    await page.getByRole('menuitem', { name: 'Mute Channel' }).tap();
    await expect(page.locator('.sheet-back')).toBeVisible();
    await page.locator('.sheet-back').tap();
    await page.getByRole('menuitem', { name: 'Copy Link' }).tap();
    await expect(page.locator('.sheet')).toHaveCount(0);
  });

  test('the server menu, the profile card and the invite dialog are sheets', async ({ page }) => {
    await openStockTalk(page);
    await page.getByRole('button', { name: 'Show Channels' }).tap();
    await page.locator('.guild-header').first().tap();
    await expect(page.getByRole('dialog', { name: 'Server menu' })).toBeVisible();
    await page.waitForTimeout(400);
    await page.getByRole('menuitem', { name: /^Invite/ }).first().tap();
    await expect(page.locator('.sheet.invite-modal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.sheet')).toHaveCount(0);
    await page.locator('.user-panel-account').tap();
    await expect(page.getByRole('dialog', { name: 'User profile' })).toBeVisible();
    await page.waitForTimeout(400);
    const s = (await page.locator('.sheet').boundingBox())!;
    expect(s.width).toBe(390);
    expect(s.y + s.height).toBe(844);
  });
});
