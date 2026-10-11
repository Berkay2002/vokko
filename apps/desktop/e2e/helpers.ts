import type { Page } from '@playwright/test';

/** Opens the DM with Alice. Before milestone A this goes through the chat playground; afterwards through the shell's DM list. */
export async function openDm(page: Page, name = 'Alice'): Promise<void> {
  await page.goto('/?playground');
  await page.getByRole('button', { name }).first().click();
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
