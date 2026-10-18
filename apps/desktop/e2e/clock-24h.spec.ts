import { expect, test } from '@playwright/test';
import { openStockTalk } from './helpers';

// Settings > Language & Time "24-hour" reaches the clocks outside chat too (event times here; Inbox reminders, voice ping, banners use the same helper).

const SHOTS = process.env.VOKKO_SHOTS_DIR;

type Win = { __vokko: { request(method: string, path: string, body?: unknown): Promise<unknown> } };

test('event times follow the 24-hour clock setting', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('vokko.prefs', JSON.stringify({ timeFormat: '24', locale: 'en-US' })));
  await openStockTalk(page);
  const guildId = new URL(page.url()).pathname.split('/')[2]!;
  // 18:00 and 20:00 tomorrow, so the card cannot say "Today".
  const at = (hour: number) => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(hour, 0, 0, 0); return d.toISOString(); };
  await page.evaluate(
    ([id, from, to]) => (window as unknown as Win).__vokko.request('POST', `/guilds/${id}/scheduled-events`, { name: 'Standup', entity_type: 3, entity_metadata: { location: 'Room 4' }, scheduled_start_time: from, scheduled_end_time: to }),
    [guildId, at(18), at(20)] as const,
  );
  await page.locator('button.cm-quicklink').click();
  const list = page.getByRole('dialog', { name: 'Events' });
  await expect(list).toContainText('Tomorrow at 18:00 – 20:00');
  await expect(list).not.toContainText(/[AP]M/);
  if (SHOTS) {
    await page.waitForTimeout(400); // the dialog fades in
    await page.screenshot({ path: `${SHOTS}/events-24h-1440x900.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${SHOTS}/events-24h-390x844.png` });
  }
});
