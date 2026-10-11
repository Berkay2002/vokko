import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { composer, message, openDm, send } from './helpers';

// The shell's Appearance settings (localStorage `vokko.prefs`) that src/chat honours: compact display, text size, group gap, toggles.
async function withPrefs(page: Page, prefs: Record<string, unknown>): Promise<void> {
  await page.addInitScript(p => { try { localStorage.setItem('vokko.prefs', JSON.stringify(p)); } catch { /* ignore */ } }, prefs);
}

test('compact display puts the time in the gutter and the name inline with the text', async ({ page }) => {
  await withPrefs(page, { messageDisplay: 'compact', showCompactAvatars: false });
  await openDm(page);
  await expect(page.locator('html')).toHaveClass(/message-compact/);
  // a short own message: a wrapped inline box would make the content's bounding box start at the left padding
  await send(page, 'compact probe');
  const row = message(page, 'compact probe');
  await expect(row).toBeVisible();
  await expect(row).toHaveClass(/compact/);
  await expect(row).not.toHaveClass(/pending/);
  await expect(row.locator('.chat-avatar')).toHaveCount(0);
  const time = await row.locator('.chat-timestamp.compact').boundingBox();
  const author = await row.locator('.chat-author').boundingBox();
  const content = await row.locator('.chat-content').first().boundingBox();
  expect(time && author && content).toBeTruthy();
  expect(author!.x).toBeGreaterThan(time!.x + 20);
  // same line: the text starts to the right of the name, at the name's height
  expect(content!.x).toBeGreaterThanOrEqual(author!.x + author!.width - 1);
  expect(Math.abs(content!.y - author!.y)).toBeLessThan(8);
  // every message in compact mode names its author, grouped or not
  const rows = await page.locator('.chat-msg.compact').count();
  await expect(page.locator('.chat-msg.compact .chat-author')).toHaveCount(rows);
});

test('compact display can show small avatars', async ({ page }) => {
  await withPrefs(page, { messageDisplay: 'compact', showCompactAvatars: true });
  await openDm(page);
  await expect(page.locator('.chat-msg.compact .chat-compact-avatar').first()).toBeVisible();
});

test('text size, group gap, embeds and reactions follow the settings', async ({ page }) => {
  await withPrefs(page, { fontSize: 20, messageGroupGap: 4, showReactions: false, roleColors: 'dot' });
  await openDm(page);
  await expect(page.locator('.chat-content').first()).toHaveCSS('font-size', '20px');
  // the group gap drives the margin of the first row of a group (gap + 1px); probe with a detached row, real ones may follow a divider
  const margin = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.className = 'chat-msg';
    document.querySelector('.chat-view')!.appendChild(probe);
    const value = getComputedStyle(probe).marginTop;
    probe.remove();
    return value;
  });
  expect(margin).toBe('5px');
  // react: the pill is not rendered while "show reactions" is off
  await send(page, 'reaction toggle');
  const mine = message(page, 'reaction toggle');
  await expect(mine).not.toHaveClass(/pending/);
  await mine.hover();
  await mine.getByRole('button', { name: 'React with 👍' }).click();
  await expect(mine.locator('.chat-reactions')).toHaveCount(0);
  await expect(composer(page)).toBeVisible();
});

for (const shot of [
  { name: '25-compact', prefs: { messageDisplay: 'compact', showCompactAvatars: true } },
  { name: '26-font-20', prefs: { fontSize: 20, messageGroupGap: 8 } },
]) {
  test(`screenshot ${shot.name}`, async ({ page }) => {
    const dir = process.env.VOKKO_SHOTS_DIR;
    test.skip(!dir, 'set VOKKO_SHOTS_DIR to capture screenshots');
    await page.setViewportSize({ width: 1440, height: 900 });
    await withPrefs(page, shot.prefs);
    await openDm(page);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${dir}/${shot.name}.png` });
  });
}

test('reactions render by default', async ({ page }) => {
  await openDm(page);
  await send(page, 'reaction default');
  const mine = message(page, 'reaction default');
  await expect(mine).not.toHaveClass(/pending/);
  await mine.hover();
  await mine.getByRole('button', { name: 'React with 👍' }).click();
  await expect(mine.locator('.chat-reaction').first()).toBeVisible();
});
