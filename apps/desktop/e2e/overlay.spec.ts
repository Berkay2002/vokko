import { expect, test, type Page } from '@playwright/test';

// The in-game overlay page (overlay.html) driven through its browser harness (`window.__overlay`), with the state the main window
// would send. Set VOKKO_OVERLAY_SHOTS=<dir> to also save passive/interactive screenshots over a fake game frame.

const avatar = (color: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="${color}"/><circle cx="16" cy="13" r="6" fill="#fff" opacity=".85"/><rect x="7" y="21" width="18" height="9" rx="4" fill="#fff" opacity=".85"/></svg>`)}`;

const STATE = {
  view: { corner: 'top-left', notifications: 'bottom-right', opacity: 100, hotkey: 'Shift+`' },
  call: {
    channel: 'Ranked grind',
    guild: 'Rift Squad',
    members: [
      { id: '1', name: 'sam', avatar: avatar('#5865f2'), speaking: true, muted: false, deafened: false },
      { id: '2', name: 'Jinx', avatar: avatar('#eb459e'), speaking: false, muted: true, deafened: false },
      { id: '3', name: 'Thresh', avatar: avatar('#23a55a'), speaking: false, muted: true, deafened: true },
      { id: '4', name: 'Lux', avatar: avatar('#f0b232'), speaking: true, muted: false, deafened: false },
    ],
  },
  selfMute: false,
  selfDeaf: false,
  toasts: [{ id: 'm1', title: 'Ahri (@ahri)', body: 'gg, want to queue again after this one?', icon: avatar('#ed4245'), channelId: 'c1', guildId: null, messageId: 'm1' }],
};

async function open(page: Page) {
  await page.goto('/overlay.html');
  await page.waitForFunction(() => !!(window as unknown as { __overlay?: unknown }).__overlay);
}

const setState = (page: Page, state: unknown) => page.evaluate(s => (window as unknown as { __overlay: { setState(s: unknown): void } }).__overlay.setState(s), state);
const setInteractive = (page: Page, on: boolean) => page.evaluate(v => (window as unknown as { __overlay: { setInteractive(v: boolean): void } }).__overlay.setInteractive(v), on);
const actions = (page: Page) => page.evaluate(() => (window as unknown as { __overlayActions: unknown[] }).__overlayActions);

/** A stand-in for a game frame behind the transparent page, for the screenshots only. */
async function fakeGame(page: Page) {
  await page.addStyleTag({
    content: `html{background:radial-gradient(circle at 30% 40%,#2d5a3a 0,#1b3a28 35%,#0c1a12 70%),#0c1a12 !important}
      html::after{content:"";position:fixed;inset:auto 0 0 0;height:160px;background:linear-gradient(#0000,#000c);pointer-events:none}`,
  });
}

test('passive overlay: voice widget, speaking rings, mute/deafen and a toast; nothing to click', async ({ page }) => {
  await open(page);
  // Nothing sent yet: the page draws nothing at all.
  await expect(page.getByTestId('overlay-root')).toHaveCount(0);
  await setState(page, STATE);
  const members = page.getByTestId('overlay-member');
  await expect(members).toHaveCount(4);
  await expect(members.nth(0)).toHaveClass(/speaking/);
  await expect(members.nth(1)).not.toHaveClass(/speaking/);
  await expect(members.nth(1).getByLabel('Muted')).toBeVisible();
  await expect(members.nth(2).getByLabel('Deafened')).toBeVisible();
  await expect(page.getByText('Shift+` to interact')).toBeVisible();
  await expect(page.getByRole('status')).toContainText('want to queue again');
  await expect(page.getByRole('toolbar', { name: 'Overlay controls' })).toHaveCount(0);
  // Transparent: the page itself paints no background over the game.
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  if (process.env.VOKKO_OVERLAY_SHOTS) {
    await fakeGame(page);
    await page.screenshot({ path: `${process.env.VOKKO_OVERLAY_SHOTS}/overlay-passive-1440.png` });
  }
});

test('interactive overlay: mute, deafen, open a toast, Esc drops back', async ({ page }) => {
  await open(page);
  await setState(page, STATE);
  await setInteractive(page, true);
  const bar = page.getByRole('toolbar', { name: 'Overlay controls' });
  await expect(bar).toContainText('Ranked grind');
  await expect(bar).toContainText('Rift Squad');
  if (process.env.VOKKO_OVERLAY_SHOTS) {
    await fakeGame(page);
    await page.screenshot({ path: `${process.env.VOKKO_OVERLAY_SHOTS}/overlay-interactive-1440.png` });
  }
  await bar.getByRole('button', { name: 'Mute' }).click();
  await bar.getByRole('button', { name: 'Deafen' }).click();
  await page.getByRole('status').getByRole('button', { name: /Ahri/ }).click();
  expect(await actions(page)).toEqual([{ type: 'mute' }, { type: 'deafen' }, { type: 'open', toastId: 'm1' }]);
  // The main window answers with the new state: the buttons follow it.
  await setState(page, { ...STATE, selfMute: true, toasts: [] });
  await expect(bar.getByRole('button', { name: 'Unmute' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(bar).toHaveCount(0);
  await expect(page.getByLabel('You are muted')).toBeVisible();
});

test('corners, opacity and notifications off follow the settings', async ({ page }) => {
  await open(page);
  await setState(page, { ...STATE, view: { corner: 'bottom-right', notifications: 'off', opacity: 40, hotkey: '' } });
  const widget = page.getByRole('region', { name: 'Voice: Ranked grind' });
  await expect(widget).toHaveClass(/ov-bottom-right/);
  await expect(widget).toHaveCSS('opacity', '0.4');
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect(page.getByText('to interact')).toHaveCount(0);
  // Interactive mode is always fully opaque.
  await setInteractive(page, true);
  await expect(widget).toHaveCSS('opacity', '1');
});

test('phone-width shot', async ({ page }) => {
  test.skip(!process.env.VOKKO_OVERLAY_SHOTS, 'screenshots only');
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await setState(page, STATE);
  await setInteractive(page, true);
  await fakeGame(page);
  await page.screenshot({ path: `${process.env.VOKKO_OVERLAY_SHOTS}/overlay-interactive-390.png` });
});
