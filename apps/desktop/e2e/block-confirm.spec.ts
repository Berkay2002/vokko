import { expect, test, type Page } from '@playwright/test';
import { stays } from './helpers';

// MOD-009: Block and Remove Friend from the user, member and DM context menus ask first and act only on confirm (mock mode).

const SHOTS = process.env.VOKKO_SHOTS_DIR;

type Win = { __vokko: { request(method: string, path: string, body?: unknown): Promise<unknown> } };

const relationshipOf = async (page: Page, username: string): Promise<number | undefined> => {
  const all = (await page.evaluate(() => (window as unknown as Win).__vokko.request('GET', '/users/@me/relationships'))) as { type: number; user: { username: string } }[];
  return all.find(r => r.user.username === username)?.type;
};

const FRIEND = 1;
const BLOCKED = 2;

test('Block from the member list asks first, also for someone who is not a friend', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: "Sam's server" }).click();
  const row = page.locator('.member-list .member-row', { hasText: 'Nova' });
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Block' }).click();
  const dialog = page.getByRole('dialog', { name: 'Block Nova' });
  await expect(dialog).toContainText('Are you sure you want to block Nova?');
  if (SHOTS) await dialog.screenshot({ path: `${SHOTS}/MOD-009-block-confirm.png` });
  const before = await relationshipOf(page, 'nova');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await stays(() => relationshipOf(page, 'nova'), before);

  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Block' }).click();
  await dialog.getByRole('button', { name: 'Block' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => relationshipOf(page, 'nova')).toBe(BLOCKED);
});

test('Remove Friend from a DM row menu asks first', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  const row = page.locator('.dm-row[aria-label^="Bob,"]');
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Remove Friend' }).click();
  const dialog = page.getByRole('dialog', { name: "Remove 'Bob'" });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await stays(() => relationshipOf(page, 'bob'), FRIEND);

  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Remove Friend' }).click();
  await dialog.getByRole('button', { name: 'Remove Friend' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => relationshipOf(page, 'bob')).toBeUndefined();
});

test('the Block dialog names a member by the nickname they have in the server, or their name without one', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: "Sam's server" }).click();
  // Seed fillers, neither a friend nor in a request: amber_fox has no nickname, misty_fox is "fox-4" in this server.
  for (const [row, name] of [['amber_fox', 'amber_fox'], ['fox-4', 'fox-4']] as const) {
    const member = page.locator('.member-list .member-row', { hasText: row });
    await member.scrollIntoViewIfNeeded(); // a scroll after the menu opens would close it
    await member.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Block' }).click();
    const dialog = page.getByRole('dialog', { name: `Block ${name}` });
    await expect(dialog).toContainText(`Are you sure you want to block ${name}?`);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
  }
});

test('a blocked author folds into one "N blocked messages" row in a server; Show reveals the run, Hide folds it again', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: "Sam's server" }).click();
  await page.getByRole('link', { name: /^general/ }).first().click();
  const list = page.locator('.chat-list');
  const novaRows = list.locator('.chat-msg:not(.chat-blocked)', { has: page.locator('.chat-author', { hasText: 'Nova' }) });
  await expect(novaRows.first()).toBeVisible();
  const shown = await list.locator('.chat-msg').count();

  await page.locator('.member-list .member-row', { hasText: 'Nova' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Block' }).click();
  await page.getByRole('dialog', { name: 'Block Nova' }).getByRole('button', { name: 'Block' }).click();

  const fold = list.locator('.chat-blocked').first();
  await expect(fold).toHaveText(/^\d+ blocked messages? · Show$/);
  await expect(novaRows).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/blocked-fold-1440.png` });

  await fold.getByRole('button', { name: /^Show \d+ blocked message/ }).click();
  await expect(novaRows.first()).toBeVisible();
  await expect(list.locator('.chat-blocked-bar')).toHaveText(/^\d+ blocked messages? · Hide$/);
  await expect(list.locator('.chat-msg')).toHaveCount(shown);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/blocked-fold-open-1440.png` });

  await list.locator('.chat-blocked-bar').getByRole('button', { name: 'Hide' }).click();
  await expect(novaRows).toHaveCount(0);
  await expect(list.locator('.chat-blocked').first()).toBeVisible();
});

test('an older page that holds folded runs does not move the list (firstItemIndex follows the rows, not the messages)', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0&seed=big');
  await page.getByRole('link', { name: 'Big Server' }).click();
  await page.getByRole('link', { name: /^firehose/ }).first().click();
  const list = page.locator('.chat-list');
  await expect(list.locator('.chat-msg').first()).toBeVisible();
  // Block three of four authors in the window: the messages are full of runs of them.
  await page.evaluate(async () => {
    const w = window as unknown as { __vokko: { request(m: string, p: string, b?: unknown): Promise<unknown>; appStore: { getState(): { me: { id: string } | null } } } };
    const channelId = location.pathname.split('/').pop();
    // The newest 500 messages (five pages), so the next older page has runs of the same authors.
    const authors = new Set<string>();
    let before = '';
    for (let i = 0; i < 5; i++) {
      const page = (await w.__vokko.request('GET', `/channels/${channelId}/messages?limit=100${before}`)) as { id: string; author: { id: string } }[];
      for (const m of page) if (m.author.id !== w.__vokko.appStore.getState().me?.id) authors.add(m.author.id);
      before = `&before=${page[page.length - 1]!.id}`;
    }
    for (const id of [...authors].filter((_, i) => i % 4 !== 3)) await w.__vokko.request('PUT', `/users/@me/relationships/${id}`, { type: 2 });
  });
  await expect(list.locator('.chat-blocked').first()).toBeVisible();
  const scroller = page.locator('.chat-scroller');
  // Load the next older page while the list is scrolled somewhere in the middle: the first row on screen must stay where it is.
  await scroller.evaluate(el => { el.style.overflowAnchor = 'none'; el.scrollTop = 900; }); // Chrome's own scroll anchoring would hide a wrong index
  await page.waitForTimeout(400);
  const anchor = await scroller.evaluate(el => {
    const box = el.getBoundingClientRect();
    const row = [...el.querySelectorAll<HTMLElement>('.chat-msg[data-message-id]')].find(r => r.getBoundingClientRect().top >= box.top)!;
    return { id: row.dataset.messageId!, top: row.getBoundingClientRect().top - box.top };
  });
  const topOf = (id: string) => scroller.evaluate((el, id) => {
    const row = el.querySelector<HTMLElement>(`.chat-msg[data-message-id="${id}"]`);
    return row ? row.getBoundingClientRect().top - el.getBoundingClientRect().top : null;
  }, id);
  const loaded = await page.evaluate(async () => {
    const store = (window as unknown as { __vokko: { messageStore: { loadOlder(id: string): Promise<void>; getState(id: string): { messages: unknown[] } } } }).__vokko.messageStore;
    const id = location.pathname.split('/').pop()!;
    const before = store.getState(id).messages.length;
    await store.loadOlder(id);
    const msgs = store.getState(id).messages as { author: { id: string } }[];
    const rel = (window as unknown as { __vokko: { appStore: { getState(): { relationships: Record<string, unknown> } } } }).__vokko.appStore.getState().relationships;
    return [msgs.length - before, msgs.slice(0, msgs.length - before).filter(m => rel[m.author.id]).length];
  });
  expect(loaded[0]).toBeGreaterThan(0);
  expect(loaded[1]).toBeGreaterThan(5); // the page really holds blocked authors
  await page.waitForTimeout(800);
  const after = await topOf(anchor.id);
  expect(after).not.toBeNull();
  expect(Math.abs(after! - anchor.top)).toBeLessThan(4);
});
