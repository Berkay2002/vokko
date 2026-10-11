import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import path from 'node:path';

// Unread DMs in the server rail (under Home, above the separator) with the mention badge, the DM list's unread pill and
// "In voice" subtitle, and the rail item popping out once the DM is read. Screenshots are written when VOKKO_SHOTS_DIR is set.
const dir = process.env.VOKKO_SHOTS_DIR;

type Win = {
  __vokkoMock: { say(c: string, u: string, t: string): string };
  __vokko: { appStore: { getState(): { channels: Record<string, { id: string; type: number; recipients?: { username: string }[] }> } } };
};

const shot = async (page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }) => {
  if (dir) await page.screenshot({ path: path.join(dir, `${name}.png`), ...(clip ? { clip } : {}) });
};

/** The rail items between Home and the separator. */
const railDms = (page: Page) => page.locator('.server-rail .rail-dm-slot:not(.leaving)');

const dmIdWith = (page: Page, username: string) =>
  page.evaluate(
    u => Object.values((window as unknown as Win).__vokko.appStore.getState().channels).find(c => c.type === 1 && c.recipients?.[0]?.username === u)?.id ?? '',
    username,
  );

test('unread DMs sit in the rail under Home with a mention badge and leave once read', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  const rail = page.getByRole('navigation', { name: 'Servers sidebar' });
  await rail.getByRole('link', { name: 'Direct Messages' }).waitFor();

  // Seed: Alice's DM (1 unread) and the group DM (2 unread), newest first, both above the separator.
  await expect(railDms(page)).toHaveCount(2);
  const alice = railDms(page).first();
  await expect(alice.getByRole('link')).toHaveAccessibleName('Alice, 1 mention');
  await expect(alice.locator('.rail-badge')).toHaveText('1');
  await expect(alice.locator('.rail-item')).toHaveAttribute('data-state', 'unread');
  await expect(alice.locator('img')).toHaveCount(1);
  const group = railDms(page).nth(1);
  await expect(group.locator('.rail-badge')).toHaveText('2');
  await expect(group.locator('.rail-dm-group')).toBeVisible();
  const order = await page.locator('.server-rail').evaluate(nav => [...nav.children].map(el => el.className.split(' ')[0]));
  expect(order.slice(0, 4)).toEqual(['rail-item', 'rail-dm-slot', 'rail-dm-slot', 'rail-separator']);

  // Badge: 16 px red pill at the avatar's bottom-right, ringed in the rail colour (measured once the pop-in has finished).
  await alice.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
  const badge = await alice.locator('.rail-badge').evaluate(el => {
    const s = getComputedStyle(el);
    const b = el.getBoundingClientRect();
    const tile = el.parentElement!.querySelector('.rail-tile')!.getBoundingClientRect();
    return { h: b.height, minW: s.minWidth, shadow: s.boxShadow, right: b.right - tile.right, bottom: b.bottom - tile.bottom, radius: getComputedStyle(el.parentElement!.querySelector('.rail-tile')!).borderRadius };
  });
  expect(badge.h).toBe(16);
  expect(badge.minW).toBe('16px');
  expect(badge.shadow).toContain('3px');
  expect(badge.right).toBeGreaterThanOrEqual(0);
  expect(badge.bottom).toBeGreaterThanOrEqual(0);
  expect(badge.radius).toBe('50%');

  // Hover: tooltip with the name, the pill grows.
  await alice.getByRole('link').hover();
  await expect(page.getByRole('tooltip')).toHaveText('Alice');
  await expect.poll(() => alice.locator('.rail-pill').evaluate(el => el.getBoundingClientRect().height)).toBe(20);
  await page.mouse.move(600, 400);

  // DM list: bold name, left unread pill, "In voice" subtitle (Alice sits in General voice in the seed).
  const row = page.locator('.dm-row', { hasText: 'Alice' }).first();
  await expect(row).toHaveClass(/unread/);
  expect(await row.evaluate(el => getComputedStyle(el, '::before').height)).toBe('8px');
  await expect(row.locator('.dm-activity.voice')).toHaveText('In voice');
  await expect(row).toHaveAccessibleName('Alice, 1 mention, online, in voice');
  await shot(page, 'vokko-46-full');
  await shot(page, 'vokko-48-rail', { x: 0, y: 30, width: 72, height: 160 });
  const rowBox = (await page.locator('.dm-row-wrap', { hasText: 'Alice' }).first().boundingBox())!;
  await shot(page, 'vokko-47-dm-row', { x: 72, y: rowBox.y - 40, width: 320, height: rowBox.height + 48 });

  // Clicking the rail item opens the DM; reading it pops the item out of the rail and clears the row.
  await alice.getByRole('link').click();
  await expect(page).toHaveURL(/\/channels\/@me\/\d+$/);
  await page.locator('.chat-msg', { hasText: 'left two comments' }).waitFor();
  await expect(railDms(page)).toHaveCount(1);
  await expect(page.locator('.server-rail .rail-dm-slot')).toHaveCount(1); // the leaving copy is gone after its animation
  await expect(row).not.toHaveClass(/unread/);
  await expect(row).toHaveAccessibleName('Alice, online, in voice');

  // A new message from Bob brings his DM back into the rail at the top, with a fresh badge.
  const bobDm = await dmIdWith(page, 'bob');
  await page.evaluate(id => (window as unknown as Win).__vokkoMock.say(id, 'bob', 'you around?'), bobDm);
  await expect(railDms(page)).toHaveCount(2);
  await expect(railDms(page).first().getByRole('link')).toHaveAccessibleName('Bob, 1 mention');
  await expect(railDms(page).first().locator('.rail-badge')).toHaveText('1');
});

test('the mention badge widens for two digits and caps at 99+', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await railDms(page).first().waitFor();
  const bobDm = await dmIdWith(page, 'bob');
  await page.evaluate(id => {
    for (let i = 0; i < 12; i++) (window as unknown as Win).__vokkoMock.say(id, 'bob', `ping ${i}`);
  }, bobDm);
  const bob = page.locator(`.rail-dm-slot[data-channel-id="${bobDm}"]`);
  await expect(bob.locator('.rail-badge')).toHaveText('12');
  expect(await bob.locator('.rail-badge').evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(16);
  await page.evaluate(id => {
    for (let i = 0; i < 90; i++) (window as unknown as Win).__vokkoMock.say(id, 'bob', `more ${i}`);
  }, bobDm);
  await expect(bob.locator('.rail-badge')).toHaveText('99+');
  await shot(page, 'vokko-rail-99', { x: 0, y: 30, width: 72, height: 220 });
});

test('a muted DM stays out of the rail, like the Dock badge', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await expect(railDms(page)).toHaveCount(2);
  await page.locator('.dm-row', { hasText: 'Nova, Bob' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Mute Conversation/ }).hover();
  await page.getByRole('menuitem', { name: 'For 1 Hour' }).click();
  await expect(railDms(page)).toHaveCount(1);
  await expect(railDms(page).first().getByRole('link')).toHaveAccessibleName('Alice, 1 mention');
});

test('opening a rail DM with the keyboard keeps focus in the app (the leaving item is inert)', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  const alice = railDms(page).first().getByRole('link');
  await expect(alice).toHaveAccessibleName('Alice, 1 mention');
  await alice.focus();
  await page.keyboard.press('Enter');
  await page.locator('.chat-msg', { hasText: 'left two comments' }).waitFor();
  await expect(page.locator('.server-rail .rail-dm-slot')).toHaveCount(1);
  // The composer or, failing that, Alice's DM list row: never <body>.
  const focused = await page.evaluate(() => (document.activeElement === document.body ? 'body' : (document.activeElement?.className ?? '')));
  expect(focused).not.toBe('body');
  expect(focused).not.toContain('rail-dm');
});

// The badge ring, pill and group icon read on light and gradient themes too (screenshots only).
for (const theme of ['light', 'catppuccin-latte', 'aurora']) {
  test(`rail DMs on the ${theme} theme`, async ({ page }) => {
    test.skip(!dir, 'set VOKKO_SHOTS_DIR to capture screenshots');
    await page.addInitScript(t => localStorage.setItem('vokko.prefs', JSON.stringify({ theme: t })), theme);
    await page.goto('/channels/@me?as=sam&mockLatency=0');
    await expect(railDms(page)).toHaveCount(2);
    await page.waitForTimeout(400);
    await shot(page, `vokko-${theme}-rail-dmlist`, { x: 0, y: 0, width: 380, height: 380 });
  });
}
