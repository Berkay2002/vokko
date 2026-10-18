import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { RUN, composer, msg, openChannel, openGuild, openWithToken, registerUser, send, shot } from './realHelpers';
import type { Session } from './realHelpers';

// Create a server, invite two newcomers, create/delete channels, leave: owner + two members in live browsers.
test.describe.configure({ mode: 'serial' });

const serverName = `E2E Server ${RUN}`;
let owner: Session;
let member: Session;
let guest: Session;
let code = '';

// text channels are links; voice channels are div buttons, so `a.channel-row` keeps "General" (voice) out of the match
const row = (page: Page, name: string) => page.getByRole('list', { name: 'Channels', exact: true }).locator('a.channel-row', { hasText: name });

test.afterAll(async () => {
  await owner?.ctx.close();
  await member?.ctx.close();
  await guest?.ctx.close();
});

test('create a server through the wizard', async ({ browser }) => {
  const o = await registerUser('own');
  const m = await registerUser('mem');
  const g = await registerUser('gst');
  owner = await openWithToken(browser, o.token, o.userId, o.username);
  member = await openWithToken(browser, m.token, m.userId, m.username);
  guest = await openWithToken(browser, g.token, g.userId, g.username);

  await owner.page.getByRole('button', { name: 'Add a Server' }).click();
  await owner.page.getByRole('button', { name: 'Create My Own' }).click();
  await owner.page.getByRole('button', { name: 'For me and my friends' }).click();
  await owner.page.getByLabel(/Server name/).fill(serverName);
  await shot(owner.page, 'r16-create-server');
  await owner.page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(owner.page.getByRole('navigation', { name: 'Servers sidebar' }).getByRole('link', { name: serverName })).toBeVisible({ timeout: 10_000 });
  await expect(row(owner.page, 'general')).toBeVisible();
});

test('the invite modal produces a link, a second user joins with it', async () => {
  await owner.page.getByRole('button', { name: 'Create Invite' }).first().click({ force: true }).catch(() => undefined);
  if (!(await owner.page.locator('#invite-link').count())) await owner.page.getByRole('button', { name: 'Invite People' }).click();
  await expect(owner.page.locator('#invite-link')).toHaveValue(/vokko\.gg\/\w+/, { timeout: 10_000 });
  code = (await owner.page.locator('#invite-link').inputValue()).replace(/^.*\//, '');
  await shot(owner.page, 'r17-invite-modal');
  await owner.page.keyboard.press('Escape');

  await member.page.getByRole('button', { name: 'Add a Server' }).click();
  await member.page.getByRole('button', { name: 'Join a Server' }).click();
  await member.page.getByLabel(/Invite link/).fill(code);
  await member.page.getByRole('button', { name: 'Join Server' }).click();
  await expect(member.page.getByRole('navigation', { name: 'Servers sidebar' }).getByRole('link', { name: serverName })).toBeVisible({ timeout: 10_000 });
});

test('a bad invite code shows an error in the join modal', async () => {
  await guest.page.getByRole('button', { name: 'Add a Server' }).click();
  await guest.page.getByRole('button', { name: 'Join a Server' }).click();
  await guest.page.getByLabel(/Invite link/).fill(`nope${RUN}`);
  await guest.page.getByRole('button', { name: 'Join Server' }).click();
  await expect(guest.page.locator('.field-error')).toBeVisible();
  await guest.page.keyboard.press('Escape');
});

test('owner and member exchange messages live in the new server', async () => {
  await openChannel(member.page, 'general');
  await send(owner.page, `welcome ${RUN}`);
  await expect(msg(member.page, `welcome ${RUN}`)).toBeVisible();
  await send(member.page, `thanks ${RUN}`);
  await expect(msg(owner.page, `thanks ${RUN}`)).toBeVisible();
  await expect(owner.page.locator('.member-list')).toContainText('E2E mem');
  await shot(owner.page, 'r18-new-server');
});

test('an invite link in chat renders a card the guest can join from', async () => {
  await send(owner.page, `join us: ${owner.page.url().split('/').slice(0, 3).join('/')}/invite/${code}`);
  const card = msg(owner.page, `join us: ${owner.page.url().split('/').slice(0, 3).join('/')}/invite/${code}`).locator('.chat-invite');
  await expect(card).toContainText(serverName);
  await expect(card.locator('.chat-invite-join')).toHaveText('Joined');
  await shot(owner.page, 'r19-invite-card');
});

test('creating a channel shows it live for members, deleting it removes it', async () => {
  // the "+" next to a category only shows while its header is hovered
  await owner.page.locator('.category-header', { hasText: 'Text Channels' }).hover();
  await owner.page.getByRole('button', { name: /^Create Channel$/ }).first().click({ timeout: 10_000 });
  await owner.page.locator('#channel-name').fill(`e2e-${RUN}`);
  await owner.page.getByRole('button', { name: 'Create Channel' }).last().click();
  await expect(row(owner.page, `e2e-${RUN}`)).toBeVisible();
  await expect(row(member.page, `e2e-${RUN}`)).toBeVisible({ timeout: 10_000 });
  await shot(member.page, 'r20-new-channel-live');
  await row(owner.page, `e2e-${RUN}`).click({ button: 'right' });
  await owner.page.getByRole('menuitem', { name: /Delete Channel/ }).click();
  await owner.page.getByRole('dialog').getByRole('button', { name: /Delete Channel/ }).click();
  await expect(row(owner.page, `e2e-${RUN}`)).toHaveCount(0);
  await expect(row(member.page, `e2e-${RUN}`)).toHaveCount(0, { timeout: 10_000 });
});

test('a member leaves and drops off the owner member list', async () => {
  await composer(member.page).waitFor();
  await member.page.getByRole('navigation', { name: 'Servers sidebar' }).getByRole('link', { name: serverName }).click({ button: 'right' });
  await member.page.getByRole('menuitem', { name: /Leave Server/ }).click();
  await member.page.getByRole('dialog').getByRole('button', { name: 'Leave Server' }).click();
  await expect(member.page.getByRole('navigation', { name: 'Servers sidebar' }).getByRole('link', { name: serverName })).toHaveCount(0);
  await expect(owner.page.locator('.member-list')).not.toContainText('E2E mem', { timeout: 10_000 });
  await openGuild(owner.page, serverName);
});
