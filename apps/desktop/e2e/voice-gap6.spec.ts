import { expect, test, type Page } from '@playwright/test';

// gap-audit-6 group A (mock backend): in-call bar on a phone (2), muted hint (8), mic error on the call page (10), wake lock and
// lock-screen controls (12), chat unread cue (13), Deafen on the phone bar (14). VOKKO_SHOTS=<dir> also saves screenshots.
// Run: VOKKO_E2E_PORT=1478 VOICE_ALL=1 npx playwright test -c e2e/voice-ui.config.ts voice-gap6

const SHOTS = process.env.VOKKO_SHOTS ?? '';
const shot = async (page: Page, name: string): Promise<void> => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

/** Recorded in the page: wake lock requests and the Media Session handlers that are set. */
async function stubSession(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __wl: string[]; __ms: Record<string, boolean> };
    w.__wl = [];
    w.__ms = {};
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: (t: string) => (w.__wl.push(t), Promise.resolve({ release: () => (w.__wl.push('release'), Promise.resolve()) })) } });
    const session = navigator.mediaSession;
    if (session) session.setActionHandler = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => void (w.__ms[action] = !!handler);
  });
}

const go = (page: Page, path: string) =>
  page.evaluate(p => {
    history.pushState({}, '', p);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);

async function ids(page: Page): Promise<{ vc: string; text: string; gid: string }> {
  return page.evaluate(() => {
    const w = window as unknown as { __vokkoMock: { channelIdByName(n: string): string }; __vokko: { appStore: { getState(): { channels: Record<string, { guild_id: string }> } } } };
    const vc = w.__vokkoMock.channelIdByName('General');
    return { vc, text: w.__vokkoMock.channelIdByName('general'), gid: w.__vokko.appStore.getState().channels[vc]!.guild_id };
  });
}

async function joinCall(page: Page): Promise<{ vc: string; text: string; gid: string }> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await expect(page.getByRole('link', { name: /^Sam's server/ })).toBeVisible(); // the mock backend and the seed are loaded
  const found = await ids(page);
  if (page.viewportSize()!.width < 500) {
    // the phone's channel list is a page of its own: pick the channel in it, then Join on the preview
    await page.getByRole('link', { name: /^Sam's server/ }).tap();
    await page.locator('.sidebar-scroller').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await page.getByRole('button', { name: 'General voice channel' }).tap();
    await page.getByRole('button', { name: /join voice/i }).first().tap();
  } else {
    await go(page, `/channels/${found.gid}/${found.vc}`);
    await page.getByRole('button', { name: /join voice/i }).first().click();
  }
  await expect(page.getByRole('region', { name: /call$/ }).getByRole('button', { name: 'Leave voice channel' })).toBeVisible();
  return found;
}

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

  test('call page: Deafen in the bar, wake lock and lock-screen controls', async ({ page }) => {
    await stubSession(page);
    await joinCall(page);
    const bar = page.locator('.voice-bar');
    await bar.getByRole('button', { name: 'Deafen' }).tap();
    await expect(bar.getByRole('button', { name: 'Undeafen' })).toHaveAttribute('aria-pressed', 'true');
    await bar.getByRole('button', { name: 'Undeafen' }).tap();
    // every control stays inside the viewport
    for (const box of await bar.getByRole('button').evaluateAll(els => els.filter(e => e.getBoundingClientRect().width > 0).map(e => e.getBoundingClientRect().toJSON()))) {
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(390);
    }
    await shot(page, 'phone-call-bar-deafen-390');
    expect(await page.evaluate(() => (window as unknown as { __wl: string[] }).__wl)).toContain('screen');
    const handlers = await page.evaluate(() => (window as unknown as { __ms: Record<string, boolean> }).__ms);
    expect(handlers['hangup'] ?? handlers['togglemicrophone']).toBe(true);
    await bar.getByRole('button', { name: 'Leave voice channel' }).tap();
    expect(await page.evaluate(() => (window as unknown as { __wl: string[] }).__wl)).toContain('release');
    expect(await page.evaluate(() => (window as unknown as { __ms: Record<string, boolean> }).__ms['hangup'])).not.toBe(true);
  });

  test('in-call bar outside the call page: mute, deafen, back to the call, leave', async ({ page }) => {
    const { text, gid, vc } = await joinCall(page);
    const callBar = page.getByRole('region', { name: 'Current call' });
    await expect(callBar).toHaveCount(0); // the call page is on screen
    await go(page, `/channels/${gid}/${text}`);
    await expect(callBar).toBeVisible();
    await shot(page, 'phone-in-call-bar-390');
    await callBar.getByRole('button', { name: 'Mute microphone' }).tap();
    await expect(callBar.getByRole('button', { name: 'Unmute microphone' })).toHaveAttribute('aria-pressed', 'true');
    await callBar.getByRole('button', { name: 'Deafen' }).tap();
    await expect(callBar.getByRole('button', { name: 'Undeafen' })).toBeVisible();
    await callBar.getByRole('button', { name: /^Return to General call/ }).tap();
    await expect(page).toHaveURL(new RegExp(`/channels/${gid}/${vc}$`));
    await expect(callBar).toHaveCount(0);
    await go(page, `/channels/${gid}/${text}`);
    await callBar.getByRole('button', { name: 'Disconnect' }).tap();
    await expect(callBar).toHaveCount(0);
  });

  test('voice channel chat: unread cue on the header button, phone', async ({ page }) => {
    const { vc } = await joinCall(page);
    await page.evaluate(id => (window as unknown as { __vokkoMock: { voice(u: string, c: string): void; say(c: string, u: string, t: string): void } }).__vokkoMock.say(id, 'nova', 'hello there'), vc);
    await expect(page.locator('.channel-header .voice-chat-badge.dot')).toBeVisible();
    await shot(page, 'phone-voice-chat-unread-390');
  });
});

test('desktop: no in-call bar, no Deafen in the bar', async ({ page }) => {
  const { text, gid } = await joinCall(page);
  await expect(page.locator('.voice-bar').getByRole('button', { name: 'Deafen' })).toHaveCount(0);
  await go(page, `/channels/${gid}/${text}`);
  await expect(page.getByRole('region', { name: 'Current call' })).toHaveCount(0);
});

test('talking while muted raises "You are muted" on the call page and the user panel, rate limited', async ({ page }) => {
  await joinCall(page);
  const raise = () =>
    page.evaluate(async () => {
      const { useVoiceUi } = await import('/src/voice/uiStore.ts');
      return useVoiceUi.getState().flagMutedSpeech();
    });
  expect(await raise()).toBe(false); // not muted: nothing to say
  await page.getByRole('region', { name: /call$/ }).getByRole('button', { name: 'Mute microphone' }).click();
  expect(await raise()).toBe(true);
  await expect(page.getByRole('region', { name: /call$/ }).getByText('You are muted')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Voice connection' }).getByText('You are muted')).toBeVisible();
  await shot(page, 'muted-hint-1440');
  expect(await raise()).toBe(false); // within the cooldown
  await page.getByRole('region', { name: /call$/ }).getByRole('button', { name: 'Unmute', exact: true }).click();
  await expect(page.getByText('You are muted')).toHaveCount(0);
});

test('mic denied shows on the call page, survives the panel timeout and Try again unmutes', async ({ page }) => {
  const { vc } = await joinCall(page);
  await page.evaluate(async id => {
    const { voiceStore } = await import('/src/voice/store.ts');
    voiceStore.getState().dispatch({ type: 'setSelfMute', mute: true });
    voiceStore.getState().dispatch({ type: 'error', error: { reason: 'permission_denied', channelId: id } });
  }, vc);
  const banner = page.getByRole('region', { name: /call$/ }).getByRole('alert').filter({ hasText: 'Microphone access was denied' });
  await expect(banner).toBeVisible();
  await shot(page, 'mic-denied-call-page-1440');
  await page.waitForTimeout(9000); // the sidebar panel used to clear every error after 8 s
  await expect(banner).toBeVisible();
  await banner.getByRole('button', { name: 'Try again' }).click();
  await expect(banner).toHaveCount(0);
  await expect(page.getByRole('region', { name: /call$/ }).getByRole('button', { name: 'Mute microphone' })).toBeVisible();
});

test('voice channel chat: unread dot, then a red mention count, on the header button; gone when the chat opens', async ({ page }) => {
  const { vc } = await joinCall(page);
  const button = page.getByRole('button', { name: 'Show Chat' });
  await expect(button.locator('.voice-chat-badge')).toHaveCount(0);
  await page.evaluate(id => (window as unknown as { __vokkoMock: { say(c: string, u: string, t: string): void } }).__vokkoMock.say(id, 'nova', 'anyone around?'), vc);
  await expect(button.locator('.voice-chat-badge.dot')).toBeVisible();
  await page.evaluate(id => {
    const w = window as unknown as { __vokkoMock: { say(c: string, u: string, t: string): void }; __vokko: { appStore: { getState(): { me: { id: string } } } } };
    w.__vokkoMock.say(id, 'nova', `hey <@${w.__vokko.appStore.getState().me.id}> can you hear me?`);
  }, vc);
  await expect(button.locator('.voice-chat-badge.count-badge')).toHaveText('1');
  await shot(page, 'voice-chat-mention-1440');
  await button.click();
  await expect(page.getByRole('button', { name: 'Hide Chat' }).locator('.voice-chat-badge')).toHaveCount(0);
});
