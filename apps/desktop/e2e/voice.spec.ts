import { expect, test, type Page } from '@playwright/test';

// Voice V1 against the mock backend: op 4 is answered by src/api/mock/voice.ts with endpoint "mock://voice", which selects the
// FakeTransport (no getUserMedia). Seed: Alice and Bob in General (they "speak" every 1.5 s once you are in the call),
// Nova in Gaming, Carol alone in Solo (user limit 1, so it is full).

type MockWin = {
  __vokkoMock: { channelIdByName(name: string): string | null; voice(user: string, channelId: string | null, opts?: { selfMute?: boolean }): void; restart(): void };
};

async function openGuild(page: Page): Promise<void> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.getByRole('list', { name: 'Channels' }).waitFor();
  // The floating user panel covers the bottom of the list until it is scrolled up (the Events row above the channels adds height).
  await page.locator('.sidebar-scroller').evaluate(el => { el.scrollTop = el.scrollHeight; });
}

const usersIn = (page: Page, channel: string) => page.getByRole('list', { name: `Users in ${channel}` });
const userRow = (page: Page, channel: string, name: string) => usersIn(page, channel).locator('.voice-user', { hasText: name });
const panel = (page: Page) => page.getByRole('region', { name: 'Voice connection' });

test('join a voice channel, see the call, mute, and disconnect', async ({ page }) => {
  await openGuild(page);

  // Before joining: occupants are listed, but no speaking rings (only shown to people in the same call).
  await expect(userRow(page, 'General', 'Alice')).toBeVisible();
  await expect(userRow(page, 'General', 'Bob')).toBeVisible();
  await expect(userRow(page, 'General', 'Sam')).toHaveCount(0);
  await page.waitForTimeout(1800);
  await expect(usersIn(page, 'General').locator('.voice-user.speaking')).toHaveCount(0);
  await expect(panel(page)).toHaveCount(0);

  await page.getByRole('button', { name: 'General voice channel' }).click();

  // You appear under the channel and the RTC panel reports the connection.
  await expect(userRow(page, 'General', 'Sam')).toBeVisible();
  await expect(panel(page).getByRole('status')).toHaveText('Voice Connected');
  await expect(panel(page)).toContainText("General / Sam's server");

  // The fake participant's speaking ring turns on (and is actually drawn).
  const alice = userRow(page, 'General', 'Alice');
  await expect(alice).toHaveClass(/speaking/, { timeout: 5000 });
  const ring = await alice.locator('.voice-user-avatar').evaluate(el => getComputedStyle(el, '::after').boxShadow);
  expect(ring).not.toBe('none');
  // ... and goes off again on the fake rhythm.
  await expect(alice).not.toHaveClass(/speaking/, { timeout: 5000 });

  // Self mute in the user panel shows on our own row (op 4 round trip through the mock server).
  const me = userRow(page, 'General', 'Sam');
  await page.getByRole('button', { name: 'Mute', exact: true }).click();
  await expect(me.getByRole('img', { name: 'Muted' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unmute', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Unmute', exact: true }).click();
  await expect(me.getByRole('img', { name: 'Muted' })).toHaveCount(0);

  // Deafen mutes too; undeafen restores.
  await page.getByRole('button', { name: 'Deafen', exact: true }).click();
  await expect(me.getByRole('img', { name: 'Deafened' })).toBeVisible();
  await expect(me.getByRole('img', { name: 'Muted' })).toBeVisible();
  await page.getByRole('button', { name: 'Undeafen', exact: true }).click();
  await expect(me.getByRole('img', { name: 'Deafened' })).toHaveCount(0);
  await expect(me.getByRole('img', { name: 'Muted' })).toHaveCount(0);

  // Disconnect removes you from the list and closes the panel.
  await panel(page).getByRole('button', { name: 'Disconnect' }).click();
  await expect(me).toHaveCount(0);
  await expect(panel(page)).toHaveCount(0);
  await expect(userRow(page, 'General', 'Alice')).toBeVisible();
});

test('per-user volume and local mute live in the user context menu while in the same call', async ({ page }) => {
  await openGuild(page);
  // Not in a call: no voice entries.
  await userRow(page, 'General', 'Alice').click({ button: 'right' });
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.getByLabel('User Volume')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'General voice channel' }).click();
  await expect(panel(page).getByRole('status')).toHaveText('Voice Connected');
  await userRow(page, 'General', 'Alice').click({ button: 'right' });
  const slider = page.getByRole('slider', { name: 'User Volume' });
  await expect(slider).toHaveValue('100');
  await slider.fill('150');
  await expect(page.locator('.voice-volume-value')).toHaveText('150%');
  await page.getByRole('menuitemcheckbox', { name: 'Mute', exact: true }).click();
  await expect(userRow(page, 'General', 'Alice').getByRole('img', { name: 'Locally Muted' })).toBeVisible();
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('vokko.voice') ?? '{}') as { volumes?: Record<string, number>; localMutes?: Record<string, boolean> });
  expect(Object.values(stored.volumes ?? {})).toContain(150);
  expect(Object.keys(stored.localMutes ?? {})).toHaveLength(1);
});

test('others joining and leaving show up live; full channels show a lock', async ({ page }) => {
  await openGuild(page);
  await expect(page.getByRole('button', { name: 'Solo voice channel' }).getByLabel('Channel full')).toBeVisible();
  const gaming = await page.evaluate(() => (window as unknown as MockWin).__vokkoMock.channelIdByName('Gaming'));
  await page.evaluate(id => (window as unknown as MockWin).__vokkoMock.voice('alice', id, { selfMute: true }), gaming);
  await expect(userRow(page, 'Gaming', 'Alice').getByRole('img', { name: 'Muted' })).toBeVisible();
  await expect(userRow(page, 'General', 'Alice')).toHaveCount(0);
  await page.evaluate(() => (window as unknown as MockWin).__vokkoMock.voice('alice', null));
  await expect(page.locator('.voice-user', { hasText: 'Alice' })).toHaveCount(0);
});

test('moving between channels keeps one connection', async ({ page }) => {
  await openGuild(page);
  await page.getByRole('button', { name: 'General voice channel' }).click();
  await expect(panel(page).getByRole('status')).toHaveText('Voice Connected');
  await page.getByRole('button', { name: 'Gaming voice channel' }).click();
  await expect(userRow(page, 'Gaming', 'Sam')).toBeVisible();
  await expect(userRow(page, 'General', 'Sam')).toHaveCount(0);
  await expect(panel(page)).toContainText("Gaming / Sam's server");
  await expect(panel(page).getByRole('status')).toHaveText('Voice Connected');
});

test('a server restart keeps the call: the client re-binds without leaving or reconnecting its media', async ({ page }) => {
  await openGuild(page);
  await page.getByRole('button', { name: 'General voice channel' }).click();
  await expect(panel(page).getByRole('status')).toHaveText('Voice Connected');
  // Every status the panel shows from now on (a media reconnect would walk through "RTC Connecting").
  await panel(page).evaluate(el => {
    const seen: string[] = [];
    (window as unknown as { statuses: string[] }).statuses = seen;
    new MutationObserver(() => {
      const text = el.querySelector('[role="status"]')?.textContent ?? '(none)';
      if (seen.at(-1) !== text) seen.push(text);
    }).observe(el, { childList: true, characterData: true, subtree: true });
  });
  await page.evaluate(() => (window as unknown as MockWin).__vokkoMock.restart());
  // Muted while the gateway is away: the op 4 after the re-identify carries it, so the icon proves the re-bind went through.
  await page.getByRole('button', { name: 'Mute', exact: true }).click();
  const me = userRow(page, 'General', 'Sam');
  await expect(me.getByRole('img', { name: 'Muted' })).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1500);
  await expect(panel(page).getByRole('status')).toHaveText('Voice Connected');
  expect(await page.evaluate(() => (window as unknown as { statuses: string[] }).statuses.filter(s => s !== 'Voice Connected'))).toEqual([]);
  await expect(userRow(page, 'General', 'Alice')).toBeVisible();
});

test('server mute, move and disconnect from the user context menu', async ({ page }) => {
  await openGuild(page);
  await page.getByRole('button', { name: 'General voice channel' }).click();
  await expect(panel(page).getByRole('status')).toHaveText('Voice Connected');

  await userRow(page, 'General', 'Alice').click({ button: 'right' });
  await page.getByRole('menuitemcheckbox', { name: 'Server Mute' }).click();
  await expect(userRow(page, 'General', 'Alice').getByRole('img', { name: 'Server Muted' })).toBeVisible();

  await page.keyboard.press('Escape');
  await userRow(page, 'General', 'Bob').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Disconnect' }).click();
  await expect(page.locator('.voice-user', { hasText: 'Bob' })).toHaveCount(0);

  await userRow(page, 'General', 'Alice').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move To' }).hover();
  await page.getByRole('menuitem', { name: 'Gaming' }).click();
  await expect(userRow(page, 'Gaming', 'Alice')).toBeVisible();
  await expect(userRow(page, 'General', 'Alice')).toHaveCount(0);
  await expect(userRow(page, 'Gaming', 'Alice').getByRole('img', { name: 'Server Muted' })).toBeVisible();
});

test('stage channel: create, join the audience, start the stage, become a speaker, end it', async ({ page }) => {
  await openGuild(page);
  await page.getByRole('button', { name: "Sam's server", exact: true }).click();
  await page.getByRole('menuitem', { name: 'Create Channel' }).click();
  await page.getByRole('radio', { name: /^Stage/ }).click();
  await page.locator('#channel-name').fill('town-hall');
  await page.getByRole('dialog').getByRole('button', { name: 'Create Channel' }).click();
  await page.getByRole('link', { name: /town-hall/ }).click();

  const stage = page.getByRole('region', { name: 'town-hall stage' });
  await expect(stage).toBeVisible();
  await expect(stage.getByText('Join the stage to start it.')).toBeVisible();
  await stage.getByRole('button', { name: 'Join Stage' }).click();
  await expect(stage.getByRole('list', { name: 'Audience' }).getByLabel('Sam')).toBeVisible();

  await stage.getByLabel('Topic').fill('Friday AMA');
  await stage.getByRole('button', { name: 'Start Stage' }).click();
  await expect(stage.getByRole('heading', { name: 'Friday AMA' })).toBeVisible();
  await expect(page.getByRole('link', { name: /town-hall/ }).getByLabel('Stage Live: Friday AMA')).toBeVisible();

  const stageId = await page.evaluate(() => (window as unknown as MockWin).__vokkoMock.channelIdByName('town-hall'));
  await page.evaluate(id => (window as unknown as MockWin).__vokkoMock.voice('alice', id), stageId);
  await expect(stage.getByRole('list', { name: 'Audience' }).getByLabel('Alice')).toBeVisible();

  await stage.getByRole('button', { name: 'Become a Speaker' }).click();
  const tile = stage.getByRole('list', { name: 'Speakers' }).getByLabel(/^Sam/);
  await expect(tile).toBeVisible();
  // a speaker is the call page's tile: 16:9, radius 8
  const box = (await tile.boundingBox())!;
  expect(box.width / box.height).toBeCloseTo(16 / 9, 1);
  await expect(tile).toHaveCSS('border-radius', '8px');

  await stage.getByRole('button', { name: 'End Stage' }).click();
  await expect(stage.getByText('Not live')).toBeVisible();
  await expect(page.getByRole('link', { name: /town-hall/ }).getByLabel(/Stage Live/)).toHaveCount(0);
  await expect(stage.getByRole('list', { name: 'Audience' }).getByLabel(/^Sam/)).toBeVisible();
});
