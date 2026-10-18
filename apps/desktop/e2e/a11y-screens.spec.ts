import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { mockReady } from './accountHelpers';
import { openDm } from './helpers';

// Regression gate for the main screens: any serious or critical axe violation fails, unless it is listed in ALLOWED with
// the reason it cannot be fixed yet. Lower impacts are reported as annotations only (a11y.spec.ts tracks those per rule).
// VOKKO_A11Y_COUNTS=<file> appends one JSON line per screen with the violation counts by impact.

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
const GATED = new Set(['serious', 'critical']);
const ALLOWED: Record<string, string> = {};
// Left out of the scan on purpose. Discord dims offline members and idle voice users to half opacity as the presence cue; the
// same state is in each row's accessible name (status dot label), so only sighted contrast is affected. Owner call to change.
const DIMMED_BY_DESIGN = ['.member-row.offline .member-name', '.voice-user.away'];

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' }); // entrance fades otherwise make axe measure half-transparent text
});

async function check(page: Page, info: TestInfo, screen: string, include?: string): Promise<void> {
  let builder = new AxeBuilder({ page }).withTags(TAGS);
  if (include) builder = builder.include(include);
  for (const sel of DIMMED_BY_DESIGN) builder = builder.exclude(sel);
  const violations = (await builder.analyze()).violations;
  if (process.env.VOKKO_SHOTS) await page.screenshot({ path: `${process.env.VOKKO_SHOTS}/screen-${screen.replace(/[^a-z0-9-]+/gi, '_')}.png` });
  const counts: Record<string, number> = {};
  for (const v of violations) counts[v.impact ?? 'none'] = (counts[v.impact ?? 'none'] ?? 0) + v.nodes.length;
  info.annotations.push({ type: 'axe', description: `${screen}: ${JSON.stringify(counts)} ${violations.map(v => `${v.id}(${v.impact})`).join(' ')}` });
  const file = process.env.VOKKO_A11Y_COUNTS;
  if (file) (await import('node:fs')).appendFileSync(file, JSON.stringify({ screen, counts, rules: violations.map(v => [v.id, v.impact, v.nodes.length]), nodes: violations.flatMap(v => v.nodes.map(n => [v.id, n.target.join(' '), n.failureSummary?.split('\n').slice(1).join(' ').slice(0, 160)])) }) + '\n');
  const bad = violations.filter(v => GATED.has(v.impact ?? '') && !(v.id in ALLOWED));
  expect(bad.map(v => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`), `${screen}: serious/critical axe violations`).toEqual([]);
}

async function openGuild(page: Page): Promise<void> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.locator('.chat-msg').first().waitFor();
}

async function userSettings(page: Page, section: string): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'User Settings' });
  if (!(await dialog.isVisible())) {
    await page.getByRole('button', { name: 'User Settings' }).click();
    await dialog.waitFor();
  }
  await dialog.getByRole('button', { name: section, exact: true }).click();
}

test.describe('desktop', () => {
  test('login and register', async ({ page }, info) => {
    await page.goto('/login?mockLatency=0');
    await mockReady(page);
    await page.getByRole('button', { name: 'Log In', exact: true }).waitFor();
    await check(page, info, 'login');
    await page.getByRole('link', { name: /register/i }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).waitFor();
    await check(page, info, 'register');
  });

  test('friends', async ({ page }, info) => {
    await page.goto('/channels/@me?as=sam&mockLatency=0');
    await page.getByRole('main', { name: 'Friends' }).waitFor();
    await check(page, info, 'friends');
  });

  test('guild channel and member list', async ({ page }, info) => {
    await openGuild(page);
    await expect(page.getByRole('complementary', { name: 'Members' })).toBeVisible();
    await check(page, info, 'guild-channel');
  });

  test('DM', async ({ page }, info) => {
    await openDm(page);
    await check(page, info, 'dm');
  });

  test('user settings pages', async ({ page }, info) => {
    await openGuild(page);
    for (const section of ['My Account', 'Data & Privacy', 'Content & Social', 'Notifications', 'Voice & Video', 'Appearance', 'Accessibility', 'Chat', 'Keybinds']) {
      await userSettings(page, section);
      await check(page, info, `settings:${section}`, '[role=dialog]');
    }
  });

  test('server settings', async ({ page }, info) => {
    await openGuild(page);
    await page.locator('.guild-header-name-button').click();
    await page.getByRole('menuitem', { name: 'Server Settings' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await check(page, info, 'server-settings:Overview', '[role=dialog]');
    await dialog.getByRole('button', { name: 'Roles', exact: true }).click();
    await expect(page.locator('.ss-role-list')).toBeVisible();
    await check(page, info, 'server-settings:Roles', '[role=dialog]');
  });

  test('modals: create server, invite', async ({ page }, info) => {
    await openGuild(page);
    await page.getByRole('button', { name: 'Add a Server' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await check(page, info, 'modal:create-server', '[role=dialog]');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Invite People' }).first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await check(page, info, 'modal:invite', '[role=dialog]');
  });

  test('voice panel', async ({ page }, info) => {
    await openGuild(page);
    await page.getByRole('button', { name: 'General voice channel' }).click();
    await expect(page.getByRole('button', { name: 'Leave voice channel' })).toBeVisible();
    await check(page, info, 'voice');
  });
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

  test('home list and chat', async ({ page }, info) => {
    await page.goto('/channels/@me?as=sam&mockLatency=0');
    await page.getByRole('link', { name: /^alice/i }).first().waitFor();
    await check(page, info, 'phone:home');
    await page.getByRole('link', { name: /^alice/i }).first().tap();
    await page.locator('.chat-msg').first().waitFor();
    await check(page, info, 'phone:dm');
  });

  // The list page (rail + DM list or channel list) stands in for the hidden chat: it carries the main landmark and the one h1.
  test('list pages: landmarks, headings and labelled lists', async ({ page }, info) => {
    await page.goto('/channels/@me?as=sam&mockLatency=0');
    const main = page.getByRole('main');
    await expect(main).toHaveCount(1);
    await expect(main).toHaveAccessibleName('Direct Messages');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(['Direct Messages']);
    await expect(main.getByRole('navigation', { name: 'Servers sidebar' })).toBeVisible();
    await expect(main.getByRole('navigation', { name: 'Private channels' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Direct Messages' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Direct messages' })).toBeVisible();
    await check(page, info, 'phone:home-list');

    await page.getByRole('link', { name: /^Sam's server/ }).tap();
    await page.getByRole('list', { name: 'Channels', exact: true }).waitFor();
    await expect(main).toHaveAccessibleName("Sam's server");
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(["Sam's server"]);
    await expect(page.getByRole('list', { name: 'Text Channels' })).toBeVisible();
    await check(page, info, 'phone:channel-list');

    // Reading and tab order: the server rail, then the list, then the account panel.
    const inOrder = await page.evaluate(() => {
      const [rail, list, panel] = ['.server-rail', '.sidebar .channel-list', '.user-panel'].map(sel => document.querySelector(sel));
      const before = (a: Element | null, b: Element | null) => !!a && !!b && !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      return before(rail, list) && before(list, panel) && document.querySelectorAll('[tabindex]:not([tabindex="0"]):not([tabindex="-1"])').length === 0;
    });
    expect(inOrder).toBe(true);

    // Picking a channel brings the chat back as the main landmark.
    await page.getByRole('link', { name: 'general', exact: true }).tap();
    await page.locator('.chat-msg').first().waitFor();
    await expect(page.getByRole('main')).toHaveAccessibleName('general');
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  });
});
