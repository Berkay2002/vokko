import { expect, test } from '@playwright/test';
import { openChannel, panel } from './threadHelpers';

// Stage channels get their own settings page (no text-channel topic, no "Not available yet" rows) with the live stage's topic
// (editStageTopic), the header shows the stage icon, and a forum post's tags can be edited after posting (Edit Post).

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
  await tags.getByRole('button', { name: 'Docs' }).click();
  await expect(tags.getByRole('button', { name: 'Docs' })).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card.locator('.forum-tag', { hasText: 'Docs' })).toBeVisible();
});
