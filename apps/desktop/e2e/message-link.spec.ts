import { expect, test } from '@playwright/test';
import { channelIdOf, composer, openDm } from './helpers';

// /channels/:guildId/:channelId/:messageId (what Copy Message Link makes) opens the channel at that message and flashes it.

const SHOTS = process.env.VOKKO_SHOTS_DIR;

type Win = { __vokkoMock: { say(c: string, u: string, t: string): string } };

test('a message link opens the channel at that message and leaves the channel URL behind', async ({ page }) => {
  await openDm(page);
  const channelId = channelIdOf(page);
  // Far enough back that the latest page of messages does not hold it.
  const target = await page.evaluate(([c]) => {
    const w = window as unknown as Win;
    const first = w.__vokkoMock.say(c!, 'alice', 'needle in the past');
    for (let i = 0; i < 120; i += 1) w.__vokkoMock.say(c!, 'alice', `filler ${i}`);
    return first;
  }, [channelId]);

  // The mock backend lives in the page, so follow the link in-app the way the deep-link handler does instead of reloading.
  await page.evaluate(([c, m]) => {
    window.history.pushState({}, '', `/channels/@me/${c}/${m}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, [channelId, target]);

  const flashed = page.locator('.chat-msg.flash', { hasText: 'needle in the past' });
  await expect(flashed).toBeVisible();
  if (SHOTS) {
    await page.screenshot({ path: `${SHOTS}/message-link-1440x900.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${SHOTS}/message-link-390x844.png` });
  }
  await expect(composer(page)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/channels/@me/${channelId}$`));
});
