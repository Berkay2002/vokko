import { expect, test, type Page } from '@playwright/test';

// Voice & Video on a touch phone: no push to talk (there is no key to hold) and no screen share defaults (phone browsers cannot share).
// VOKKO_SHOTS=<dir> also saves a screenshot of the page.

async function openVoiceVideo(page: Page): Promise<void> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('button', { name: 'User Settings' }).click();
  await page.getByRole('dialog', { name: 'User Settings' }).getByRole('button', { name: 'Voice & Video', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Voice & Video' })).toBeVisible();
}

test.describe('touch phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

  test('hides push to talk and the screen share defaults', async ({ page }) => {
    await page.addInitScript(() => { delete (MediaDevices.prototype as Partial<MediaDevices>).getDisplayMedia; }); // as in phone browsers
    await openVoiceVideo(page);
    await expect(page.getByRole('radiogroup', { name: 'Input mode' })).toHaveCount(0);
    await expect(page.getByText('Push to talk sound')).toHaveCount(0);
    await page.getByRole('switch', { name: 'Echo cancellation' }).scrollIntoViewIfNeeded();
    if (process.env.VOKKO_SHOTS) await page.screenshot({ path: `${process.env.VOKKO_SHOTS}/voice-video-390.png` });
    await page.getByRole('button', { name: 'Show advanced stream settings' }).tap();
    await expect(page.getByText('Watching quality').first()).toBeVisible();
    await expect(page.getByText('Default stream quality')).toHaveCount(0);
    await page.getByRole('button', { name: /^Show \d+ more$/ }).tap();
    await expect(page.getByText('Push to Talk Activated')).toHaveCount(0);
  });
});

test('a desktop window keeps push to talk', async ({ page }) => {
  await openVoiceVideo(page);
  await page.getByRole('radiogroup', { name: 'Input mode' }).getByText('Push to Talk').click();
  await expect(page.getByText('Push to talk sound')).toBeVisible();
  await page.getByRole('radiogroup', { name: 'Input mode' }).evaluate(el => el.scrollIntoView({ block: 'center' }));
  if (process.env.VOKKO_SHOTS) await page.screenshot({ path: `${process.env.VOKKO_SHOTS}/voice-video-1440.png` });
});
