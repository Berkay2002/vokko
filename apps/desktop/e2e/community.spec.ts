import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { channelIdOf, openStockTalk } from './helpers';

// Community features on the mock backend: scheduled events (quick link, list, wizard, details, Interested), member onboarding,
// the pin confirmation dialog and friend suggestions.

type Win = {
  __vokko: { request(method: string, path: string, body?: unknown): Promise<unknown>; appStore: { getState(): { me: { id: string }; members: Record<string, Record<string, { roles: string[]; flags?: number }>>; guilds: Record<string, { name: string }> } } };
  __vokkoMock: { seedOnboardingGuild(owner?: string): { guildId: string; inviteCode: string; gamerRoleId: string; channels: Record<string, string>; strangerId: string } };
};

const pad = (n: number) => String(n).padStart(2, '0');
const dateInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const tomorrow = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d;
};

/** Navigates inside the app (a reload would re-seed the mock and drop the session). */
async function goTo(page: Page, path: string): Promise<void> {
  await page.evaluate(target => {
    history.pushState({}, '', target);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

test('create an event with the wizard, see it in the list and mark yourself interested', async ({ page }) => {
  await openStockTalk(page);
  const quickLink = page.locator('button.cm-quicklink');
  await expect(quickLink).toHaveText('Events');

  await quickLink.click();
  const list = page.getByRole('dialog', { name: 'Events' });
  await expect(list.getByText('There are no upcoming events')).toBeVisible();
  await list.getByRole('button', { name: 'Create Event' }).click();

  const wizard = page.getByRole('dialog', { name: 'Create Event' });
  await expect(wizard.locator('.cm-steps li.current')).toContainText('Location');
  await wizard.getByRole('radio', { name: /Somewhere Else/ }).click();
  await wizard.getByLabel(/Where is it\?/).fill('The lounge');
  await wizard.getByRole('button', { name: 'Next' }).click();

  // the topic is required: Next stops here until it is filled
  await wizard.getByRole('button', { name: 'Next' }).click();
  await expect(wizard.getByText('Give your event a topic.')).toBeVisible();
  await wizard.getByLabel(/Event topic/).fill('Movie night');
  const day = dateInput(tomorrow());
  await wizard.getByLabel(/Start date/).fill(day);
  await wizard.getByLabel(/Start time/).fill('18:00');
  await wizard.getByLabel(/End date/).fill(day);
  await wizard.getByLabel(/End time/).fill('20:00');
  await wizard.getByLabel('Description').fill('Bring snacks <b>not bold</b>');
  await wizard.getByRole('button', { name: 'Next' }).click();

  const review = wizard.getByLabel('Event preview');
  await expect(review).toContainText('Movie night');
  await expect(review).toContainText('The lounge');
  await expect(review).toContainText('Tomorrow at');
  await wizard.getByRole('button', { name: 'Create Event' }).click();

  // the details open; the description is text, never markup
  const detail = page.getByRole('dialog', { name: 'Movie night' });
  await expect(detail.getByRole('heading', { name: 'Movie night' })).toBeVisible();
  await expect(detail.locator('.cm-detail-description')).toHaveText('Bring snacks <b>not bold</b>');
  await expect(detail.locator('.cm-detail-description b')).toHaveCount(0);
  const interested = detail.getByRole('button', { name: 'Interested' });
  await expect(interested).toHaveAttribute('aria-pressed', 'false');
  await interested.click();
  await expect(interested).toHaveAttribute('aria-pressed', 'true');
  await expect(detail.getByText('1 interested').or(detail.getByText('Sam', { exact: true }))).toBeVisible();

  // the list and the quick link know about it
  await page.keyboard.press('Escape');
  await expect(quickLink).toHaveText('1 Event');
  await quickLink.click();
  const card = page.getByRole('dialog', { name: 'Events' }).getByRole('listitem').filter({ hasText: 'Movie night' });
  await expect(card).toContainText('1 interested');
  await expect(card.getByRole('button', { name: 'Interested' })).toHaveAttribute('aria-pressed', 'true');
});

test('a stage event picks a stage channel, a voice event a voice channel', async ({ page }) => {
  await openStockTalk(page);
  const guildId = new URL(page.url()).pathname.split('/')[2]!;
  await page.evaluate(id => (window as unknown as Win).__vokko.request('POST', `/guilds/${id}/channels`, { name: 'town-hall', type: 13 }), guildId);
  await page.locator('button.cm-quicklink').click();
  await page.getByRole('dialog', { name: 'Events' }).getByRole('button', { name: 'Create Event' }).click();
  const wizard = page.getByRole('dialog', { name: 'Create Event' });
  await expect(wizard).not.toContainText('no stage channels');
  await expect(wizard.getByLabel(/Voice channel/)).not.toContainText('town-hall');
  await wizard.getByRole('radio', { name: /Stage Channel/ }).click();
  const picker = wizard.getByLabel(/Stage channel/);
  await expect(picker.locator('option')).toHaveText(['town-hall']);
  await wizard.getByRole('button', { name: 'Next' }).click();
  await wizard.getByLabel(/Event topic/).fill('Town hall');
  const day = dateInput(tomorrow());
  await wizard.getByLabel(/Start date/).fill(day);
  await wizard.getByLabel(/Start time/).fill('18:00');
  await wizard.getByLabel(/End date/).fill(day);
  await wizard.getByLabel(/End time/).fill('19:00');
  await wizard.getByRole('button', { name: 'Next' }).click();
  await wizard.getByRole('button', { name: 'Create Event' }).click();
  await expect(page.getByRole('dialog', { name: 'Town hall' })).toContainText('town-hall');
});

test('an event can be started, ended and deleted by its creator, and others are told through the gateway', async ({ page }) => {
  await openStockTalk(page);
  const guildId = new URL(page.url()).pathname.split('/')[2]!;
  const start = new Date(Date.now() + 3_600_000).toISOString();
  const end = new Date(Date.now() + 7_200_000).toISOString();
  await page.evaluate(
    ([id, from, to]) => (window as unknown as Win).__vokko.request('POST', `/guilds/${id}/scheduled-events`, { name: 'Standup', entity_type: 3, entity_metadata: { location: 'Room 4' }, scheduled_start_time: from, scheduled_end_time: to }),
    [guildId, start, end] as const,
  );
  // the gateway CREATE event updated the quick link without a reload
  await expect(page.locator('button.cm-quicklink')).toHaveText('1 Event');
  await page.locator('button.cm-quicklink').click();
  await page.getByRole('dialog', { name: 'Events' }).getByRole('button', { name: /Standup/ }).click();
  const detail = page.getByRole('dialog', { name: 'Standup' });
  await detail.getByRole('button', { name: 'Start Event' }).click();
  await expect(detail.getByText(/Happening now/)).toBeVisible();
  await expect(page.locator('.cm-live-dot')).toHaveCount(1);
  await detail.getByRole('button', { name: 'End Event' }).click();
  await expect(detail.getByText(/Ended/)).toBeVisible();
  await expect(page.locator('button.cm-quicklink')).toHaveText('Events');
  await detail.getByRole('button', { name: 'Delete Event' }).click();
  await detail.getByRole('alertdialog').getByRole('button', { name: 'Delete Event' }).click();
  await expect(page.getByRole('dialog', { name: 'Standup' })).toHaveCount(0);
});

test('an open event detail follows the event when somebody else cancels or deletes it', async ({ page }) => {
  await openStockTalk(page);
  const guildId = new URL(page.url()).pathname.split('/')[2]!;
  const make = (name: string) =>
    page.evaluate(
      ([id, title]) =>
        (window as unknown as Win).__vokko.request('POST', `/guilds/${id}/scheduled-events`, {
          name: title,
          entity_type: 3,
          entity_metadata: { location: 'Room 4' },
          scheduled_start_time: new Date(Date.now() + 3_600_000).toISOString(),
          scheduled_end_time: new Date(Date.now() + 7_200_000).toISOString(),
        }) as Promise<{ id: string }>,
      [guildId, name] as const,
    );
  const first = await make('Cancelled soon');
  const second = await make('Deleted soon');
  await page.locator('button.cm-quicklink').click();
  await page.getByRole('dialog', { name: 'Events' }).getByRole('button', { name: /Cancelled soon/ }).click();
  const detail = page.getByRole('dialog', { name: 'Cancelled soon' });
  await expect(detail.getByRole('button', { name: 'Start Event' })).toBeVisible();
  // another manager cancels it while the detail is open: the actions go away instead of staying on the stale copy
  await page.evaluate(([id, event]) => (window as unknown as Win).__vokko.request('PATCH', `/guilds/${id}/scheduled-events/${event}`, { status: 4 }), [guildId, first.id] as const);
  await expect(detail.getByText(/Canceled/)).toBeVisible();
  await expect(detail.getByRole('button', { name: 'Start Event' })).toHaveCount(0);

  await detail.getByRole('button', { name: 'Close' }).first().click();
  // closing the detail goes back to the list, which no longer offers the canceled event
  await expect(page.getByRole('dialog', { name: 'Events' }).getByRole('button', { name: /Cancelled soon/ })).toHaveCount(0);
  await page.getByRole('dialog', { name: 'Events' }).getByRole('button', { name: /Deleted soon/ }).click();
  await expect(page.getByRole('dialog', { name: 'Deleted soon' })).toBeVisible();
  await page.evaluate(([id, event]) => (window as unknown as Win).__vokko.request('DELETE', `/guilds/${id}/scheduled-events/${event}`), [guildId, second.id] as const);
  await expect(page.getByText("This event doesn't exist any more.")).toBeVisible();
});

test('an event whose voice channel was deleted can still be renamed without picking a channel', async ({ page }) => {
  await openStockTalk(page);
  const guildId = new URL(page.url()).pathname.split('/')[2]!;
  const voice = await page.evaluate(async id => {
    const w = window as unknown as Win;
    const channels = (await w.__vokko.request('GET', `/guilds/${id}/channels`)) as { id: string; type: number }[];
    const channel = channels.find(c => c.type === 2)!;
    await w.__vokko.request('POST', `/guilds/${id}/scheduled-events`, { name: 'Game night', entity_type: 2, channel_id: channel.id, scheduled_start_time: new Date(Date.now() + 7_200_000).toISOString() });
    await w.__vokko.request('DELETE', `/channels/${channel.id}`);
    return channel.id;
  }, guildId);
  expect(voice).toBeTruthy();
  await page.locator('button.cm-quicklink').click();
  await page.getByRole('dialog', { name: 'Events' }).getByRole('button', { name: /Game night/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Edit Event' }).click();
  const wizard = page.getByRole('dialog', { name: 'Edit Event' });
  await wizard.getByLabel(/Event topic/).fill('Game night!');
  await wizard.getByRole('button', { name: 'Next' }).click();
  await wizard.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.getByRole('dialog', { name: 'Game night!' })).toBeVisible();
});

test('the server menu offers Create Event', async ({ page }) => {
  await openStockTalk(page);
  await page.locator('.guild-header-name-button').click();
  await page.getByRole('menuitem', { name: 'Create Event' }).click();
  await expect(page.getByRole('dialog', { name: 'Create Event' })).toBeVisible();
});

test('a new member answers the onboarding questions, accepts the rules and lands in the channels', async ({ page }) => {
  await openStockTalk(page);
  const seeded = await page.evaluate(() => (window as unknown as Win).__vokkoMock.seedOnboardingGuild('alice'));
  await page.evaluate(code => (window as unknown as Win).__vokko.request('POST', `/invites/${code}`), seeded.inviteCode);
  await goTo(page, `/channels/${seeded.guildId}`);

  const flow = page.getByRole('dialog', { name: 'Welcome to Pixel Pals' });
  await expect(flow).toBeVisible();
  await flow.getByRole('button', { name: 'Get started' }).click();

  const question = page.getByRole('dialog', { name: 'What are you here for?' });
  await expect(question.getByRole('button', { name: 'Continue' })).toBeDisabled();
  await question.getByRole('checkbox', { name: /Games/ }).click();
  await question.getByRole('button', { name: 'Continue' }).click();

  const rules = page.getByRole('dialog', { name: 'Server rules' });
  await expect(rules).toContainText('Be kind to everyone.');
  const finish = rules.getByRole('button', { name: 'Finish' });
  await expect(finish).toBeDisabled();
  await rules.getByRole('checkbox', { name: /agree/ }).check();
  await finish.click();

  // landed in the first default channel, the flow is gone, the role and the flags are on the member
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => channelIdOf(page)).toBe(seeded.channels.general);
  const member = await page.evaluate(([guildId]) => {
    const state = (window as unknown as Win).__vokko.appStore.getState();
    return state.members[guildId!]![state.me.id]!;
  }, [seeded.guildId] as const);
  expect(member.roles).toContain(seeded.gamerRoleId);
  expect(member.flags! & 2).toBe(2);
  await expect(page.locator('.channel-row', { hasText: 'gaming' })).toBeVisible();
});

test('"Do this later" parks the onboarding until the page reloads', async ({ page }) => {
  await openStockTalk(page);
  const seeded = await page.evaluate(() => (window as unknown as Win).__vokkoMock.seedOnboardingGuild('alice'));
  await page.evaluate(code => (window as unknown as Win).__vokko.request('POST', `/invites/${code}`), seeded.inviteCode);
  await goTo(page, `/channels/${seeded.guildId}/${seeded.channels.general}`);
  const flow = page.getByRole('dialog', { name: 'Welcome to Pixel Pals' });
  await flow.getByRole('button', { name: 'Do this later' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('a member who has not accepted the rules sees the rules bar instead of the composer; Review Rules reopens the flow', async ({ page }) => {
  await openStockTalk(page);
  const seeded = await page.evaluate(() => (window as unknown as Win).__vokkoMock.seedOnboardingGuild('alice'));
  await page.evaluate(code => (window as unknown as Win).__vokko.request('POST', `/invites/${code}`), seeded.inviteCode);
  await goTo(page, `/channels/${seeded.guildId}/${seeded.channels.general}`);
  await page.getByRole('dialog', { name: 'Welcome to Pixel Pals' }).getByRole('button', { name: 'Do this later' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const bar = page.locator('.chat-composer-rules');
  await expect(bar).toContainText('Accept the server rules to talk here');
  await expect(page.getByRole('textbox')).toHaveCount(0);

  // the server refuses a send in the meantime
  const refused = await page.evaluate(
    ([channel]) => (window as unknown as Win).__vokko.request('POST', `/channels/${channel}/messages`, { content: 'hi' }).then(() => 'sent', (e: { code?: number }) => e.code),
    [seeded.channels.general] as const,
  );
  expect(refused).toBe(150010);

  await bar.getByRole('button', { name: 'Review Rules' }).click();
  const flow = page.getByRole('dialog', { name: 'Welcome to Pixel Pals' });
  await flow.getByRole('button', { name: 'Get started' }).click();
  await page.getByRole('dialog', { name: 'What are you here for?' }).getByRole('checkbox', { name: /Games/ }).click();
  await page.getByRole('dialog', { name: 'What are you here for?' }).getByRole('button', { name: 'Continue' }).click();
  const rules = page.getByRole('dialog', { name: 'Server rules' });
  await rules.getByRole('checkbox', { name: /agree/ }).check();
  await rules.getByRole('button', { name: 'Finish' }).click();

  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.chat-composer-rules')).toHaveCount(0);
  await expect(page.getByRole('textbox').first()).toBeVisible();
});

test('the Channels & Roles row lets a member who finished onboarding change their answers', async ({ page }) => {
  await openStockTalk(page);
  const seeded = await page.evaluate(() => (window as unknown as Win).__vokkoMock.seedOnboardingGuild('alice'));
  await page.evaluate(code => (window as unknown as Win).__vokko.request('POST', `/invites/${code}`), seeded.inviteCode);
  await goTo(page, `/channels/${seeded.guildId}/${seeded.channels.general}`);
  const flow = page.getByRole('dialog', { name: 'Welcome to Pixel Pals' });
  await flow.getByRole('button', { name: 'Get started' }).click();
  await page.getByRole('dialog', { name: 'What are you here for?' }).getByRole('checkbox', { name: /Games/ }).click();
  await page.getByRole('dialog', { name: 'What are you here for?' }).getByRole('button', { name: 'Continue' }).click();
  const rules = page.getByRole('dialog', { name: 'Server rules' });
  await rules.getByRole('checkbox', { name: /agree/ }).check();
  await rules.getByRole('button', { name: 'Finish' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.locator('button.cm-quicklink', { hasText: 'Channels & Roles' }).click();
  const modal = page.getByRole('dialog', { name: 'Channels & Roles' });
  await expect(modal.getByRole('checkbox', { name: /Games/ })).toHaveAttribute('aria-checked', 'true');
  await modal.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('the owner sets up onboarding in server settings', async ({ page }) => {
  await openStockTalk(page);
  const guildId = new URL(page.url()).pathname.split('/')[2]!;
  await page.locator('.guild-header-name-button').click();
  await page.getByRole('menuitem', { name: 'Server Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Server Settings' });
  await settings.getByRole('button', { name: 'Onboarding' }).click();
  await expect(settings.getByRole('heading', { name: 'Onboarding', level: 1 })).toBeVisible();

  await settings.getByRole('switch', { name: 'Enable onboarding' }).click();
  await settings.getByRole('checkbox', { name: 'general', exact: true }).first().click();
  await settings.getByLabel(/^Rules \(one per line/).fill('Be kind.\nNo spam.');
  await settings.getByRole('button', { name: 'Add question' }).click();

  // a question without a title cannot be saved yet, and the page says why
  const save = settings.getByRole('button', { name: 'Save Changes' });
  await expect(save).toBeDisabled();
  await expect(settings.locator('.cm-problems')).toContainText('Question 1 needs a title.');
  await settings.getByLabel('Question 1 title').fill('What brings you here?');
  await settings.getByLabel('Answer 1 title').fill('Games');
  await settings.getByLabel('Answer 1 emoji').fill('🎮');
  await settings.getByRole('group', { name: 'Roles for answer 1' }).getByRole('checkbox').first().click();
  await settings.getByRole('switch', { name: 'Question 1: required' }).click();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(settings.getByRole('status')).toHaveText('Saved');

  const stored = await page.evaluate(id => (window as unknown as Win).__vokko.request('GET', `/guilds/${id}/onboarding`), guildId);
  expect(stored).toMatchObject({
    enabled: true,
    rules: { items: ['Be kind.', 'No spam.'] },
    prompts: [{ title: 'What brings you here?', required: true, options: [{ title: 'Games', emoji: { id: null, name: '🎮' } }] }],
  });
  const config = stored as { default_channel_ids: string[]; prompts: { options: { role_ids: string[] }[] }[] };
  expect(config.default_channel_ids).toHaveLength(1);
  expect(config.prompts[0]!.options[0]!.role_ids).toHaveLength(1);
});

test('pinning asks first and shows the message', async ({ page }) => {
  const channelId = await openStockTalk(page);
  const target = page.locator('.chat-msg').filter({ hasText: /\S/ }).nth(2);
  const text = ((await target.locator('.chat-content').first().innerText()) || '').trim();
  await target.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Pin Message' }).click();

  const dialog = page.getByRole('dialog', { name: 'Pin this message?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.chat-pin-preview')).toContainText(text.slice(0, 20));
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  const pinned = () => page.evaluate(id => (window as unknown as Win).__vokko.request('GET', `/channels/${id}/messages/pins`) as Promise<{ items: unknown[] }>, channelId);
  const before = (await pinned()).items.length;

  await target.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Pin Message' }).click();
  await page.getByRole('dialog', { name: 'Pin this message?' }).getByRole('button', { name: 'Pin it' }).click();
  await expect(page.getByRole('dialog', { name: 'Pin this message?' })).toHaveCount(0);
  await expect.poll(async () => (await pinned()).items.length).toBe(before + 1);
});

async function joinDemoServer(page: Page): Promise<void> {
  await openStockTalk(page);
  const seeded = await page.evaluate(() => (window as unknown as Win).__vokkoMock.seedOnboardingGuild('alice'));
  await page.evaluate(code => (window as unknown as Win).__vokko.request('POST', `/invites/${code}`), seeded.inviteCode);
  await goTo(page, '/channels/@me');
  await page.getByRole('tab', { name: 'Suggestions' }).click();
}

test('friend suggestions list people from a shared server; a friend request takes them off the list', async ({ page }) => {
  await joinDemoServer(page);
  const row = page.locator('.cm-suggestion', { hasText: 'Pixel' });
  await expect(row).toContainText('Both in Pixel Pals');
  await row.getByRole('button', { name: 'Add Friend' }).click();
  await expect(row.getByRole('button', { name: 'Request Sent' })).toBeDisabled();

  // after a request there is nothing to suggest any more
  await page.getByRole('tab', { name: 'Online' }).click();
  await page.getByRole('tab', { name: 'Suggestions' }).click();
  await expect(page.locator('.cm-suggestion', { hasText: 'Pixel' })).toHaveCount(0);
  await expect(page.getByText(/No suggestions right now/)).toBeVisible();
});

test('Add Friend shows the people you may know under the form', async ({ page }) => {
  await joinDemoServer(page);
  await page.getByRole('tab', { name: 'Add Friend' }).click();
  const row = page.locator('.cm-suggestions.embedded .cm-suggestion', { hasText: 'Pixel' });
  await expect(page.getByRole('heading', { name: /People you may know/ })).toBeVisible();
  await row.getByRole('button', { name: 'Add Friend' }).click();
  await expect(row.getByRole('button', { name: 'Request Sent' })).toBeDisabled();
});

test('ignoring a suggestion hides it for good, and opting out empties the tab', async ({ page }) => {
  await joinDemoServer(page);
  const row = page.locator('.cm-suggestion', { hasText: 'Pixel' });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Ignore Pixel' }).click();
  await expect(row).toHaveCount(0);
  await page.getByRole('tab', { name: 'Online' }).click();
  await page.getByRole('tab', { name: 'Suggestions' }).click();
  await expect(page.getByText(/No suggestions right now/)).toBeVisible();

  // the switch: off hides the list and says so, on brings the (now empty) list back
  const toggle = page.getByRole('switch', { name: 'Show me in friend suggestions' });
  await toggle.click();
  await expect(page.getByText('Friend suggestions are off.')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(page.getByText('Friend suggestions are off.')).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
});

test('the welcome checklist guides the owner of a brand-new server', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  await page.getByRole('button', { name: 'Add a Server' }).click();
  const create = page.getByRole('dialog');
  await create.getByRole('button', { name: /Create My Own/i }).click();
  await create.getByRole('button', { name: /For me and my friends/i }).click();
  await create.getByRole('textbox').fill('Fresh start');
  await create.getByRole('button', { name: 'Create' }).click();
  // Discord's next step: the invite dialog over the new server
  const invite = page.getByRole('dialog', { name: 'Invite friends to Fresh start' });
  await expect(invite.locator('#invite-link')).toHaveValue(/\w+$/);
  await page.keyboard.press('Escape');
  await expect(invite).toBeHidden();

  const checklist = page.getByRole('region', { name: 'Server setup checklist' });
  await expect(checklist).toContainText('Welcome to Fresh start');
  await expect(checklist).toContainText('0 of 4 done');
  await checklist.getByRole('button', { name: 'Invite your friends' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(checklist).toContainText('1 of 4 done');

  // opening the icon and app steps alone ticks nothing: they need an icon and a bot
  await checklist.getByRole('button', { name: 'Personalize your server with an icon' }).click();
  await page.getByRole('dialog', { name: 'Server Settings' }).getByRole('button', { name: 'Close' }).click();
  await checklist.getByRole('button', { name: 'Add your first app' }).click();
  const settings = page.getByRole('dialog', { name: 'Server Settings' });
  await expect(settings.getByText('Bots and Apps')).toBeVisible();
  await settings.getByRole('button', { name: 'Close' }).click();
  await expect(checklist).toContainText('1 of 4 done');
  await page.evaluate(() => (window as unknown as { __vokkoMock: { installEchoBot(guild: string): string } }).__vokkoMock.installEchoBot('Fresh start'));
  await expect(checklist).toContainText('2 of 4 done');

  // sending a message ticks the third step
  const box = page.locator('.chat-textarea');
  await box.click();
  await box.fill('hello, world');
  await box.press('Enter');
  await expect(checklist).toContainText('3 of 4 done');

  await checklist.getByRole('button', { name: 'Hide this checklist' }).click();
  await page.getByRole('dialog', { name: 'Hide this checklist?' }).getByRole('button', { name: 'Hide' }).click();
  await expect(checklist).toHaveCount(0);
});

// Accessibility: the new dialogs and cards must be clean under axe (no known-issue list needed).
async function expectClean(page: Page, include: string): Promise<void> {
  // The dialog behind a click may still be mounting: axe throws when the include selector matches nothing.
  await expect(page.locator(include).first()).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).include(include).analyze();
  expect(results.violations.map(v => `${v.id}: ${v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`)).toEqual([]);
}

test('the events dialogs, the onboarding flow and the checklist pass axe', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openStockTalk(page);
  const guildId = new URL(page.url()).pathname.split('/')[2]!;
  await page.evaluate(
    id => (window as unknown as Win).__vokko.request('POST', `/guilds/${id}/scheduled-events`, { name: 'Standup', description: 'Daily sync', entity_type: 3, entity_metadata: { location: 'Room 4' }, scheduled_start_time: new Date(Date.now() + 3_600_000).toISOString(), scheduled_end_time: new Date(Date.now() + 7_200_000).toISOString() }),
    guildId,
  );
  await page.locator('button.cm-quicklink').click();
  await expectClean(page, '.cm-modal');
  await page.getByRole('dialog', { name: 'Events' }).getByRole('button', { name: /Standup/ }).click();
  await expectClean(page, '.cm-modal');
  await page.getByRole('dialog').getByRole('button', { name: 'Edit Event' }).click();
  await expectClean(page, '.cm-modal');
  const wizard = page.getByRole('dialog', { name: 'Edit Event' });
  await wizard.getByRole('button', { name: 'Next' }).click();
  await expectClean(page, '.cm-modal');
  await page.keyboard.press('Escape');

  const seeded = await page.evaluate(() => (window as unknown as Win).__vokkoMock.seedOnboardingGuild('alice'));
  await page.evaluate(code => (window as unknown as Win).__vokko.request('POST', `/invites/${code}`), seeded.inviteCode);
  await goTo(page, `/channels/${seeded.guildId}`);
  await page.getByRole('button', { name: 'Get started' }).click();
  await expectClean(page, '.cm-onboarding');
  await page.getByRole('checkbox', { name: /Games/ }).click();
  await expectClean(page, '.cm-onboarding');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expectClean(page, '.cm-onboarding');
});

test('the welcome checklist and the suggestions tab pass axe', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  await page.getByRole('button', { name: 'Add a Server' }).click();
  const create = page.getByRole('dialog');
  await create.getByRole('button', { name: /Create My Own/i }).click();
  await create.getByRole('button', { name: /For me and my friends/i }).click();
  await create.getByRole('textbox').fill('Fresh start');
  await create.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('dialog', { name: 'Invite friends to Fresh start' }).waitFor();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'Server setup checklist' })).toBeVisible();
  await expectClean(page, '.cm-welcome');
  await expectClean(page, '.cm-quicklink');
  await goTo(page, '/channels/@me');
  await page.getByRole('tab', { name: 'Suggestions' }).click();
  await expect(page.locator('.cm-suggestions')).toBeVisible();
  // The switch is disabled (faded to 50%, which axe reads as low contrast) until the settings have loaded.
  await expect(page.locator('.cm-suggestions .switch-row.disabled')).toHaveCount(0);
  await expectClean(page, '.cm-suggestions');
});
