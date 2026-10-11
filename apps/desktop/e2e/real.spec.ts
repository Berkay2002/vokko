import { expect, test } from '@playwright/test';
import { api, apiLogin, guildByName, openDmWith, openSession, shot } from './realHelpers';

// Real-server integration, smoke tier. Run with VOKKO_REAL=1 (see playwright.config.ts) against a seeded vokko-server.
// The other real.*.spec.ts files cover chat, guilds, social, resilience and the shell screens.

test('server is up and seeded', async () => {
  const { token } = await apiLogin('sam');
  const me = await api<{ username: string }>(token, 'GET', '/users/@me');
  expect(me.username).toBe('sam');
  const g = await guildByName(token, "Sam's server");
  expect(g.id).toBeTruthy();
});

test('login form signs in and the DM list shows the seeded conversations', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel(/Email or username/).fill('sam');
  await page.getByLabel(/Password/).fill('vokko-dev');
  await page.getByRole('button', { name: /Log In/i }).click();
  await expect(page.getByRole('list', { name: 'Direct messages' }).getByRole('link', { name: /Carol/ })).toBeVisible({ timeout: 15_000 });
  await shot(page, 'r01-home');
});

test('a wrong password shows the form error, a restored session survives reload', async ({ page, browser }) => {
  await page.goto('/');
  await page.getByLabel(/Email or username/).fill('sam');
  await page.getByLabel(/Password/).fill('definitely-wrong');
  await page.getByRole('button', { name: /Log In/i }).click();
  await expect(page.locator('.field-label-error').first()).toBeVisible();
  const s = await openSession(browser, 'sam');
  await expect(s.page.getByRole('list', { name: 'Direct messages' })).toBeVisible();
  await s.page.reload();
  await expect(s.page.getByRole('list', { name: 'Direct messages' })).toBeVisible();
  await s.ctx.close();
});

test('DM history loads from the server, scrolls to the start and shows the intro', async ({ browser }) => {
  const s = await openSession(browser, 'sam');
  await openDmWith(s.page, 'carol');
  await expect(s.page.locator('.chat-msg').first()).toBeVisible();
  await shot(s.page, 'r02-dm-history');
  // the seeded DM has ~60 messages; page up until the start-of-conversation intro mounts
  await s.page.locator('.chat-scroller').hover();
  for (let i = 0; i < 12 && (await s.page.locator('.chat-start').count()) === 0; i++) {
    await s.page.mouse.wheel(0, -4000);
    await s.page.waitForTimeout(300);
  }
  await expect(s.page.locator('.chat-start')).toBeVisible();
  await shot(s.page, 'r03-dm-start');
  await s.ctx.close();
});
