import { expect, test, type Page } from '@playwright/test';

// "New Unreads" / "New Mentions" over a long channel list (shell/ChannelJumpBar.tsx): a 60-channel server in a 900px window.

type Win = {
  __vokkoMock: { say(c: string, u: string, t: string): string; requestAs(u: string, m: string, p: string, b?: unknown): unknown };
  __vokko: {
    request(m: string, p: string, b?: unknown): Promise<unknown>;
    appStore: { getState(): { me: { id: string }; guilds: Record<string, { id: string; name: string }>; channels: Record<string, { id: string; name: string | null; last_message_id?: string | null }>; connection: string } };
  };
};

test.use({ viewport: { width: 1440, height: 900 } });

const SHOTS = process.env.VOKKO_SHOTS_DIR;

/** Sam's server gets 60 more text channels; everything starts read. */
async function bigServer(page: Page): Promise<Record<string, string>> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.waitForFunction(() => (window as unknown as Win).__vokko.appStore.getState().connection === 'ready');
  const ids = await page.evaluate(async () => {
    const w = window as unknown as Win;
    const guildId = Object.values(w.__vokko.appStore.getState().guilds).find(g => g.name === "Sam's server")!.id;
    const ids: Record<string, string> = {};
    for (let i = 0; i < 60; i += 1) {
      const name = `bulk-${String(i).padStart(2, '0')}`;
      ids[name] = (w.__vokkoMock.requestAs('sam', 'POST', `/guilds/${guildId}/channels`, { name, type: 0 }) as { id: string }).id;
    }
    for (const c of Object.values(w.__vokko.appStore.getState().channels)) {
      if (c.last_message_id) await w.__vokko.request('POST', `/channels/${c.id}/messages/${c.last_message_id}/ack`);
    }
    return ids;
  });
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await expect(page.getByRole('link', { name: /bulk-59/ })).toBeAttached();
  return ids;
}

const row = (page: Page, name: string) => page.locator('a.channel-row', { hasText: new RegExp(`^${name}`) });

test('a hidden unread or mention shows a pill at that edge; a click scrolls it in', async ({ page }) => {
  const ids = await bigServer(page);
  const scroller = page.locator('.channel-scroller');
  await scroller.evaluate(el => { el.scrollTop = 0; });
  await expect(page.locator('.channel-jump-pill')).toHaveCount(0);

  // A mention below the fold: "New Mentions" at the bottom edge.
  const meId = await page.evaluate(() => (window as unknown as Win).__vokko.appStore.getState().me.id);
  await page.evaluate(([c, me]) => (window as unknown as Win).__vokkoMock.say(c, 'alice', `<@${me}> down here`), [ids['bulk-58'], meId]);
  const bottom = page.locator('.channel-jump.bottom').getByRole('button', { name: 'New Mentions' });
  await expect(bottom).toBeVisible();
  await expect(row(page, 'bulk-58')).not.toBeInViewport();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/jump-bar-1440x900.png` });
  await bottom.click();
  await expect(row(page, 'bulk-58')).toBeInViewport();
  await expect(bottom).toHaveCount(0);
  await row(page, 'bulk-58').click(); // read it
  await expect(row(page, 'bulk-58').locator('.count-badge')).toHaveCount(0);

  // Scrolled to the end, an unread near the top: "New Unreads" at the top edge.
  await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.evaluate(c => (window as unknown as Win).__vokkoMock.say(c, 'alice', 'up here'), ids['bulk-01']);
  const top = page.locator('.channel-jump.top').getByRole('button', { name: 'New Unreads' });
  await expect(top).toBeVisible();
  await top.click();
  await expect(row(page, 'bulk-01')).toBeInViewport();
  await expect(top).toHaveCount(0);
});
