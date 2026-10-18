import { expect, test, type Browser, type Page } from '@playwright/test';
import { LIVEKIT, api, befriend, launchMedia, openCallSession, registerUser, shot, type Session } from './realHelpers';

// Group DM call with three people against a real server and LiveKit: create the group from Friends, call in it, add a fourth
// person to the existing group through "Add Friends to DM" (PUT /channels/{id}/recipients/{uid}), remove them again.
// Opt-in: skipped unless VOKKO_LIVEKIT=1. Run recipe: the header of e2e/real.dmcall.spec.ts.

test.skip(!LIVEKIT, 'needs a LiveKit-configured vokko-server; see the recipe at the top of e2e/real.dmcall.spec.ts');
test.describe.configure({ mode: 'serial' });

const panel = (page: Page) => page.getByRole('region', { name: 'Call', exact: true });
const incoming = (page: Page) => page.getByRole('alertdialog', { name: /^Incoming call from/ });
const tile = (page: Page, userId: string) => panel(page).locator(`.voice-tile[data-user-id="${userId}"]:not([data-stream])`);

let browser: Browser;
let alice: Session;
let bob: Session;
let carl: Session;
let dana: { token: string; userId: string; username: string };
let group = '';

test.afterAll(async () => {
  for (const s of [alice, bob, carl]) await s?.ctx.close();
  await browser?.close();
});

test('setup: alice creates a group DM with bob and carl from the Friends page', async () => {
  browser = await launchMedia();
  const [a, b, c] = [await registerUser('alice'), await registerUser('bob'), await registerUser('carl')];
  dana = await registerUser('dana');
  for (const other of [b, c, dana]) await befriend(a, other);
  alice = await openCallSession(browser, a, '/channels/@me');
  bob = await openCallSession(browser, b, '/channels/@me');
  carl = await openCallSession(browser, c, '/channels/@me');

  await alice.page.getByRole('button', { name: 'New Group DM' }).click();
  const dialog = alice.page.getByRole('dialog');
  for (const name of ['E2E bob', 'E2E carl']) await dialog.getByRole('button', { name: new RegExp(name, 'i') }).click();
  await dialog.getByRole('button', { name: 'Create Group DM' }).click();
  await expect(alice.page).toHaveURL(/\/channels\/@me\/\d+$/);
  group = alice.page.url().split('/').pop() ?? '';
  await expect(alice.page.getByRole('button', { name: 'Start Voice Call' })).toBeVisible();
  await expect(bob.page.getByRole('list', { name: 'Direct messages' }).getByRole('link', { name: /bob|carl|alice/i }).first()).toBeVisible({ timeout: 15_000 });
});

test('three people in one group call', async () => {
  await alice.page.getByRole('button', { name: 'Start Voice Call' }).click();
  for (const s of [bob, carl]) {
    await expect(incoming(s.page)).toBeVisible({ timeout: 30_000 });
    await incoming(s.page).getByRole('button', { name: 'Accept', exact: true }).click();
  }
  for (const s of [alice, bob, carl]) {
    await expect(s.page.getByRole('region', { name: 'Voice connection' }).getByRole('status')).toHaveText('Voice Connected', { timeout: 30_000 });
    for (const who of [alice, bob, carl]) await expect(tile(s.page, who.userId)).toBeVisible({ timeout: 20_000 });
  }
  await shot(alice.page, 'groupcall-01-three-alice');
  await shot(carl.page, 'groupcall-02-three-carl');
  await panel(bob.page).getByRole('button', { name: 'Turn on camera' }).click();
  await bob.page.getByRole('dialog').getByRole('button', { name: 'Turn On Camera' }).click();
  const video = tile(carl.page, bob.userId).locator('video[data-source="camera"]');
  await expect(video).toBeVisible({ timeout: 30_000 });
  await shot(carl.page, 'groupcall-03-bob-camera');
});

test('Add Friends to DM on the group adds dana to it, no new group', async () => {
  const before = Object.keys(await channelsOf(alice)).length;
  await alice.page.getByRole('button', { name: 'Add Friends to DM' }).click();
  const dialog = alice.page.getByRole('dialog');
  await expect(dialog.getByText('Add Friends to DM')).toBeVisible();
  await shot(alice.page, 'groupcall-04-add-friends');
  await dialog.getByRole('button', { name: /E2E dana/i }).click();
  await dialog.getByRole('button', { name: /^(Create Group DM|Create DM)$/ }).click();
  await expect(dialog).toHaveCount(0);
  expect(alice.page.url().endsWith(`/${group}`)).toBe(true);
  expect(Object.keys(await channelsOf(alice)).length).toBe(before);
  const mine = await api<{ id: string; recipients: { id: string }[] }[]>(alice.token, 'GET', '/users/@me/channels');
  expect(mine.find(c => c.id === group)?.recipients.map(r => r.id)).toContain(dana.userId);
  // Bob (already in the call) learns of her through CHANNEL_RECIPIENT_ADD: the group's name in his sidebar gains her.
  await expect(bob.page.getByRole('list', { name: 'Direct messages' }).locator(`a[href$="/${group}"]`)).toContainText(/dana/i, { timeout: 15_000 });
  await shot(bob.page, 'groupcall-05-dana-added');
});

test('the owner removes carl: he leaves the call and the group, the rest hear it', async () => {
  await api(alice.token, 'DELETE', `/channels/${group}/recipients/${carl.userId}`);
  await expect(panel(carl.page)).toHaveCount(0, { timeout: 15_000 });
  await expect(tile(alice.page, carl.userId)).toHaveCount(0, { timeout: 15_000 });
  await expect(carl.page.getByRole('list', { name: 'Direct messages' }).locator(`a[href$="/${group}"]`)).toHaveCount(0);
  await shot(alice.page, 'groupcall-06-carl-removed');
});

async function channelsOf(s: Session): Promise<Record<string, unknown>> {
  const list = await api<{ id: string }[]>(s.token, 'GET', '/users/@me/channels');
  return Object.fromEntries(list.map(c => [c.id, c]));
}
