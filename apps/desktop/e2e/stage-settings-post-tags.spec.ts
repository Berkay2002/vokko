import { expect, test, type Page } from '@playwright/test';
import { openChannel, panel } from './threadHelpers';

// Stage channels get their own settings page (no text-channel topic, no "Not available yet" rows) with the live stage's topic
// (editStageTopic), the header shows the stage icon, and a forum post's tags can be edited after posting (Edit Post).

const SHOTS = process.env.VOKKO_SHOTS_DIR;
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };

type MockWin = { __vokkoMock: { channelIdByName(name: string): string | null } };

test('stage settings: stage topic instead of the channel topic, the header has the stage icon', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.getByRole('button', { name: "Sam's server", exact: true }).click();
  await page.getByRole('menuitem', { name: 'Create Channel' }).click();
  await page.getByRole('radio', { name: /^Stage/ }).click();
  await page.locator('#channel-name').fill('town-hall');
  await page.getByRole('dialog').getByRole('button', { name: 'Create Channel' }).click();
  await page.getByRole('link', { name: /town-hall/ }).click();
  await expect(page.locator('.channel-header-icon.lucide-radio')).toBeVisible();

  const stage = page.getByRole('region', { name: 'town-hall stage' });
  await stage.getByRole('button', { name: 'Join Stage' }).click();
  await stage.getByLabel('Topic').fill('Friday AMA');
  await stage.getByRole('button', { name: 'Start Stage' }).click();
  await expect(stage.getByRole('heading', { name: 'Friday AMA' })).toBeVisible();

  const id = await page.evaluate(() => (window as unknown as MockWin).__vokkoMock.channelIdByName('town-hall'));
  await page.locator(`.channel-row-wrap:has(a[href$="/${id}"])`).hover();
  await page.getByRole('button', { name: 'Edit Channel' }).first().click();
  const dialog = page.getByRole('dialog', { name: /Channel Settings/ });
  await expect(dialog.getByRole('button', { name: 'Integrations', exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('Channel topic')).toHaveCount(0);
  await expect(dialog.getByText('Not available yet')).toHaveCount(0);
  await shot(page, 'stage-settings-1440');
  await dialog.getByLabel('Stage topic').fill('Monday AMA');
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(dialog.getByText('Saved.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(stage.getByRole('heading', { name: 'Monday AMA' })).toBeVisible();
});

test('a post\'s tags can be changed in Post Settings', async ({ page }) => {
  await openChannel(page, 'support');
  const card = page.locator('.forum-post', { hasText: 'Idea: show joined threads' });
  await card.click();
  await panel(page).getByRole('button', { name: 'Post Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit Post' });
  const tags = dialog.getByRole('group', { name: 'Tags' });
  await shot(page, 'edit-post-1440');
  await tags.getByRole('button', { name: 'Docs' }).click();
  await expect(tags.getByRole('button', { name: 'Docs' })).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card.locator('.forum-tag', { hasText: 'Docs' })).toBeVisible();
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('Edit Post at 390 keeps the tags inside the window', async ({ page }) => {
    await openChannel(page, 'support');
    await page.locator('.forum-post', { hasText: 'Idea: show joined threads' }).tap();
    await panel(page).getByRole('button', { name: 'Thread actions' }).tap();
    await page.getByRole('dialog', { name: 'Menu' }).getByRole('menuitem', { name: 'Edit Post' }).tap();
    const dialog = page.getByRole('dialog', { name: 'Edit Post' });
    for (const t of await dialog.getByRole('group', { name: 'Tags' }).getByRole('button').all()) {
      const b = (await t.boundingBox())!;
      expect(b.x + b.width).toBeLessThanOrEqual(391);
    }
    await shot(page, 'edit-post-390');
  });
});

type As = { __vokkoMock: { requestAs(u: string, m: string, p: string, b?: unknown): Promise<unknown> | unknown } };
const as = (page: Page, user: string, method: string, path: string, body?: unknown) =>
  page.evaluate(([u, m, p, b]) => Promise.resolve((window as unknown as As).__vokkoMock.requestAs(u as string, m as string, p as string, b)), [user, method, path, body] as const);

test('Edit Post: a member cannot add or remove a moderated tag, and a required tag does not block a rename', async ({ page }) => {
  const forumId = await openChannel(page, 'support', 'bob');
  const solved = await page.evaluate(id => (window as unknown as { __vokko: { appStore: { getState(): { channels: Record<string, { available_tags?: { id: string; name: string }[] }> } } } })
    .__vokko.appStore.getState().channels[id]!.available_tags!.find(t => t.name === 'Solved')!.id, forumId);
  const post = (await as(page, 'bob', 'POST', `/channels/${forumId}/threads`, { name: 'bob post', message: { content: 'hello' } }) as { id: string });
  await as(page, 'sam', 'PATCH', `/channels/${post.id}`, { applied_tags: [solved] });
  await as(page, 'sam', 'PATCH', `/channels/${forumId}`, { flags: 16 }); // RequireTag

  const card = page.locator('.forum-post', { hasText: 'bob post' });
  await card.click();
  await panel(page).getByRole('button', { name: 'Post Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit Post' });
  const solvedBtn = dialog.getByRole('group', { name: 'Tags' }).getByRole('button', { name: 'Solved' });
  await expect(solvedBtn).toHaveAttribute('aria-pressed', 'true');
  await solvedBtn.click({ force: true });
  await expect(solvedBtn).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByLabel('Thread name').fill('bob post renamed');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.forum-post', { hasText: 'bob post renamed' }).locator('.forum-tag', { hasText: 'Solved' })).toBeVisible();
});

test('a stage topic saves on its own and a rename saves with it', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.getByRole('button', { name: "Sam's server", exact: true }).click();
  await page.getByRole('menuitem', { name: 'Create Channel' }).click();
  await page.getByRole('radio', { name: /^Stage/ }).click();
  await page.locator('#channel-name').fill('town-hall');
  await page.getByRole('dialog').getByRole('button', { name: 'Create Channel' }).click();
  await page.getByRole('link', { name: /town-hall/ }).click();
  const stage = page.getByRole('region', { name: 'town-hall stage' });
  await stage.getByRole('button', { name: 'Join Stage' }).click();
  await stage.getByLabel('Topic').fill('Friday AMA');
  await stage.getByRole('button', { name: 'Start Stage' }).click();
  await expect(stage.getByRole('heading', { name: 'Friday AMA' })).toBeVisible();

  const id = await page.evaluate(() => (window as unknown as MockWin).__vokkoMock.channelIdByName('town-hall'));
  await page.locator(`.channel-row-wrap:has(a[href$="/${id}"])`).hover();
  await page.getByRole('button', { name: 'Edit Channel' }).first().click();
  const dialog = page.getByRole('dialog', { name: /Channel Settings/ });
  await expect(page.getByRole('button', { name: 'Save Changes' })).toHaveCount(0); // not an unsaved edit before anything is typed
  await dialog.getByLabel('Stage topic').fill('Topic only');
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(dialog.getByText('Saved.')).toBeVisible();
  await expect(dialog.getByLabel('Channel name')).toHaveValue('town-hall');
  await dialog.getByLabel('Channel name').fill('Town Hall');
  await dialog.getByLabel('Stage topic').fill('Both');
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(dialog.getByLabel('Channel name')).toHaveValue('Town Hall');
  await expect(dialog.getByText('Saved.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(stage.getByRole('heading', { name: 'Both' })).toBeVisible();
});
