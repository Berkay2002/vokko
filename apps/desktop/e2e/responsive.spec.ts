import { expect, test } from '@playwright/test';
import { composer, openStockTalk } from './helpers';
import { openChannel } from './threadHelpers';

// Narrow-window layouts (styles/responsive.css): <=1000 side panels start hidden, <=767 rail+sidebar drawer, <=485 fullscreen settings.

test.describe('1100px: side panel stays', () => {
  test.use({ viewport: { width: 1100, height: 800 } });
  test('the member list is shown', async ({ page }) => {
    await openStockTalk(page);
    await expect(page.locator('.member-list')).toBeVisible();
  });
});

test.describe('1000px: member list hidden, toggle opens it', () => {
  test.use({ viewport: { width: 1000, height: 800 } });
  test('toggle works per visit', async ({ page }) => {
    await openStockTalk(page);
    await expect(page.locator('.member-list')).toHaveCount(0);
    await page.getByRole('button', { name: /Show Member List/ }).click();
    await expect(page.locator('.member-list')).toBeVisible();
    await page.getByRole('button', { name: /Hide Member List/ }).click();
    await expect(page.locator('.member-list')).toHaveCount(0);
  });
});

test.describe('700px: rail and sidebar are a drawer', () => {
  test.use({ viewport: { width: 700, height: 800 } });
  test('menu button opens it, picking a channel closes it', async ({ page }) => {
    await openStockTalk(page);
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(page.locator('.chat-composer-box')).toBeVisible();
    const box = await page.locator('.chat-composer-box').boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(700);

    await page.getByRole('button', { name: 'Show Channels' }).click();
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('.server-rail')).toBeVisible();
    await expect(page.locator('.user-panel')).toBeVisible();

    await page.locator('.sidebar a[href*="/channels/"]').nth(1).click();
    await expect(page.locator('.sidebar')).toBeHidden();
  });

  test('Escape closes the drawer', async ({ page }) => {
    await openStockTalk(page);
    await page.getByRole('button', { name: 'Show Channels' }).click();
    await expect(page.locator('.sidebar')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.sidebar')).toBeHidden();
  });
});

for (const width of [390, 768]) {
  test.describe(`${width}px: a user can open #general, see its header and type`, () => {
    test.use({ viewport: { width, height: 844 } });
    test('the channel name stays visible next to the search box', async ({ page }) => {
      await openStockTalk(page);
      if (width <= 767) await page.getByRole('button', { name: 'Show Channels' }).click(); // 768 still has the sidebar in the layout
      await page.locator('.sidebar a[href*="/channels/"]', { hasText: /^general$/ }).first().click();
      const heading = page.locator('.channel-header').getByRole('heading', { name: 'general', exact: true });
      await expect(heading).toBeVisible();
      expect((await heading.boundingBox())!.width).toBeGreaterThan(40);
      await composer(page).click();
      await composer(page).pressSequentially('hello from a phone');
      await expect(composer(page)).toHaveText('hello from a phone');
    });

    test('the toolbar of a 1:1 DM and of an announcement channel stays inside the window', async ({ page }) => {
      await openStockTalk(page);
      for (const pick of [(c: { name?: string; guild_id: string | null; type: number }) => !c.guild_id && c.type === 1, (c: { name?: string; guild_id: string | null }) => c.name === 'announcements' && !!c.guild_id]) {
        const target = await page.evaluate(`(() => { const c = Object.values(window.__vokko.appStore.getState().channels).find(${pick.toString()}); return '/channels/' + (c.guild_id ?? '@me') + '/' + c.id; })()`) as string;
        await page.evaluate(path => { history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, target);
        await expect(page.locator('.channel-header-toolbar .toolbar-button')).toHaveCount(5);
        const right = await page.locator('.channel-header-toolbar .toolbar-button').last().evaluate(el => el.getBoundingClientRect().right);
        expect(right).toBeLessThanOrEqual(width);
      }
    });
  });
}

test.describe('780px: user settings fit', () => {
  test.use({ viewport: { width: 780, height: 700 } });
  test('the modal stays inside the window and the column does not overflow', async ({ page }) => {
    await page.goto('/channels/@me?as=sam&mockLatency=0');
    await page.locator('.dm-row').first().waitFor();
    await page.getByRole('button', { name: 'User Settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'User Settings' });
    const size = await dialog.evaluate(el => ({ left: (el as HTMLElement).offsetLeft, width: (el as HTMLElement).offsetWidth }));
    expect(size.left).toBeGreaterThanOrEqual(0);
    expect(size.left + size.width).toBeLessThanOrEqual(780);
    const overflow = await page.locator('.sm-scroll').evaluate(el => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

test.describe('485px: user settings are fullscreen with a section list and a page', () => {
  test.use({ viewport: { width: 485, height: 800 } });
  test('list first, page after picking, back returns', async ({ page }) => {
    await page.goto('/channels/@me?as=sam&mockLatency=0');
    await page.getByRole('button', { name: 'Show Channels' }).waitFor();
    await page.getByRole('button', { name: 'Show Channels' }).click();
    await page.getByRole('button', { name: 'User Settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'User Settings' });
    // layout size, not the animated bounding box (the dialog scales in)
    const size = await dialog.evaluate(el => ({ width: (el as HTMLElement).offsetWidth, height: (el as HTMLElement).offsetHeight }));
    expect(size.width).toBe(485);
    expect(size.height).toBeGreaterThanOrEqual(760); // the full window, minus the 32px banner when one is showing
    await expect(dialog.getByRole('button', { name: 'Appearance' })).toBeVisible();
    await expect(dialog.locator('.sm-main')).toBeHidden();

    await dialog.getByRole('button', { name: 'Appearance' }).click();
    await expect(dialog.locator('.sm-side')).toBeHidden();
    await expect(dialog.getByRole('heading', { name: 'Appearance', level: 1 })).toBeVisible();

    await dialog.getByRole('button', { name: 'Back to sections' }).click();
    await expect(dialog.getByRole('button', { name: 'Appearance' })).toBeVisible();
  });
});

for (const [width, topicShown] of [[390, false], [768, false], [1440, true]] as const) {
  test.describe(`${width}px: channel topic in the header`, () => {
    test.use({ viewport: { width, height: 844 } });
    test(topicShown ? 'the topic and its divider show next to the name' : 'no divider or topic sliver, the name stays', async ({ page }) => {
      await openStockTalk(page); // #stock-talk has a topic
      const header = page.locator('.channel-header');
      await expect(header.getByRole('heading', { name: 'stock-talk', exact: true })).toBeVisible();
      for (const part of ['.channel-header-divider', '.channel-header-topic']) {
        if (topicShown) await expect(header.locator(part)).toBeVisible();
        else await expect(header.locator(part)).toBeHidden();
      }
    });

    test(topicShown ? 'no topic entry while the topic shows' : 'the topic entry opens the full topic by mouse and keyboard', async ({ page }) => {
      await openStockTalk(page);
      const header = page.locator('.channel-header');
      const entry = header.getByRole('button', { name: 'stock-talk, channel topic', exact: true });
      if (topicShown) return expect(entry).toBeHidden();
      await expect(entry).toBeVisible();
      await expect(entry).toHaveAccessibleDescription('Channel topic: Charts, takes and bad ideas.');
      await entry.click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toContainText('Charts, takes and bad ideas.');
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await header.locator('.channel-header-toolbar button').first().focus();
      await page.keyboard.press('Shift+Tab');
      await expect(entry).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('dialog')).toContainText('Charts, takes and bad ideas.');
    });
  });
}

for (const width of [390, 1100]) {
  test.describe(`${width}px: a very long channel name`, () => {
    test.use({ viewport: { width, height: 844 } });
    test('truncates with an ellipsis and the toolbar stays inside the window', async ({ page }) => {
      await openStockTalk(page);
      const m = await page.evaluate(() => {
        document.querySelector('.channel-header-name')!.textContent = 'a-very-long-channel-name-'.repeat(3);
        const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
        const h1 = document.querySelector('.channel-header-name') as HTMLElement;
        const bs = [...document.querySelectorAll('.channel-header-toolbar > *')].map(e => e.getBoundingClientRect().right);
        return { clipped: h1.scrollWidth > h1.clientWidth, last: Math.max(...bs), search: r('.header-search').width, win: window.innerWidth };
      });
      expect(m.clipped).toBe(true);
      expect(m.last).toBeLessThanOrEqual(m.win);
      if (width === 1100) expect(Math.round(m.search)).toBe(244);
    });
  });
}

test.describe('1050px: the topic follows the header width, not the window', () => {
  test.use({ viewport: { width: 1050, height: 800 } });
  test('the topic shows with the default sidebar and hides with a wide one', async ({ page, browser }) => {
    await openStockTalk(page);
    await expect(page.locator('.channel-header-topic')).toBeVisible();
    const wide = await browser.newContext({ viewport: { width: 1050, height: 800 } });
    const wp = await wide.newPage();
    await wp.addInitScript(() => localStorage.setItem('vokko.sidebarWidth', '360'));
    await openStockTalk(wp);
    await expect(wp.locator('.channel-header').getByRole('heading', { name: 'stock-talk', exact: true })).toBeVisible();
    await expect(wp.locator('.channel-header-topic')).toBeHidden();
    await wide.close();
  });
});

for (const [width, wraps] of [[390, true], [1100, true], [1440, false]] as const) {
  test.describe(`${width}px: forum toolbar`, () => {
    test.use({ viewport: { width, height: 844 } });
    test(wraps ? 'search keeps its own row, sort and New Post stay inside the window' : 'one row, search at its full width', async ({ page }) => {
      await openChannel(page, 'support'); // a forum channel
      const box = async (sel: string) => (await page.locator(sel).boundingBox())!;
      const search = await page.getByLabel('Search posts').boundingBox().then(b => b!);
      const sort = await box('.forum-sort');
      const add = await box('.forum-new-button');
      await expect(page.locator('.forum-new-button')).toBeVisible();
      for (const b of [search, sort, add]) expect(b.x + b.width).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      if (wraps) {
        expect(search.width).toBeGreaterThanOrEqual(200);
        expect(sort.y).toBeGreaterThan(search.y); // second row
      } else {
        expect(search.width).toBeGreaterThan(280); // 320 minus the label's padding and icon
        expect(Math.abs(sort.y + sort.height / 2 - (search.y + search.height / 2))).toBeLessThan(4); // same row
      }
    });
  });
}
