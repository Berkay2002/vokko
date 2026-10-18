import { expect, test, type Page } from '@playwright/test';
import { composer } from './helpers';

// Items 1 and 15 of gap-audit-6: on a phone Enter is a new line and buttons send / save; on desktop Enter still sends.
// Screenshots go to $VOKKO_SHOTS_DIR when set.

const shot = async (page: Page, name: string) => { if (process.env.VOKKO_SHOTS_DIR) await page.screenshot({ path: `${process.env.VOKKO_SHOTS_DIR}/${name}.png` }); };

type StoreWin = { __vokko: { appStore: { getState(): { channels: Record<string, { id: string; name?: string; guild_id: string | null }> } } } };

/** Opens #stock-talk the way each layout does: the phone has the channel list as a drawer page first. */
async function openStockTalk(page: Page, phone: boolean): Promise<void> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.waitForFunction(() => Object.values((window as unknown as StoreWin).__vokko.appStore.getState().channels).some(c => c.name === 'stock-talk'));
  const target = await page.evaluate(() => {
    const c = Object.values((window as unknown as StoreWin).__vokko.appStore.getState().channels).find(x => x.name === 'stock-talk')!;
    return `/channels/${c.guild_id}/${c.id}`;
  });
  await page.evaluate(path => { history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, target); // a reload re-seeds the mock
  if (phone) {
    await expect(page.locator('.app-frame')).toHaveClass(/nav-open/);
    await page.locator('a.channel-row[aria-current="page"]').first().tap();
  }
  await composer(page).waitFor();
  await page.locator('.chat-msg').first().waitFor();
  await page.waitForTimeout(400);
}

/** Holds a finger at (x, y) for `ms` (CDP, so no mouse events are involved). */
async function longPress(page: Page, x: number, y: number, ms = 700): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await page.waitForTimeout(ms);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test.describe('desktop', () => {
  test('Enter sends, Shift+Enter is a new line, no Send button, edit keeps its keyboard hint', async ({ page }) => {
    await openStockTalk(page, false);
    const box = composer(page);
    await box.click();
    await box.pressSequentially('line one');
    await box.press('Shift+Enter');
    await box.pressSequentially('line two');
    await expect(page.getByRole('button', { name: 'Send message' })).toHaveCount(0);
    await shot(page, 'chat-phone-composer-1440');
    await box.press('Enter');
    const sent = page.locator('.chat-msg', { hasText: 'line two' }).last();
    await expect(sent).toContainText('line one');
    await expect(box).toHaveText('');

    await sent.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Edit Message' }).click();
    await expect(page.locator('.chat-edit-hint')).toHaveText('escape to cancel • enter to save');
    await expect(page.locator('.chat-edit-actions')).toHaveCount(0);
    await shot(page, 'chat-phone-desktop-edit-1440');
    await page.keyboard.press('Escape');
  });
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

  test('Enter is a new line, the Send arrow sends and shows only with text', async ({ page }) => {
    await openStockTalk(page, true);
    const box = composer(page);
    const send = page.getByRole('button', { name: 'Send message' });
    await expect(send).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Record voice message' })).toBeVisible();
    await box.tap();
    await box.pressSequentially('phone line one');
    await expect(send).toBeVisible();
    await expect(page.getByRole('button', { name: 'Record voice message' })).toHaveCount(0);
    await box.press('Enter');
    await box.pressSequentially('phone line two');
    await expect(page.locator('.chat-msg', { hasText: 'phone line' })).toHaveCount(0); // Enter did not send
    await shot(page, 'chat-phone-send-390');
    const b = (await send.boundingBox())!;
    expect(b.width).toBeGreaterThanOrEqual(32);
    await send.tap();
    const sent = page.locator('.chat-msg', { hasText: 'phone line two' }).last();
    await expect(sent).toContainText('phone line one');
    await expect(box).toHaveText('');
    await expect(send).toHaveCount(0);
  });

  test('edit shows Cancel and Save buttons, Enter is a new line, Save stores it', async ({ page }) => {
    await openStockTalk(page, true);
    const box = composer(page);
    await box.tap();
    await box.pressSequentially('edit me');
    await page.getByRole('button', { name: 'Send message' }).tap();
    const row = page.locator('.chat-msg', { hasText: 'edit me' }).last();
    await expect(row).toBeVisible();
    await page.waitForTimeout(600); // the list settles at the bottom
    const rb = (await row.boundingBox())!;
    await longPress(page, rb.x + rb.width - 12, rb.y + rb.height / 2);
    await page.getByRole('menuitem', { name: 'Edit Message' }).tap();

    const edit = page.locator('.chat-edit');
    await expect(edit.locator('.chat-edit-hint')).toHaveCount(0);
    const cancel = edit.getByRole('button', { name: 'Cancel' });
    const save = edit.getByRole('button', { name: 'Save' });
    for (const button of [cancel, save]) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(40);
    await shot(page, 'chat-phone-edit-390');

    const area = edit.getByRole('textbox', { name: 'Edit message' });
    await area.press('Enter');
    await area.pressSequentially('more');
    await expect(area).toHaveValue('edit me\nmore');
    await cancel.tap();
    await expect(page.locator('.chat-edit')).toHaveCount(0);
    await expect(row).not.toContainText('more');

    await longPress(page, rb.x + rb.width - 12, rb.y + rb.height / 2);
    await page.getByRole('menuitem', { name: 'Edit Message' }).tap();
    await area.press('Enter');
    await area.pressSequentially('saved');
    await save.tap();
    await expect(page.locator('.chat-edit')).toHaveCount(0);
    await expect(page.locator('.chat-msg', { hasText: 'saved' }).last()).toContainText('edit me');
  });
});
