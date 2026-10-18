import { expect, test, type Page } from '@playwright/test';

// Keyboard regions, list arrows and live announcements (src/keyboard/regions.ts, src/ui/announce.tsx). Mock backend.
// VOKKO_SHOTS=<dir> writes focus-ring screenshots there.

type Hooks = { __vokkoMock: { say(c: string, u: string, t: string): void; typing(c: string, u: string): void; voice(u: string, c: string | null): void } };

async function openGuild(page: Page): Promise<void> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.locator('.chat-msg').first().waitFor();
}

const focusedIn = (page: Page, sel: string) => page.evaluate(s => !!document.activeElement?.closest(s), sel);

async function shot(page: Page, name: string): Promise<void> {
  if (process.env.VOKKO_SHOTS) await page.screenshot({ path: `${process.env.VOKKO_SHOTS}/${name}.png` });
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

test('F6 / Shift+F6 cycle rail, channel list, chat and member list', async ({ page }) => {
  await openGuild(page);
  await page.locator('.chat-textarea').focus();
  await page.keyboard.press('F6');
  await expect.poll(() => focusedIn(page, '.member-list')).toBe(true);
  await shot(page, 'focus-member-row');
  await page.keyboard.press('F6');
  await expect.poll(() => focusedIn(page, '.server-rail')).toBe(true);
  await expect(page.locator('.rail-item[data-state=selected] .rail-tile')).toBeFocused();
  await shot(page, 'focus-rail');
  await page.keyboard.press('F6');
  await expect(page.locator('a.channel-row.selected')).toBeFocused();
  await shot(page, 'focus-channel-row');
  await page.keyboard.press('F6');
  await expect(page.locator('.chat-textarea')).toBeFocused();
  await shot(page, 'focus-composer');
  await page.keyboard.press('Shift+F6');
  await expect(page.locator('a.channel-row.selected')).toBeFocused();
});

test('arrow keys move between rows in the rail, channel list and member list', async ({ page }) => {
  await openGuild(page);
  const rail = page.locator('.rail-item[data-state=selected] .rail-tile');
  await rail.focus();
  await page.keyboard.press('ArrowUp');
  await expect(rail).not.toBeFocused();
  expect(await focusedIn(page, '.server-rail')).toBe(true);
  await page.keyboard.press('Home');
  await expect(page.getByRole('link', { name: /^Direct Messages/ })).toBeFocused();

  const row = page.locator('a.channel-row.selected');
  await row.focus();
  const start = await row.getAttribute('href');
  await page.keyboard.press('ArrowDown');
  const next = await page.evaluate(() => document.activeElement?.getAttribute('href') ?? document.activeElement?.getAttribute('aria-label'));
  expect(next).not.toBe(start);
  expect(await focusedIn(page, '.sidebar')).toBe(true);
  await page.keyboard.press('ArrowUp');
  await expect(row).toBeFocused();
  // The route does not change: arrows only move focus, Enter opens.
  expect(new URL(page.url()).pathname).toBe(start);

  const members = page.locator('.member-row');
  await members.first().focus();
  await page.keyboard.press('ArrowDown');
  await expect(members.nth(1)).toBeFocused();
  await shot(page, 'focus-member-arrow');
});

test('voice channel row: the name is the button, Enter joins, its actions are reachable by Tab', async ({ page }) => {
  await openGuild(page);
  const voice = page.getByRole('button', { name: 'General voice channel' });
  await voice.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Leave voice channel' })).toBeVisible();
  await voice.focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('.channel-row.voice.selected .channel-action').first()).toBeFocused();
  await shot(page, 'focus-voice-action');
});

test('announcements: new messages, typing, voice join and leave', async ({ page }) => {
  await openGuild(page);
  const announcer = page.getByTestId('announcer');
  const channelId = new URL(page.url()).pathname.split('/').pop()!;
  await page.evaluate(id => (window as unknown as Hooks).__vokkoMock.say(id, 'alice', 'live region probe'), channelId);
  await expect(announcer).toContainText('live region probe');
  await page.evaluate(id => (window as unknown as Hooks).__vokkoMock.typing(id, 'alice'), channelId);
  await expect(page.locator('.chat-typing[aria-live=polite]')).toContainText(/typing/i);

  await page.getByRole('button', { name: 'General voice channel' }).click();
  await expect(page.getByRole('button', { name: 'Leave voice channel' })).toBeVisible();
  await expect(page).not.toHaveURL(new RegExp(`${channelId}$`));
  const voiceId = new URL(page.url()).pathname.split('/').pop()!; // joining opens the voice channel's page
  await expect(page.locator('.voice-panel-status')).toHaveText('Voice Connected'); // joins and leaves count only once connected
  // Bob is in General in the seed.
  await page.evaluate(() => (window as unknown as Hooks).__vokkoMock.voice('bob', null));
  await expect(announcer).toContainText('Bob left the call');
  await page.evaluate(id => (window as unknown as Hooks).__vokkoMock.voice('bob', id), voiceId);
  await expect(announcer).toContainText('Bob joined the call');
});

test('reduced motion stops looping animations', async ({ page }) => {
  await openGuild(page);
  const count = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.animation = 'spin 1s linear infinite';
    document.body.append(probe);
    const n = getComputedStyle(probe).animationIterationCount;
    probe.remove();
    return n;
  });
  expect(count).toBe('1');
});
