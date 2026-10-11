import type { Page } from '@playwright/test';

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

/** Current channel id from the URL (/channels/@me/<id> or /channels/<guild>/<id>). */
export function channelIdOf(page: Page): string {
  return new URL(page.url()).pathname.split('/').filter(Boolean).pop() ?? '';
}
