import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { composer, send } from './helpers';
import { openChannel, panel } from './threadHelpers';

// Threads, forum channels and announcement channels against the in-memory mock (?as=sam&mockLatency=0: sam is an administrator).
// The seed has: #general with a thread "gateway docs" (and an archived "replay buffer sizing"), #announcements (type 5) and the forum #support
// with tags Question / Bug / Feature / Docs / Solved and five posts, one of them pinned.

const row = (page: Page, text: string | RegExp) => page.locator('.channel-chat .chat-msg', { hasText: text }).last();

test('start a thread from a message, reply in it, archive and unarchive it', async ({ page }) => {
  await openChannel(page, 'general');
  await expect(page.locator('.chat-msg .thread-chip', { hasText: 'gateway docs' })).toBeVisible(); // seeded thread, shown under its message

  const text = `thread probe ${Date.now()}`;
  await send(page, text);
  const message = row(page, text);
  await expect(message).not.toHaveClass(/pending/);
  await message.hover();
  await message.getByRole('button', { name: 'Create Thread' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create Thread' });
  await expect(dialog.getByLabel('Thread name')).toHaveValue(text);
  await dialog.getByLabel('Thread name').fill('probe thread');
  await dialog.getByRole('button', { name: 'Create Thread' }).click();

  // the panel opens next to the channel: header, the original message as the starter, the composer
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByRole('heading', { name: 'probe thread' })).toBeVisible();
  await expect(panel(page).locator('.thread-starter')).toContainText(text);
  await expect(page.locator('.member-list')).toHaveCount(0);

  await panel(page).locator('.chat-textarea').fill('first reply in the thread');
  await panel(page).locator('.chat-textarea').press('Enter');
  const reply = panel(page).locator('.chat-msg', { hasText: 'first reply in the thread' });
  await expect(reply).toBeVisible();
  await expect(reply).not.toHaveClass(/pending/);

  // the chip under the original message counts the reply and reopens the panel
  const chip = message.locator('.thread-chip');
  await expect(chip).toContainText('probe thread');
  await expect(chip).toContainText('1 Message');
  await panel(page).getByRole('button', { name: 'Close thread' }).click();
  await expect(panel(page)).toHaveCount(0);
  await chip.click();
  await expect(panel(page).getByRole('heading', { name: 'probe thread' })).toBeVisible();

  // archive from the actions menu: banner, and the thread moves to the Archived tab of the threads popout
  await panel(page).getByRole('button', { name: 'Thread actions' }).click();
  await page.getByRole('menuitem', { name: 'Archive' }).click();
  await expect(panel(page).getByRole('status').filter({ hasText: 'This thread is archived' })).toBeVisible();
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  const popout = page.getByRole('dialog', { name: 'Threads' });
  await expect(popout.getByRole('button', { name: /probe thread/ })).toHaveCount(0); // active tab
  await expect(popout.getByRole('button', { name: /gateway docs/ })).toBeVisible();
  await popout.getByRole('tab', { name: 'Archived Threads' }).click();
  await expect(popout.getByRole('button', { name: /probe thread/ })).toBeVisible();
  await expect(popout.getByRole('button', { name: /replay buffer sizing/ })).toBeVisible(); // seeded archived thread
  await page.keyboard.press('Escape');

  await panel(page).getByRole('button', { name: 'Unarchive' }).click();
  await expect(panel(page).getByText('This thread is archived')).toHaveCount(0);
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Threads' }).getByRole('button', { name: /probe thread/ })).toBeVisible();
});

test('"Create Thread" is also in the message menu, and a message with a thread offers "Open Thread"', async ({ page }) => {
  await openChannel(page, 'general');
  const text = `menu probe ${Date.now()}`;
  await send(page, text);
  const message = row(page, text);
  await expect(message).not.toHaveClass(/pending/);
  await message.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Create Thread' }).click();
  await page.getByRole('dialog', { name: 'Create Thread' }).getByRole('button', { name: 'Create Thread' }).click();
  await expect(panel(page).locator('.thread-starter')).toContainText(text);
  await panel(page).getByRole('button', { name: 'Close thread' }).click();
  await message.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Create Thread' })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Open Thread' }).click();
  await expect(panel(page)).toBeVisible();
});

test('a thread started without a message posts a notice in the channel and joined threads show in the sidebar', async ({ page }) => {
  await openChannel(page, 'general');
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await page.getByRole('dialog', { name: 'Threads' }).getByRole('button', { name: /Create/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Create Thread' });
  await dialog.getByLabel('Thread name').fill('standalone talk');
  await dialog.getByRole('button', { name: 'Create Thread' }).click();
  // level 2 is the panel header; the empty thread's channel-start intro is an h1 with the same text and can appear at the same time
  await expect(panel(page).getByRole('heading', { name: 'standalone talk', level: 2 })).toBeVisible();
  // type 18 notice in the channel
  await expect(page.locator('.chat-msg.system', { hasText: 'started a thread' })).toContainText('standalone talk');
  // the creator is a member: the thread is listed under #general
  await expect(page.getByRole('list', { name: 'Threads in general' }).getByRole('button', { name: 'standalone talk' })).toBeVisible();
  await expect(composer(page).last()).toBeVisible();
});

test('forum: filter by tag, search, pinned first, create a post with a tag', async ({ page }) => {
  await openChannel(page, 'support');
  const cards = page.locator('.forum-post');
  await expect(cards).toHaveCount(5);
  await expect(cards.first()).toContainText('Read this before posting'); // pinned
  await expect(page.getByRole('heading', { name: 'Post Guidelines' })).toBeVisible();

  const filter = page.getByRole('group', { name: 'Filter by tag' });
  await filter.getByRole('button', { name: 'Bug' }).click();
  await expect(cards).toHaveCount(2);
  await expect(cards.filter({ hasText: 'Gateway reconnect loop' })).toHaveCount(1);
  await expect(cards.filter({ hasText: 'Member list contrast' })).toHaveCount(1);
  await filter.getByRole('button', { name: 'Clear' }).click();
  await expect(cards).toHaveCount(5);

  await page.getByLabel('Search posts').fill('server tag');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('How do I change my server tag?');
  await page.getByLabel('Search posts').fill('');
  await expect(cards).toHaveCount(5);

  // a post opens in the thread panel, with its starter message
  await cards.filter({ hasText: 'Gateway reconnect loop' }).click();
  await expect(panel(page).getByRole('heading', { name: 'Gateway reconnect loop after resume' })).toBeVisible();
  await expect(panel(page).locator('.chat-msg').first()).toContainText('reconnects every second');
  await panel(page).getByRole('button', { name: 'Close thread' }).click();

  // new post with a tag
  await page.getByRole('button', { name: 'New Post' }).click();
  const form = page.getByRole('form', { name: 'New post' });
  await form.getByLabel('Post title').fill('E2E forum post');
  await form.getByRole('group', { name: 'Tags' }).getByRole('button', { name: 'Question' }).click();
  await form.getByLabel('Post message').fill('Does this show up under the Question tag?');
  await form.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(panel(page).getByRole('heading', { name: 'E2E forum post' })).toBeVisible();
  await expect(cards).toHaveCount(6);
  await expect(cards.filter({ hasText: 'E2E forum post' }).locator('.forum-tag')).toHaveText('❓Question');

  // the tag filter now finds the new post next to the seeded question
  await filter.getByRole('button', { name: 'Question' }).click();
  await expect(cards).toHaveCount(2);
  await expect(cards.filter({ hasText: 'E2E forum post' })).toHaveCount(1);
  await expect(cards.filter({ hasText: 'How do I change my server tag?' })).toHaveCount(1);
});

test('forum: gallery layout, sort and the create-channel dialog offers Forum, Announcement and Stage', async ({ page }) => {
  await openChannel(page, 'support');
  await page.getByRole('button', { name: 'Gallery view' }).click();
  await expect(page.locator('.forum-posts.gallery')).toBeVisible();
  await page.getByLabel('Sort posts').selectOption('creation_time');
  await expect(page.locator('.forum-post').first()).toContainText('Read this before posting'); // pinned stays first
  await expect(page.locator('.forum-post').nth(1)).toContainText('Idea: show joined threads'); // newest post of the seed
  await page.getByLabel('Sort posts').selectOption('last_message_time');
  await page.getByRole('button', { name: 'List view' }).click();

  await page.locator('.category-header').first().hover(); // the + button shows on hover
  await page.getByRole('button', { name: 'Create Channel' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Create Channel' });
  for (const type of ['Announcement', 'Forum', 'Stage']) await expect(dialog.getByRole('radio', { name: new RegExp(`^${type}`) })).toBeEnabled();
  await dialog.getByRole('radio', { name: /^Forum/ }).click();
  await dialog.locator('#channel-name').fill('ideas');
  await dialog.getByRole('button', { name: 'Create Channel' }).click();
  await expect(page.locator('.forum')).toBeVisible();
  await expect(page.getByText('No posts yet')).toBeVisible();
  await expect(page.getByRole('link', { name: /^ideas/ })).toBeVisible();
});

test('announcements: follow into another channel, publish a message, the copy arrives and the source says Published', async ({ page }) => {
  await openChannel(page, 'announcements');
  await expect(page.getByRole('heading', { name: 'announcements' })).toBeVisible();

  await page.getByRole('button', { name: 'Follow', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Follow Announcement Channel' });
  await expect(dialog.getByLabel('Server')).toContainText("Sam's server");
  await dialog.getByLabel('Channel').selectOption({ label: '# general' });
  await dialog.getByRole('button', { name: 'Follow', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('#general');
  await dialog.getByRole('button', { name: 'Done' }).click();

  const text = `news ${Date.now()}`;
  await send(page, text);
  const message = row(page, text);
  await expect(message).not.toHaveClass(/pending/);
  await message.hover();
  await message.getByRole('button', { name: 'Publish' }).click();
  await expect(message.getByText('Published', { exact: true })).toBeVisible();
  await message.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Published' })).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');

  await page.getByRole('link', { name: /^general/ }).click();
  const copy = row(page, text);
  await expect(copy).toBeVisible();
  await expect(copy.locator('.chat-crosspost-tag')).toContainText('Published from an announcement channel');
});
