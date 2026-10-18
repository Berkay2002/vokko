import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// Voice UI parity (mock backend, same seed as voice.spec.ts): connected channel row, call card merged with the user row,
// voice channel page (tiles, control bar, chat panel), modals and popouts.

// Review screenshots are written only when VOKKO_SHOTS names a directory (the two "screenshots" tests skip otherwise).
const SHOTS = process.env.VOKKO_SHOTS ?? '';

async function openGuild(page: Page): Promise<void> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.getByRole('list', { name: 'Channels' }).waitFor();
  // The floating user panel covers the bottom of the list until it is scrolled up (the Events row above the channels adds height).
  await page.locator('.sidebar-scroller').evaluate(el => { el.scrollTop = el.scrollHeight; });
}

// The whole row (status line, actions); its name part is the button.
const row = (page: Page, channel = 'General') => page.locator('.channel-row.voice', { has: page.getByRole('button', { name: `${channel} voice channel` }) });
const card = (page: Page) => page.getByRole('region', { name: 'Voice connection' });
const userPanel = (page: Page) => page.getByRole('region', { name: 'User status and settings' });
const call = (page: Page) => page.getByRole('region', { name: /call$/ });

async function join(page: Page): Promise<void> {
  await row(page).click();
  await expect(card(page).getByRole('status')).toHaveText('Voice Connected');
}

test('connected channel row: green speaker, status line, timer, invite row, rail badge, page', async ({ page }) => {
  await openGuild(page);
  await expect(page.getByRole('link', { name: /Voice call active/ })).toHaveCount(0);
  await join(page);

  await expect(row(page)).toHaveClass(/connected/);
  await expect(row(page).getByRole('button', { name: 'Set channel status' })).toBeVisible();
  await expect(row(page).locator('.voice-timer')).toHaveText(/^\d+:\d{2}$/);
  await expect(page.getByRole('button', { name: 'Invite to voice' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Voice call active/ })).toBeVisible();
  // Clicking the row opened the channel page.
  await expect(page).toHaveURL(/\/channels\/[^/]+\/[^/]+$/);
  await expect(call(page)).toBeVisible();
  await expect(call(page).locator('.voice-tile')).toHaveCount(3);

  // Hover swaps the timer for the chat / invite / cog icons.
  await row(page).hover();
  await expect(row(page).getByRole('button', { name: 'Open Chat' })).toBeVisible();
  await expect(row(page).getByRole('button', { name: 'Create Invite' })).toBeVisible();
  await expect(row(page).getByRole('button', { name: 'Edit Channel' })).toBeVisible();
  await expect(row(page).locator('.voice-timer')).toBeHidden();
});

test('call card and user row read as one card, with the four call tools and tooltips above', async ({ page }) => {
  await openGuild(page);
  await join(page);
  await expect(userPanel(page).getByText('In voice channel')).toBeVisible();
  const cardBox = await card(page).boundingBox();
  const panelBox = await userPanel(page).boundingBox();
  expect(cardBox && panelBox).toBeTruthy();
  // The card sits directly on the user row (within the shared 1px border).
  expect(Math.abs((cardBox!.y + cardBox!.height) - panelBox!.y)).toBeLessThanOrEqual(2);
  await expect(card(page).locator('.voice-panel-wide')).toHaveCount(4);

  await card(page).getByRole('button', { name: 'Share Your Screen' }).hover();
  const tip = page.getByRole('tooltip', { name: 'Share Your Screen' });
  await expect(tip).toBeVisible();
  const tipBox = await tip.boundingBox();
  const btnBox = await card(page).getByRole('button', { name: 'Share Your Screen' }).boundingBox();
  expect(tipBox!.y + tipBox!.height).toBeLessThanOrEqual(btnBox!.y + 1);

  // Noise suppression is a pref, toggled from the card.
  const ns = card(page).getByRole('button', { name: 'Noise Suppression' });
  await expect(ns).toHaveAttribute('aria-pressed', 'true');
  await ns.click();
  await expect(ns).toHaveAttribute('aria-pressed', 'false');
  await ns.click();
});

test('channel status is set from the row and shows under the channel name', async ({ page }) => {
  await openGuild(page);
  await join(page);
  await row(page).getByRole('button', { name: 'Set channel status' }).click();
  const modal = page.getByRole('dialog', { name: 'What are we talking about?' });
  await modal.getByRole('textbox', { name: 'Status' }).fill('Movie night');
  await modal.getByRole('button', { name: 'Set Status' }).click();
  await expect(row(page).getByRole('button', { name: 'Movie night' })).toBeVisible();
});

test('control bar: mute from the bar, popouts, text chat panel, leave', async ({ page }) => {
  await openGuild(page);
  await join(page);
  const bar = call(page);
  await bar.getByRole('button', { name: 'Mute microphone' }).click();
  await expect(bar.getByRole('button', { name: 'Unmute microphone' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.voice-user', { hasText: 'Sam' }).getByRole('img', { name: 'Muted' })).toBeVisible();
  await bar.getByRole('button', { name: 'Unmute microphone' }).click();

  await bar.getByRole('button', { name: 'Soundboard' }).click();
  await expect(page.getByRole('textbox', { name: 'Find the perfect sound' })).toBeVisible();
  await page.keyboard.press('Escape');

  await bar.getByRole('button', { name: 'Share your screen' }).click();
  await expect(page.getByRole('dialog', { name: 'Share your screen' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

  await bar.getByRole('button', { name: 'Turn on camera' }).click();
  await expect(page.getByRole('dialog', { name: 'Ready to video chat?' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();

  await page.getByRole('button', { name: 'Show Chat' }).click();
  await expect(page.getByRole('complementary', { name: 'General chat' })).toBeVisible();
  // The panel is the regular chat: start-of-channel header, composer, and messages go through the normal message API.
  const chat = page.getByRole('complementary', { name: 'General chat' });
  await expect(chat.getByRole('heading', { name: 'Welcome to General!' })).toBeVisible();
  await chat.getByRole('textbox', { name: 'Message General' }).fill('hello from voice');
  await page.keyboard.press('Enter');
  await expect(chat.getByText('hello from voice')).toBeVisible();
  // With the chat open the stage is narrow: Pop out and Fullscreen keep their own slot right of the hang-up.
  const hangup = await bar.getByRole('button', { name: 'Leave voice channel' }).boundingBox();
  const popOut = await bar.getByRole('button', { name: 'Pop out' }).boundingBox();
  expect(popOut!.x).toBeGreaterThanOrEqual(hangup!.x + hangup!.width);
  await page.getByRole('button', { name: 'Close Chat' }).click();
  await expect(page.getByRole('complementary', { name: 'General chat' })).toHaveCount(0);

  await bar.getByRole('button', { name: 'Leave voice channel' }).click();
  await expect(card(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Join Voice' })).toBeVisible();
});

test('alone in the channel shows the invite / activity card', async ({ page }) => {
  await openGuild(page);
  await row(page, 'AFK').click();
  await expect(card(page).getByRole('status')).toHaveText('Voice Connected');
  await expect(call(page).getByRole('button', { name: 'Invite to Voice' })).toBeVisible();
  // Choose Activity opens the same shelf as the call bar's Activities button.
  await call(page).getByRole('button', { name: 'Choose Activity' }).click();
  await expect(page.getByRole('menu', { name: 'Activities' }).getByRole('menuitem').first()).toContainText('Watch Together');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await call(page).getByRole('button', { name: 'Invite to Voice' }).click();
  await expect(page.getByRole('dialog')).toContainText('Recipients will land in');
});

test("someone else's profile popout shows the in-voice card with Open Voice", async ({ page }) => {
  await openGuild(page);
  await page.locator('.voice-user', { hasText: 'Alice' }).click();
  const profile = page.locator('.profile-card');
  await expect(profile.getByRole('region', { name: 'In voice channel' })).toContainText('General');
  await profile.getByRole('button', { name: 'Open Voice' }).click();
  await expect(call(page)).toBeVisible();
});

test('voice channel settings: bitrate and user limit save', async ({ page }) => {
  await openGuild(page);
  await row(page, 'Gaming').hover();
  await row(page, 'Gaming').getByRole('button', { name: 'Edit Channel' }).click();
  const bitrate = page.getByRole('slider', { name: 'Bitrate' });
  await expect(bitrate).toHaveValue('64');
  await bitrate.fill('96');
  await page.getByRole('slider', { name: 'User limit' }).fill('12');
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  const stored = await page.evaluate(() => {
    const w = window as unknown as { __vokko: { appStore: { getState(): { channels: Record<string, { name?: string; bitrate?: number; user_limit?: number }> } } } };
    return Object.values(w.__vokko.appStore.getState().channels).find(c => c.name === 'Gaming');
  });
  expect(stored?.bitrate).toBe(96000);
  expect(stored?.user_limit).toBe(12);
});

interface MockHooks { say(channelId: string, username: string, text: string): string; channelIdByName(name: string): string | null }

test('a voice channel row shows unread text-in-voice messages and the context menu has the voice entries', async ({ page }) => {
  await openGuild(page);
  await expect(row(page)).not.toHaveClass(/unread/);
  await page.evaluate(() => {
    const hooks = (window as unknown as { __vokkoMock: MockHooks }).__vokkoMock;
    hooks.say(hooks.channelIdByName('General')!, 'alice', 'anyone up for a game?');
  });
  await expect(row(page)).toHaveClass(/unread/);

  await row(page).click({ button: 'right' });
  for (const name of ['Invite to Voice', 'Open Chat', 'Copy Link', 'Edit Channel', 'Duplicate Channel', 'Create Voice Channel', 'Delete Channel']) {
    await expect(page.getByRole('menuitem', { name })).toBeVisible();
  }
  await expect(page.getByRole('menuitem', { name: 'Create Text Channel' })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('marking the server as read clears the unread dot of a voice channel', async ({ page }) => {
  await openGuild(page);
  await page.evaluate(() => {
    const hooks = (window as unknown as { __vokkoMock: MockHooks }).__vokkoMock;
    hooks.say(hooks.channelIdByName('General')!, 'alice', 'anyone up for a game?');
  });
  await expect(row(page)).toHaveClass(/unread/);
  await page.keyboard.press('Shift+Escape');
  await expect(row(page)).not.toHaveClass(/unread/);
});

test('not connected and nobody there: the page offers Join Voice Channel, "Open Chat" does not join', async ({ page }) => {
  await openGuild(page);
  await row(page, 'AFK').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open Chat' }).click();
  await expect(card(page)).toHaveCount(0);
  await expect(page.getByText('No one is currently in the voice channel')).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'AFK chat' })).toBeVisible();
  await page.getByRole('button', { name: 'Join Voice Channel' }).click();
  await expect(card(page).getByRole('status')).toHaveText('Voice Connected');
});

test('own row and tile menus: Mute / Deafen switches, no Message, server switches for moderators', async ({ page }) => {
  await openGuild(page);
  await join(page);
  await page.locator('.voice-user', { hasText: 'Sam' }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Profile', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Message', exact: true })).toHaveCount(0);
  await expect(page.getByRole('menuitemcheckbox', { name: 'Server Mute' })).not.toHaveAttribute('aria-disabled', 'true');
  await page.getByRole('menuitemcheckbox', { name: 'Deafen', exact: true }).click();
  await expect(userPanel(page).getByRole('button', { name: 'Undeafen' })).toBeVisible();
  // Soundboard is off while deafened.
  await expect(card(page).getByRole('button', { name: 'Open Soundboard' })).toHaveAttribute('aria-disabled', 'true');

  await call(page).locator('.voice-tile.own').click({ button: 'right' });
  await expect(page.getByRole('menuitemcheckbox', { name: 'Deafen', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('menuitemcheckbox', { name: 'Deafen', exact: true }).click();
  await expect(userPanel(page).getByRole('button', { name: 'Deafen' })).toBeVisible();
});

test('connection details popout and device menus', async ({ page }) => {
  await openGuild(page);
  await join(page);
  await card(page).getByRole('button', { name: 'Connection details' }).click();
  const popout = page.locator('.voice-quality-popout');
  await expect(popout.getByText('Average ping:')).toBeVisible();
  await expect(popout.getByText('Last ping:')).toBeVisible();
  await expect(popout.getByRole('img', { name: 'Ping history' })).toBeVisible();
  await expect(popout.getByText('Secure connection')).toBeVisible();
  await page.keyboard.press('Escape');

  await userPanel(page).getByRole('button', { name: 'Input Options' }).click();
  await expect(page.getByRole('menuitem', { name: /Input Device/ })).toBeVisible();
  // the current device and profile sit under the label, as on Discord; Voice Settings has its cog in front
  await expect(page.getByRole('menuitem', { name: /Input Device/ })).toContainText('Default');
  await expect(page.getByRole('menuitem', { name: /Input Profile/ })).toContainText('Custom');
  const volume = page.getByRole('slider', { name: 'Input Volume' });
  await volume.fill('70');
  await expect(volume).toHaveValue('70');
  await expect(page.getByRole('menuitem', { name: 'Voice Settings' })).toBeVisible();
  await page.keyboard.press('Escape');
  await userPanel(page).getByRole('button', { name: 'Output Options' }).click();
  await expect(page.getByRole('slider', { name: 'Output Volume' })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('start of the voice chat has an Edit Channel shortcut', async ({ page }) => {
  await openGuild(page);
  await join(page);
  await page.getByRole('button', { name: 'Show Chat' }).click();
  await page.getByRole('complementary', { name: 'General chat' }).getByRole('button', { name: 'Edit Channel' }).click();
  await expect(page.getByRole('dialog', { name: /Channel Settings/ })).toBeVisible();
});

test('speaking rings of neighbouring voice rows do not touch', async ({ page }) => {
  await openGuild(page);
  await join(page);
  const avatars = page.getByRole('list', { name: 'Users in General' }).locator('.voice-user-avatar');
  await expect(avatars).toHaveCount(3);
  // The ring is the ::after box: its inset plus the shadow spread is how far it reaches past the avatar.
  const reach = await avatars.first().evaluate(el => {
    const s = getComputedStyle(el, '::after');
    const spread = Number(/0px 0px 0px (\d+)px/.exec(s.boxShadow)?.[1] ?? 0);
    return spread - Number.parseFloat(s.top);
  });
  const a = (await avatars.nth(0).boundingBox())!;
  const b = (await avatars.nth(1).boundingBox())!;
  const gap = b.y - (a.y + a.height) - 2 * reach;
  expect(gap).toBeGreaterThanOrEqual(2);
});

test('screenshots 2', async ({ page }) => {
  test.skip(!SHOTS, 'set VOKKO_SHOTS to a directory to write screenshots');
  mkdirSync(SHOTS, { recursive: true });
  await openGuild(page);
  await row(page, 'AFK').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open Chat' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/empty-state.png` });
  await row(page, 'General').click({ button: 'right' });
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${SHOTS}/row-menu.png` });
  await page.keyboard.press('Escape');
  await join(page);
  await card(page).getByRole('button', { name: 'Connection details' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/connection-popout.png` });
  await page.keyboard.press('Escape');
  await userPanel(page).getByRole('button', { name: 'Input Options' }).click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${SHOTS}/input-menu.png` });
  await page.keyboard.press('Escape');
  await userPanel(page).getByRole('button', { name: 'Output Options' }).click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${SHOTS}/output-menu.png` });
  await page.keyboard.press('Escape');
  await page.locator('.voice-user', { hasText: 'Sam' }).click({ button: 'right' });
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${SHOTS}/own-row-menu.png` });
  await page.keyboard.press('Escape');
  await call(page).locator('.voice-tile.own').click({ button: 'right' });
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${SHOTS}/own-tile-menu.png` });
  await page.keyboard.press('Escape');
  await userPanel(page).getByRole('button', { name: 'Deafen' }).click();
  await page.mouse.move(700, 300);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/deafened.png` });
});

test('screenshots', async ({ page }) => {
  test.skip(!SHOTS, 'set VOKKO_SHOTS to a directory to write screenshots');
  mkdirSync(SHOTS, { recursive: true });
  await openGuild(page);
  await join(page);
  await row(page).getByRole('button', { name: 'Set channel status' }).click();
  await page.getByRole('textbox', { name: 'Status' }).fill('Movie night');
  await page.getByRole('button', { name: 'Set Status' }).click();
  await page.mouse.move(700, 300);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/connected-full.png` });
  await page.getByRole('button', { name: 'Show Chat' }).click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${SHOTS}/connected-chat.png` });
  await card(page).getByRole('button', { name: 'Open Soundboard' }).click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${SHOTS}/soundboard.png` });
  await page.keyboard.press('Escape');
  await userPanel(page).locator('.user-panel-account').click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${SHOTS}/own-popout.png` });
  await page.keyboard.press('Escape');
  await card(page).getByRole('button', { name: 'Turn On Camera' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/camera-preview.png` });
  await page.keyboard.press('Escape');
  await card(page).getByRole('button', { name: 'Share Your Screen' }).click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${SHOTS}/screen-share.png` });
});
