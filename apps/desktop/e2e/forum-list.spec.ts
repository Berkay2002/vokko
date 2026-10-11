import { expect, test } from '@playwright/test';
import { openChannel, panel } from './threadHelpers';

// Forum post list (GLD-014): unread state, reactions on cards, tag pills, layout toggle (filter / sort / search are in threads.spec.ts).

const card = (page: import('@playwright/test').Page, name: string) => page.locator('.forum-post', { hasText: name });

test('unread posts are marked and turn read once opened', async ({ page }) => {
  await openChannel(page, 'support');
  const idea = card(page, 'Idea: show joined threads');
  await expect(idea).toHaveClass(/unread/);
  await expect(card(page, 'Read this before posting')).not.toHaveClass(/unread/); // sam read it
  await expect(card(page, 'Gateway reconnect loop')).not.toHaveClass(/unread/); // sam replied last
  await expect(page.getByRole('button', { name: 'Open post Idea: show joined threads under their channel (unread)' })).toBeVisible();

  await idea.click();
  await expect(panel(page).getByRole('heading', { name: 'Idea: show joined threads under their channel', level: 2 })).toBeVisible();
  await expect(idea).not.toHaveClass(/unread/, { timeout: 10_000 }); // acked after Discord's 3 s debounce
});

test('cards show the top reaction of the starter message, or the default reaction; clicking toggles it without opening the post', async ({ page }) => {
  await openChannel(page, 'support');
  const idea = card(page, 'Idea: show joined threads').locator('.forum-post-reaction');
  await expect(idea).toHaveAccessibleName('3 👍'); // 👍 x3 beats 💡 x1
  await idea.click();
  await expect(idea).toHaveAccessibleName('4 👍');
  await expect(idea).toHaveAttribute('aria-pressed', 'true');
  await expect(panel(page)).toHaveCount(0);
  await idea.click();
  await expect(idea).toHaveAccessibleName('3 👍');

  // no reactions yet: the forum's default reaction, as an add button
  const tag = card(page, 'How do I change my server tag?').locator('.forum-post-reaction');
  await expect(tag).toHaveAccessibleName('React with 👍');
  await tag.click();
  await expect(tag).toHaveAccessibleName('1 👍');
  // the list refetches on the gateway echo and keeps the count
  await page.getByLabel('Search posts').fill('server tag');
  await expect(page.locator('.forum-post')).toHaveCount(1);
  await expect(page.locator('.forum-post-reaction')).toHaveAccessibleName('1 👍');
});

test('tag pills on cards, and the list / gallery toggle is remembered per forum', async ({ page }) => {
  await openChannel(page, 'support');
  await expect(card(page, 'Member list contrast').locator('.forum-post-tags .forum-tag')).toHaveText(['🐛Bug', '📖Docs']);
  await page.getByRole('button', { name: 'Gallery view' }).click();
  await expect(page.getByRole('button', { name: 'Gallery view' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.forum-posts.gallery')).toBeVisible();
  await page.getByRole('link', { name: /^general/ }).click();
  await page.getByRole('link', { name: /^support/ }).click();
  await expect(page.locator('.forum-posts.gallery')).toBeVisible();
  await page.getByRole('button', { name: 'List view' }).click();
  await expect(page.locator('.forum-posts.list')).toBeVisible();
});
