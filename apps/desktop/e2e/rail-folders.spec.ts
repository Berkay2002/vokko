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
