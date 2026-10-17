import { expect, test, type Page } from '@playwright/test';
import { goInApp } from './accountHelpers';
import { openStockTalk } from './helpers';

// Rich presence ("Playing X") in the member list, DM list and profile card, and the desktop-only pieces staying out of the
// browser build (mock mode; the Tauri adapters are no-ops here).

type Hooks = {
  __vokko: {
    appStore: { getState(): { me: { id: string } | null; users: Record<string, unknown>; presences: Record<string, { activities?: { name: string; type: number }[] }> }; setState(s: unknown): void };
    gateway: { send(op: number, d: unknown): void };
  };
};

/** Gives every other user a Factorio session that started 12 minutes ago. */
async function everyonePlays(page: Page) {
  await page.evaluate(() => {
    const store = (window as unknown as Hooks).__vokko.appStore;
    const { me, users, presences } = store.getState();
    const next = { ...presences };
    for (const id of Object.keys(users)) {
      if (id === me?.id) continue;
      next[id] = { user_id: id, status: 'online', custom_status: null, activities: [{ name: 'Factorio', type: 0, timestamps: { start: Date.now() - 12 * 60_000 } }] } as never;
    }
    store.setState({ presences: next });
  });
}

test('the member list shows "Playing X" with the elapsed time', async ({ page }) => {
  await openStockTalk(page);
  await everyonePlays(page);
  const line = page.locator('.member-list [data-testid="activity-line"]').first();
  await expect(line).toContainText('Playing');
  await expect(line).toContainText('Factorio');
  await expect(line).toContainText('12m');
});

test('the profile card shows the game', async ({ page }) => {
  await openStockTalk(page);
  await everyonePlays(page);
  await page.locator('.member-row', { has: page.getByTestId('activity-line') }).first().click();
  const card = page.getByTestId('activity-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Playing');
  await expect(card).toContainText('Factorio');
});

test('the DM list shows the game of the other person', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  await everyonePlays(page);
  await expect(page.locator('.dm-row [data-testid="activity-line"]').first()).toContainText('Factorio');
});

test('the Friends page Active Now shows a game card after the voice cards, and the game under the channel for friends in voice', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  const column = page.getByRole('complementary', { name: 'Active Now' });
  await expect(column.locator('.active-card').first()).toBeVisible();
  await expect(column.getByTestId('activity-line')).toHaveCount(0);
  await everyonePlays(page);
  // every seeded friend sits in voice: befriend a user who does not, so a game-only card shows too
  const gamer = await page.evaluate(() => {
    const store = (window as unknown as Hooks).__vokko.appStore;
    const { me, users, relationships } = store.getState() as unknown as { me: { id: string }; users: Record<string, { id: string; username: string }>; relationships: Record<string, unknown> };
    const user = Object.values(users).find(u => u.id !== me.id && !relationships[u.id])!;
    store.setState({ relationships: { ...relationships, [user.id]: { id: user.id, type: 1, nickname: null, user } } });
    return user.username;
  });
  const cards = column.locator('.active-card');
  const game = cards.filter({ hasText: gamer });
  await expect(game.getByTestId('activity-line')).toHaveText('Playing Factorio · 12m');
  await expect(game).not.toContainText(/In .+ · /);
  await expect(cards.last()).toContainText(gamer);
  const voice = cards.first();
  await expect(voice.locator('.active-card-voice-row')).toBeVisible();
  await expect(voice.getByTestId('activity-line')).toContainText('Playing Factorio · 12m');
});

test('Active Now card geometry follows the reference: 420 column, 387 card, radius 16, 32 avatar, 24 icon tile, 32 art tile', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  await everyonePlays(page);
  const column = page.getByRole('complementary', { name: 'Active Now' });
  const card = column.locator('.active-card').first();
  await expect(card.locator('.active-card-body')).toBeVisible();
  const box = async (locator: ReturnType<typeof card.locator>) => (await locator.boundingBox())!;
  expect((await box(column)).width).toBeCloseTo(420, 0);
  expect((await box(card)).width).toBeCloseTo(387, 0);
  expect(await card.evaluate(el => getComputedStyle(el).borderRadius)).toBe('16px');
  for (const [locator, size] of [[card.locator('.active-card-main .avatar').first(), 32], [card.locator('.active-card-icon'), 24], [card.locator('.active-card-art'), 32]] as const) {
    const b = await box(locator);
    expect(b.width).toBeCloseTo(size, 0);
    expect(b.height).toBeCloseTo(size, 0);
  }
  // only the header carries the muted background; the body sits on the column
  const bg = (sel: string) => card.locator(sel).evaluate(el => getComputedStyle(el).backgroundColor);
  expect(await bg('.active-card-main')).not.toBe('rgba(0, 0, 0, 0)');
  expect(await bg('.active-card-body')).toBe('rgba(0, 0, 0, 0)');
  await expect(card.locator('.active-card-body .active-card-title')).toHaveText('Factorio');
  await expect(card.locator('.active-card-body .active-card-body-sub')).toHaveText(/^\d+:\d{2} elapsed$/);
  // a friend outside voice gets a game-only card: header 68 and body 64 px, as in the reference
  const gamer = await page.evaluate(() => {
    const store = (window as unknown as Hooks).__vokko.appStore;
    const { me, users, relationships } = store.getState() as unknown as { me: { id: string }; users: Record<string, { id: string; username: string }>; relationships: Record<string, unknown> };
    const user = Object.values(users).find(u => u.id !== me.id && !relationships[u.id])!;
    store.setState({ relationships: { ...relationships, [user.id]: { id: user.id, type: 1, nickname: null, user } } });
    return user.username;
  });
  const game = column.locator('.active-card', { hasText: gamer });
  // a custom-status-only friend gets no activity icon and no body
  await page.evaluate(() => {
    const store = (window as unknown as Hooks).__vokko.appStore;
    const { me, users, relationships, presences } = store.getState() as unknown as { me: { id: string }; users: Record<string, { id: string; username: string }>; relationships: Record<string, unknown>; presences: Record<string, unknown> };
    const user = Object.values(users).find(u => u.id !== me.id && !relationships[u.id])!;
    store.setState({
      relationships: { ...relationships, [user.id]: { id: user.id, type: 1, nickname: null, user } },
      presences: { ...presences, [user.id]: { user_id: user.id, status: 'online', custom_status: 'Out for lunch', activities: [] } },
    } as never);
  });
  const custom = column.locator('.active-card', { hasText: 'Out for lunch' });
  await expect(custom).toHaveCount(1);
  await expect(custom.locator('.active-card-icon')).toHaveCount(0);
  await expect(custom.locator('.active-card-body')).toHaveCount(0);
  await expect(game).not.toContainText(/In .+ · /);
  expect((await box(game.locator('.active-card-main'))).height).toBeCloseTo(68, 0);
  expect((await box(game.locator('.active-card-body'))).height).toBeCloseTo(64, 0);
});

/** The first Active Now card of a friend in a voice channel of a shared server. */
async function voiceCard(page: Page) {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  const card = page.getByRole('complementary', { name: 'Active Now' }).locator('.active-card', { has: page.locator('.active-card-voice-row') }).first();
  await expect(card).toBeVisible();
  return { card, row: card.locator('button.active-card-voice-row') };
}

test('a voice card of a shared server always shows the channel, the server and the faces; clicking it joins and opens the channel', async ({ page }) => {
  const { card, row } = await voiceCard(page);
  await expect(row.locator('.active-card-title')).not.toHaveText('');
  await expect(row.locator('.active-card-body-sub')).not.toHaveText('');
  await expect(row.locator('.active-card-voice-badge')).toBeVisible();
  await expect(row.locator('.avatar, img').first()).toBeVisible();
  await expect(row).toHaveAccessibleName(/^Join /);
  const where = (await row.locator('.active-card-body-sub').textContent())!;
  await row.click();
  await expect(page).toHaveURL(/\/channels\/\d+\/\d+$/);
  await expect(page.locator('.channel-row.voice.connected')).toHaveCount(1);
  // back on Friends (client-side: a reload re-seeds the mock) the same row says Open
  await goInApp(page, '/channels/@me');
  const again = page.getByRole('complementary', { name: 'Active Now' }).locator('.active-card-voice-row', { hasText: where }).first();
  await expect(again).toHaveAccessibleName(/^Open /);
  void card;
});

test('the voice row of an Active Now card is a keyboard stop: Tab from the header, Enter joins', async ({ page }) => {
  const { card, row } = await voiceCard(page);
  await card.locator('.active-card-main').focus();
  await page.keyboard.press('Tab');
  await expect(row).toBeFocused();
  await expect(row).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/channels\/\d+\/\d+$/);
});

test('a DM call card in Active Now shows plain faces: no channel button, no Join', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  // alice calls sam from their DM: her voice state moves out of the server channel into the call
  await page.evaluate(() => (window as unknown as { __vokkoMock: { call(u: string, o: string | null): string | null } }).__vokkoMock.call('alice', 'sam'));
  const card = page.getByRole('complementary', { name: 'Active Now' }).locator('.active-card', { hasText: 'Alice' });
  await expect(card).toBeVisible();
  await expect(card.locator('.active-card-sub').first()).toHaveText('In a call');
  // focus, not hover: the incoming-call toast sits over the column
  await card.locator('.active-card-main').focus();
  const faces = card.getByRole('group', { name: /\d+ in voice/ });
  await expect(faces).toBeVisible();
  await expect(faces.locator('.avatar, img').first()).toBeVisible();
  await expect(card.locator('button.active-card-channel')).toHaveCount(0);
  await expect(card.getByRole('button', { name: /^(Join Voice|Joined)$/ })).toHaveCount(0);
});

/** Befriends a user who is not in voice and gives everyone a game, so a game-only card shows; returns the card and the user's name. */
async function gameOnlyCard(page: Page) {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  await everyonePlays(page);
  const gamer = await page.evaluate(() => {
    const store = (window as unknown as Hooks).__vokko.appStore;
    const { me, users, relationships } = store.getState() as unknown as { me: { id: string }; users: Record<string, { id: string; username: string; global_name?: string | null }>; relationships: Record<string, unknown> };
    const user = Object.values(users).find(u => u.id !== me.id && !relationships[u.id])!;
    store.setState({ relationships: { ...relationships, [user.id]: { id: user.id, type: 1, nickname: null, user } } });
    return user.global_name ?? user.username;
  });
  return { card: page.getByRole('complementary', { name: 'Active Now' }).locator('.active-card', { hasText: gamer }), gamer };
}

test('clicking the body of an Active Now card opens the friend\'s profile card', async ({ page }) => {
  const { card, gamer } = await gameOnlyCard(page);
  await card.locator('.active-card-body').click();
  await expect(page.locator('.profile-card')).toContainText(gamer);
});

test('the body of an Active Now card is a keyboard stop: Tab from the header, Enter opens the profile card', async ({ page }) => {
  const { card, gamer } = await gameOnlyCard(page);
  await card.locator('.active-card-main').focus();
  await page.keyboard.press('Tab');
  const body = card.getByRole('button', { name: /'s profile$/ });
  await expect(body).toBeFocused();
  await expect(body).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('Enter');
  await expect(page.locator('.profile-card')).toContainText(gamer);
});

test('presence update with activities is kept when absent and cleared by an empty list', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  const own = () =>
    page.evaluate(() => {
      const { me, presences } = (window as unknown as Hooks).__vokko.appStore.getState();
      return presences[me?.id ?? '']?.activities?.map(a => a.name) ?? [];
    });
  await page.evaluate(() => (window as unknown as Hooks).__vokko.gateway.send(3, { status: 'online', activities: [{ name: 'Terraria', type: 0, timestamps: { start: 1000 } }] }));
  await expect.poll(own).toEqual(['Terraria']);
  // absent keeps
  await page.evaluate(() => (window as unknown as Hooks).__vokko.gateway.send(3, { status: 'idle' }));
  await page.waitForTimeout(300);
  expect(await own()).toEqual(['Terraria']);
  // [] clears
  await page.evaluate(() => (window as unknown as Hooks).__vokko.gateway.send(3, { status: 'online', activities: [] }));
  await expect.poll(own).toEqual([]);
});

test('the browser build has no window controls and no Registered Games', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  await expect(page.getByTestId('window-controls')).toHaveCount(0);
  await page.getByRole('button', { name: 'User Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'User Settings' });
  await expect(dialog.getByRole('button', { name: 'Registered Games' })).toHaveCount(0);
  // Activity Privacy still exists, and its switch is not the live desktop one
  await dialog.getByRole('button', { name: 'Activity Privacy' }).click();
  await expect(dialog.getByRole('heading', { name: 'Activity Privacy' })).toBeVisible();
});
