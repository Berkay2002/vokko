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

/** Blocks three of four authors of the newest 500 messages of the open channel: the window is then full of folded runs. */
async function blockThreeOfFour(page: Page): Promise<void> {
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
}

/** Waits until the open channel loads nothing and its list has not moved (scroll, height, rendered rows) for 10 frames in a row. */
async function settled(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => {
    const w = window as unknown as { __vokko: { messageStore: { getState(id: string): { loadingOlder: boolean; loadingNewer: boolean } } } };
    const channelId = location.pathname.split('/').pop()!;
    let last = '';
    let same = 0;
    const tick = () => {
      const el = document.querySelector('.chat-scroller')!;
      const { loadingOlder, loadingNewer } = w.__vokko.messageStore.getState(channelId);
      const rows = [...el.querySelectorAll('[data-index]')].map(r => `${r.getAttribute('data-index')}@${Math.round(r.getBoundingClientRect().top)}`).join();
      const now = `${loadingOlder || loadingNewer}:${el.scrollTop}:${el.scrollHeight}:${rows}`;
      same = now === last && !loadingOlder && !loadingNewer ? same + 1 : 0;
      last = now;
      if (same >= 10) resolve();
      else requestAnimationFrame(tick);
    };
    tick();
  }));
}

test('an older page that holds folded runs does not move the list (firstItemIndex follows the rows, not the messages)', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0&seed=big');
  await page.getByRole('link', { name: 'Big Server' }).click();
  await page.getByRole('link', { name: /^firehose/ }).first().click();
  const list = page.locator('.chat-list');
  await expect(list.locator('.chat-msg').first()).toBeVisible();
  await blockThreeOfFour(page);
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

test('Show and Hide on a run of three or more keep the fold row where it is', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0&seed=big');
  await page.getByRole('link', { name: 'Big Server' }).click();
  await page.getByRole('link', { name: /^firehose/ }).first().click();
  const list = page.locator('.chat-list');
  await expect(list.locator('.chat-msg').first()).toBeVisible();
  await blockThreeOfFour(page);
  const scroller = page.locator('.chat-scroller');
  await scroller.evaluate(el => { el.style.overflowAnchor = 'none'; });
  await page.mouse.move(700, 450);
  // Wheel gestures up (the list stops following the bottom) until a run of three or more is on screen.
  const bigId = () => page.evaluate(() => {
    const el = [...document.querySelectorAll<HTMLElement>('.chat-blocked')].find(e => {
      const r = e.getBoundingClientRect();
      return /^([3-9]|\d\d+) blocked messages/.test(e.textContent ?? '') && r.top > 120 && r.bottom < innerHeight - 60;
    });
    return el?.dataset.messageId ?? null;
  });
  // Past the list's atBottomThreshold (160): a gesture that ends closer is undone by the list snapping back to the bottom.
  const scrolledUp = () => scroller.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight > 160);
  await settled(page);
  for (let i = 0; i < 30 && !((await scrolledUp()) && (await bigId())); i++) {
    await page.mouse.wheel(0, -250);
    await settled(page);
  }
  expect(await scrolledUp()).toBe(true);
  const id = (await bigId())!;
  expect(id).not.toBeNull();
  const big = list.locator(`.chat-blocked[data-message-id="${id}"]`);
  // The list row that holds the run's first message: the fold row, then the bar above the first message, then the fold row again.
  const rowTop = () => page.evaluate(id => document.querySelector(`.chat-row [data-message-id="${id}"]`)?.closest('.chat-row')?.getBoundingClientRect().top ?? null, id);
  const closedTop = (await rowTop())!;
  expect(closedTop).not.toBeNull();
  await big.getByRole('button', { name: /^Show/ }).evaluate(el => (el as HTMLElement).click()); // no scrolling into view, which would move the row
  await expect(big).toHaveCount(0);
  await expect(list.locator('.chat-blocked-bar').first()).toBeVisible();
  await settled(page);
  expect(Math.abs((await rowTop())! - closedTop)).toBeLessThan(4);
  await list.locator('.chat-blocked-bar').first().getByRole('button', { name: 'Hide' }).evaluate(el => (el as HTMLElement).click());
  await expect(big).toBeVisible();
  await settled(page);
  expect(Math.abs((await rowTop())! - closedTop)).toBeLessThan(4);
});
