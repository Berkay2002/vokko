import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { API, RUN, api, channelByName, composer, guildByName, msg, openChannel, openGuild, openSession, send, shot } from './realHelpers';
import type { Session } from './realHelpers';

// Guild chat against the seeded "Sam's server": live delivery, permissions, unread/ack.
test.describe.configure({ mode: 'serial' });

let sam: Session;
let carol: Session;
let guildId: string;
let general: string;
let devTalk: string;
let memes: string;

const row = (page: Page, name: string) => page.getByRole('list', { name: 'Channels' }).locator('.channel-row', { hasText: name });

test.afterAll(async () => {
  await sam?.ctx.close();
  await carol?.ctx.close();
});

test('guild opens with the seeded channels and history', async ({ browser }) => {
  sam = await openSession(browser, 'sam');
  carol = await openSession(browser, 'carol');
  const g = await guildByName(sam.token, "Sam's server");
  guildId = g.id;
  general = (await channelByName(sam.token, guildId, 'general')).id;
  devTalk = (await channelByName(sam.token, guildId, 'dev-talk')).id;
  memes = (await channelByName(sam.token, guildId, 'memes')).id;
  await openGuild(sam.page, "Sam's server");
  await openChannel(sam.page, 'general');
  await expect(sam.page.locator('.chat-msg').first()).toBeVisible();
  await expect(sam.page.locator('.chat-msg', { hasText: 'welcome to the server everyone!' })).toBeVisible();
  await shot(sam.page, 'r09-guild-general');
});

test('the hidden #mods channel is listed for the owner and the Moderator role only', async ({ browser }) => {
  await expect(row(sam.page, 'mods')).toBeVisible();
  // alice holds the Moderator role in the seed, carol does not
  const alice = await openSession(browser, 'alice');
  await openGuild(alice.page, "Sam's server");
  await expect(row(alice.page, 'mods')).toBeVisible();
  await alice.ctx.close();
  await openGuild(carol.page, "Sam's server");
  await expect(row(carol.page, 'general')).toBeVisible();
  await expect(row(carol.page, 'mods')).toHaveCount(0);
  const mods = await channelByName(sam.token, guildId, 'mods');
  const res = await fetch(`${API}/api/v1/channels/${mods.id}/messages`, { headers: { authorization: carol.token } });
  expect(res.status).toBeGreaterThanOrEqual(400);
});

test('a message with a mention is delivered live and highlights for the mentioned user', async () => {
  await openGuild(carol.page, "Sam's server");
  await openChannel(carol.page, 'general');
  await composer(sam.page).click();
  await composer(sam.page).fill('hey @carol0r');
  await expect(sam.page.locator('.chat-autocomplete')).toBeVisible();
  await composer(sam.page).press('Tab');
  await composer(sam.page).pressSequentially(` standup ${RUN}`);
  await composer(sam.page).press('Enter');
  const theirs = msg(carol.page, `standup ${RUN}`);
  await expect(theirs).toBeVisible();
  await expect(theirs.locator('.md-mention')).toContainText('@');
  await expect(theirs).toHaveClass(/mentioned/);
  await shot(carol.page, 'r10-mention');
});

test('edit and delete in a guild channel propagate', async () => {
  const mine = msg(sam.page, `standup ${RUN}`);
  await expect(mine).not.toHaveClass(/pending/);
  await mine.hover();
  await mine.getByRole('button', { name: 'Edit' }).click();
  const edit = sam.page.getByLabel('Edit message');
  await edit.press('End');
  await edit.pressSequentially(' (edited)');
  await edit.press('Enter');
  await expect(msg(carol.page, `standup ${RUN}`)).toContainText('(edited)');
  await mine.hover();
  await mine.getByRole('button', { name: 'More' }).click();
  await sam.page.getByRole('menuitem', { name: 'Delete Message' }).click();
  await sam.page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(carol.page.locator('.chat-msg', { hasText: `standup ${RUN}` })).toHaveCount(0);
});

test('unread: a message elsewhere marks the channel unread, opening it acks, reload keeps it read', async () => {
  await api(carol.token, 'POST', `/channels/${devTalk}/messages`, { content: `unread probe ${RUN}` });
  await expect(row(sam.page, 'dev-talk')).toHaveClass(/unread/, { timeout: 10_000 });
  await shot(sam.page, 'r11-unread-channel');
  await openChannel(sam.page, 'dev-talk');
  await expect(sam.page.locator('.chat-msg', { hasText: `unread probe ${RUN}` })).toBeVisible();
  await expect(row(sam.page, 'dev-talk')).not.toHaveClass(/unread/);
  await sam.page.reload();
  await expect(row(sam.page, 'dev-talk')).toBeVisible();
  await expect(row(sam.page, 'dev-talk')).not.toHaveClass(/unread/);
});

test('Shift+Escape marks the whole server read and it persists', async () => {
  await api(carol.token, 'POST', `/channels/${memes}/messages`, { content: `memes probe ${RUN}` });
  await api(carol.token, 'POST', `/channels/${general}/messages`, { content: `general probe ${RUN}` });
  await expect(row(sam.page, 'memes')).toHaveClass(/unread/, { timeout: 10_000 });
  await sam.page.locator('.chat-view').click({ position: { x: 700, y: 200 } });
  await sam.page.keyboard.press('Shift+Escape');
  await expect(row(sam.page, 'memes')).not.toHaveClass(/unread/, { timeout: 10_000 });
  await sam.page.reload();
  await expect(row(sam.page, 'memes')).toBeVisible();
  await expect(sam.page.getByRole('list', { name: 'Channels' }).locator('.channel-row.unread')).toHaveCount(0);
});

test('member list shows the guild members', async () => {
  await expect(sam.page.locator('.member-list')).toContainText('Carol');
  await shot(sam.page, 'r12-guild-members');
});
