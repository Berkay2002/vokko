import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import path from 'node:path';
import { openDm } from './helpers';

// Voice messages against the in-memory mock (?as=sam&mockLatency=0): the microphone is a 440 Hz oscillator, so MediaRecorder writes a real
// clip that the player can play back.

test.use({ launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'], ...(process.env.VOKKO_CHROMIUM ? { executablePath: process.env.VOKKO_CHROMIUM } : {}) } });

type StoreWin = { __vokko: { appStore: { getState(): { channels: Record<string, { id: string; name?: string; guild_id: string | null }> } } } };

async function fakeMicrophone(page: Page): Promise<void> {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext();
      await ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.5;
      const out = ctx.createMediaStreamDestination();
      osc.connect(gain).connect(out);
      osc.start();
      return out.stream;
    };
  });
}

async function openGeneral(page: Page): Promise<void> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.waitForFunction(() => Object.values((window as unknown as StoreWin).__vokko.appStore.getState().channels).some(c => c.name === 'general' && c.guild_id));
  const target = await page.evaluate(() => {
    const c = Object.values((window as unknown as StoreWin).__vokko.appStore.getState().channels).find(x => x.name === 'general' && x.guild_id)!;
    return `/channels/${c.guild_id}/${c.id}`;
  });
  await page.evaluate(path => { history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, target);
  await page.locator('.channel-header').getByRole('heading', { name: 'general', exact: true }).waitFor();
}

async function recordAndSend(page: Page, ms: number): Promise<void> {
  await page.getByRole('button', { name: 'Record voice message' }).click();
  const recorder = page.getByRole('group', { name: 'Recording voice message' });
  await expect(recorder).toBeVisible();
  await page.waitForTimeout(ms);
  await expect(recorder.getByRole('timer')).toHaveText(/^0:0[1-9]$/);
  if (process.env.VOKKO_SHOTS_DIR) await page.screenshot({ path: path.join(process.env.VOKKO_SHOTS_DIR, 'desktop-recording.png') });
  await recorder.getByRole('button', { name: 'Send voice message' }).click();
  await expect(recorder).toHaveCount(0);
}

test('record, send and play a voice message in a server channel', async ({ page }) => {
  await fakeMicrophone(page);
  await openGeneral(page);
  const players = page.locator('.chat-msg .voice-player');
  const before = await players.count();

  // the mic is offered only while the box is empty
  const mic = page.getByRole('button', { name: 'Record voice message' });
  await expect(mic).toBeVisible();
  await page.getByRole('textbox').first().fill('typing');
  await expect(mic).toHaveCount(0);
  await page.getByRole('textbox').first().fill('');

  // cancel discards the recording
  await mic.click();
  await page.getByRole('button', { name: 'Cancel voice message' }).click();
  await expect(page.getByRole('group', { name: 'Recording voice message' })).toHaveCount(0);
  await expect(players).toHaveCount(before);

  await recordAndSend(page, 2200);
  const player = players.last();
  await expect(players).toHaveCount(before + 1);
  await expect(player.locator('.voice-player-time')).toHaveText(/^0:0[2-3]$/);
  // the oscillator is loud the whole time, so the waveform is full height
  expect(await player.locator('.voice-player-wave span').count()).toBeGreaterThanOrEqual(24);
  await expect(player.getByRole('link', { name: 'Download voice message' })).toHaveAttribute('download', /^voice-message\.(webm|ogg|m4a)$/);

  await player.getByRole('button', { name: 'Playback speed 1x' }).click();
  await expect(player.getByRole('button', { name: 'Playback speed 1.5x' })).toBeVisible();
  await player.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(player.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  if (process.env.VOKKO_SHOTS_DIR) await page.screenshot({ path: path.join(process.env.VOKKO_SHOTS_DIR, 'desktop-player.png') });
  await expect(player.locator('.voice-player-wave span.played').first()).toBeVisible({ timeout: 5000 });
  await expect(player.getByRole('button', { name: 'Play', exact: true })).toBeVisible({ timeout: 5000 }); // played to the end
});

test('a voice message in a DM, and no edit for it', async ({ page }) => {
  await fakeMicrophone(page);
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await openDm(page);
  await recordAndSend(page, 1200);
  const message = page.locator('.chat-msg', { has: page.locator('.voice-player') }).last();
  await expect(message).toBeVisible();
  await message.hover();
  await expect(message.getByRole('button', { name: 'Edit' })).toHaveCount(0);
});

test('phone: hold the mic to record, release to send, slide left to cancel', async ({ page }) => {
  await fakeMicrophone(page);
  await openGeneral(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const players = page.locator('.chat-msg .voice-player');
  const before = await players.count();
  const mic = page.getByRole('button', { name: 'Record voice message' });
  await expect(mic).toBeVisible();
  const box = (await mic.boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const recorder = page.getByRole('group', { name: 'Recording voice message' });

  // slide left past the threshold: cancelled
  await page.mouse.move(x, y);
  await page.mouse.down();
  await expect(recorder).toContainText('Slide to cancel');
  await page.waitForTimeout(800);
  await page.mouse.move(x - 160, y, { steps: 5 });
  await expect(recorder).toContainText('Release to cancel');
  await page.mouse.up();
  await expect(recorder).toHaveCount(0);
  await expect(players).toHaveCount(before);

  // hold and release: sent
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(1500);
  if (process.env.VOKKO_SHOTS_DIR) await page.screenshot({ path: path.join(process.env.VOKKO_SHOTS_DIR, 'phone-recording.png') });
  await page.mouse.up();
  await expect(players).toHaveCount(before + 1);
  if (process.env.VOKKO_SHOTS_DIR) await page.screenshot({ path: path.join(process.env.VOKKO_SHOTS_DIR, 'phone-player.png') });
});
