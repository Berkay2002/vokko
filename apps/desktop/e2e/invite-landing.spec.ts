import { expect, test, type Page } from '@playwright/test';
import { goInApp } from './accountHelpers';

// The /invite/:code landing screen against the in-memory mock. A reload re-seeds the mock, so each test stays in one
// page load and moves between routes with history.pushState.

type Win = {
  __vokko: {
    request(method: string, path: string, body?: unknown): Promise<unknown>;
    appStore: { getState(): { guilds: Record<string, unknown>; removeGuild(id: string): void } };
  };
  __vokkoMock: { channelIdByName(name: string): string | null; rateLimit(count: number, retryAfter: number): void };
};

/** The invite card; its alert is the only one on the page. */
const card = (page: Page) => page.getByRole('main', { name: 'Server invite' });

/** Signs in as `who`, makes an invite to #dev-talk (not the server's first channel) and returns its code. */
async function inviteToDevTalk(page: Page, who: string, query = 'mockLatency=0'): Promise<{ code: string; channelId: string }> {
  await page.goto(`/channels/@me?as=${who}&${query}`);
  await page.locator('.dm-row').first().waitFor();
  return page.evaluate(async () => {
    const w = window as unknown as Win;
    const channelId = w.__vokkoMock.channelIdByName('dev-talk')!;
    const invite = (await w.__vokko.request('POST', `/channels/${channelId}/invites`, { max_age: 0 })) as { code: string };
    return { code: invite.code, channelId };
  });
}

/** The visitor leaves the server client-side so the invite page sees a non-member. */
async function leaveServer(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as Win;
    const id = Object.keys(w.__vokko.appStore.getState().guilds)[0]!;
    await w.__vokko.request('DELETE', `/users/@me/guilds/${id}`);
    w.__vokko.appStore.getState().removeGuild(id);
  });
}

test('a non-member sees the server card, joins, and lands in the invite channel', async ({ page }) => {
  const { code, channelId } = await inviteToDevTalk(page, 'bob', 'mockLatency=250');
  await leaveServer(page);
  await goInApp(page, `/invite/${code}`);

  await expect(page.getByRole('heading', { name: "Sam's server" })).toBeVisible();
  await expect(page.getByText(/^\S.* invited you to join$/)).toBeVisible();
  await expect(page.getByText(/\d+ Online/)).toBeVisible();
  await expect(page.getByText(/\d+ Members?/)).toBeVisible();

  await page.getByRole('button', { name: 'Accept Invite' }).click();
  await expect(page.getByRole('button', { name: 'Joining…' })).toBeDisabled();
  await expect(page).toHaveURL(new RegExp(`/channels/\\d+/${channelId}$`));
  await expect(page.locator('.chat-textarea')).toBeVisible();
});

test('a member gets Continue to Server instead of joining, into the invite channel', async ({ page }) => {
  const { code, channelId } = await inviteToDevTalk(page, 'sam');
  await goInApp(page, `/invite/${code}`);

  await expect(page.getByText('You are already in')).toBeVisible();
  await expect(page.getByRole('heading', { name: "Sam's server" })).toBeVisible();
  await page.getByRole('button', { name: 'Continue to Server' }).click();
  await expect(page).toHaveURL(new RegExp(`/channels/\\d+/${channelId}$`));
});

test('an unknown invite says Invite Invalid with a way back to the app', async ({ page }) => {
  await page.goto('/invite/nope?as=sam&mockLatency=0');
  await expect(page.getByRole('heading', { name: 'Invite Invalid' })).toBeVisible();
  await expect(page.getByText('This invite may be expired')).toBeVisible();
  await page.getByRole('link', { name: 'Continue to Vokko' }).click();
  await expect(page).toHaveURL(/\/channels\/@me/);
});

test('a failed preview says so and Try again loads the card', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  // 429 with a wait too long for rest.ts to sit out: the invite itself is fine. Two answers because StrictMode
  // (dev server) runs the preview effect twice; the retry after them is the third request and goes through.
  await page.evaluate(() => (window as unknown as Win).__vokkoMock.rateLimit(2, 120));
  await goInApp(page, '/invite/vokkodev');
  await expect(page.getByRole('heading', { name: "Couldn't load this invite" })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(1);
  await expect(page.getByRole('alert')).toContainText('rate limited');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: "Sam's server" })).toBeVisible();
});

test('a signed-out visitor who leaves an invalid invite is not sent back to it after login', async ({ page }) => {
  await page.goto('/invite/nope?mockLatency=0');
  await expect(page.getByRole('heading', { name: 'Invite Invalid' })).toBeVisible();
  await page.getByRole('link', { name: 'Continue to Vokko' }).click();
  await page.getByRole('button', { name: 'Log In' }).click();
  await expect(page).toHaveURL(/\/channels\/@me/);
});

// The mock previews only lowercase codes without an account (routes.ts isInvitePreview); a mixed-case code gets the 401
// a real server gives every signed-out preview, which is the "Log in to continue" card.
test('a server that wants an account for the preview shows the locked card, then the invite after login', async ({ page }) => {
  await page.goto('/invite/VokkoDev?mockLatency=0');
  await expect(page.getByRole('heading', { name: 'Log in to continue' })).toBeVisible();
  await page.getByRole('button', { name: 'Accept Invite' }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByRole('button', { name: 'Log In' }).click();
  await expect(page).toHaveURL(/\/invite\/VokkoDev/);
  // the mock has no such code once signed in: the card gives way to Invite Invalid
  await expect(page.getByRole('heading', { name: 'Invite Invalid' })).toBeVisible();
});

test('a banned visitor sees the server\'s message on the card', async ({ page }) => {
  const { code } = await inviteToDevTalk(page, 'sam');
  // The owner bans bob; the page then asks as bob (requests read the token from storage on every call).
  await page.evaluate(async () => {
    const w = window as unknown as Win & { __vokkoMock: { tokenFor(name: string): string | null } };
    const guildId = Object.keys(w.__vokko.appStore.getState().guilds)[0]!;
    const bobToken = w.__vokkoMock.tokenFor('bob')!;
    await w.__vokko.request('PUT', `/guilds/${guildId}/bans/${bobToken.slice(5)}`, {});
    localStorage.setItem('vokko.token', bobToken);
  });
  // client-side only: the server refuses bob's own leave request now
  await page.evaluate(() => {
    const store = (window as unknown as Win).__vokko.appStore.getState();
    store.removeGuild(Object.keys(store.guilds)[0]!);
  });
  await goInApp(page, `/invite/${code}`);
  await page.getByRole('button', { name: 'Accept Invite' }).click();
  await expect(card(page).getByRole('alert')).toContainText('banned');
  await expect(page.getByRole('button', { name: 'Accept Invite' })).toBeEnabled();
});

test('a signed-out visitor goes through login and comes back to the invite', async ({ page }) => {
  await page.goto('/invite/vokkodev?mockLatency=0');
  await expect(page.getByRole('heading', { name: "Sam's server" })).toBeVisible();
  await expect(page.getByText('You will be asked to log in or register first.')).toBeVisible();
  await page.getByRole('button', { name: 'Accept Invite' }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByRole('button', { name: 'Log In' }).click();
  await expect(page).toHaveURL(/\/invite\/vokkodev/);
  await expect(page.getByRole('heading', { name: "Sam's server" })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue to Server' })).toBeVisible();
});

test('a new account keeps the invite through register and joins from the card', async ({ page }) => {
  await page.goto('/invite/vokkodev?mockLatency=0');
  await page.getByRole('link', { name: 'Create an account' }).click();
  await expect(page).toHaveURL(/\/register/);
  await page.getByLabel('Email').fill('newbie@example.test');
  await page.getByLabel('Username').fill('newbie');
  await page.getByLabel('Password').fill('Plain-word-longer-9');
  await page.getByLabel('Month').selectOption('5');
  await page.getByLabel('Day').selectOption('10');
  await page.getByLabel('Year').selectOption('1995');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();

  await expect(page).toHaveURL(/\/invite\/vokkodev/);
  await expect(page.getByRole('heading', { name: "Sam's server" })).toBeVisible();
  await expect(page.getByText(/^\S.* invited you to join$/)).toBeVisible();
  await page.getByRole('button', { name: 'Accept Invite' }).click();
  await expect(page).toHaveURL(/\/channels\/\d+\/\d+$/);
  await expect(page.locator('.chat-textarea')).toBeVisible();
});

test('a rate-limited join shows the wait and lets the visitor try again', async ({ page }) => {
  const { code } = await inviteToDevTalk(page, 'bob');
  await leaveServer(page);
  await goInApp(page, `/invite/${code}`);
  await expect(page.getByRole('button', { name: 'Accept Invite' })).toBeVisible();
  await page.evaluate(() => (window as unknown as Win).__vokkoMock.rateLimit(1, 2));
  await page.getByRole('button', { name: 'Accept Invite' }).click();
  await expect(card(page).getByRole('alert')).toContainText('rate limited');
  await expect(card(page).getByRole('alert')).toContainText('Try again in 2s');
  await page.getByRole('button', { name: 'Accept Invite' }).click();
  await expect(page).toHaveURL(/\/channels\/\d+\/\d+$/);
});
