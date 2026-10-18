import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// Streaming in the channel list and the voice panel (mock backend, FakeTransport paints the stream):
// the LIVE pill on a voice user row, the "Streaming now" card on hover / focus, Watch Stream joining the call and watching,
// and our own share in the voice connection panel and user panel. Screenshots only when VOKKO_SHOTS names a directory.

const SHOTS = process.env.VOKKO_SHOTS ?? '';

test.use({
  permissions: ['camera', 'microphone'],
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
});

type Win = {
  __vokkoMock: { channelIdByName(name: string): string | null; voice(user: string, channelId: string | null, opts?: { selfStream?: boolean }): void; tokenFor(user: string): string | null };
  __vokko: { appStore: { getState(): { users: Record<string, { username: string }>; presences: Record<string, unknown> }; setState(s: unknown): void } };
};

async function openGuild(page: Page): Promise<void> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.getByRole('list', { name: 'Channels', exact: true }).waitFor();
}

/** Alice goes live in General and has been playing Factorio for 1h 2m 3s. */
async function aliceStreams(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Win;
    w.__vokkoMock.voice('alice', w.__vokkoMock.channelIdByName('General'), { selfStream: true });
    const store = w.__vokko.appStore;
    const { users, presences } = store.getState();
    const id = Object.keys(users).find(k => users[k]!.username === 'alice')!;
    const start = Date.now() - (3600 + 120 + 3) * 1000;
    store.setState({ presences: { ...presences, [id]: { user_id: id, status: 'online', custom_status: null, activities: [{ name: 'Factorio', type: 0, timestamps: { start } }] } } });
  });
}

const aliceRow = (page: Page) => page.getByRole('list', { name: 'Users in General' }).locator('.voice-user', { hasText: 'Alice' });
const streamCard = (page: Page) => page.getByRole('dialog', { name: 'Alice is streaming' });
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

test('hovering a streaming voice user shows the stream card; Watch Stream joins and watches', async ({ page }) => {
  await openGuild(page);
  await aliceStreams(page);
  const row = aliceRow(page);
  await expect(row.locator('.voice-user-live')).toHaveText('LIVE');
  await expect(row.getByRole('img', { name: 'Playing Factorio' })).toBeVisible();

  // Non-streaming users keep today's behaviour: no card.
  await page.getByRole('list', { name: 'Users in General' }).locator('.voice-user', { hasText: 'Bob' }).hover();
  await page.waitForTimeout(400);
  await expect(page.getByRole('dialog', { name: /is streaming$/ })).toHaveCount(0);

  await row.hover();
  const card = streamCard(page);
  await expect(card).toBeVisible();
  await expect(card.getByText('Streaming now')).toBeVisible();
  await expect(card.getByText('LIVE')).toBeVisible();
  await expect(card.getByText('Factorio')).toBeVisible();
  await expect(card.locator('.stream-card-elapsed')).toHaveText(/^1:02:0\d$/);
  // Not watching yet: a placeholder, no video.
  await expect(card.locator('video')).toHaveCount(0);

  // The card stays open while the pointer crosses over to it.
  await card.getByRole('button', { name: 'Watch Stream' }).hover();
  await page.waitForTimeout(400);
  await expect(card).toBeVisible();
  await shot(page, 'card-hover');

  // A hover-opened card does not take Escape from the composer.
  await page.getByRole('textbox', { name: /^Message #welcome/i }).focus();
  await page.keyboard.press('Escape');
  await expect(card).toBeVisible();
  await page.mouse.move(1000, 400);
  await expect(card).toHaveCount(0);

  // Clicking the row opens the profile, not the card.
  await row.click();
  await expect(page.locator('.profile-body')).toBeVisible();
  await expect(card).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.profile-body')).toHaveCount(0);

  // Keyboard: focus opens the card, ArrowRight moves into it, Escape returns to the row.
  await page.mouse.move(1000, 400);
  await row.blur();
  await row.focus();
  await expect(card).toBeVisible();
  // A keyboard-opened card stays put while the mouse passes over the row.
  await row.hover();
  await page.mouse.move(1000, 400);
  await page.waitForTimeout(400);
  await expect(card).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(card.getByRole('button', { name: 'Watch Stream' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await expect(row).toBeFocused();
  // ArrowRight on the row with the card closed opens it and moves focus in.
  await page.keyboard.press('ArrowRight');
  await expect(card.getByRole('button', { name: 'Watch Stream' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(row).toBeFocused();
  // Clicking the already focused row (profile) must not stop keyboard focus from opening the card later.
  await row.click();
  await page.keyboard.press('Escape');
  await page.mouse.move(1000, 400);
  await row.blur();
  await row.focus();
  await expect(card).toBeVisible();
  // Enter on the row while the card is open also moves into it.
  await row.blur();
  await row.focus();
  await expect(card).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(card.getByRole('button', { name: 'Watch Stream' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(card).toHaveCount(0);
  // The click stays in the card (it must not reach the row and open the profile).
  await expect(page.locator('.profile-body')).toHaveCount(0);

  // Joined General and watching Alice's screen.
  await expect(page.getByRole('region', { name: 'Voice connection' }).getByRole('status')).toHaveText('Voice Connected');
  const tile = page.getByRole('region', { name: /call$/ }).locator('.voice-tile.focused', { hasText: 'Alice' }); // Watch Stream also focuses the streamer's tile
  await expect(tile.locator('video[data-source="screen"]')).toBeVisible();

  // Now the card previews the live stream.
  await page.mouse.move(1000, 400);
  await row.hover();
  await expect(streamCard(page).locator('video.stream-card-video')).toBeVisible();
  await page.waitForTimeout(300);
  await shot(page, 'card-live-preview');
});

test('Watch Stream from another call moves you there and watches in the new channel', async ({ page }) => {
  await openGuild(page);
  await page.getByRole('button', { name: 'Gaming voice channel' }).click();
  const panel = page.getByRole('region', { name: 'Voice connection' });
  await expect(panel.getByRole('status')).toHaveText('Voice Connected');
  await expect(panel).toContainText('Gaming');
  await aliceStreams(page);

  await aliceRow(page).hover();
  await streamCard(page).getByRole('button', { name: 'Watch Stream' }).click();
  await expect(panel).toContainText('General');
  await expect(panel.getByRole('status')).toHaveText('Voice Connected');
  const tile = page.getByRole('region', { name: /call$/ }).locator('.voice-tile.focused', { hasText: 'Alice' }); // Watch Stream also focuses the streamer's tile
  await expect(tile.locator('video[data-source="screen"]')).toBeVisible();
  await expect(tile.getByRole('button', { name: 'Stream quality' })).toBeVisible();
});

test('Watch Stream on the channel preview (not in the call) joins and watches', async ({ page }) => {
  await openGuild(page);
  await aliceStreams(page);
  // The voice channel's page without joining (a row click joins): navigate in-app, a reload would re-seed the mock.
  await page.evaluate(() => {
    const w = window as unknown as Win & { __vokko: { appStore: { getState(): { channels: Record<string, { guild_id: string | null }> } } } };
    const id = w.__vokkoMock.channelIdByName('General')!;
    history.pushState({}, '', `/channels/${w.__vokko.appStore.getState().channels[id]!.guild_id}/${id}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  const call = page.getByRole('region', { name: /call$/ });
  await expect(call.getByRole('button', { name: 'Join Voice' })).toBeVisible();
  await call.getByRole('button', { name: 'Watch Stream' }).click();
  await expect(page.getByRole('region', { name: 'Voice connection' }).getByRole('status')).toHaveText('Voice Connected');
  const tile = call.locator('.voice-tile.focused', { hasText: 'Alice' });
  await expect(tile.locator('video[data-source="screen"]')).toBeVisible();

  // Alice stops and goes live again: like Discord, her new stream waits for another Watch Stream.
  const live = (on: boolean) => page.evaluate(stream => {
    const w = window as unknown as Win;
    w.__vokkoMock.voice('alice', w.__vokkoMock.channelIdByName('General'), { selfStream: stream });
  }, on);
  await live(false);
  await expect(call.locator('.voice-tile.stream')).toHaveCount(0);
  await live(true);
  await expect(call.getByRole('button', { name: 'Watch Stream' })).toBeVisible();
  await expect(call.locator('video[data-source="screen"]')).toHaveCount(0);
  // The unwatched stream tile shows only the button, not the streamer's avatar under it.
  await expect(call.locator('.voice-tile.stream .voice-tile-avatar')).toHaveCount(0);
});

test('sharing your screen: the panel shows the share with a stop button, the user panel says so', async ({ page }) => {
  await openGuild(page);
  await page.getByRole('button', { name: 'General voice channel' }).click();
  const panel = page.getByRole('region', { name: 'Voice connection' });
  await expect(panel.getByRole('status')).toHaveText('Voice Connected');
  await page.getByRole('region', { name: /call$/ }).getByRole('button', { name: 'Share your screen' }).click();
  await page.getByRole('dialog', { name: 'Share your screen' }).getByRole('button', { name: 'Go Live' }).click();

  const row = panel.getByTestId('voice-panel-stream');
  await expect(row).toContainText('Your Screen');
  const wide = panel.locator('.voice-panel-actions').getByRole('button', { name: 'Stop Streaming' });
  await expect(wide).toHaveAttribute('aria-pressed', 'true');
  await expect(wide).toHaveClass(/streaming/);
  await expect(page.getByRole('region', { name: 'User status and settings' }).getByText('Sharing Your Screen')).toBeVisible();
  // Our own row in the channel list is LIVE too, and there is no Watch Stream for ourselves.
  await expect(page.getByRole('list', { name: 'Users in General' }).locator('.voice-user', { hasText: 'Sam' }).locator('.voice-user-live')).toBeVisible();
  await shot(page, 'panel-sharing');

  await row.getByRole('button', { name: 'Stop Streaming' }).click();
  await expect(row).toHaveCount(0);
  await expect(panel.locator('.voice-panel-actions').getByRole('button', { name: 'Share Your Screen' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'User status and settings' }).getByText('In voice channel')).toBeVisible();
});
