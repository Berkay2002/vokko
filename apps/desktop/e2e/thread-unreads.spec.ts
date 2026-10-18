import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { openChannel, panel } from './threadHelpers';

// A mention in a thread the viewer joined ("gateway docs" under #general) shows in the server pill, the Inbox Unreads and Mentions,
// says "gateway docs, in #general", and a click opens the thread beside #general (not a thread id as a route).
// Review screenshots are written only when VOKKO_SHOTS names a directory.
const SHOTS = process.env.VOKKO_SHOTS ?? '';
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

type Win = {
  __vokkoMock: { say(channelId: string, username: string, content: string): string };
  __vokko: { appStore: { getState(): { me: { id: string } | null; threads: Record<string, { id: string; name?: string }> } } };
};

/** Nova @mentions sam in "gateway docs" while sam looks at another channel. */
async function mentionInThread(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Win;
    const s = w.__vokko.appStore.getState();
    const thread = Object.values(s.threads).find(t => t.name === 'gateway docs')!;
    w.__vokkoMock.say(thread.id, 'nova', `hey <@${s.me!.id}> look at this`);
  });
}

test('desktop: a thread mention lights the server pill and the Inbox, and a click opens the thread', async ({ page }) => {
  await openChannel(page, 'random');
  const rail = page.getByRole('link', { name: /^Sam's server/ });
  // Opening #random reads its seeded mentions; the thread's is the only one left.
  await expect(rail).toHaveAttribute('aria-label', "Sam's server");
  await mentionInThread(page);
  await expect(rail).toHaveAttribute('aria-label', "Sam's server, 1 mention");
  await expect(page.locator('.thread-row-link', { hasText: 'gateway docs' }).locator('.count-badge')).toHaveText('1');
  await shot(page, 'desktop-sidebar');

  await page.getByRole('button', { name: 'Inbox' }).click();
  const inbox = page.locator('.inbox-popout');
  const card = inbox.getByRole('region', { name: /^gateway docs, Sam's server › in #general/ });
  await expect(card).toContainText('hey @Sam look at this');
  await shot(page, 'desktop-inbox-unreads');

  await inbox.getByRole('tab', { name: 'Mentions' }).click();
  const row = inbox.getByTestId('mention').filter({ hasText: 'look at this' });
  await expect(inbox.locator('.media-mention-where', { hasText: 'gateway docs, in #general' })).toBeVisible();
  await shot(page, 'desktop-inbox-mentions');
  await row.getByRole('button', { name: /^Jump to message by/ }).click();

  await expect(panel(page).locator('.thread-panel-header').getByRole('heading', { name: 'gateway docs', level: 2 })).toBeVisible();
  await expect(panel(page).locator('.chat-msg', { hasText: 'look at this' })).toBeVisible();
  await expect(page.locator('.channel-header').getByRole('heading', { name: 'general', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/channels\/\d+\/\d+$/);
  // The thread is read now: the pill's mention is gone again.
  await expect(rail).toHaveAttribute('aria-label', "Sam's server");
});

test('desktop: the Inbox card check marks a joined thread read', async ({ page }) => {
  await openChannel(page, 'random');
  await mentionInThread(page);
  await page.getByRole('button', { name: 'Inbox' }).click();
  const inbox = page.locator('.inbox-popout');
  const card = inbox.getByRole('region', { name: /^gateway docs, / });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Mark gateway docs as read' }).click();
  await expect(card).toHaveCount(0);
});

test('phone: the thread mention shows in the Inbox sheet and opens the thread', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.waitForFunction(() => Object.values((window as unknown as Win).__vokko.appStore.getState().threads).some(t => t.name === 'gateway docs'));
  await mentionInThread(page);
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await shot(page, 'phone-sidebar');
  await page.locator('.user-panel').getByRole('button', { name: 'Inbox' }).click();
  const sheet = page.getByRole('dialog', { name: 'Inbox' });
  const card = sheet.getByRole('region', { name: /^gateway docs, Sam's server › in #general/ });
  await expect(card).toBeVisible();
  await shot(page, 'phone-inbox-unreads');
  await card.getByRole('button', { name: /look at this/ }).click();
  await expect(panel(page).locator('.thread-panel-header').getByRole('heading', { name: 'gateway docs', level: 2 })).toBeVisible();
  await shot(page, 'phone-thread-opened');
});
