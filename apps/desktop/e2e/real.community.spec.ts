import { expect, test } from '@playwright/test';
import { RUN, api, openWithToken, registerUser } from './realHelpers';
import type { Session } from './realHelpers';

// Community features against a real vokko-server: events (UI wizard, gateway, Interested), onboarding (editor-made config,
// member flow, granted roles) and friend suggestions. Users and the guild are created per run.
test.describe.configure({ mode: 'serial' });

interface Guild { id: string }
interface Channel { id: string; name: string }
interface Role { id: string }
interface Invite { code: string }
interface Member { user: { id: string }; roles: string[]; flags?: number }
interface ScheduledEvent { id: string; name: string; user_count: number; entity_metadata: { location: string } | null }

let owner: Session;
let member: Session;
let stranger: Session;
let guildId = '';
let general = '';
let gaming = '';
let gamerRole = '';
let inviteCode = '';

const pad = (n: number) => String(n).padStart(2, '0');
const dateInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

test.afterAll(async () => {
  await owner?.ctx.close();
  await member?.ctx.close();
  await stranger?.ctx.close();
});

test('the owner builds a server with onboarding through the API', async ({ browser }) => {
  const o = await registerUser('co');
  const m = await registerUser('cm');
  const s = await registerUser('cs');
  const guild = await api<Guild>(o.token, 'POST', '/guilds', { name: `Community ${RUN}` });
  guildId = guild.id;
  const channels = await api<Channel[]>(o.token, 'GET', `/guilds/${guildId}/channels`);
  general = channels.find(c => c.name === 'general')!.id;
  gaming = (await api<Channel>(o.token, 'POST', `/guilds/${guildId}/channels`, { name: 'gaming', type: 0 })).id;
  gamerRole = (await api<Role>(o.token, 'POST', `/guilds/${guildId}/roles`, { name: 'gamer' })).id;
  const config = await api<{ enabled: boolean; prompts: { options: { role_ids: string[] }[] }[] }>(o.token, 'PUT', `/guilds/${guildId}/onboarding`, {
    enabled: true,
    default_channel_ids: [general],
    rules: { description: 'House rules', items: ['Be kind'] },
    prompts: [{ type: 0, title: 'What do you play?', required: true, single_select: true, options: [{ title: 'Games', emoji: { id: null, name: '🎮' }, role_ids: [gamerRole], channel_ids: [gaming] }] }],
  });
  expect(config.enabled).toBe(true);
  expect(config.prompts[0]!.options[0]!.role_ids).toEqual([gamerRole]);
  inviteCode = (await api<Invite>(o.token, 'POST', `/channels/${general}/invites`, {})).code;
  owner = await openWithToken(browser, o.token, o.userId, o.username, `/channels/${guildId}/${general}`);
  member = await openWithToken(browser, m.token, m.userId, m.username);
  stranger = await openWithToken(browser, s.token, s.userId, s.username);
});

test('the owner creates an event with the wizard', async () => {
  const page = owner.page;
  await expect(page.locator('button.cm-quicklink')).toHaveText('Events');
  await page.locator('button.cm-quicklink').click();
  await page.getByRole('dialog', { name: 'Events' }).getByRole('button', { name: 'Create Event' }).click();
  const wizard = page.getByRole('dialog', { name: 'Create Event' });
  await wizard.getByRole('radio', { name: /Somewhere Else/ }).click();
  await wizard.getByLabel(/Where is it\?/).fill('The lounge');
  await wizard.getByRole('button', { name: 'Next' }).click();
  await wizard.getByLabel(/Event topic/).fill(`Movie night ${RUN}`);
  const day = new Date(Date.now() + 86_400_000);
  await wizard.getByLabel(/Start date/).fill(dateInput(day));
  await wizard.getByLabel(/Start time/).fill('18:00');
  await wizard.getByLabel(/End date/).fill(dateInput(day));
  await wizard.getByLabel(/End time/).fill('20:00');
  await wizard.getByRole('button', { name: 'Next' }).click();
  await wizard.getByRole('button', { name: 'Create Event' }).click();
  await expect(page.getByRole('dialog', { name: `Movie night ${RUN}` })).toBeVisible();

  const events = await api<ScheduledEvent[]>(owner.token, 'GET', `/guilds/${guildId}/scheduled-events`);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ name: `Movie night ${RUN}`, entity_metadata: { location: 'The lounge' } });
  await page.keyboard.press('Escape');
  await expect(page.locator('button.cm-quicklink')).toHaveText('1 Event');
});

test('a new member goes through onboarding and lands in the default channel with the role', async () => {
  const page = member.page;
  await page.locator('.dm-row, .friends-page').first().waitFor();
  await api(member.token, 'POST', `/invites/${inviteCode}`, {});
  await page.getByRole('navigation', { name: 'Servers sidebar' }).getByRole('link', { name: new RegExp(`Community ${RUN}`) }).click();

  const flow = page.getByRole('dialog', { name: new RegExp(`Welcome to Community ${RUN}`) });
  await expect(flow).toBeVisible();
  await flow.getByRole('button', { name: 'Get started' }).click();
  const question = page.getByRole('dialog', { name: 'What do you play?' });
  await expect(question.getByRole('button', { name: 'Continue' })).toBeDisabled();
  await question.getByRole('radio', { name: /Games/ }).click();
  await question.getByRole('button', { name: 'Continue' }).click();
  const rules = page.getByRole('dialog', { name: 'Server rules' });
  await expect(rules).toContainText('House rules');
  await rules.getByRole('checkbox', { name: /agree/ }).check();
  await rules.getByRole('button', { name: 'Finish' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/channels/${guildId}/${general}$`));

  const members = await api<Member[]>(owner.token, 'GET', `/guilds/${guildId}/members`);
  const me = members.find(x => x.user.id === member.userId)!;
  expect(me.roles).toContain(gamerRole);
  expect(me.flags! & 2).toBe(2);
});

test('the member sees the event, marks interest, and the owner hears about it live', async () => {
  const page = member.page;
  await expect(page.locator('button.cm-quicklink')).toHaveText('1 Event');
  await page.locator('button.cm-quicklink').click();
  const card = page.getByRole('dialog', { name: 'Events' }).getByRole('listitem').filter({ hasText: `Movie night ${RUN}` });
  await card.getByRole('button', { name: 'Interested' }).click();
  await expect(card.getByRole('button', { name: 'Interested' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await api<ScheduledEvent[]>(owner.token, 'GET', `/guilds/${guildId}/scheduled-events`))[0]!.user_count).toBe(1);

  // the owner's open client got GUILD_SCHEDULED_EVENT_USER_ADD: the list shows it without a refetch of the page
  await owner.page.locator('button.cm-quicklink').click();
  await expect(owner.page.getByRole('dialog', { name: 'Events' }).getByRole('listitem').filter({ hasText: `Movie night ${RUN}` })).toContainText('1 interested');
});

test('friend suggestions come from the shared small server and the opt-out hides both ways', async () => {
  await api(stranger.token, 'POST', `/invites/${inviteCode}`, {});
  const page = member.page;
  await page.keyboard.press('Escape');
  await page.goto('/channels/@me');
  await page.getByRole('tab', { name: 'Suggestions' }).click();
  await expect(page.locator('.cm-suggestion', { hasText: `E2E cs` })).toContainText(`Both in Community ${RUN}`);

  // the stranger opts out: they vanish from the member's list and the member from theirs
  await api(stranger.token, 'PATCH', '/users/@me/friend-suggestion-settings', { enabled: false });
  await page.getByRole('tab', { name: 'Online' }).click();
  await page.getByRole('tab', { name: 'Suggestions' }).click();
  await expect(page.locator('.cm-suggestion', { hasText: 'E2E cs' })).toHaveCount(0);
  const theirs = await api<{ enabled: boolean; suggestions: unknown[] }>(stranger.token, 'GET', '/users/@me/friend-suggestions');
  expect(theirs).toEqual({ enabled: false, suggestions: [] });
});
