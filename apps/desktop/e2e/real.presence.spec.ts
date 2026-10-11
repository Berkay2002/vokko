import { expect, test } from '@playwright/test';
import { RUN, api, openWithToken, registerUser, shot } from './realHelpers';
import type { Session } from './realHelpers';

// Presence: connected -> online, last connection closed -> offline, observed in the member list.
test.describe.configure({ mode: 'serial' });

let owner: Session;
let peer: Session | undefined;
let peerUser: { token: string; userId: string; username: string };

test.afterAll(async () => {
  await owner?.ctx.close();
  await peer?.ctx.close();
});

test('a member who connects after the owner shows as online live, and offline when they leave', async ({ browser }) => {
  const o = await registerUser('po');
  peerUser = await registerUser('pp');
  const guild = await api<{ id: string }>(o.token, 'POST', '/guilds', { name: `Presence ${RUN}` });
  const channels = await api<{ id: string; type: number }[]>(o.token, 'GET', `/guilds/${guild.id}/channels`);
  const text = channels.find(c => c.type === 0)!;
  const invite = await api<{ code: string }>(o.token, 'POST', `/channels/${text.id}/invites`, {});
  await api(peerUser.token, 'POST', `/invites/${invite.code}`);

  owner = await openWithToken(browser, o.token, o.userId, o.username, `/channels/${guild.id}/${text.id}`);
  await expect(owner.page.locator('.member-list')).toContainText('E2E pp');
  await expect(owner.page.locator('.member-list')).toContainText(/Offline/);

  peer = await openWithToken(browser, peerUser.token, peerUser.userId, peerUser.username);
  await expect(owner.page.locator('.member-list')).toContainText(/Online — 2/, { timeout: 10_000 });
  await shot(owner.page, 'r21-presence-online');

  await peer.ctx.close();
  peer = undefined;
  await expect(owner.page.locator('.member-list')).toContainText(/Online — 1/, { timeout: 10_000 });
});

test('a member who is already connected shows as online after the owner loads', async ({ browser }) => {
  peer = await openWithToken(browser, peerUser.token, peerUser.userId, peerUser.username);
  await expect(peer.page.getByRole('navigation', { name: 'Servers sidebar' })).toBeVisible();
  await owner.page.reload();
  await expect(owner.page.locator('.member-list')).toContainText(/Online — 2/, { timeout: 10_000 });
});

// Keep last: a failure restarts the worker and drops the state above.
test('a connected user who joins the guild shows as online for the owner without a reload', async ({ browser }) => {
  // Contract ecd0e81: GUILD_CREATE.presences for the joiner, PRESENCE_UPDATE for the existing members.
  const o = await registerUser('jo');
  const joiner = await registerUser('jj');
  const guild = await api<{ id: string }>(o.token, 'POST', '/guilds', { name: `Joiner ${RUN}` });
  const channels = await api<{ id: string; type: number }[]>(o.token, 'GET', `/guilds/${guild.id}/channels`);
  const text = channels.find(c => c.type === 0)!;
  const invite = await api<{ code: string }>(o.token, 'POST', `/channels/${text.id}/invites`, {});
  const ownerSession = await openWithToken(browser, o.token, o.userId, o.username, `/channels/${guild.id}/${text.id}`);
  const joinerSession = await openWithToken(browser, joiner.token, joiner.userId, joiner.username);
  await expect(joinerSession.page.getByRole('navigation', { name: 'Servers sidebar' })).toBeVisible();
  await api(joiner.token, 'POST', `/invites/${invite.code}`);
  await expect(ownerSession.page.locator('.member-list')).toContainText('E2E jj');
  try {
    await expect(ownerSession.page.locator('.member-list')).toContainText(/Online — 2/, { timeout: 10_000 });
  } finally {
    await ownerSession.ctx.close();
    await joinerSession.ctx.close();
  }
});
