import { expect, test, type Locator, type Page } from '@playwright/test';

// Phone widths: every full-screen view has a visible way out, and back (the iOS swipe, Android back, the browser button: page.goBack()
// here) closes it instead of leaving the app (ui/backHistory.ts). Each view is left twice, once with its button and once with back.
// VOKKO_SHOTS_DIR saves a screenshot of each view.


const SHOTS = process.env.VOKKO_SHOTS_DIR;
type StoreWin = { __vokko: { appStore: { getState(): { channels: Record<string, { id: string; name?: string; guild_id: string | null }> } } } };

async function longPress(page: Page, target: Locator, ms = 700): Promise<void> {
  const b = (await target.boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + b.width / 2, y: b.y + b.height / 2 }] });
  await page.waitForTimeout(ms);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function home(page: Page): Promise<void> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.waitForFunction(() => Object.values((window as unknown as StoreWin).__vokko.appStore.getState().channels).some(c => c.name === 'stock-talk'));
}

/** Opens a channel of the demo server from the list page (in-app navigation: a reload would re-seed the mock). */
async function openChannel(page: Page, name = 'stock-talk'): Promise<void> {
  await home(page);
  const target = await page.evaluate(n => {
    const c = Object.values((window as unknown as StoreWin).__vokko.appStore.getState().channels).find(x => x.name === n && x.guild_id)!;
    return `/channels/${c.guild_id}/${c.id}`;
  }, name);
  await page.evaluate(path => { history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, target);
  await page.locator('.app-frame.nav-open a.channel-row[aria-current="page"]').first().tap();
  await page.locator('.channel-header').getByRole('heading', { name, exact: true }).waitFor();
  await page.waitForTimeout(300);
}

const chatShown = (page: Page) => expect(page.locator('.chat-textarea')).toBeVisible();

/**
 * Opens a view twice from the same place: leaves it with its button, then with back. After each, `back` (the place it was opened from)
 * must hold and the URL must be the one before, inside the app.
 */
async function leaveTwice(page: Page, name: string, o: { open(): Promise<void>; view: Locator; button: Locator; back(): Promise<void> }): Promise<void> {
  for (const how of ['button', 'history'] as const) {
    const url = new URL(page.url()).pathname;
    await o.open();
    await expect(o.view).toBeVisible();
    await page.waitForTimeout(400); // slide-ins
    if (how === 'button') {
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}-${page.viewportSize()!.width}.png` });
      await expect(o.button).toBeVisible();
      await o.button.tap();
    } else {
      await page.goBack();
    }
    await expect(o.view, `${name}: left with ${how}`).toBeHidden();
    await o.back();
    expect(new URL(page.url()).pathname, `${name}: still in the app after ${how}`).toBe(url);
  }
}

for (const { width, height } of [{ width: 390, height: 844 }, { width: 430, height: 932 }]) {
test.describe(`${width}x${height}`, () => {
  test.use({ viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  test('User Settings: Close on the section list, Back to sections on a page', async ({ page }) => {
    await home(page);
    const dialog = page.getByRole('dialog', { name: 'User Settings' });
    const list = dialog.locator('.sm-side');
    await leaveTwice(page, 'user-settings-root', {
      open: () => page.getByRole('button', { name: 'User Settings' }).first().tap(),
      view: dialog,
      button: list.getByRole('button', { name: 'Close' }),
      back: () => expect(page.locator('.sidebar')).toBeVisible(),
    });
    await page.getByRole('button', { name: 'User Settings' }).first().tap();
    await leaveTwice(page, 'user-settings-page', {
      open: () => dialog.getByRole('button', { name: 'My Account' }).tap(),
      view: dialog.locator('.sm-main'),
      button: dialog.getByRole('button', { name: 'Back to sections' }),
      back: () => expect(list).toBeVisible(),
    });
    await page.goBack();
    await expect(dialog).toHaveCount(0);
  });

  test('Server Settings and Channel Settings: Close on the list, Back to sections on a page', async ({ page }) => {
    await openChannel(page);
    await page.getByRole('button', { name: 'Show Channels' }).tap();
    const dialog = page.getByRole('dialog', { name: /Server Settings/ });
    await leaveTwice(page, 'server-settings-root', {
      open: async () => {
        await page.locator('.guild-header').first().tap();
        await page.waitForTimeout(400);
        await page.getByRole('menuitem', { name: 'Server Settings' }).tap();
      },
      view: dialog,
      button: dialog.locator('.fss-sidebar').getByRole('button', { name: 'Close' }),
      back: () => expect(page.locator('.sidebar')).toBeVisible(),
    });
    await page.locator('.guild-header').first().tap();
    await page.waitForTimeout(400);
    await page.getByRole('menuitem', { name: 'Server Settings' }).tap();
    await leaveTwice(page, 'server-settings-page', {
      open: () => dialog.getByRole('button', { name: 'Roles', exact: true }).tap(),
      view: dialog.locator('.fss-content'),
      button: dialog.getByRole('button', { name: 'Back to sections' }),
      back: () => expect(dialog.locator('.fss-sidebar')).toBeVisible(),
    });
    await dialog.locator('.fss-sidebar').getByRole('button', { name: 'Close' }).tap();

    const channelDialog = page.getByRole('dialog', { name: /Channel Settings|stock-talk/ });
    await leaveTwice(page, 'channel-settings-root', {
      open: async () => {
        await longPress(page, page.locator('a.channel-row', { hasText: 'stock-talk' }));
        await page.waitForTimeout(400);
        await page.getByRole('menuitem', { name: 'Edit Channel' }).tap();
      },
      view: channelDialog,
      button: channelDialog.locator('.fss-sidebar').getByRole('button', { name: 'Close' }),
      back: () => expect(page.locator('.sidebar')).toBeVisible(),
    });
  });

  test('the chat, the details page, search results and a thread: back arrows', async ({ page }) => {
    await openChannel(page);
    await leaveTwice(page, 'chat', {
      open: async () => {
        if (await page.locator('.app-frame.nav-open').count()) await page.locator('a.channel-row[aria-current="page"]').first().tap();
      },
      view: page.locator('.chat-textarea'),
      button: page.getByRole('button', { name: 'Show Channels' }),
      back: () => expect(page.locator('.sidebar')).toBeVisible(),
    });
    await page.locator('a.channel-row[aria-current="page"]').first().tap();
    await chatShown(page);

    await leaveTwice(page, 'details', {
      open: () => page.getByRole('button', { name: 'stock-talk, details' }).tap(),
      view: page.locator('.details-page'),
      button: page.locator('.details-page').getByRole('button', { name: 'Back' }),
      back: () => chatShown(page),
    });

    const panel = page.locator('.search-panel');
    await leaveTwice(page, 'search-results', {
      open: async () => {
        const box = page.getByRole('combobox', { name: 'Search' });
        await box.tap();
        await box.fill('morning');
        await box.press('Enter');
      },
      view: panel,
      button: panel.getByRole('button', { name: 'Close Search' }),
      back: () => chatShown(page),
    });
  });

  test('a thread (forum posts open in the same panel): Close thread', async ({ page }) => {
    await openChannel(page, 'general');
    const thread = page.locator('.thread-panel');
    await leaveTwice(page, 'thread', {
      open: async () => {
        await page.getByRole('button', { name: 'general, details' }).tap();
        await page.locator('.details-page').getByRole('tab', { name: 'Threads' }).tap();
        await page.locator('.details-page').getByRole('button', { name: /gateway docs/ }).tap();
      },
      view: thread,
      button: thread.getByRole('button', { name: 'Close thread' }),
      back: () => chatShown(page),
    });
  });

  test('Friends, the Inbox, the profile sheet and the profile editor', async ({ page }) => {
    await home(page);
    await leaveTwice(page, 'friends', {
      open: () => page.locator('.sidebar').getByText('Friends', { exact: true }).first().tap(),
      view: page.locator('.friends-tab').first(),
      button: page.getByRole('button', { name: 'Show Channels' }).first(),
      back: () => expect(page.locator('.sidebar')).toBeVisible(),
    });
    await leaveTwice(page, 'inbox', {
      open: () => page.locator('.user-panel').getByRole('button', { name: 'Inbox' }).tap(),
      view: page.locator('.inbox-popout'),
      button: page.locator('.user-panel').getByRole('button', { name: 'Inbox' }),
      back: () => expect(page.locator('.sidebar')).toBeVisible(),
    });
    const sheet = page.getByRole('dialog', { name: 'User profile' });
    await leaveTwice(page, 'profile-sheet', {
      open: () => page.locator('.user-panel-account').tap(),
      view: sheet,
      button: sheet.locator('.sheet-grabber'),
      back: () => expect(page.locator('.sidebar')).toBeVisible(),
    });
    // Edit Profile in the account sheet opens User Settings > Profiles; the editor opens over it from there
    await page.locator('.user-panel-account').tap();
    await page.waitForTimeout(400);
    await sheet.getByRole('menuitem', { name: 'Edit Profile' }).tap();
    const settings = page.getByRole('dialog', { name: 'User Settings' });
    const editor = page.getByRole('dialog', { name: 'Edit Profile' });
    await leaveTwice(page, 'profile-editor', {
      open: () => settings.getByRole('button', { name: 'Edit Profiles' }).tap(),
      view: editor,
      button: editor.locator('.pe-close'),
      back: () => expect(settings.getByRole('button', { name: 'Edit Profiles' })).toBeVisible(),
    });
    await page.goBack(); // Profiles page -> section list
    await page.goBack(); // section list -> closed
    await expect(settings).toHaveCount(0);
    await expect(page.locator('.sidebar')).toBeVisible();
  });
});
}
