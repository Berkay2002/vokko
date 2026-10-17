import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Games in calls against the mock backend (src/api/mock/games.ts, docs/design/games-host.md section 10). The built-in
// `builtin:mock` game (public/games/mock/, MOCK builds only) shows "players: N", sends {"ping":n} and lists what it gets;
// Alice and Bob are seeded in General and have no gateway session, so the mock lets the first of them answer pings.
// Run from apps/desktop: VOKKO_E2E_PORT=1453 npx playwright test e2e/games.spec.ts

const SHOTS = process.env.GAMES_SHOTS ?? '/srv/vokko/.claude/artifacts/games-host';
const shot = (name: string) => join(SHOTS, name);

type StoreWin = { __vokko: { appStore: { getState(): { channels: Record<string, { id: string; name?: string; guild_id: string | null }> } } } };

async function openGuild(page: Page): Promise<void> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.getByRole('list', { name: 'Channels' }).waitFor();
  await page.locator('.sidebar-scroller').evaluate(el => { el.scrollTop = el.scrollHeight; });
}

const call = (page: Page) => page.getByRole('region', { name: /call$/ });
const game = (page: Page) => page.frameLocator('iframe.game-frame');

test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));

test('start a game from Activities, ping -> pong through the relay, hostile frames are ignored, stop', async ({ page }) => {
  await openGuild(page);
  await page.getByRole('button', { name: 'General voice channel' }).click();
  await expect(call(page).locator('.voice-tile')).toHaveCount(3);

  await call(page).getByRole('button', { name: 'Activities', exact: true }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: /Sketch/ })).toBeVisible();
  await page.screenshot({ path: shot('activities-menu.png') });
  await menu.getByRole('menuitem', { name: /Mock Game/ }).click();

  // The tile is focused and loads the frame, sandboxed without allow-same-origin (a built-in has an opaque origin).
  const tile = call(page).locator('.voice-tile.game');
  await expect(tile).toHaveClass(/focused/);
  await expect(tile.locator('.game-origin')).toHaveText('Vokko');
  const frame = tile.locator('iframe.game-frame');
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-pointer-lock');
  await expect(frame).toHaveAttribute('allow', '');
  await expect(game(page).getByTestId('game-players')).toHaveText('players: 3');
  await expect(tile.locator('.game-loading')).toHaveCount(0); // the game said ready
  await expect(page.locator('.voice-game-line')).toHaveText('Game: Mock Game');

  await game(page).getByRole('button', { name: 'Send ping' }).click();
  await expect(game(page).getByTestId('game-message')).toHaveText(['{"pong":1}']);
  await page.screenshot({ path: shot('game-running.png') });

  // Two hostile frames on the same page say hello: one with the app's origin, one opaque like the game. Neither is the
  // game's window, so neither gets a port; a window message that looks like a "send" is not a relay either.
  await page.evaluate(() => {
    const script = `<script>
      addEventListener('message', function (e) { if (e.data && e.data.vokko === 'init') document.body.dataset.got = 'init'; });
      parent.postMessage({ vokko: 'hello', v: 1 }, '*');
      parent.postMessage({ type: 'send', data: { ping: 99 } }, '*');
      setTimeout(function () { document.body.dataset.done = '1'; }, 300);
    <\/script>`;
    for (const sandbox of [null, 'allow-scripts']) {
      const el = document.createElement('iframe');
      el.className = 'hostile-frame';
      if (sandbox) el.setAttribute('sandbox', sandbox);
      el.srcdoc = `<!doctype html><body>${script}</body>`;
      document.body.append(el);
    }
  });
  for (const i of [0, 1]) {
    const hostile = page.frameLocator('iframe.hostile-frame').nth(i).locator('body');
    await expect(hostile).toHaveAttribute('data-done', '1');
    await expect(hostile).not.toHaveAttribute('data-got', 'init');
  }
  await page.waitForTimeout(300);
  await expect(game(page).getByTestId('game-message')).toHaveText(['{"pong":1}']);

  // Phone width: the frame stays clipped to its tile under the header strip.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: shot('game-running-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 900 });

  // Close keeps the session (the tile goes back to a cover in the grid); Stop ends it for everyone.
  await tile.getByRole('button', { name: 'Close game' }).click();
  await expect(tile).toHaveClass(/grid/);
  await expect(tile.locator('iframe')).toHaveCount(0);
  await tile.getByRole('button', { name: 'Stop game' }).click();
  await expect(call(page).locator('.voice-tile.game')).toHaveCount(0);
  await expect(page.locator('.voice-game-line')).toHaveCount(0);
});

test('Server Settings > Activities adds and removes a game',async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.waitForFunction(() => Object.values((window as unknown as StoreWin).__vokko.appStore.getState().channels).some(c => c.name === 'general' && c.guild_id));
  const target = await page.evaluate(() => {
    const c = Object.values((window as unknown as StoreWin).__vokko.appStore.getState().channels).find(x => x.name === 'general' && x.guild_id)!;
    return `/channels/${c.guild_id}/${c.id}`;
  });
  await page.evaluate(path => { history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, target);
  await page.locator('.guild-header-name-button').click();
  await page.getByRole('menuitem', { name: 'Server Settings' }).click();
  await page.getByRole('button', { name: 'Activities', exact: true }).click();
  await expect(page.getByText('No games added yet.')).toBeVisible();

  await page.getByRole('button', { name: 'Add Game' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a game' });
  await dialog.getByLabel('Name').fill('Codenames');
  await dialog.getByLabel('Game URL').fill('http://play.example/vokko/');
  await dialog.getByRole('button', { name: 'Add Game' }).click();
  await expect(dialog).toContainText('Must be an absolute https URL.');
  await dialog.getByLabel('Game URL').fill('https://play.example/vokko/');
  await expect(dialog).toContainText('This game runs code from https://play.example in your members\' calls.');
  await dialog.getByLabel('Icon (one emoji, optional)').fill('🕵️');
  await dialog.getByRole('button', { name: 'Add Game' }).click();
  await expect(dialog).toHaveCount(0);

  const list = page.getByRole('list', { name: 'Games' });
  await expect(list.locator('li')).toHaveCount(1);
  await expect(list.locator('li')).toContainText('Codenames');
  await expect(list.locator('li')).toContainText('https://play.example · 2-8 players');
  await page.screenshot({ path: shot('settings-allowlist.png') });

  await list.getByRole('button', { name: 'Remove Codenames' }).click();
  const confirm = page.getByRole('dialog', { name: 'Remove Game' });
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(list.locator('li')).toContainText('Codenames');
  await list.getByRole('button', { name: 'Remove Codenames' }).click();
  await confirm.getByRole('button', { name: 'Remove Game' }).click();
  await expect(page.getByText('No games added yet.')).toBeVisible();
});
