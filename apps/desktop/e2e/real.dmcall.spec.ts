import { expect, test, type Browser, type Page } from '@playwright/test';
import { LIVEKIT, befriend, dmWith, launchMedia, openCallSession, registerUser, shot, type Session } from './realHelpers';

// DM voice call against a real server and a real LiveKit SFU: ring, decline, ring again, accept, camera, screen share, hang up,
// the "started a call that lasted" row, and the missed-call row. Opt-in: skipped unless VOKKO_LIVEKIT=1.
//
// Run recipe (the VPS recipe; any host works, change the ports):
//   1. livekit.yaml:  port: 1472 / bind_addresses: ["127.0.0.1"] / rtc: {tcp_port: 1473, udp_port: 1474, use_external_ip: false,
//      node_ip: 127.0.0.1} / keys: {devkey: secret-secret-secret-secret-secret} / webhook: {api_key: devkey, urls: [http://127.0.0.1:1470/internal/livekit/webhook]}
//      then `livekit-server --config livekit.yaml`.
//   2. vokko-server (DATABASE_URL = a scratch database, VOKKO_BIND=127.0.0.1:1470, VOKKO_LIVEKIT_URL=ws://127.0.0.1:1472,
//      VOKKO_LIVEKIT_API_KEY=devkey, VOKKO_LIVEKIT_API_SECRET=secret-secret-secret-secret-secret, VOKKO_CALL_RING_TIMEOUT_SECS=8,
//      VOKKO_CORS_ORIGINS=http://127.0.0.1:1471) `vokko-server serve`.
//   3. From apps/desktop: VOKKO_LIVEKIT=1 VOKKO_REAL=1 VOKKO_REAL_API=http://127.0.0.1:1470 VOKKO_E2E_PORT=1471 \
//        npx playwright test e2e/real.dmcall.spec.ts e2e/real.groupcall.spec.ts   (Playwright starts Vite on 1471 against the server)
//      VOKKO_REAL_SHOTS_DIR=<dir> saves screenshots of the call UI. The fake-media flags are set at launch (launchMedia in
//      realHelpers.ts), so these specs start their own Chromium instead of the config's.
// The call stage is a lazy chunk: every step waits for the call UI itself, never a fixed delay.

test.skip(!LIVEKIT, 'needs a LiveKit-configured vokko-server; see the recipe at the top of this file');
test.describe.configure({ mode: 'serial' });

const panel = (page: Page) => page.getByRole('region', { name: 'Call', exact: true });
const incoming = (page: Page) => page.getByRole('alertdialog', { name: /^Incoming call from/ });
const tile = (page: Page, userId: string) => panel(page).locator(`.voice-tile[data-user-id="${userId}"]:not([data-stream])`);
const connected = (page: Page) => page.getByRole('region', { name: 'Voice connection' }).getByRole('status');

let browser: Browser;
let alice: Session;
let bob: Session;
let dm: string;

test.afterAll(async () => {
  await alice?.ctx.close();
  await bob?.ctx.close();
  await browser?.close();
});

test('setup: two friends with a DM, each in a browser with fake media', async () => {
  browser = await launchMedia();
  const a = await registerUser('alice');
  const b = await registerUser('bob');
  await befriend(a, b);
  dm = (await dmWith(a.token, b.userId)).id;
  alice = await openCallSession(browser, a, `/channels/@me/${dm}`);
  bob = await openCallSession(browser, b, '/channels/@me');
  await expect(alice.page.getByRole('button', { name: 'Start Voice Call' })).toBeVisible();
});

test('ring, decline, ring again, accept: both end up connected with two tiles', async () => {
  await alice.page.getByRole('button', { name: 'Start Voice Call' }).click();
  await expect(panel(alice.page).getByRole('group', { name: /ringing$/ })).toBeVisible({ timeout: 30_000 });
  await expect(incoming(bob.page)).toBeVisible({ timeout: 30_000 });
  await shot(bob.page, 'dmcall-01-incoming');
  await shot(alice.page, 'dmcall-02-ringing');

  await incoming(bob.page).getByRole('button', { name: 'Decline' }).click();
  await expect(incoming(bob.page)).toHaveCount(0);
  await expect(panel(alice.page).getByRole('button', { name: /^Ring / })).toBeVisible();

  await panel(alice.page).getByRole('button', { name: /^Ring / }).click();
  await expect(incoming(bob.page)).toBeVisible({ timeout: 30_000 });
  await incoming(bob.page).getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(bob.page).toHaveURL(new RegExp(`/channels/@me/${dm}$`));
  for (const s of [alice, bob]) {
    await expect(connected(s.page)).toHaveText('Voice Connected', { timeout: 30_000 });
    await expect(tile(s.page, alice.userId)).toBeVisible();
    await expect(tile(s.page, bob.userId)).toBeVisible();
  }
  await shot(alice.page, 'dmcall-03-connected-alice');
  await shot(bob.page, 'dmcall-04-connected-bob');
});

test('camera: bob sees alice\'s live video', async () => {
  await panel(alice.page).getByRole('button', { name: 'Turn on camera' }).click();
  const video = tile(bob.page, alice.userId).locator('video[data-source="camera"]');
  await shot(alice.page, 'dmcall-05a-camera-preview');
  await alice.page.getByRole('dialog').getByRole('button', { name: 'Turn On Camera' }).click();
  await expect(video).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.videoWidth), { timeout: 20_000 }).toBeGreaterThan(0);
  await shot(bob.page, 'dmcall-05-camera');
  await panel(alice.page).getByRole('button', { name: 'Turn off camera' }).click();
  await expect(tile(bob.page, alice.userId).locator('video[data-source="camera"]')).toHaveCount(0, { timeout: 15_000 });
});

test('screen share: bob gets a stream tile with a picture', async () => {
  await panel(alice.page).getByRole('button', { name: 'Share your screen' }).click();
  await alice.page.getByRole('dialog').getByRole('button', { name: 'Go Live' }).click();
  const stream = panel(bob.page).locator(`.voice-tile[data-stream][data-user-id="${alice.userId}"]`);
  await expect(stream).toBeVisible({ timeout: 30_000 });
  await shot(bob.page, 'dmcall-06a-stream-card');
  await stream.locator('.voice-tile-watch').click(); // the stream is not received until it is watched
  const video = stream.locator('video[data-source="screen"]');
  await expect(video).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.videoWidth), { timeout: 20_000 }).toBeGreaterThan(0);
  await shot(bob.page, 'dmcall-06-screen-share');
  await panel(alice.page).getByRole('button', { name: 'Stop streaming' }).click();
  await expect(stream).toHaveCount(0, { timeout: 15_000 });
});

test('hang up: the call row shows how long it lasted', async () => {
  await panel(alice.page).getByRole('button', { name: 'Leave Call' }).click();
  await panel(bob.page).getByRole('button', { name: 'Leave Call' }).click();
  await expect(panel(alice.page)).toHaveCount(0, { timeout: 15_000 });
  await expect(alice.page.locator('.chat-system-text[data-call]').last()).toContainText(/started a call that lasted/);
  await shot(alice.page, 'dmcall-07-call-row');
});

test('nobody answers: the ring times out and bob gets a missed-call row', async () => {
  await alice.page.getByRole('button', { name: 'Start Voice Call' }).click();
  await expect(incoming(bob.page)).toBeVisible({ timeout: 30_000 });
  // The ring ends after VOKKO_CALL_RING_TIMEOUT_SECS (8 in the recipe); alice then ends the call.
  await expect(incoming(bob.page)).toHaveCount(0, { timeout: 60_000 });
  await panel(alice.page).getByRole('button', { name: 'Leave Call' }).click();
  await bob.page.goto(`/channels/@me/${dm}`);
  await expect(bob.page.locator('.chat-system-text[data-call]').last()).toContainText(/You missed a call from/, { timeout: 30_000 });
  await shot(bob.page, 'dmcall-08-missed');
});
