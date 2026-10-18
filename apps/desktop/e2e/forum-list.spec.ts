import { expect, test } from '@playwright/test';
import { openChannel, panel } from './threadHelpers';

// Forum post list (GLD-014): unread state, reactions on cards, tag pills, layout toggle (filter / sort / search are in threads.spec.ts).

const card = (page: import('@playwright/test').Page, name: string) => page.locator('.forum-post', { hasText: name });

/** Right-clicks a card after scrolling it into view: a scroll event after the menu opened would close it. */
async function rightClick(page: import('@playwright/test').Page, target: import('@playwright/test').Locator) {
  await target.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  await target.click({ button: 'right' });
}

test('unread posts are marked and turn read once opened', async ({ page }) => {
  await openChannel(page, 'support');
  const idea = card(page, 'Idea: show joined threads');
  await expect(idea).toHaveClass(/unread/);
  await expect(card(page, 'Read this before posting')).not.toHaveClass(/unread/); // sam read it
  await expect(card(page, 'Gateway reconnect loop')).not.toHaveClass(/unread/); // sam replied last
  await expect(page.getByRole('button', { name: 'Open post Idea: show joined threads under their channel (unread)' })).toBeVisible();

  await idea.click();
  await expect(panel(page).locator('.thread-panel-header').getByRole('heading', { name: 'Idea: show joined threads under their channel', level: 2 })).toBeVisible();
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

test('a post is muted and unmuted from its context menu: dimmed card with a muted icon, the Until label, no unread state', async ({ page }) => {
  await openChannel(page, 'support');
  const idea = card(page, 'Gateway reconnect loop'); // sam is in this post
  await rightClick(page, idea);
  await page.getByRole('menuitem', { name: 'Mute Thread' }).hover();
  await page.getByRole('menuitem', { name: 'For 1 Hour' }).click();
  await expect(idea).toHaveClass(/muted/);
  await expect(idea.getByLabel('Muted')).toBeVisible();
  await expect(idea).toHaveCSS('opacity', '0.5');

  await rightClick(page, idea);
  await expect(page.getByRole('menuitem', { name: 'Unmute Thread' })).toContainText(/Until /);
  await page.getByRole('menuitem', { name: 'Unmute Thread' }).click();
  await expect(idea).not.toHaveClass(/muted/);
  await expect(idea.getByLabel('Muted')).toHaveCount(0);
  await expect(idea).toHaveCSS('opacity', '1');
});

test('muting the forum from the sidebar dims its posts and drops their unread state', async ({ page }) => {
  await openChannel(page, 'support');
  const unread = card(page, 'Idea: show joined threads');
  await expect(unread).toHaveClass(/unread/);
  await page.getByRole('link', { name: /^support/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Mute Channel/ }).hover();
  await page.getByRole('menuitem', { name: 'Until I turn it back on' }).click();
  await expect(unread).toHaveClass(/muted/);
  await expect(unread).not.toHaveClass(/unread/);
  await page.getByRole('link', { name: /^support/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Unmute Channel/ }).click();
  await expect(unread).not.toHaveClass(/muted/);
  await expect(unread).toHaveClass(/unread/);
});
