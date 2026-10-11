import { chromium, expect, test, type Browser } from '@playwright/test';
import { channelByName, guildByName, openGuild, openSession, type Session } from './realHelpers';

// Voice V1 two-client e2e against a real LiveKit SFU (docs/design/voice.md §6, V1 acceptance):
// A and B join the same voice channel; B's client has A's microphone track subscribed and shows A's speaking ring while
// A's fake microphone plays a beep.
//
// SKIPPED: the cloud sandbox has no livekit-server binary (GitHub release downloads are blocked, no Docker daemon).
// To run it locally:
//   1. A beep file for the fake microphone (1 kHz, 0.5 s on / 0.5 s off, 30 s, 48 kHz mono), e.g.
//        ffmpeg -f lavfi -i "sine=frequency=1000:sample_rate=48000:duration=30,volume='if(lt(mod(t,1),0.5),1,0)':eval=frame" -ac 1 e2e/beep.wav
//      and point VOKKO_BEEP_WAV at it (absolute path).
//   2. livekit-server --dev --bind 127.0.0.1        (dev keys: devkey / secret, ws://127.0.0.1:7880; the brief's
//      livekit.yaml sets audio.update_interval 200 ms, --dev uses LiveKit's default which is still well under the timeouts below)
//   3. vokko-server with VOKKO_LIVEKIT_URL=ws://127.0.0.1:7880 VOKKO_LIVEKIT_API_KEY=devkey VOKKO_LIVEKIT_API_SECRET=secret
//      and its webhook URL configured in LiveKit (http://127.0.0.1:8711/internal/livekit/webhook), seeded (`vokko-server seed`).
//   4. From apps/desktop: VOKKO_REAL=1 VOKKO_BEEP_WAV=$PWD/e2e/beep.wav npx playwright test e2e/real.voice.spec.ts
//   Then remove the `test.skip` line below.
// The fake-media flags must be set at browser launch, so this spec launches its own Chromium instead of the config's one.

test.skip(true, 'needs livekit-server --dev + a LiveKit-configured vokko-server; see the comment at the top of this file');

let browser: Browser;
let a: Session;
let b: Session;

test.afterAll(async () => {
  await a?.ctx.close();
  await b?.ctx.close();
  await browser?.close();
});

test('B hears A: audio track subscribed and A speaking ring on while the beep plays', async () => {
  const beep = process.env.VOKKO_BEEP_WAV;
  test.skip(!beep, 'set VOKKO_BEEP_WAV to an absolute path of a beep WAV');
  browser = await chromium.launch({
    executablePath: process.env.VOKKO_CHROMIUM || undefined,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${beep}`, '--autoplay-policy=no-user-gesture-required'],
  });
  a = await openSession(browser, 'sam');
  b = await openSession(browser, 'carol');
  for (const s of [a, b]) await s.ctx.grantPermissions(['microphone']);

  const guild = await guildByName(a.token, "Sam's server");
  await channelByName(a.token, guild.id, 'General'); // throws if the seed has no "General" voice channel
  for (const s of [a, b]) {
    await openGuild(s.page, "Sam's server");
    await s.page.getByRole('button', { name: 'General voice channel' }).click();
    await expect(s.page.getByRole('region', { name: 'Voice connection' }).getByRole('status')).toHaveText('Voice Connected', { timeout: 20_000 });
  }

  // Both see each other under the channel (VOICE_STATE_UPDATE through the gateway).
  const users = (s: Session) => s.page.getByRole('list', { name: 'Users in General' });
  await expect(users(b).locator(`.voice-user[data-user-id="${a.userId}"]`)).toBeVisible();
  await expect(users(a).locator(`.voice-user[data-user-id="${b.userId}"]`)).toBeVisible();

  // B subscribed A's microphone track (the transport attaches one <audio> per subscribed remote track, tagged by user id).
  await expect(b.page.locator(`[data-voice-audio] audio[data-user-id="${a.userId}"]`)).toHaveCount(1, { timeout: 15_000 });

  // A's speaking ring turns on at B while the beep plays (ActiveSpeakersChanged from the SFU), and off in the gaps.
  const ringOfA = users(b).locator(`.voice-user[data-user-id="${a.userId}"]`);
  await expect(ringOfA).toHaveClass(/speaking/, { timeout: 10_000 });
  await expect(ringOfA).not.toHaveClass(/speaking/, { timeout: 10_000 });

  // A mutes: B sees the muted icon and no ring.
  await a.page.getByRole('button', { name: 'Mute', exact: true }).click();
  await expect(ringOfA.getByRole('img', { name: 'Muted' })).toBeVisible();
  await b.page.waitForTimeout(1500);
  await expect(ringOfA).not.toHaveClass(/speaking/);

});
