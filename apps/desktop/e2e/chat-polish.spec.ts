import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { composer, send } from './helpers';

// Composer autocomplete, code/list markdown and the emoji picker's Favorites/Frequently Used, against the in-memory mock as sam
// (owner of "Sam's server": announcements, the support forum and the Gaming voice channel are seeded there).
// SHOTS=dir saves screenshots of each state.

type StoreWin = { __vokko: { appStore: { getState(): { channels: Record<string, { id: string; name?: string; guild_id: string | null }> } } } };
const SHOTS = process.env.SHOTS;

async function openChannel(page: Page, name: string, theme?: string): Promise<void> {
  if (theme) await page.addInitScript(t => localStorage.setItem('vokko.prefs', JSON.stringify({ theme: t })), theme);
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.waitForFunction(n => Object.values((window as unknown as StoreWin).__vokko.appStore.getState().channels).some(c => c.name === n && c.guild_id), name);
  const target = await page.evaluate(n => {
    const c = Object.values((window as unknown as StoreWin).__vokko.appStore.getState().channels).find(x => x.name === n && x.guild_id)!;
    return `/channels/${c.guild_id}/${c.id}`;
  }, name);
  await page.evaluate(path => { history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, target);
  if (page.viewportSize()!.width < 600) await page.locator('a.channel-row[aria-current="page"]').first().click(); // phone: the list page first
  await page.locator('.chat-textarea').waitFor();
}

const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}-${page.viewportSize()!.width}.png` }); };
const rows = (page: Page) => page.locator('.chat-autocomplete-item');

test('# lists announcement, forum and voice channels; @ keeps @everyone and @here', async ({ page }) => {
  await openChannel(page, 'general');
  const box = composer(page);
  await box.click();
  for (const [q, name] of [['#ann', 'announcements'], ['#sup', 'support'], ['#Gam', 'Gaming']]) {
    await box.fill(q);
    await expect(rows(page).first()).toContainText(name);
    if (q === '#ann') await shot(page, 'ac-channels');
  }
  await box.fill('@');
  await expect(rows(page).filter({ hasText: '@everyone' })).toHaveCount(1);
  await expect(rows(page).filter({ hasText: '@here' })).toHaveCount(1);
  await shot(page, 'ac-at');
  // # inserts a channel mention that renders as a pill
  await box.fill('#Gam');
  await box.press('Tab');
  await box.press('Enter');
  await expect(page.locator('.chat-msg').last().locator('.md-mention', { hasText: 'Gaming' })).toBeVisible();
});

test('search in: lists the same channels', async ({ page }) => {
  await openChannel(page, 'general');
  const search = page.getByRole('combobox', { name: /search/i }).first();
  await search.click();
  await search.pressSequentially('in:sup');
  await expect(page.locator('.search-opt, [role="option"]').filter({ hasText: 'support' }).first()).toBeVisible();
});

for (const theme of ['onyx', 'dark', 'ash', 'light']) {
  test(`code is visible and lists nest in ${theme}`, async ({ page }) => {
    await openChannel(page, 'random', theme);
    await send(page, '- item a\n  - nested b\n    - deeper c\nsome `inline code` here\n```rust\nfn main() {}\n```');
    const msg = page.locator('.chat-msg').last();
    await expect(msg.locator('ul ul ul li', { hasText: 'deeper c' })).toBeVisible();
    // the block and the span both differ from the chat background (Onyx painted them #000 on #000)
    const colours = await msg.evaluate(el => {
      const bg = (e: Element | null) => (e ? getComputedStyle(e).backgroundColor : '');
      const block = el.querySelector('.md-codeblock');
      return { chat: bg(document.querySelector('.chat-view')), block: bg(block), span: bg(el.querySelector('.md-code')), border: block ? getComputedStyle(block).borderTopColor : '' };
    });
    expect(colours.block).not.toBe(colours.chat);
    expect(colours.span).not.toBe(colours.chat);
    expect(colours.block).not.toBe('rgba(0, 0, 0, 0)');
    expect(colours.border).not.toBe(colours.block);
    await shot(page, `md-${theme}`);
  });
}

test('Frequently Used counts sent emoji and quick reactions; right-click Favorite adds a Favorites row on top', async ({ page }) => {
  await openChannel(page, 'random');
  await send(page, 'party ❤️ 🎉');
  await expect(page.locator('.chat-msg').last()).toContainText('party');
  const last = page.locator('.chat-msg').last();
  await last.hover();
  await last.getByRole('button', { name: /^React with/ }).first().click();

  await page.locator('.chat-composer').getByRole('button', { name: /emoji/i }).last().click();
  const picker = page.getByRole('dialog', { name: 'Emoji picker' }).or(page.getByRole('tabpanel', { name: 'Emoji picker' }));
  const recent = picker.locator('[data-cat="recent"] .chat-emoji-cell');
  await expect(recent.filter({ hasText: '❤️' })).toHaveCount(1);
  await expect(recent.filter({ hasText: '🎉' })).toHaveCount(1);

  // from the search results: a right-click that first scrolls the grid would close the menu again (menus close on scroll)
  await picker.getByRole('textbox', { name: 'Search emoji' }).fill('fire');
  await picker.getByRole('button', { name: 'fire', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Favorite' }).click();
  await picker.getByRole('button', { name: 'Clear search' }).click();
  await expect(picker.locator('[data-cat="favorites"] .chat-emoji-cell')).toHaveText(['🔥']);
  const sections = await picker.locator('section[data-cat]').evaluateAll(s => s.slice(0, 2).map(x => (x as HTMLElement).dataset.cat));
  expect(sections).toEqual(['favorites', 'recent']);
  await shot(page, 'emoji-favorites');

  await picker.locator('[data-cat="favorites"] .chat-emoji-cell').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Unfavorite' }).click();
  await expect(picker.locator('[data-cat="favorites"]')).toHaveCount(0);
});

test('Frequently Used ranks by use count, includes custom emoji, and leads the : autocomplete; custom emoji can be favourites', async ({ page }) => {
  await openChannel(page, 'random');
  const box = composer(page);
  for (let i = 0; i < 3; i++) await send(page, `turtle ${i} 🐢`);
  await box.fill(':ship_it');
  await expect(rows(page).first()).toContainText(':ship_it:');
  await box.press('Tab');
  await box.press('Enter');
  await expect(page.locator('.chat-msg').last().locator('img[alt=":ship_it:"]')).toBeVisible();
  await send(page, 'cat 😺');

  // used twice as much as anything else: first, though sent earlier
  await page.locator('.chat-composer').getByRole('button', { name: /emoji/i }).last().click();
  const picker = page.getByRole('dialog', { name: 'Emoji picker' }).or(page.getByRole('tabpanel', { name: 'Emoji picker' }));
  const recent = picker.locator('[data-cat="recent"] .chat-emoji-cell');
  await expect(recent.first()).toHaveText('🐢');
  const custom = picker.locator('[data-cat="recent"] .emoji-custom-cell[data-emoji-name="ship_it"]');
  await expect(custom).toHaveCount(1);
  await custom.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Copy emoji' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Favorite emoji' }).click();
  await expect(picker.locator('[data-cat="favorites"] .emoji-custom-cell[data-emoji-name="ship_it"]')).toHaveCount(1);
  await shot(page, 'emoji-frecency');
  await page.keyboard.press('Escape');

  // a used emoji leads its match rank in the : autocomplete
  await box.fill(':smi');
  await expect(rows(page).first()).toContainText(':smiley_cat:');
});

test.describe('phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('code, nested lists and # autocomplete fit', async ({ page }) => {
    await openChannel(page, 'random');
    await send(page, '- item a\n  - nested b\n    - deeper c\nsome `inline code` here\n```rust\nfn main() {}\n```');
    await expect(page.locator('.chat-msg').last().locator('ul ul ul li', { hasText: 'deeper c' })).toBeVisible();
    await shot(page, 'md-onyx');
    await composer(page).fill('#ann');
    await expect(rows(page).first()).toContainText('announcements');
    await shot(page, 'ac-channels');
  });
});
