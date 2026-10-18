import { test, type Page } from '@playwright/test';

// Screenshots for gap-audit-8 group A: the folded blocked row and the Markdown topic (header and channel start). Only with VOKKO_SHOTS_DIR.
const SHOTS = process.env.VOKKO_SHOTS_DIR;
test.skip(!SHOTS, 'set VOKKO_SHOTS_DIR');

const TOPIC = 'Rules: be **kind**, read the [guide](https://example.com/guide) and `ask` first';

async function setup(page: Page): Promise<void> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: "Sam's server" }).click();
  await page.getByRole('link', { name: /^general/ }).first().click();
  await page.locator('.chat-msg').first().waitFor();
  await page.evaluate(async topic => {
    const w = window as unknown as { __vokko: { request(m: string, p: string, b?: unknown): Promise<unknown> } };
    const channelId = location.pathname.split('/').pop();
    await w.__vokko.request('PATCH', `/channels/${channelId}`, { topic });
  }, TOPIC);
}

for (const [name, size] of [['1440', { width: 1440, height: 900 }], ['390', { width: 390, height: 844 }]] as const) {
  test(`blocked fold and topic at ${name}`, async ({ page }) => {
    await page.setViewportSize(size);
    await setup(page);
    await page.locator('.channel-header-topic-text strong').waitFor({ state: size.width > 800 ? 'visible' : 'attached' });
    await page.screenshot({ path: `${SHOTS}/topic-header-${name}.png` });
    // Block Nova through the API (the member list is not on a phone), then the fold shows in the channel.
    await page.evaluate(async () => {
      const w = window as unknown as { __vokko: { request(m: string, p: string, b?: unknown): Promise<unknown>; appStore: { getState(): { users: Record<string, { id: string; username: string }> } } } };
      const nova = Object.values(w.__vokko.appStore.getState().users).find(u => u.username === 'nova')!;
      await w.__vokko.request('PUT', `/users/@me/relationships/${nova.id}`, { type: 2 });
    });
    await page.locator('.chat-scroller').evaluate(el => { el.scrollTop = 0; });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/channel-start-topic-${name}.png` });
    await page.locator('.chat-scroller').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await page.locator('.chat-blocked').first().waitFor();
    await page.screenshot({ path: `${SHOTS}/blocked-fold-${name}.png` });
    await page.locator('.chat-blocked-toggle').first().click();
    await page.locator('.chat-blocked-bar').first().waitFor();
    await page.screenshot({ path: `${SHOTS}/blocked-fold-open-${name}.png` });
  });
}
