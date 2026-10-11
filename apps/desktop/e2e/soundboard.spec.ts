import { expect, test, type Page } from '@playwright/test';
import { pickOption } from './helpers';

// Soundboard against the mock backend (src/api/mock/soundboard.ts): upload in Server Settings, play from the popout, a sound
// another user plays reaches this client (VOICE_CHANNEL_EFFECT_SEND → local playback + flash on their row), and an entrance
// sound plays when someone joins. The mock is per page, so "another client" is a seeded user driven through __vokkoMock.

type Play = { url: string; volume: number; kind: 'effect' | 'preview'; at: number };
type MockWin = {
  __vokkoMock: {
    channelIdByName(name: string): string | null;
    voice(user: string, channelId: string | null): void;
    playSound(user: string, soundId: string, sourceGuildId?: string): void;
    entranceSound(user: string, soundId: string | null, sourceGuildId?: string): void;
  };
  __vokkoSoundboard: { plays: Play[] };
};

const card = (page: Page) => page.getByRole('region', { name: 'Voice connection' });
const userRow = (page: Page, channel: string, name: string) => page.getByRole('list', { name: `Users in ${channel}` }).locator('.voice-user', { hasText: name });
const plays = (page: Page) => page.evaluate(() => (window as unknown as MockWin).__vokkoSoundboard.plays.map(p => ({ ...p })));
const effects = async (page: Page) => (await plays(page)).filter(p => p.kind === 'effect');

async function joinGeneral(page: Page): Promise<void> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.getByRole('list', { name: 'Channels' }).waitFor();
  await page.getByRole('button', { name: 'General voice channel' }).click();
  await expect(card(page).getByRole('status')).toHaveText('Voice Connected');
}

/** A 1 s 440 Hz WAV (8 kHz mono 16-bit). */
function toneWav(seconds: number): Buffer {
  const rate = 8000;
  const count = Math.round(rate * seconds);
  const out = Buffer.alloc(44 + count * 2);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + count * 2, 4);
  out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i += 1) out.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000), 44 + i * 2);
  return out;
}

test('play from the popout: everyone in the channel (you included) plays it, your row flashes the emoji', async ({ page }) => {
  await joinGeneral(page);
  await card(page).getByRole('button', { name: 'Open Soundboard' }).click();
  const popout = page.locator('.voice-soundboard');
  await expect(popout.getByRole('region', { name: "Sam's server" }).getByRole('button', { name: 'Play Victory' })).toBeVisible();
  await expect(popout.getByRole('region', { name: 'Default Sounds' }).getByRole('button', { name: 'Play Chime' })).toBeVisible();

  // Search narrows every section.
  await popout.getByRole('textbox', { name: 'Find the perfect sound' }).fill('door');
  await expect(popout.locator('.sb-tile')).toHaveCount(1);
  await popout.getByRole('textbox', { name: 'Find the perfect sound' }).fill('');

  // Hover preview is local only.
  await popout.getByRole('button', { name: 'Preview Chime' }).hover();
  await expect.poll(async () => (await plays(page)).filter(p => p.kind === 'preview').length).toBeGreaterThan(0);
  expect(await effects(page)).toHaveLength(0);

  // Favourite: a Favorites section appears first.
  await popout.getByRole('button', { name: 'Add Doorbell to favorites' }).click();
  await expect(popout.locator('.sb-section').first()).toHaveAttribute('aria-label', 'Favorites');

  await popout.getByRole('region', { name: 'Default Sounds' }).getByRole('button', { name: 'Play Chime' }).click();
  await expect.poll(async () => (await effects(page)).length).toBe(1);
  const me = userRow(page, 'General', 'Sam');
  await expect(me).toHaveClass(/sound-flash/);
  await expect(me.locator('.sb-effect')).toHaveText('🎐');

  // A second play within 3 s is refused by the server (shown in the popout), nothing plays.
  await popout.getByRole('region', { name: 'Default Sounds' }).getByRole('button', { name: 'Play Pop' }).click();
  await expect(popout.getByRole('status')).toHaveText('Slow down! You can play a sound every 3 seconds.');
  expect(await effects(page)).toHaveLength(1);
  await expect(me).not.toHaveClass(/sound-flash/, { timeout: 5000 });

  // The soundboard volume setting scales playback.
  await popout.getByRole('button', { name: 'Soundboard volume' }).click();
  await popout.getByRole('slider', { name: 'Soundboard volume' }).fill('50');
  await page.waitForTimeout(3100);
  await popout.getByRole('region', { name: 'Default Sounds' }).getByRole('button', { name: 'Play Chime' }).click();
  await expect.poll(async () => (await effects(page)).length).toBe(2);
  expect((await effects(page))[1]!.volume).toBeCloseTo(0.5, 5);
});

test("another member's sound plays on this client and flashes on their row; entrance sounds play on join", async ({ page }) => {
  await joinGeneral(page);
  const alice = userRow(page, 'General', 'Alice');
  await page.evaluate(() => (window as unknown as MockWin).__vokkoMock.playSound('alice', '5'));
  await expect.poll(async () => (await effects(page)).length).toBe(1);
  expect((await effects(page))[0]!.volume).toBeCloseTo(0.8, 5); // Fanfare's own volume × 100 %
  await expect(alice).toHaveClass(/sound-flash/);
  await expect(alice.locator('.sb-effect')).toHaveText('🎺');

  // Nova sets an entrance sound and joins General: it plays here, flagged as an entrance.
  await page.evaluate(() => {
    const mock = (window as unknown as MockWin).__vokkoMock;
    mock.entranceSound('nova', '3');
    mock.voice('nova', mock.channelIdByName('General'));
  });
  await expect.poll(async () => (await effects(page)).length).toBe(2);
  const nova = userRow(page, 'General', 'Nova');
  await expect(nova.locator('.sb-effect.entrance')).toHaveText('🔔');

  // Deafened: the flash still shows, but nothing plays.
  await page.getByRole('button', { name: 'Deafen', exact: true }).click();
  await page.evaluate(() => (window as unknown as MockWin).__vokkoMock.playSound('bob', '1'));
  await expect(userRow(page, 'General', 'Bob')).toHaveClass(/sound-flash/);
  expect(await effects(page)).toHaveLength(2);
});

test('upload a sound in Server Settings (trimmed in the browser), then edit and delete it', async ({ page }) => {
  await joinGeneral(page);
  await page.locator('.guild-header-name-button').click();
  await page.getByRole('menuitem', { name: 'Server Settings' }).click();
  const dialog = page.getByRole('dialog', { name: /Server Settings/ });
  await dialog.getByRole('button', { name: 'Soundboard', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Soundboard', level: 1 })).toBeVisible();
  await expect(dialog.getByRole('list', { name: 'Server sounds' }).locator('.sb-row')).toHaveCount(3);

  await dialog.getByLabel('Sound file').setInputFiles({ name: 'long-tone.wav', mimeType: 'audio/wav', buffer: toneWav(7) });
  await expect(dialog.getByRole('textbox', { name: 'Sound name' })).toHaveValue('long tone');
  // A 7 s file starts trimmed to the first 5.2 s.
  await expect(dialog.getByRole('slider', { name: 'Trim end' })).toHaveValue('5.2');
  await dialog.getByRole('slider', { name: 'Trim start' }).fill('1');
  await dialog.getByRole('textbox', { name: 'Sound name' }).fill('Beep');
  await dialog.getByRole('textbox', { name: 'Related emoji' }).fill('📣');
  await dialog.getByRole('button', { name: 'Upload', exact: true }).click();
  const rows = dialog.getByRole('list', { name: 'Server sounds' }).locator('.sb-row');
  await expect(rows).toHaveCount(4);
  await expect(rows.filter({ hasText: 'Beep' })).toContainText('📣');
  const beepId = await rows.filter({ hasText: 'Beep' }).getAttribute('data-sound-id');
  const beep = dialog.locator(`.sb-row[data-sound-id="${beepId}"]`);

  await beep.getByRole('button', { name: 'Edit Beep' }).click();
  await beep.getByRole('textbox', { name: 'Sound name' }).fill('Beeper');
  await beep.getByRole('button', { name: 'Save' }).click();
  await expect(rows.filter({ hasText: 'Beeper' })).toHaveCount(1);

  // The new sound is in the popout and plays.
  await page.keyboard.press('Escape');
  await card(page).getByRole('button', { name: 'Open Soundboard' }).click();
  await page.locator('.voice-soundboard').getByRole('button', { name: 'Play Beeper' }).click();
  await expect.poll(async () => (await effects(page)).length).toBe(1);
  await page.keyboard.press('Escape');

  await page.locator('.guild-header-name-button').click();
  await page.getByRole('menuitem', { name: 'Server Settings' }).click();
  await dialog.getByRole('button', { name: 'Soundboard', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete Beeper' }).click();
  await expect(rows).toHaveCount(3);
});

test('entrance sound picker in Voice & Video plays for the channel when you join', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('button', { name: 'User Settings' }).click();
  const dialog = page.getByRole('dialog').last();
  await dialog.getByRole('button', { name: 'Voice & Video', exact: true }).click();
  await pickOption(page, dialog.getByRole('combobox', { name: 'Entrance sound', exact: true }), '🎺 Fanfare (Default)');
  await expect(dialog.getByRole('button', { name: 'Preview entrance sound' })).toBeEnabled();
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.getByRole('button', { name: 'General voice channel' }).click();
  await expect.poll(async () => (await effects(page)).length).toBe(1);
  await expect(userRow(page, 'General', 'Sam').locator('.sb-effect.entrance')).toHaveText('🎺');
});
