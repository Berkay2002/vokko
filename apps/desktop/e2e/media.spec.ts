import { expect, test, type Locator, type Page } from '@playwright/test';
import { message, send } from './helpers';

// GIFs, stickers, forward, bookmarks and reminders against the in-memory mock backend (docs/cloud/media-actions.md).
// Set VOKKO_SHOTS=<dir> to also write screenshots of the pickers and the forward dialog there.

const SHOTS = process.env.VOKKO_SHOTS;
async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

type Win = { __vokko: { request(method: string, path: string, body?: unknown): Promise<unknown> }; __vokkoMock: { gifProvider(p: string): void; say(channelId: string, user: string, text: string): string; channelIdByName(n: string): string | null } };

async function openChannel(page: Page, name: string): Promise<void> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  const target = await page.evaluate(n => {
    const store = (window as unknown as { __vokko: { appStore: { getState(): { channels: Record<string, { id: string; name?: string; guild_id: string | null }> } } } }).__vokko.appStore;
    const c = Object.values(store.getState().channels).find(x => x.name === n)!;
    return `/channels/${c.guild_id}/${c.id}`;
  }, name);
  await page.evaluate(path => { history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, target);
  await page.locator('.chat-textarea').waitFor();
  await page.locator('.chat-msg').first().waitFor();
}

/** The sidebar link of a DM by display name (its accessible name starts with it, then unread state and presence: "Bob, idle, in voice"). */
const dmLink = (page: Page, name: string): Locator => page.getByRole('link', { name: new RegExp(`^${name}(,|$)`, 'i') }).first();

async function openDm(page: Page, name = 'Alice'): Promise<void> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await dmLink(page, name).click();
  await page.locator('.chat-textarea').waitFor();
  await page.locator('.chat-msg').first().waitFor();
}

/** Sends a message with a unique text and waits until the server has it; returns the text. */
async function postUnique(page: Page, label: string): Promise<string> {
  const text = `${label} ${Math.random().toString(36).slice(2, 8)}`;
  await send(page, text);
  await expect(message(page, text)).not.toHaveClass(/pending/);
  return text;
}

const picker = (page: Page) => page.getByRole('dialog', { name: 'Expression picker' });

async function imageLoaded(img: Locator): Promise<boolean> {
  return img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0);
}

test.describe('GIF picker', () => {
  test('search, pick a result: the message shows the media and hides the URL', async ({ page }) => {
    await openDm(page);
    await page.getByRole('button', { name: 'Open GIF picker' }).click();
    const gifs = picker(page).getByRole('tabpanel', { name: 'GIFs' });
    // home: category tiles incl. Trending
    await expect(gifs.getByRole('button', { name: 'Trending GIFs' })).toBeVisible();
    await expect(gifs.getByRole('button', { name: 'Reactions' })).toBeVisible();
    await shot(page, 'gif-home');

    await gifs.getByRole('textbox', { name: 'Search GIFs' }).fill('cat dance');
    const results = gifs.getByRole('button', { name: /^Send GIF:/ });
    await expect(results.first()).toBeVisible();
    expect(await results.count()).toBe(24);
    await expect(results.first()).toHaveAccessibleName(/cat dance 1/);
    await shot(page, 'gif-search');

    await results.first().click();
    await expect(picker(page)).toHaveCount(0);
    const posted = page.locator('.chat-msg', { has: page.locator('.media-gif') }).last();
    await expect(posted.locator('.media-gif img')).toBeVisible();
    expect(await imageLoaded(posted.locator('.media-gif img'))).toBe(true);
    // the raw URL is not shown anywhere in the row
    await expect(posted).not.toContainText('media.mock');
    await expect(posted).not.toContainText('https://');
    await expect(posted).not.toHaveClass(/pending/);
  });

  test('category and trending listings load and the star toggles a favourite that shows under Favorites', async ({ page }) => {
    await openDm(page);
    await page.getByRole('button', { name: 'Open GIF picker' }).click();
    const gifs = picker(page).getByRole('tabpanel', { name: 'GIFs' });
    await gifs.getByRole('button', { name: 'Trending GIFs' }).click();
    const results = gifs.getByRole('button', { name: /^Send GIF:/ });
    await expect(results).toHaveCount(24);
    // paging
    await gifs.getByRole('button', { name: 'Load more' }).click();
    await expect(results).toHaveCount(48);

    const star = gifs.getByRole('button', { name: 'Add to favorites' }).first();
    await star.click({ force: true });
    await expect(gifs.getByRole('button', { name: 'Remove from favorites' })).toHaveCount(1);

    await gifs.getByRole('button', { name: 'Back to categories' }).click();
    await gifs.getByRole('button', { name: 'Favorites' }).click();
    await expect(results).toHaveCount(1);
    // unstar from the favourites view
    await gifs.getByRole('button', { name: 'Remove from favorites' }).click({ force: true });
    await expect(gifs.getByText('No favorite GIFs yet')).toBeVisible();
    await expect(results).toHaveCount(0);
  });

  test('with no provider the picker shows favourites only, honestly', async ({ page }) => {
    await page.goto('/channels/@me?as=sam&mockLatency=0&mockGifProvider=none');
    await dmLink(page, 'Alice').click();
    await page.locator('.chat-textarea').waitFor();
    await page.getByRole('button', { name: 'Open GIF picker' }).click();
    const gifs = picker(page).getByRole('tabpanel', { name: 'GIFs' });
    await expect(gifs.getByText('No favorite GIFs yet')).toBeVisible();
    await expect(gifs).toContainText('GIF search isn’t set up');
    await expect(gifs.getByRole('button', { name: 'Trending GIFs' })).toHaveCount(0);
    await expect(gifs.getByRole('textbox', { name: 'Search GIFs' })).toHaveAttribute('placeholder', 'Search favorites');
    await shot(page, 'gif-none');
  });
});

test.describe('sticker picker', () => {
  test('stickers are grouped under their server, searchable, and send as an image', async ({ page }) => {
    await openChannel(page, 'general');
    await page.getByRole('button', { name: 'Open sticker picker' }).click();
    const stickers = picker(page).getByRole('tabpanel', { name: 'Stickers' });
    const group = stickers.getByRole('region', { name: "Sam's server" });
    await expect(group).toBeVisible();
    await expect(group.locator('.media-sticker-cell')).toHaveCount(3);
    await shot(page, 'sticker-picker');

    // hover preview names the sticker
    await group.getByRole('button', { name: 'party', exact: true }).hover();
    await expect(stickers.locator('.media-sticker-preview')).toContainText('party');
    await shot(page, 'sticker-hover');

    // search by tag
    await stickers.getByRole('textbox', { name: 'Search stickers' }).fill('approve');
    await expect(group.locator('.media-sticker-cell')).toHaveCount(1);
    await expect(group.getByRole('button', { name: 'thumbs-up', exact: true })).toBeVisible();
    await stickers.getByRole('textbox', { name: 'Search stickers' }).fill('zzzz');
    await expect(stickers.getByText('No stickers found')).toBeVisible();
    await stickers.getByRole('textbox', { name: 'Search stickers' }).fill('wave');

    await group.getByRole('button', { name: 'wave', exact: true }).click();
    await expect(picker(page)).toHaveCount(0);
    const sent = page.locator('.chat-msg', { has: page.locator('img.media-sticker') }).last();
    const img = sent.locator('img.media-sticker');
    await expect(img).toHaveAttribute('alt', 'Sticker: wave');
    expect(await imageLoaded(img)).toBe(true);
    const box = await img.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(150);
    expect(box?.width).toBeLessThanOrEqual(170);
  });

  test('a sticker can be sent in a DM', async ({ page }) => {
    await openDm(page);
    await page.getByRole('button', { name: 'Open sticker picker' }).click();
    await picker(page).getByRole('button', { name: 'party', exact: true }).click();
    await expect(page.locator('img.media-sticker[alt="Sticker: party"]')).toBeVisible();
  });
});

test.describe('forward', () => {
  async function openForward(page: Page, text: string): Promise<Locator> {
    const original = message(page, text);
    await original.hover();
    await original.getByRole('button', { name: 'Forward' }).click();
    const dialog = page.getByRole('dialog', { name: 'Forward To' });
    await expect(dialog).toBeVisible();
    return dialog;
  }

  test('select two destinations with a comment: both get the snapshot, the comment follows it', async ({ page }) => {
    await openDm(page);
    const unique = `forward me ${Date.now()}`;
    await send(page, unique);
    await expect(message(page, unique)).not.toHaveClass(/pending/);

    const dialog = await openForward(page, unique);
    await expect(dialog.getByText('0/5 selected')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await expect(dialog.locator('.media-forward-preview')).toContainText(unique);
    await shot(page, 'forward-modal');

    // search narrows the list
    await dialog.getByRole('textbox', { name: 'Search channels and conversations' }).fill('bob');
    await dialog.getByRole('option', { name: /^Bob$/ }).getByRole('button').click();
    await dialog.getByRole('textbox', { name: 'Search channels and conversations' }).fill('random');
    await dialog.getByRole('option', { name: /^random/ }).getByRole('button').click();
    await dialog.getByRole('textbox', { name: 'Search channels and conversations' }).fill('');
    await expect(dialog.getByText('2/5 selected')).toBeVisible();
    await dialog.getByRole('textbox', { name: 'Optional comment' }).fill('fyi, see this');
    await shot(page, 'forward-modal-filled');
    await dialog.getByRole('button', { name: 'Send (2)' }).click();
    await expect(dialog).toHaveCount(0);

    // the DM with bob: a forwarded block with the original text, then the comment
    await dmLink(page, 'Bob').click();
    const block = page.locator('.media-forward', { hasText: unique });
    await expect(block).toBeVisible();
    await expect(block.getByText('Forwarded', { exact: true })).toBeVisible();
    await expect(block.locator('time')).toBeVisible();
    await expect(page.locator('.chat-msg', { hasText: 'fyi, see this' }).last()).toBeVisible();
    // the source is a DM we know locally: "jump to original" is offered
    await expect(block.getByRole('button', { name: 'Jump to original' })).toBeVisible();
    await shot(page, 'forward-result');

    // my own forward has no text to edit: neither the menu nor the hover bar offers Edit
    const mine = page.locator('.chat-msg', { has: block }).last();
    await mine.hover();
    await expect(mine.getByRole('button', { name: 'Edit' })).toHaveCount(0);
    await mine.click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Edit Message' })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: 'Forward' })).toBeVisible();
    await page.keyboard.press('Escape');

    // and #random in the server
    await openChannelInApp(page, 'random');
    await expect(page.locator('.media-forward', { hasText: unique })).toBeVisible();
    await expect(page.locator('.chat-msg', { hasText: 'fyi, see this' }).last()).toBeVisible();
  });

  test('at most 5 destinations can be picked', async ({ page }) => {
    await openDm(page, 'Carol');
    const dialog = await openForward(page, await postUnique(page, 'limit test'));
    const rows = dialog.getByRole('option');
    const total = await rows.count();
    expect(total).toBeGreaterThan(6);
    for (let i = 0; i < 5; i += 1) await rows.nth(i).getByRole('button').click();
    await expect(dialog.getByText('5/5 selected')).toBeVisible();
    // every unselected row is disabled, the selected ones can still be unticked
    await expect(rows.nth(5).getByRole('button')).toBeDisabled();
    await expect(rows.nth(0).getByRole('button')).toBeEnabled();
    await rows.nth(0).getByRole('button').click();
    await expect(dialog.getByText('4/5 selected')).toBeVisible();
    await expect(rows.nth(5).getByRole('button')).toBeEnabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
  });

  test('the context menu Forward opens the same dialog', async ({ page }) => {
    await openDm(page, 'Carol');
    const target = message(page, await postUnique(page, 'menu forward'));
    await target.click({ button: 'right', position: { x: 200, y: 10 } });
    await page.getByRole('menuitem', { name: 'Forward' }).click();
    await expect(page.getByRole('dialog', { name: 'Forward To' })).toBeVisible();
  });
});

async function openChannelInApp(page: Page, name: string): Promise<void> {
  const target = await page.evaluate(n => {
    const store = (window as unknown as { __vokko: { appStore: { getState(): { channels: Record<string, { id: string; name?: string; guild_id: string | null }> } } } }).__vokko.appStore;
    const c = Object.values(store.getState().channels).find(x => x.name === n)!;
    return `/channels/${c.guild_id}/${c.id}`;
  }, name);
  await page.evaluate(path => { history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, target);
  await page.locator('.chat-textarea').waitFor();
}

async function openInbox(page: Page, tab: 'Bookmarks' | 'Reminders'): Promise<Locator> {
  await page.getByRole('button', { name: 'Inbox' }).click();
  await page.getByRole('tab', { name: tab }).click();
  return page.locator('.inbox-popout');
}

test.describe('bookmarks and reminders', () => {
  test('bookmark via the menu shows up in the Bookmarks tab and can be removed', async ({ page }) => {
    await openDm(page, 'Carol');
    const text = await postUnique(page, 'bookmark me');
    const row = message(page, text);
    await row.click({ button: 'right', position: { x: 200, y: 10 } });
    await page.getByRole('menuitem', { name: 'Bookmark Message' }).click();

    let inbox = await openInbox(page, 'Bookmarks');
    const saved = inbox.getByTestId('saved-message');
    await expect(saved).toHaveCount(1);
    await expect(saved).toContainText(text);
    await shot(page, 'inbox-bookmarks');
    await page.keyboard.press('Escape');

    // the menu now offers to remove it
    await row.click({ button: 'right', position: { x: 200, y: 10 } });
    await expect(page.getByRole('menuitem', { name: 'Remove Bookmark' })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Remove Bookmark' }).click();
    inbox = await openInbox(page, 'Bookmarks');
    await expect(inbox.getByTestId('saved-message')).toHaveCount(0);
    await expect(inbox).toContainText('No bookmarks yet');
  });

  test('removing a bookmark from the inbox and jumping to it', async ({ page }) => {
    await openDm(page, 'Carol');
    const text = await postUnique(page, 'jump back to me');
    const row = message(page, text);
    await row.click({ button: 'right', position: { x: 200, y: 10 } });
    await page.getByRole('menuitem', { name: 'Bookmark Message' }).click();
    // another conversation, then jump back from the inbox
    await dmLink(page, 'Bob').click();
    await page.locator('.chat-textarea').waitFor();
    const inbox = await openInbox(page, 'Bookmarks');
    await inbox.getByRole('button', { name: /^Jump to bookmarked message/ }).click();
    await expect(page.locator('.chat-msg', { hasText: text }).last()).toBeVisible();
    expect(new URL(page.url()).pathname).toMatch(/^\/channels\/@me\/\d+$/);

    const again = await openInbox(page, 'Bookmarks');
    await again.getByRole('button', { name: 'Remove bookmark' }).click();
    await expect(again.getByTestId('saved-message')).toHaveCount(0);
  });

  test('preset reminders are listed in the Reminders tab and can be cancelled', async ({ page }) => {
    await openDm(page, 'Carol');
    const text = await postUnique(page, 'remind me');
    const row = message(page, text);
    await row.click({ button: 'right', position: { x: 200, y: 10 } });
    await page.getByRole('menuitem', { name: 'Create Reminder' }).hover();
    const sub = page.locator('.chat-submenu');
    await expect(sub.locator('.media-reminder-header')).toHaveText('Remind me');
    await expect(sub.getByRole('menuitem')).toHaveText(['In 30 min', 'In 1 hour', 'In 4 hours', /^Tomorrow at 0?9:00/, /^Monday at 0?9:00/, 'Custom…']);
    await page.getByRole('menuitem', { name: 'In 1 hour' }).click();
    await expect(page.locator('.chat-toast', { hasText: 'Reminder set for' })).toBeVisible();

    const inbox = await openInbox(page, 'Reminders');
    const reminder = inbox.getByTestId('reminder');
    await expect(reminder).toHaveCount(1);
    await expect(reminder).toContainText(text);
    await expect(reminder).toContainText('Reminds you');
    await shot(page, 'inbox-reminders');
    await reminder.getByRole('button', { name: 'Cancel reminder' }).click();
    await expect(inbox.getByTestId('reminder')).toHaveCount(0);
  });

  test('custom reminders validate the time and are saved at the chosen minute', async ({ page }) => {
    await openDm(page, 'Carol');
    const text = await postUnique(page, 'remind me');
    const row = message(page, text);
    await row.click({ button: 'right', position: { x: 200, y: 10 } });
    await page.getByRole('menuitem', { name: 'Create Reminder' }).hover();
    await page.getByRole('menuitem', { name: 'Custom…' }).click();
    const input = page.getByLabel('Remind me at');
    await input.fill('2000-01-01T10:00');
    await page.getByRole('button', { name: 'Set reminder' }).click();
    await expect(page.getByRole('alert')).toContainText('future');

    const when = new Date(Date.now() + 26 * 3600 * 1000);
    when.setSeconds(0, 0);
    const pad = (n: number) => String(n).padStart(2, '0');
    await input.fill(`${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(when.getHours())}:${pad(when.getMinutes())}`);
    await page.getByRole('button', { name: 'Set reminder' }).click();
    await expect(page.locator('.chat-toast', { hasText: 'Reminder set for' })).toBeVisible();
    const stored = await page.evaluate(async () => ((await (window as unknown as Win).__vokko.request('GET', '/users/@me/reminders')) as { remind_at: string }[])[0]?.remind_at);
    expect(new Date(stored!).getTime()).toBe(when.getTime());
  });

  test('a reminder that comes due shows a notice with the message, then dismisses', async ({ page }) => {
    await openDm(page, 'Carol');
    const text = await postUnique(page, 'due soon');
    const id = await message(page, text).getAttribute('data-message-id');
    const channelId = new URL(page.url()).pathname.split('/').pop()!;
    await page.evaluate(([c, m]) => (window as unknown as Win).__vokko.request('POST', '/users/@me/reminders', { channel_id: c, message_id: m, remind_at: new Date(Date.now() + 1500).toISOString() }), [channelId, id!]);

    const notice = page.getByTestId('reminder-notice');
    await expect(notice).toHaveCount(0);
    await expect(notice).toBeVisible({ timeout: 8000 });
    await expect(notice).toContainText('Reminder');
    await expect(notice).toContainText(text);
    await shot(page, 'reminder-notice');

    // it stays in the inbox, marked due, until dismissed
    await notice.getByRole('button', { name: 'Hide notice' }).click();
    await expect(notice).toHaveCount(0);
    const inbox = await openInbox(page, 'Reminders');
    await expect(inbox.getByTestId('reminder')).toContainText('Reminder is due');
    await inbox.getByRole('button', { name: 'Dismiss reminder' }).click();
    await expect(inbox.getByTestId('reminder')).toHaveCount(0);
  });
});

test('stickers and GIF links in messages: a plain URL stays text, a forward of a GIF stays a GIF', async ({ page }) => {
  await openDm(page);
  await send(page, 'see https://example.com/page and enjoy');
  await expect(message(page, 'see https://example.com/page')).toBeVisible();
  await expect(message(page, 'see https://example.com/page').locator('.media-gif')).toHaveCount(0);

  await page.getByRole('button', { name: 'Open GIF picker' }).click();
  await picker(page).getByRole('textbox', { name: 'Search GIFs' }).fill('party');
  await picker(page).getByRole('button', { name: /^Send GIF:/ }).first().click();
  const gifRow = page.locator('.chat-msg', { has: page.locator('.media-gif img') }).last();
  await expect(gifRow).toBeVisible();

  await gifRow.hover();
  await gifRow.getByRole('button', { name: 'Forward' }).click();
  const dialog = page.getByRole('dialog', { name: 'Forward To' });
  await dialog.getByRole('option', { name: /^Bob$/ }).getByRole('button').click();
  await dialog.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await dmLink(page, 'Bob').click();
  const forwarded = page.locator('.media-forward').last();
  await expect(forwarded.locator('.media-gif img')).toBeVisible();
  await expect(forwarded).not.toContainText('https://');
});

test.describe('inbox mentions', () => {
  test('lists mention messages that stay after reading, filters @everyone, jumps and removes one', async ({ page }) => {
    await openChannel(page, 'general');
    const general = await page.evaluate(() => (window as unknown as Win).__vokkoMock.channelIdByName('general')!);
    const me = await page.evaluate(() => (window as unknown as { __vokko: { appStore: { getState(): { me: { id: string } | null } } } }).__vokko.appStore.getState().me!.id);
    const stamp = Date.now().toString(36);
    await page.evaluate(([c, id, s]) => {
      const mock = (window as unknown as Win).__vokkoMock;
      mock.say(c!, 'alice', `direct ping <@${id}> ${s}`);
      mock.say(c!, 'bob', `@everyone all hands ${s}`);
    }, [general, me, stamp]);
    await page.locator('.chat-msg', { hasText: `all hands ${stamp}` }).waitFor(); // the open channel is read now

    await page.getByRole('button', { name: 'Inbox' }).click();
    await page.getByRole('tab', { name: 'Mentions' }).click();
    const inbox = page.locator('.inbox-popout');
    const rows = inbox.getByTestId('mention');
    await expect(rows.first()).toContainText(`all hands ${stamp}`);
    await expect(rows.nth(1)).toContainText(`direct ping`);
    await expect(inbox.locator('.media-mention-where').first()).toContainText('#general');
    await shot(page, 'inbox-mentions');

    await inbox.getByRole('button', { name: 'Include @everyone' }).click();
    await expect(rows.filter({ hasText: `all hands ${stamp}` })).toHaveCount(0);
    await expect(rows.first()).toContainText(`direct ping`);
    await inbox.getByRole('button', { name: 'Include @everyone' }).click();
    await expect(rows.first()).toContainText(`all hands ${stamp}`);

    await rows.first().getByRole('button', { name: 'Remove mention' }).click();
    await expect(rows.filter({ hasText: `all hands ${stamp}` })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Inbox' }).click();
    await page.getByRole('tab', { name: 'Mentions' }).click();
    await expect(rows.first()).toContainText(`direct ping`);
    await rows.first().getByRole('button', { name: /^Jump to message by/ }).click();
    await expect(page.locator('.chat-msg', { hasText: `direct ping` }).last()).toBeVisible();
  });
});
