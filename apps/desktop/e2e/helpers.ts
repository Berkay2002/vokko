import type { Locator, Page } from '@playwright/test';

/** Picks `option` in one of the app's custom dropdowns (ui/Dropdown.tsx): opens the combobox, then clicks the option.
 * The listbox is portalled out of the trigger's parent, so the option is looked up on the page, not inside the dialog. */
export async function pickOption(page: Page, combobox: Locator, option: string): Promise<void> {
  await combobox.click();
  const name = (await combobox.getAttribute('aria-label')) ?? undefined;
  await page.getByRole('listbox', { name, exact: true }).getByRole('option', { name: option, exact: true }).click();
}

/** Signs in to the mock backend as sam and opens the DM with `name`. */
export async function openDm(page: Page, name = 'alice'): Promise<void> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: new RegExp(`^${name}`, 'i') }).first().click();
  await page.locator('.chat-textarea').waitFor();
  await page.locator('.chat-msg').first().waitFor();
}

export function composer(page: Page) {
  return page.locator('.chat-textarea');
}

export async function send(page: Page, text: string): Promise<void> {
  const box = composer(page);
  await box.click();
  await box.fill(text);
  await box.press('Enter');
}

export function message(page: Page, text: string | RegExp) {
  return page.locator('.chat-msg', { hasText: text }).last();
}

/** Origin the app is served from (the invite parser only recognises the app's own host). */
export function appOrigin(page: Page): string {
  return new URL(page.url()).origin;
}

/** Current channel id from the URL (/channels/@me/<id> or /channels/<guild>/<id>). */
export function channelIdOf(page: Page): string {
  return new URL(page.url()).pathname.split('/').filter(Boolean).pop() ?? '';
}

type StoreWin = { __vokko: { appStore: { getState(): { channels: Record<string, { id: string; name?: string; guild_id: string | null }> } } } };

/** Signs in as sam and opens #stock-talk (the message-area showcase channel of the mock seed). `query` is appended to the first URL. */
export async function openStockTalk(page: Page, query = ''): Promise<string> {
  await page.goto(`/channels/@me?as=sam&mockLatency=0${query}`);
  await page.waitForFunction(() => Object.values((window as unknown as StoreWin).__vokko.appStore.getState().channels).some(c => c.name === 'stock-talk'));
  const target = await page.evaluate(() => {
    const c = Object.values((window as unknown as StoreWin).__vokko.appStore.getState().channels).find(x => x.name === 'stock-talk')!;
    return `/channels/${c.guild_id}/${c.id}`;
  });
  // A reload would re-seed the mock and drop the session: navigate in-app.
  await page.evaluate(path => { history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, target);
  await page.locator('.chat-textarea').waitFor();
  await page.locator('.chat-msg').first().waitFor();
  await page.waitForTimeout(400);
  return target.split('/').pop()!;
}
