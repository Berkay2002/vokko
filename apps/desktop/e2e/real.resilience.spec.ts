import { expect, test } from '@playwright/test';
import { RUN, api, channelByName, composer, dmWith, guildByName, msg, openDmWith, openGuild, openChannel, openSession, restartServer, send, shot } from './realHelpers';
import type { Session } from './realHelpers';

// Gateway resilience against the real server. The restart test needs VOKKO_SERVER_SCRIPT (see realHelpers.restartServer).
test.describe.configure({ mode: 'serial' });

let sam: Session;
let carol: Session;
let dmId = '';

test.afterAll(async () => {
  await sam?.ctx.close();
  await carol?.ctx.close();
});

test('open the seeded DM on both sides', async ({ browser }) => {
  sam = await openSession(browser, 'sam');
  carol = await openSession(browser, 'carol');
  await openDmWith(sam.page, 'carol');
  await openDmWith(carol.page, 'sam');
  dmId = new URL(sam.page.url()).pathname.split('/').pop()!;
  const probe = await dmWith(carol.token, sam.userId);
  expect(probe.id).toBe(dmId);
});

test('a client that goes offline for a few seconds catches up on the missed messages', async () => {
  await sam.ctx.setOffline(true);
  await api(carol.token, 'POST', `/channels/${dmId}/messages`, { content: `while you were away 1 ${RUN}` });
  await api(carol.token, 'POST', `/channels/${dmId}/messages`, { content: `while you were away 2 ${RUN}` });
  await sam.page.waitForTimeout(1500);
  await sam.ctx.setOffline(false);
  await expect(msg(sam.page, `while you were away 2 ${RUN}`)).toBeVisible({ timeout: 45_000 });
  await expect(msg(sam.page, `while you were away 1 ${RUN}`)).toBeVisible();
  await shot(sam.page, 'r22-resumed');
});

test('the server restarts and both clients reconnect and keep exchanging messages', async () => {
  test.skip(!process.env.VOKKO_SERVER_SCRIPT, 'set VOKKO_SERVER_SCRIPT to restart the server');
  await restartServer();
  // the stored tokens survive a restart (sessions live in the database)
  await api(carol.token, 'POST', `/channels/${dmId}/messages`, { content: `after restart ${RUN}` });
  await expect(msg(sam.page, `after restart ${RUN}`)).toBeVisible({ timeout: 60_000 });
  await send(sam.page, `sam after restart ${RUN}`);
  await expect(msg(carol.page, `sam after restart ${RUN}`)).toBeVisible({ timeout: 30_000 });
  await shot(carol.page, 'r23-after-restart');
});

test('typing events and read state still work after the restart', async () => {
  test.skip(!process.env.VOKKO_SERVER_SCRIPT, 'set VOKKO_SERVER_SCRIPT to restart the server');
  await composer(carol.page).click();
  await composer(carol.page).pressSequentially('still typing', { delay: 30 });
  await expect(sam.page.locator('.chat-typing-text')).toContainText(/typing/i, { timeout: 15_000 });
});

test('guild channel messages are delivered after the restart', async () => {
  test.skip(!process.env.VOKKO_SERVER_SCRIPT, 'set VOKKO_SERVER_SCRIPT to restart the server');
  const g = await guildByName(sam.token, "Sam's server");
  const general = await channelByName(sam.token, g.id, 'general');
  await openGuild(sam.page, "Sam's server");
  await openChannel(sam.page, 'general');
  await api(carol.token, 'POST', `/channels/${general.id}/messages`, { content: `guild after restart ${RUN}` });
  await expect(msg(sam.page, `guild after restart ${RUN}`)).toBeVisible({ timeout: 20_000 });
});
