import { expect, test } from '@playwright/test';
import { API, RUN, api, composer, msg, openWithToken, registerUser, send, shot } from './realHelpers';
import type { Session } from './realHelpers';

// Friends, DMs and blocking between two throwaway users (so the seeded relationships stay untouched).
test.describe.configure({ mode: 'serial' });

let a: Session;
let b: Session;
let aUser: { token: string; userId: string; username: string };
let bUser: { token: string; userId: string; username: string };

test.afterAll(async () => {
  await a?.ctx.close();
  await b?.ctx.close();
});

test('friend request by username reaches the other user live and is accepted', async ({ browser }) => {
  aUser = await registerUser('a');
  bUser = await registerUser('b');
  a = await openWithToken(browser, aUser.token, aUser.userId, aUser.username);
  b = await openWithToken(browser, bUser.token, bUser.userId, bUser.username);

  await a.page.getByRole('tab', { name: 'Add Friend' }).click();
  await a.page.getByLabel('Username').fill(bUser.username);
  await a.page.getByRole('button', { name: 'Send Friend Request' }).click();
  await expect(a.page.locator('.add-friend-result.success')).toBeVisible();

  // b sees the pending badge without a reload
  await expect(b.page.getByRole('tab', { name: /Pending/ })).toContainText('1', { timeout: 10_000 });
  await b.page.getByRole('tab', { name: /Pending/ }).click();
  await shot(b.page, 'r13-friend-pending');
  await b.page.getByRole('button', { name: 'Accept' }).click();
  await b.page.getByRole('tab', { name: 'All' }).click();
  await expect(b.page.getByRole('list').getByText(`E2E a`).first()).toBeVisible();

  await a.page.getByRole('tab', { name: 'All' }).click();
  await expect(a.page.getByText('E2E b').first()).toBeVisible({ timeout: 10_000 });
});

test('unknown username shows the friendly error', async () => {
  await a.page.getByRole('tab', { name: 'Add Friend' }).click();
  await a.page.getByLabel('Username').fill(`nobody-${RUN}`);
  await a.page.getByRole('button', { name: 'Send Friend Request' }).click();
  await expect(a.page.locator('.add-friend-result.error')).toBeVisible();
});

test('message the friend: DM opens, intro offers Remove Friend and Block, messages are live', async () => {
  await a.page.getByRole('tab', { name: 'All' }).click();
  await a.page.getByRole('listitem').filter({ hasText: 'E2E b' }).getByRole('button', { name: 'Message' }).click();
  await composer(a.page).waitFor();
  await expect(a.page.locator('.chat-start')).toContainText('Remove Friend');
  await send(a.page, `hi b ${RUN}`);
  await b.page.getByRole('list', { name: 'Direct messages' }).getByRole('link', { name: /E2E a/ }).click();
  await expect(msg(b.page, `hi b ${RUN}`)).toBeVisible();
  await send(b.page, `hi a ${RUN}`);
  await expect(msg(a.page, `hi a ${RUN}`)).toBeVisible();
  await shot(a.page, 'r14-friend-dm');
});

test('Remove Friend then Add Friend from the intro, the other side accepts', async () => {
  const relation = a.page.locator('.chat-start-relation');
  await a.page.locator('.chat-scroller').hover();
  await a.page.mouse.wheel(0, -3000);
  await relation.getByRole('button', { name: 'Remove Friend' }).click();
  await expect(relation.getByRole('button', { name: 'Add Friend' })).toBeVisible();
  await relation.getByRole('button', { name: 'Add Friend' }).click();
  await expect(relation.getByRole('button', { name: 'Friend Request Sent' })).toBeDisabled();
  await api(bUser.token, 'PUT', `/users/@me/relationships/${aUser.userId}`);
  await expect(relation.getByRole('button', { name: 'Remove Friend' })).toBeVisible({ timeout: 10_000 });
});

test('block from the intro: confirm modal, Unblock, blocked list, the blocked user cannot send', async () => {
  await a.page.locator('.chat-start-relation').getByRole('button', { name: 'Block' }).click();
  await shot(a.page, 'r15-block-modal');
  await a.page.getByRole('dialog').getByRole('button', { name: 'Block' }).click();
  await expect(a.page.locator('.chat-start-relation').getByRole('button', { name: 'Unblock' })).toBeVisible();
  const dm = new URL(a.page.url()).pathname.split('/').pop()!;
  // the blocked user's send is rejected by the server
  const res = await fetch(`${API}/api/v1/channels/${dm}/messages`, {
    method: 'POST', headers: { authorization: bUser.token, 'content-type': 'application/json' }, body: JSON.stringify({ content: 'blocked?' }),
  });
  expect(res.status, 'blocked user posting into the DM').toBeGreaterThanOrEqual(400);
  await a.page.getByRole('link', { name: 'Direct Messages' }).first().click();
  await a.page.getByRole('tab', { name: 'Blocked' }).click();
  await expect(a.page.getByText('E2E b').first()).toBeVisible();
});
