import { expect, test } from '@playwright/test';
import { openChannel, openThreadFromPopout, panel } from './threadHelpers';

// Thread side panel (GLD-013): header buttons, "Started by", resizing, locked and read-only states.

test('header: notification menu, pinned messages, settings; the thread starts with "Started by"', async ({ page }) => {
  await openChannel(page, 'general');
  await openThreadFromPopout(page, 'gateway docs');
  const header = panel(page).locator('.thread-panel-header');

  // same 32x32 buttons at a 40 px pitch as the channel header toolbar (guild/spec.md)
  const metrics = () =>
    header.locator('.toolbar-button').evaluateAll(els => {
      const r = els.map(e => e.getBoundingClientRect());
      return { sizes: [...new Set(r.map(b => `${b.width}x${b.height}`))], pitches: [...new Set(r.slice(1).map((b, i) => b.x - r[i]!.x))] };
    });
  await expect.poll(metrics).toEqual({ sizes: ['32x32'], pitches: [40] });

  await header.getByRole('button', { name: 'Notification Settings' }).click();
  await expect(page.getByRole('menuitem', { name: 'Mute Thread' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Notification Settings' }).hover();
  await expect(page.getByRole('menuitemcheckbox', { name: 'Use Channel Default' })).toBeChecked();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  await header.getByRole('button', { name: 'Pinned Messages' }).click();
  await expect(header.getByRole('button', { name: 'Pinned Messages' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.pins-popout-host')).toBeVisible();
  await page.keyboard.press('Escape');

  await header.getByRole('button', { name: 'Thread Settings' }).click();
  await expect(page.getByRole('dialog', { name: /Edit Thread|Thread Settings/ })).toBeVisible();
  await page.keyboard.press('Escape');

  // the whole history fits, so the start-of-thread intro shows above the starter message
  await expect(panel(page).locator('.chat-start')).toContainText('Started by');
  await expect(panel(page).locator('.chat-start')).toContainText('Nova');
});

test('the panel resizes by dragging or with the keys, never squeezes the chat below 440 px, and keeps its width', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openChannel(page, 'general');
  await openThreadFromPopout(page, 'gateway docs');
  const width = async () => (await panel(page).boundingBox())!.width;
  const chat = async () => (await page.locator('.channel-chat').boundingBox())!.width;
  await expect.poll(width).toBe(420);

  const handle = panel(page).getByRole('separator', { name: 'Resize thread panel' });
  const drag = async (dx: number) => {
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + 200, { steps: 5 });
    await page.mouse.up();
  };
  await drag(-100);
  await expect.poll(width).toBe(520);

  // dragging far past the limit stops where the chat column keeps its 440 px minimum; aria-valuemax says where that is
  await drag(-2000);
  await expect.poll(chat).toBeGreaterThanOrEqual(440);
  const max = Number(await handle.getAttribute('aria-valuemax'));
  await expect.poll(width).toBe(max);
  await expect(handle).toHaveAttribute('aria-valuemin', '360');

  await handle.focus();
  await page.keyboard.press('Home');
  await expect.poll(width).toBe(360);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(width).toBe(376);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect.poll(width).toBe(360); // never narrower than 360
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect.poll(width).toBe(488);

  // a narrow window clamps the panel; it grows back to the preferred width when the window grows again
  await page.setViewportSize({ width: 1300, height: 900 });
  await expect.poll(chat).toBeGreaterThanOrEqual(440);
  await expect.poll(width).toBeLessThan(488);
  await page.setViewportSize({ width: 1600, height: 900 });
  await expect.poll(width).toBe(488);

  // the width survives closing and opening another thread
  await panel(page).getByRole('button', { name: 'Close thread' }).click();
  await openThreadFromPopout(page, 'coffee setups');
  await expect.poll(width).toBe(488);
});

test('lock and unlock from the actions menu; a moderator keeps the composer', async ({ page }) => {
  await openChannel(page, 'general');
  await openThreadFromPopout(page, 'gateway docs');
  await panel(page).getByRole('button', { name: 'Thread actions' }).click();
  await page.getByRole('menuitem', { name: 'Lock' }).click();
  await expect(panel(page).getByRole('status').filter({ hasText: 'This thread is locked' })).toBeVisible();
  await expect(panel(page).getByLabel('Locked')).toBeVisible();
  await expect(panel(page).locator('.chat-textarea')).toBeVisible();
  await panel(page).getByRole('button', { name: 'Thread actions' }).click();
  await page.getByRole('menuitem', { name: 'Unlock' }).click();
  await expect(panel(page).getByText('This thread is locked')).toHaveCount(0);
});

test('a locked thread is read-only without Manage Threads, even for its owner', async ({ page }) => {
  await openChannel(page, 'general', 'bob');
  await openThreadFromPopout(page, 'coffee setups');
  await expect(panel(page).getByRole('status').filter({ hasText: 'This thread is locked' })).toBeVisible();
  await expect(panel(page).getByRole('note')).toContainText('cannot send messages');
  await expect(panel(page).locator('.chat-textarea')).toBeHidden();
  await expect(panel(page).getByRole('button', { name: 'Thread Settings' })).toHaveCount(0); // a locked thread is not editable by its owner
});
