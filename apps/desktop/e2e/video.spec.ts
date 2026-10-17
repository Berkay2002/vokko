import { mkdirSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { pickOption } from './helpers';

// Video perks against the mock backend (FakeTransport paints the remote pictures; the camera preview uses Chromium's fake
// device, see video.config.ts): Go Live quality picker, camera preview and backgrounds, watching a stream, the Voice & Video
// settings page and the persisted choices. Screenshots are written only when VOKKO_SHOTS names a directory.

const SHOTS = process.env.VOKKO_SHOTS ?? '';

type MockWin = { __vokkoMock: { channelIdByName(name: string): string | null; voice(user: string, channelId: string | null, opts?: { selfMute?: boolean; selfVideo?: boolean; selfStream?: boolean }): void } };

async function openGuild(page: Page): Promise<void> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.getByRole('list', { name: 'Channels' }).waitFor();
}

const row = (page: Page, channel = 'General') => page.getByRole('button', { name: `${channel} voice channel` });
const card = (page: Page) => page.getByRole('region', { name: 'Voice connection' });
const call = (page: Page) => page.getByRole('region', { name: /call$/ });
const dialog = (page: Page, name: string | RegExp) => page.getByRole('dialog', { name });
const prefs = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('vokko.prefs') ?? '{}') as Record<string, unknown>);

async function join(page: Page): Promise<void> {
  await row(page).click();
  await expect(card(page).getByRole('status')).toHaveText('Voice Connected');
  await expect(call(page)).toBeVisible();
}

const webgl2 = (page: Page) =>
  page.evaluate(() => {
    try {
      return !!document.createElement('canvas').getContext('webgl2');
    } catch {
      return false;
    }
  });

test('Go Live: every resolution and frame rate is offered, the choice goes live and is remembered', async ({ page }) => {
  await openGuild(page);
  await join(page);
  const bar = call(page);
  await bar.getByRole('button', { name: 'Share your screen' }).click();
  const share = dialog(page, 'Share your screen');
  await expect(share).toBeVisible();

  await share.getByRole('combobox', { name: 'Resolution' }).click();
  await expect(page.getByRole('listbox', { name: 'Resolution' }).getByRole('option')).toHaveText(['720p', '1080p', '1440p', 'Source']);
  await page.getByRole('option', { name: '1440p', exact: true }).click();
  await share.getByRole('combobox', { name: 'Frame rate' }).click();
  await expect(page.getByRole('listbox', { name: 'Frame rate' }).getByRole('option')).toHaveText(['15 fps', '30 fps', '60 fps']);
  await page.getByRole('option', { name: '60 fps', exact: true }).click();
  await share.getByRole('radio', { name: /^Screen sharing/ }).click();
  await expect(share.getByText(/^1440p · 60 fps · Screen sharing · /)).toBeVisible();
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/go-live.png` });
  }
  await share.getByRole('button', { name: 'Go Live' }).click();

  // Our own tile shows LIVE (op 4 round trip through the mock) and the button turns into "Stop streaming".
  const own = bar.locator('.voice-tile.own.stream');
  await expect(own.locator('.voice-tile-live')).toBeVisible();
  await expect(own.locator('video[data-source="screen"]')).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Stop streaming' })).toHaveAttribute('aria-pressed', 'true');
  expect(await prefs(page)).toMatchObject({ streamResolution: '1440p', streamFps: 60, streamContent: 'detail' });

  await bar.getByRole('button', { name: 'Stop streaming' }).click();
  await expect(own.locator('.voice-tile-live')).toHaveCount(0);
  await expect(bar.getByRole('button', { name: 'Share your screen' })).toBeVisible();

  // The next dialog starts from the remembered choice.
  await bar.getByRole('button', { name: 'Share your screen' }).click();
  await expect(dialog(page, 'Share your screen').getByRole('combobox', { name: 'Resolution' })).toHaveText('1440p');
  await expect(dialog(page, 'Share your screen').getByRole('combobox', { name: 'Frame rate' })).toHaveText('60 fps');
  await expect(dialog(page, 'Share your screen').getByRole('radio', { name: /^Screen sharing/ })).toHaveAttribute('aria-checked', 'true');
});

test('camera and screen share at once: two tiles, the camera on the user tile and the screen on the stream tile', async ({ page }) => {
  await openGuild(page);
  await join(page);
  const bar = call(page);
  await bar.getByRole('button', { name: 'Turn on camera' }).click();
  const camera = dialog(page, 'Ready to video chat?');
  await expect(camera.locator('.cam-preview')).toHaveAttribute('data-status', 'live', { timeout: 15_000 });
  await camera.getByRole('button', { name: 'Turn On Camera' }).click();
  await expect(bar.locator('.voice-tile.own:not(.stream) video[data-source="camera"]')).toBeVisible();
  await expect(card(page).getByRole('status')).toHaveText('Video Connected');

  await bar.getByRole('button', { name: 'Share your screen' }).click();
  await dialog(page, 'Share your screen').getByRole('button', { name: 'Go Live' }).click();
  await expect(bar.locator('.voice-tile.own.stream video[data-source="screen"]')).toBeVisible();
  // Starting the stream did not take the camera off its tile.
  await expect(bar.locator('.voice-tile.own:not(.stream) video[data-source="camera"]')).toBeVisible();
  await expect(bar.locator('.voice-tile.own')).toHaveCount(2);
  await expect(bar.getByRole('button', { name: 'Turn off camera' })).toHaveAttribute('aria-pressed', 'true');
  await expect(bar.getByRole('button', { name: 'Stop streaming' })).toHaveAttribute('aria-pressed', 'true');
});

test('watching someone else\'s stream: Watch Stream, then the quality menu', async ({ page }) => {
  await openGuild(page);
  await join(page);
  const general = await page.evaluate(() => (window as unknown as MockWin).__vokkoMock.channelIdByName('General'));
  await page.evaluate(id => (window as unknown as MockWin).__vokkoMock.voice('alice', id, { selfStream: true }), general);

  const alice = call(page).locator('.voice-tile.stream', { hasText: 'Alice' });
  await expect(alice.locator('.voice-tile-live')).toBeVisible();
  // Nothing is received until the user asks for it.
  await expect(alice.locator('video')).toHaveCount(0);
  await alice.getByRole('button', { name: 'Watch Stream' }).click();
  await expect(alice.locator('video[data-source="screen"]')).toBeVisible();

  await alice.getByRole('button', { name: 'Stream quality' }).click();
  await expect(page.getByRole('menuitemcheckbox', { name: 'Auto' })).toHaveAttribute('aria-checked', 'true');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/watch-stream-menu.png` });
  // The menu offers the layers the stream really has (the fake one is a 1080p share with 720p and 360p under it).
  await expect(page.getByRole('menuitemcheckbox')).toHaveText(['Auto', 'Source', '720p', '360p']);
  await page.getByRole('menuitemcheckbox', { name: '720p' }).click();
  await expect(alice.getByRole('button', { name: 'Stream quality' })).toContainText('720p');

  await alice.getByRole('button', { name: 'Stream quality' }).click();
  await page.getByRole('menuitem', { name: 'Stop Watching' }).click();
  await expect(alice.getByRole('button', { name: 'Watch Stream' })).toBeVisible();
  await expect(alice.locator('video')).toHaveCount(0);
});

test('camera preview: backgrounds, remembered choice, Turn On Camera publishes', async ({ page }) => {
  await openGuild(page);
  await join(page);
  const bar = call(page);
  await bar.getByRole('button', { name: 'Turn on camera' }).click();
  const modal = dialog(page, 'Ready to video chat?');
  await expect(modal).toBeVisible();
  await expect(modal.locator('.cam-preview')).toHaveAttribute('data-status', 'live', { timeout: 15_000 });

  const picker = modal.getByRole('radiogroup', { name: 'Video background' });
  for (const name of ['None', 'Blur', 'Strong blur', 'Dusk', 'Lagoon', 'Ember', 'Meadow', 'Slate', 'Orchid']) {
    await expect(picker.getByRole('radio', { name, exact: true })).toBeVisible();
  }
  await expect(picker.getByRole('radio', { name: 'None', exact: true })).toHaveAttribute('aria-checked', 'true');

  const hasWebgl = await webgl2(page);
  if (hasWebgl) {
    await picker.getByRole('radio', { name: 'Strong blur', exact: true }).click();
    await expect(picker.getByRole('radio', { name: 'Strong blur', exact: true })).toHaveAttribute('aria-checked', 'true');
    expect((await prefs(page)).videoBackground).toBe('blur-strong');
    // Let the segmenter load so the screenshot shows the blurred picture, not the raw one.
    await page.waitForTimeout(6_000);
  } else {
    // No WebGL 2: everything but None is disabled and says why.
    await expect(picker.getByRole('radio', { name: 'Strong blur', exact: true })).toBeDisabled();
    await expect(modal.getByText(/need WebGL 2/)).toBeVisible();
  }
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/camera-preview.png` });

  await modal.getByRole('button', { name: 'Turn On Camera' }).click();
  await expect(modal).toHaveCount(0);
  await expect(bar.getByRole('button', { name: 'Turn off camera' })).toHaveAttribute('aria-pressed', 'true');
  await expect(bar.locator('.voice-tile.own video[data-source="camera"]')).toBeVisible();

  await bar.getByRole('button', { name: 'Turn off camera' }).click();
  await expect(bar.locator('.voice-tile.own video')).toHaveCount(0);

  // The choice is stored, so a reload (and the next preview) starts from it.
  await page.reload();
  if (hasWebgl) {
    expect((await prefs(page)).videoBackground).toBe('blur-strong');
    await openGuild(page);
    await join(page);
    await call(page).getByRole('button', { name: 'Turn on camera' }).click();
    const again = dialog(page, 'Ready to video chat?');
    await expect(again.getByRole('radio', { name: 'Strong blur', exact: true })).toHaveAttribute('aria-checked', 'true');
  } else {
    expect((await prefs(page)).videoBackground).toBe('none');
  }
});

test('camera blur changes the picture (fake camera, WebGL 2 required)', async ({ page }) => {
  await openGuild(page);
  await join(page);
  test.skip(!(await webgl2(page)), 'no WebGL 2 in this browser');
  await call(page).getByRole('button', { name: 'Turn on camera' }).click();
  const modal = dialog(page, 'Ready to video chat?');
  await expect(modal.locator('.cam-preview')).toHaveAttribute('data-status', 'live', { timeout: 15_000 });
  const picker = modal.getByRole('radiogroup', { name: 'Video background' });

  // Mean absolute horizontal gradient of the preview frame, averaged over a few frames (the fake camera animates):
  // blur removes high-frequency detail, so it must drop.
  const sharpnessOf = (video: Locator) =>
    video.evaluate(async (el: HTMLVideoElement) => {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      const ctx = canvas.getContext('2d')!;
      let total = 0;
      const frames = 5;
      for (let f = 0; f < frames; f++) {
        await new Promise(resolve => setTimeout(resolve, 150));
        ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        let sum = 0;
        let n = 0;
        for (let y = 0; y < canvas.height; y++) {
          for (let x = 1; x < canvas.width; x++) {
            const i = (y * canvas.width + x) * 4;
            sum += Math.abs(data[i]! - data[i - 4]!) + Math.abs(data[i + 1]! - data[i - 3]!) + Math.abs(data[i + 2]! - data[i - 2]!);
            n += 3;
          }
        }
        total += sum / n;
      }
      return total / frames;
    });

  const sharpness = () => sharpnessOf(modal.locator('.cam-preview video'));
  await expect.poll(sharpness, { timeout: 10_000 }).toBeGreaterThan(0.05);
  const raw = await sharpness();
  await picker.getByRole('radio', { name: 'Strong blur', exact: true }).click();
  // The segmenter loads lazily (wasm + model), so poll until the processed frames settle below the raw ones.
  await expect.poll(sharpness, { timeout: 45_000, intervals: [1000] }).toBeLessThan(raw * 0.75);

  // What is published is the processed track, not the raw capture: the own tile is as soft as the preview.
  await modal.getByRole('button', { name: 'Turn On Camera' }).click();
  const own = call(page).locator('.voice-tile.own video[data-source="camera"]');
  await expect(own).toBeVisible();
  await expect.poll(() => sharpnessOf(own), { timeout: 15_000, intervals: [1000] }).toBeLessThan(raw * 0.75);
});

test('Voice & Video settings: six sections, persisted choices, sounds and reset', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('button', { name: 'User Settings' }).click();
  const settings = page.getByRole('dialog', { name: /User Settings/ });
  await settings.getByRole('button', { name: 'Voice & Video' }).click();
  const headings = settings.locator('.settings-category-title');
  await expect(headings).toHaveText(['Voice', 'Camera', 'Streaming', 'Sounds', 'Soundboard', 'Advanced']);
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/settings-voice.png` });
    await settings.locator('.settings-category-title', { hasText: 'Camera' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/settings-camera.png` });
  }

  // Input profile and noise suppression persist.
  await settings.getByRole('radiogroup', { name: 'Input profile' }).getByRole('radio', { name: /Studio/ }).click();
  expect((await prefs(page)).inputProfile).toBe('studio');
  await settings.getByRole('radiogroup', { name: 'Input profile' }).getByRole('radio', { name: /Custom/ }).click();
  expect((await prefs(page)).inputProfile).toBe('custom');

  // Streaming defaults.
  await settings.getByRole('button', { name: 'Show advanced stream settings' }).click();
  await pickOption(page, settings.getByRole('combobox', { name: 'Stream resolution' }), '1440p');
  await pickOption(page, settings.getByRole('combobox', { name: 'Stream frame rate' }), '60 fps');
  expect(await prefs(page)).toMatchObject({ streamResolution: '1440p', streamFps: 60 });
  if (SHOTS) {
    await settings.getByRole('combobox', { name: 'Stream resolution' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/settings-streaming.png` });
  }

  // Sounds: a sound can be turned off; the choice is stored.
  await settings.getByRole('switch', { name: 'Mute', exact: true }).click();
  expect(String((await prefs(page)).disabledSounds).split(',')).toEqual(['mute']);
  await settings.getByRole('button', { name: /Show \d+ more/ }).click();
  await expect(settings.getByRole('switch', { name: 'Camera On' })).toBeVisible();

  // The soundboard block holds the soundboard volume and the global entrance sound picker.
  await expect(settings.getByRole('combobox', { name: 'Entrance sound', exact: true })).toBeVisible();
  if (SHOTS) {
    await settings.locator('.settings-category-title', { hasText: 'Sounds' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/settings-sounds.png` });
  }

  // Reset asks first, then restores the defaults.
  await settings.getByRole('button', { name: 'Reset Voice & Video Settings' }).click();
  const confirm = page.getByRole('dialog', { name: 'Reset Voice & Video Settings' });
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  expect((await prefs(page)).streamResolution).toBe('1440p');
  await settings.getByRole('button', { name: 'Reset Voice & Video Settings' }).click();
  await page.getByRole('dialog', { name: 'Reset Voice & Video Settings' }).getByRole('button', { name: 'Reset' }).click();
  expect((await prefs(page)).streamResolution).toBe('1080p');
  expect(String((await prefs(page)).disabledSounds ?? '')).toBe('');
});
