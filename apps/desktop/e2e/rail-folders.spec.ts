import { expect, test, type Page } from '@playwright/test';

// Server folders on the rail (SHELL-006, GLD-016): tile size, the roll-up badge on a collapsed folder, the folder menu,
// colour on the tile and dragging a server out again. Create / rename / reconnect live in invites-folders.spec.ts.

type Win = { __vokko: { request(method: string, path: string, body?: unknown): Promise<unknown> }; __vokkoMock: { say(channelId: string, username: string, content: string): string; channelIdByName(name: string): string | null } };

async function openHome(page: Page): Promise<void> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: "Sam's server" }).waitFor();
}

async function createGuild(page: Page, name: string): Promise<void> {
  await page.evaluate(n => (window as unknown as Win).__vokko.request('POST', '/guilds', { name: n }), name);
  await page.getByRole('link', { name }).waitFor();
}

const rail = (page: Page) => page.getByRole('navigation', { name: 'Servers sidebar' });

test('a collapsed folder is a 48 px tile of 2x2 icons that rolls up mentions, and the menu collapses, tints and marks read', async ({ page }) => {
  await openHome(page);
  await createGuild(page, 'Alpha');
  const nav = rail(page);
  await nav.getByRole('link', { name: 'Alpha' }).dragTo(nav.getByRole('link', { name: "Sam's server" }));
  const folder = nav.locator('.rail-folder');
  const tile = folder.getByRole('button', { name: /^Folder/ });
  await expect(tile).toHaveAttribute('aria-expanded', 'true');

  // The menu collapses it.
  await tile.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Collapse Folder' }).click();
  await expect(tile).toHaveAttribute('aria-expanded', 'false');
  await expect(folder.getByRole('link')).toHaveCount(0);

  // 48x48 tile holding a 2x2 grid of 20 px icons.
  expect(await tile.evaluate(el => [el.getBoundingClientRect().width, el.getBoundingClientRect().height])).toEqual([48, 48]);
  const minis = await folder.locator('.rail-folder-mini').evaluateAll(els => els.map(e => [e.getBoundingClientRect().width, e.getBoundingClientRect().x, e.getBoundingClientRect().y]));
  expect(minis).toHaveLength(2);
  expect(minis[0]![0]).toBe(20);

  // The seeded server already has 2 mentions; another one adds to the sum on the folder tile and in its accessible name; none while expanded.
  await expect(folder.locator('.rail-folder-badge')).toHaveText('2');
  const randomId = await page.evaluate(() => (window as unknown as Win).__vokkoMock.channelIdByName('random')!);
  await page.evaluate(id => (window as unknown as Win).__vokkoMock.say(id, 'alice', '@everyone look'), randomId);
  await expect(folder.locator('.rail-folder-badge')).toHaveText('3');
  await expect(tile).toHaveAccessibleName(/^Folder .+, 3 mentions$/);
  if (process.env.VOKKO_SHOTS_DIR) await nav.screenshot({ path: `${process.env.VOKKO_SHOTS_DIR}/SHELL-006-folder-collapsed-badge.png` });
  await tile.click();
  await expect(folder.locator('.rail-folder-badge')).toHaveCount(0);
  await expect(folder.getByRole('link', { name: /^Sam's server, 3 mentions/ })).toBeVisible();
  await tile.click();

  // Mark Folder As Read clears it.
  await tile.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Mark Folder As Read' }).click();
  await expect(folder.locator('.rail-folder-badge')).toHaveCount(0);
  await expect(tile).toHaveAccessibleName("Folder Sam's server, Alpha");

  // A message without a mention makes the name end in ", unread" and shows no count.
  await page.evaluate(id => (window as unknown as Win).__vokkoMock.say(id, 'alice', 'just chatting'), randomId);
  await expect(tile).toHaveAccessibleName("Folder Sam's server, Alpha, unread");
  await expect(folder.locator('.rail-folder-badge')).toHaveCount(0);

  // The chosen colour is what the tile and the expanded background use.
  const plain = await tile.evaluate(el => getComputedStyle(el).backgroundColor);
  await tile.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Folder Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Folder Settings' });
  await dialog.getByRole('radio', { name: '#ed4245' }).click();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(folder).toHaveCSS('--folder-color', '#ed4245');
  await expect(tile).not.toHaveCSS('background-color', plain);

  // Compact and cozy density: the 48 px tile does not overlap its neighbours.
  for (const density of ['density-compact', 'density-cozy']) {
    await page.evaluate(d => { document.documentElement.classList.remove('density-compact', 'density-cozy'); document.documentElement.classList.add(d); }, density);
    const rects = await nav.locator('.rail-item').evaluateAll(els => els.map(e => (e.querySelector('.rail-tile') ?? e).getBoundingClientRect()).filter(r => r.height > 0).map(r => [r.top, r.bottom]));
    const sorted = rects.sort((x, y) => x[0]! - y[0]!);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]![0]!).toBeGreaterThanOrEqual(sorted[i - 1]![1]! - 0.5);
  }
});

test('dragging a server out of a folder puts it back on the rail, and a folder of one is removed with the menu', async ({ page }) => {
  await openHome(page);
  await createGuild(page, 'Alpha');
  await createGuild(page, 'Beta');
  const nav = rail(page);
  await nav.getByRole('link', { name: 'Alpha' }).dragTo(nav.getByRole('link', { name: "Sam's server" }));
  const folder = nav.locator('.rail-folder');
  await expect(folder.getByRole('link')).toHaveCount(2);

  // Top quarter of Beta: before it, outside the folder.
  await folder.getByRole('link', { name: 'Alpha' }).dragTo(nav.getByRole('link', { name: 'Beta' }), { targetPosition: { x: 20, y: 3 } });
  await expect(folder.getByRole('link')).toHaveCount(1);
  const names = await nav.locator('[href^="/channels/"]:not(.rail-home):not(.rail-dm)').evaluateAll(els => els.map(e => e.getAttribute('aria-label')));
  expect(names.slice(-3).map(n => n!.replace(/, \d+ mentions?$/, ''))).toEqual(["Sam's server", 'Alpha', 'Beta']);

  await folder.getByRole('button', { name: /^Folder/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Remove Folder' }).click();
  await expect(nav.locator('.rail-folder')).toHaveCount(0);
  await expect(nav.getByRole('link', { name: "Sam's server" })).toBeVisible();
});

test('Move Up / Move Down from the keyboard reorder a server, a folder and a server inside a folder, and the order is saved', async ({ page }) => {
  await openHome(page);
  await createGuild(page, 'Alpha');
  await createGuild(page, 'Beta');
  const nav = rail(page);
  // The announcement goes through the shell announcer, so it works here on Friends home (no chat view mounted).
  await expect(page.getByRole('main', { name: 'Friends' })).toBeVisible();
  await expect(page.locator('.chat-toasts')).toHaveCount(0);
  const toast = page.getByTestId('announcer');
  const ids = async () => nav.locator('a.rail-guild').evaluateAll(els => els.map(e => e.getAttribute('href')!.split('/')[2]!));
  const names = async () => nav.locator('a.rail-guild').evaluateAll(els => els.map(e => e.getAttribute('aria-label')!.replace(/, \d+ mentions?$/, '')));
  const saved = async () => (await page.evaluate(() => (window as unknown as Win).__vokko.request('GET', '/users/@me/guild-layout'))) as { guild_positions: string[]; guild_folders: { guild_ids: string[] }[] };

  // Shift+F10 opens the menu on the focused tile, the arrow keys walk to the row and Enter picks it.
  async function move(tile: Locator, row: 'Move Up' | 'Move Down', shot?: string): Promise<void> {
    await tile.focus();
    await page.keyboard.press('Shift+F10');
    await expect(page.getByRole('menu')).toBeVisible();
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('ArrowDown');
      if ((await page.locator('.context-menu-item.focused', { hasText: row }).count()) > 0) break;
    }
    if (shot && process.env.VOKKO_SHOTS_DIR) await page.screenshot({ path: `${process.env.VOKKO_SHOTS_DIR}/${shot}.png` });
    await page.keyboard.press('Enter');
  }

  // A top-level server.
  expect(await names()).toEqual(["Sam's server", 'Alpha', 'Beta']);
  const alpha = nav.getByRole('link', { name: 'Alpha' });
  await move(alpha, 'Move Up', 'GLD-016-server-move-menu');
  await expect.poll(names).toEqual(['Alpha', "Sam's server", 'Beta']);
  await expect(alpha).toBeFocused();
  await expect(toast).toContainText('Moved Alpha up to 1 of 3 on the server rail.');
  expect((await saved()).guild_positions).toEqual(await ids());

  // A folder as a whole: Beta onto Sam's server makes one (it opens), Move Up puts the folder above Alpha.
  await nav.getByRole('link', { name: 'Beta' }).dragTo(nav.getByRole('link', { name: "Sam's server" }));
  const folder = nav.locator('.rail-folder');
  const tile = folder.getByRole('button', { name: /^Folder/ });
  await expect(folder.getByRole('link')).toHaveCount(2);
  await move(tile, 'Move Up', 'GLD-016-folder-move-menu');
  await expect.poll(names).toEqual(["Sam's server", 'Beta', 'Alpha']);
  await expect(tile).toBeFocused();
  await expect(toast).toContainText('Moved folder');
  await expect(toast).toContainText('up to 1 of 2 on the server rail.');
  expect((await saved()).guild_positions).toEqual(await ids());

  // A server inside the folder swaps with its neighbour there ...
  const beta = folder.getByRole('link', { name: 'Beta' });
  await move(beta, 'Move Up');
  await expect.poll(names).toEqual(['Beta', "Sam's server", 'Alpha']);
  await expect(beta).toBeFocused();
  await expect(toast).toContainText('Moved Beta up to 1 of 2 in ');
  // ... and at the folder's edge steps out above it.
  await move(beta, 'Move Up');
  await expect(folder.getByRole('link')).toHaveCount(1);
  await expect(nav.getByRole('link', { name: 'Beta' })).toBeFocused();
  await expect(toast).toContainText('Moved Beta up to 1 of 3 on the server rail.');
  expect(await names()).toEqual(['Beta', "Sam's server", 'Alpha']);
  const layout = await saved();
  expect(layout.guild_positions).toEqual(await ids());
  expect(layout.guild_folders.map(f => f.guild_ids.length)).toEqual([1]);

  // A fresh READY rebuilds the order from the server: change the layout through the API while the socket is down (the update
  // event is missed), so the new order can only come from READY.
  const reversed = [...(await ids())].reverse();
  await page.evaluate(
    ([positions, folders]) => {
      const w = window as unknown as Win & { __vokkoMock: { dropConnections(): void } };
      w.__vokkoMock.dropConnections();
      return w.__vokko.request('PATCH', '/users/@me/guild-layout', { guild_positions: positions, guild_folders: folders });
    },
    [reversed, layout.guild_folders] as const,
  );
  await expect.poll(names).toEqual(['Alpha', "Sam's server", 'Beta']);
  expect((await saved()).guild_positions).toEqual(reversed);
});
