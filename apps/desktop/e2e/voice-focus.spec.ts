import { expect, test, type Page } from '@playwright/test';

// Call stage (mock backend, same seed as voice-ui.spec.ts): the grid fills the stage, clicking a tile focuses it over a
// strip of the others, Escape returns to the grid, and the strip can be hidden and shown again.
// Run from apps/desktop: VOICE_ALL=1 npx playwright test -c e2e/voice-ui.config.ts voice-focus

async function openGuild(page: Page): Promise<void> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.getByRole('list', { name: 'Channels' }).waitFor();
  await page.locator('.sidebar-scroller').evaluate(el => { el.scrollTop = el.scrollHeight; });
}

const call = (page: Page) => page.getByRole('region', { name: /call$/ });

async function joinGeneral(page: Page): Promise<void> {
  await openGuild(page);
  await page.getByRole('button', { name: 'General voice channel' }).click();
  await expect(call(page).locator('.voice-tile')).toHaveCount(3);
}

test('grid: 3 people lay out as 2 + 1 and fill the stage width', async ({ page }) => {
  await joinGeneral(page);
  const grid = call(page).locator('.voice-grid');
  await expect(grid).toHaveAttribute('data-cols', '2');
  const tiles = await call(page).locator('.voice-grid > .voice-tile').evaluateAll(els => els.map(el => el.getBoundingClientRect().toJSON() as DOMRect));
  // Two tiles on the first row, one centred under them, all the same 16:9 size.
  expect(Math.abs(tiles[0].y - tiles[1].y)).toBeLessThan(1);
  expect(tiles[2].y).toBeGreaterThan(tiles[0].y + tiles[0].height - 1);
  const rowCentre = (tiles[0].x + tiles[1].x + tiles[1].width) / 2;
  expect(Math.abs(tiles[2].x + tiles[2].width / 2 - rowCentre)).toBeLessThan(2);
  expect(Math.abs(tiles[0].width / tiles[0].height - 16 / 9)).toBeLessThan(0.02);
  // The tiles are sized to the stage, not a small fixed row.
  const stage = await call(page).locator('.voice-tiles.grid').boundingBox();
  const fillsWidth = tiles[0].width * 2 + 8 >= stage!.width * 0.97;
  const fillsHeight = tiles[0].height * 2 + 8 >= stage!.height * 0.97;
  expect(fillsWidth || fillsHeight).toBe(true);
});

test('focus a tile, switch from the strip, return with a click and with Escape', async ({ page }) => {
  await joinGeneral(page);
  await call(page).getByRole('button', { name: /^Focus Alice/ }).click();

  const focused = call(page).locator('.voice-tile.focused');
  await expect(focused).toHaveAttribute('aria-pressed', 'true');
  await expect(focused).toHaveAttribute('aria-label', /^Return to grid \(Alice/);
  const strip = call(page).getByRole('group', { name: 'Members' });
  await expect(strip.locator('.voice-tile')).toHaveCount(2);
  const stripBox = await strip.boundingBox();
  expect(Math.round(stripBox!.height)).toBe(140);
  const focusedBox = await focused.boundingBox();
  expect(focusedBox!.y + focusedBox!.height).toBeLessThanOrEqual(stripBox!.y);

  // Clicking a strip tile switches focus.
  await strip.getByRole('button', { name: /^Focus Bobby/ }).click();
  await expect(focused).toHaveAttribute('aria-label', /^Return to grid \(Bobby/);
  await expect(strip.getByRole('button', { name: /^Focus Alice/ })).toBeVisible();

  // Clicking the focused tile returns to the grid.
  await focused.click();
  await expect(call(page).locator('.voice-grid > .voice-tile')).toHaveCount(3);
  await expect(call(page).locator('.voice-tile.focused')).toHaveCount(0);

  // Keyboard: Enter focuses, Escape returns.
  await call(page).getByRole('button', { name: /^Focus Alice/ }).focus();
  await page.keyboard.press('Enter');
  await expect(focused).toHaveAttribute('aria-label', /^Return to grid \(Alice/);

  // An open popout keeps Escape (it closes, focus stays), even when its search box is not focused.
  await call(page).getByRole('button', { name: 'Soundboard' }).click();
  const search = page.getByRole('textbox', { name: 'Find the perfect sound' });
  await expect(search).toBeVisible();
  await search.evaluate(el => (el as HTMLElement).blur());
  await page.keyboard.press('Escape');
  await expect(search).toHaveCount(0);
  await expect(focused).toHaveCount(1);
  // Shift+Escape is the shell's mark-as-read, not "return to grid".
  await page.keyboard.press('Shift+Escape');
  await expect(focused).toHaveCount(1);

  await page.keyboard.press('Escape');
  await expect(call(page).locator('.voice-tile.focused')).toHaveCount(0);
  await expect(call(page).locator('.voice-grid > .voice-tile')).toHaveCount(3);
});

test('hide and show members in focus mode; focus resets when the focused person leaves', async ({ page }) => {
  await joinGeneral(page);
  await call(page).getByRole('button', { name: /^Focus Alice/ }).click();
  const focused = call(page).locator('.voice-tile.focused');
  const before = await focused.boundingBox();

  await call(page).locator('.voice-strip-wrap').hover();
  const hide = call(page).getByRole('button', { name: 'Hide Members' });
  await hide.hover();
  await expect(page.getByRole('tooltip', { name: 'Hide Members' })).toBeVisible();
  await hide.click();
  await expect(call(page).getByRole('group', { name: 'Members' })).toHaveCount(0);
  const after = await focused.boundingBox();
  expect(after!.height).toBeGreaterThan(before!.height);

  // The pill moved to the bottom centre of the focused tile.
  const show = call(page).getByRole('button', { name: 'Show Members' });
  const showBox = await show.boundingBox();
  expect(showBox!.y + showBox!.height).toBeLessThanOrEqual(after!.y + after!.height);
  expect(showBox!.y).toBeGreaterThan(after!.y + after!.height - 60);
  expect(Math.abs(showBox!.x + showBox!.width / 2 - (after!.x + after!.width / 2))).toBeLessThan(2);

  // A stream that is not focused shows as a picture-in-picture while members are hidden.
  const general = await page.evaluate(() => (window as unknown as { __vokkoMock: { channelIdByName(n: string): string } }).__vokkoMock.channelIdByName('General'));
  await page.evaluate(id => (window as unknown as { __vokkoMock: { voice(u: string, c: string | null, o?: object): void } }).__vokkoMock.voice('nova', id, { selfStream: true }), general);
  const pip = call(page).locator('.voice-pip .voice-tile');
  await expect(pip).toHaveCount(1);
  await expect(pip.locator('.voice-tile-live')).toHaveText('LIVE');

  await focused.hover();
  await show.click();
  await expect(call(page).getByRole('group', { name: 'Members' }).locator('.voice-tile')).toHaveCount(3);
  await expect(call(page).locator('.voice-pip')).toHaveCount(0);
  await expect(call(page).getByRole('group', { name: 'Members' }).locator('.voice-tile-live')).toHaveCount(1);

  // Alice leaves: back to the grid.
  await page.evaluate(() => (window as unknown as { __vokkoMock: { voice(u: string, c: string | null): void } }).__vokkoMock.voice('alice', null));
  await expect(call(page).locator('.voice-tile.focused')).toHaveCount(0);
  await expect(call(page).locator('.voice-grid > .voice-tile')).toHaveCount(3);
});
