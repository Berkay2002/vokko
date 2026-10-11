import { expect, test } from '@playwright/test';
import { openChannel, panel } from './threadHelpers';

// Create-post flow (GLD-014): guidelines in the composer, required tags, moderated tags.

type Win = { __vokko: { editChannel(id: string, body: Record<string, unknown>): Promise<unknown> } };

test('the composer shows the post guidelines and needs a tag when the forum requires one', async ({ page }) => {
  const forumId = await openChannel(page, 'support');
  await page.evaluate(id => (window as unknown as Win).__vokko.editChannel(id, { flags: 16 }), forumId); // ChannelFlags.RequireTag

  await page.getByRole('button', { name: 'New Post' }).click();
  const form = page.getByRole('form', { name: 'New post' });
  await expect(form.getByRole('region', { name: 'Post guidelines for this forum' })).toContainText('One post per topic.');
  await form.getByLabel('Post title').fill('Tagged post');
  await form.getByLabel('Post message').fill('This forum wants a tag.');
  const tags = form.getByRole('group', { name: 'Tags (at least one required)' });
  await expect(tags.getByText('Pick at least one tag to post.')).toBeVisible();
  await expect(form.getByRole('button', { name: 'Post', exact: true })).toBeDisabled();

  await tags.getByRole('button', { name: 'Docs' }).click();
  await expect(tags.getByText('Pick at least one tag to post.')).toHaveCount(0);
  await form.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(panel(page).getByRole('heading', { name: 'Tagged post', level: 2 })).toBeVisible();
  await expect(page.locator('.forum-post', { hasText: 'Tagged post' }).locator('.forum-tag')).toHaveText('📖Docs');
});

test('at most five tags; Cancel closes the composer', async ({ page }) => {
  await openChannel(page, 'support');
  await page.getByRole('button', { name: 'New Post' }).click();
  const form = page.getByRole('form', { name: 'New post' });
  const tags = form.getByRole('group', { name: 'Tags' });
  for (const name of ['Question', 'Bug', 'Feature', 'Docs', 'Solved']) await tags.getByRole('button', { name }).click();
  await expect(tags.locator('[aria-pressed="true"]')).toHaveCount(5);
  await form.getByRole('button', { name: 'Cancel' }).click();
  await expect(form).toHaveCount(0);
});
