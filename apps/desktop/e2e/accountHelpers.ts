import type { Page } from '@playwright/test';

// Helpers for the account specs (mock backend, src/api/mock/accounts.ts).

export type Mail = { to: string; subject: string; body: string };
export type AccountHooks = { __vokkoMockAccounts: { outbox(): Mail[]; instance(patch: Record<string, unknown>): void } };

/** Client-side navigation: a reload would re-seed the mock and drop the session. */
export async function goInApp(page: Page, path: string): Promise<void> {
  await page.evaluate(target => { history.pushState({}, '', target); window.dispatchEvent(new PopStateEvent('popstate')); }, path);
}

export async function lastMail(page: Page, to: string): Promise<Mail> {
  return page.evaluate(address => (window as unknown as AccountHooks).__vokkoMockAccounts.outbox().filter(m => m.to === address).pop()!, to);
}

/** Waits until the mock's account hooks are installed (the app bundle has loaded). */
export async function mockReady(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as unknown as Partial<AccountHooks>).__vokkoMockAccounts);
}

/** RFC 6238 code of a base32 secret, `offset` 30 s steps from now (computed in the test runner). */
export async function totpCode(secret: string, offset = 0): Promise<string> {
  const { createHmac } = await import('node:crypto');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/\s/g, '')) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map(b => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offset));
  const digest = createHmac('sha1', key).update(counter).digest();
  const at = digest[19]! & 15;
  return String((digest.readUInt32BE(at) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
