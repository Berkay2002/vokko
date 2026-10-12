import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { composer } from './helpers';

// Bots, slash commands and webhooks against the in-memory mock. The seed has the Echo application (owned by sam); the tests add
// its bot to "Sam's server" with __vokkoMock.installEchoBot(). Its handler answers like examples/echo-bot.

type StoreWin = { __vokko: { appStore: { getState(): { channels: Record<string, { id: string; name?: string; guild_id: string | null }> } } } };
type MockWin = { __vokkoMock: { installEchoBot(): string; executeWebhook(channelId: string, content: string, username?: string): string } };

async function openGeneral(page: Page): Promise<string> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.waitForFunction(() => Object.values((window as unknown as StoreWin).__vokko.appStore.getState().channels).some(c => c.name === 'general' && c.guild_id));
  await page.evaluate(() => (window as unknown as MockWin).__vokkoMock.installEchoBot());
  const target = await page.evaluate(() => {
    const c = Object.values((window as unknown as StoreWin).__vokko.appStore.getState().channels).find(x => x.name === 'general' && x.guild_id)!;
    return `/channels/${c.guild_id}/${c.id}`;
  });
  await page.evaluate(path => { history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, target);
  await page.locator('.channel-header').getByRole('heading', { name: 'general', exact: true }).waitFor();
  await page.locator('.chat-msg').first().waitFor();
  return target.split('/').pop()!;
}

const row = (page: Page, text: string | RegExp) => page.locator('.chat-msg', { hasText: text }).last();

test('run /echo from the picker and see the ephemeral reply, then dismiss it', async ({ page }) => {
  await openGeneral(page);
  const box = composer(page);
  await box.click();
  await box.pressSequentially('/ec');
  const picker = page.getByRole('listbox', { name: 'Commands' });
  await expect(picker.getByRole('option', { name: /\/echo/ })).toBeVisible();
  await expect(picker.locator('.apps-picker-group', { hasText: 'Echo' })).toBeVisible();
  await box.press('Enter'); // picks /echo and fills in its required option
  await expect(box).toHaveText('/echo text:');
  await expect(page.locator('.apps-command-bar .apps-option-chip', { hasText: 'text' })).toHaveClass(/active/);
  await box.press('Enter'); // the required option is still empty
  await expect(page.locator('.apps-command-error')).toContainText('text');
  const secret = `psst ${Date.now()}`;
  await box.pressSequentially(secret);
  await box.press('Enter');
  await expect(box).toHaveText('');

  const reply = row(page, secret);
  await expect(reply).toBeVisible();
  await expect(reply.locator('.apps-used')).toContainText('used /echo');
  await expect(reply.locator('.apps-tag')).toHaveText('APP');
  await expect(reply.locator('.apps-ephemeral')).toContainText('Only you can see this');
  await expect(reply).toHaveClass(/ephemeral/);
  await reply.getByRole('button', { name: 'Dismiss message' }).click();
  await expect(page.locator('.chat-msg', { hasText: secret })).toHaveCount(0);
});

test('typing / opens the panel with the app rail and sections, and the rail scrolls to a section', async ({ page }) => {
  await openGeneral(page);
  const box = composer(page);
  await box.click();
  await box.pressSequentially('/');
  const picker = page.getByRole('listbox', { name: 'Commands' });
  const rail = page.getByRole('navigation', { name: 'Command sources' });
  await expect(rail.getByRole('button', { name: 'Echo' })).toBeVisible();
  await expect(rail.getByRole('button', { name: 'Built-in' })).toBeVisible();
  await expect(rail.getByRole('button', { name: 'Frequently Used' })).toHaveCount(0);
  await expect(picker.locator('.apps-picker-group', { hasText: 'Echo' })).toBeVisible();
  await expect(picker.locator('.apps-picker-group', { hasText: 'Built-in' })).toHaveCount(1);
  await expect(picker.getByRole('option', { name: /\/shrug/ })).toHaveCount(1);
  await expect(picker.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  await rail.getByRole('button', { name: 'Built-in' }).click();
  await expect(picker.locator('.apps-picker-group', { hasText: 'Built-in' })).toBeInViewport();
  await expect(rail.getByRole('button', { name: 'Built-in' })).toHaveClass(/active/);
  await rail.getByRole('button', { name: 'Echo' }).click();
  await expect(picker.locator('.apps-picker-group', { hasText: 'Echo' })).toBeInViewport();
  await box.pressSequentially('ech'); // filtering drops the rail and the sections without matches
  await expect(rail).toHaveCount(0);
  await expect(picker.locator('.apps-picker-group')).toHaveCount(1);
});

test('built-in /tts posts the plain message', async ({ page }) => {
  await openGeneral(page);
  const box = composer(page);
  await box.click();
  await box.pressSequentially('/tts hello there');
  await box.press('Enter');
  await expect(box).toHaveText('');
  await expect(row(page, 'hello there')).toBeVisible();
});

test('built-in /shrug posts the message with the face, and Echo shows under Frequently Used after a run', async ({ page }) => {
  await openGeneral(page);
  const box = composer(page);
  await box.click();
  await box.pressSequentially('/shrug hi');
  await box.press('Enter');
  await expect(box).toHaveText('');
  await expect(row(page, 'hi ¯\\_(ツ)_/¯')).toBeVisible();

  await box.pressSequentially('/shrug me'); // "me" is a prefix of the option name, but free text sends
  await box.press('Enter');
  await expect(box).toHaveText('');
  await expect(row(page, 'me ¯\\_(ツ)_/¯')).toBeVisible();

  await box.pressSequentially('/echo text:again');
  await box.press('Enter');
  await expect(row(page, 'again')).toBeVisible();
  await box.pressSequentially('/');
  const picker = page.getByRole('listbox', { name: 'Commands' });
  await expect(picker.locator('.apps-picker-group').first()).toHaveText('Frequently Used');
  const recent = picker.getByRole('group', { name: 'Frequently Used' });
  await expect(recent.getByRole('option').first()).toContainText('/shrug'); // used twice, ahead of /echo
  await expect(recent.getByRole('option', { name: /\/echo/ })).toHaveCount(1);
  await expect(page.getByRole('navigation', { name: 'Command sources' }).getByRole('button', { name: 'Frequently Used' })).toBeVisible();
});

test('/nick changes the nickname in a server and shows a notice, and is not offered in a DM', async ({ page }) => {
  await openGeneral(page);
  const box = composer(page);
  await box.click();
  await box.pressSequentially('/nick Zed Zero');
  await box.press('Enter');
  await expect(box).toHaveText('');
  await expect(page.getByRole('status').filter({ hasText: 'Your nickname on this server has been changed to Zed Zero.' })).toBeVisible();
  await box.pressSequentially('/nick ');
  await page.waitForTimeout(500); // the member update dropped the cached command index; typing / reloads it and Enter waits for that
  await box.press('Enter'); // an empty value resets it
  await expect(page.getByRole('status').filter({ hasText: 'has been reset' })).toBeVisible();

  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: /^alice/i }).first().click();
  const dm = composer(page);
  await dm.click();
  await dm.pressSequentially('/ni');
  await expect(page.getByRole('listbox', { name: 'Commands' }).getByRole('option', { name: /\/nick/ })).toHaveCount(0);
  await dm.clear();
  await dm.pressSequentially('/msg');
  await expect(page.getByRole('listbox', { name: 'Commands' }).getByRole('option', { name: /\/msg/ })).toHaveCount(1);
});

test('/msg sends a direct message and goes to the DM', async ({ page }) => {
  await openGeneral(page);
  const box = composer(page);
  await box.click();
  const text = `slash dm ${Date.now()}`;
  await box.pressSequentially(`/msg user:Alice message:${text}`);
  await box.press('Enter');
  await expect(page).toHaveURL(/\/channels\/@me\/\d+/);
  await expect(row(page, text)).toBeVisible();
});

test('/thread creates a thread, posts the message in it and opens the thread panel', async ({ page }) => {
  await openGeneral(page);
  const box = composer(page);
  await box.click();
  const text = `first post ${Date.now()}`;
  await box.pressSequentially(`/thread name:Slash plans message:${text}`);
  await box.press('Enter');
  const panel = page.getByRole('complementary', { name: 'Thread: Slash plans' });
  await expect(panel).toBeVisible();
  await expect(panel.locator('.chat-msg', { hasText: text })).toBeVisible();
});

test('/gif lists search results as choices and sends the picked GIF URL', async ({ page }) => {
  await openGeneral(page);
  const box = composer(page);
  await box.click();
  await box.pressSequentially('/gif cat');
  const options = page.getByRole('listbox', { name: 'Command options' }).getByRole('option');
  await expect(options.first()).toBeVisible();
  await box.press('Enter'); // picks the first result
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await box.press('Enter'); // sends its URL
  await expect(box).toHaveText('');
  await expect(page.locator('.chat-msg').last()).toBeVisible();
  await expect(page.locator('.chat-msg img').last()).toBeVisible();
});

test('a deferred /roll thinks first, then shows the result to everyone', async ({ page }) => {
  await openGeneral(page);
  const box = composer(page);
  await box.click();
  await box.pressSequentially('/roll ');
  const options = page.getByRole('listbox', { name: 'Command options' });
  await expect(options.getByRole('option', { name: /sides/ })).toBeVisible();
  await box.press('Tab');
  await expect(box).toHaveText('/roll sides:');
  await box.pressSequentially('500');
  await box.press('Enter');
  await expect(page.locator('.apps-command-error')).toContainText('at most 100');
  await box.press('Backspace');
  await box.press('Backspace');
  await box.press('Enter'); // sides:5
  const result = row(page, 'You rolled');
  await expect(result).toBeVisible();
  await expect(result).toContainText('(d5)');
  await expect(result.locator('.apps-used')).toContainText('used /roll');
  await expect(result.locator('.apps-ephemeral')).toHaveCount(0);
});

test('choices and autocomplete fill option values from the picker', async ({ page }) => {
  await openGeneral(page);
  const box = composer(page);
  await box.click();
  await box.pressSequentially('/pick fruit:ma');
  const choices = page.getByRole('listbox', { name: 'Command options' });
  await expect(choices.getByRole('option', { name: 'mango' })).toBeVisible(); // from the bot's autocomplete answer
  await box.press('Enter');
  await expect(box).toHaveText('/pick fruit:mango ');
  await box.pressSequentially('size:');
  await expect(choices.getByRole('option', { name: 'Large' })).toBeVisible();
  await box.press('ArrowDown');
  await box.press('Enter');
  await expect(box).toHaveText('/pick fruit:mango size:Large ');
  await box.press('Enter');
  await expect(row(page, 'You picked mango.')).toBeVisible();
});

test('message and user context menus list the bot commands under Apps', async ({ page }) => {
  await openGeneral(page);
  const target = row(page, 'that should be plenty');
  await target.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Apps' }).hover();
  await page.getByRole('menuitem', { name: 'Quote' }).click();
  const quote = row(page, 'used Quote');
  await expect(quote.locator('blockquote')).toContainText('that should be plenty');

  await expect(page.getByRole('menuitem')).toHaveCount(0); // the message menu closed
  await page.getByRole('complementary', { name: 'Members' }).getByRole('button', { name: /Alice/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Apps' }).hover();
  await page.getByRole('menuitem', { name: /Wave at/ }).click();
  await expect(row(page, 'waves at')).toContainText('used Wave at on Alice');
});

test('server integrations: create a webhook, post through it, remove the bot', async ({ page }) => {
  const channelId = await openGeneral(page);
  await page.locator('.guild-header-name-button').click();
  await page.getByRole('menuitem', { name: 'Server Settings' }).click();
  await page.getByRole('button', { name: 'Integrations', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Bots' })).toContainText('Echo');
  await page.getByRole('button', { name: 'New Webhook' }).click();
  const hooks = page.getByRole('list', { name: 'Webhooks' });
  await expect(hooks).toContainText('New Webhook');
  await hooks.getByLabel('Name').fill('Deploys');
  await hooks.getByRole('button', { name: 'Save Changes' }).click();
  await expect(hooks.locator('.apps-card-name')).toHaveText('Deploys');
  await expect(hooks.getByRole('button', { name: 'Copy Webhook URL' })).toBeEnabled();

  await page.getByRole('list', { name: 'Bots' }).getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('dialog', { name: 'Remove Echo' }).getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText('No apps have been added to this server.')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.evaluate(([id]) => (window as unknown as MockWin).__vokkoMock.executeWebhook(id!, 'deploy finished', 'CI'), [channelId]);
  const posted = row(page, 'deploy finished');
  await expect(posted).toBeVisible();
  await expect(posted.locator('.chat-author')).toHaveText('CI');
  await expect(posted.locator('.apps-tag')).toHaveText('APP');
});

test('developer settings: create an application and see its token once', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('button', { name: 'User Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'User Settings' });
  await settings.getByRole('button', { name: 'Advanced', exact: true }).click();
  await expect(settings.getByRole('list', { name: 'Your applications' })).toContainText('Echo');
  await settings.getByRole('button', { name: 'New Application' }).click();
  await page.getByRole('dialog', { name: 'Create an application' }).getByLabel('Name').fill('Weather');
  await page.getByRole('dialog', { name: 'Create an application' }).getByRole('button', { name: 'Create' }).click();
  const token = page.getByRole('dialog', { name: 'Your bot token' });
  await expect(token.getByTestId('bot-token')).toHaveText(/^[0-9a-f]{64}$/);
  await token.getByRole('button', { name: 'Done' }).click();
  await expect(settings.getByRole('list', { name: 'Your applications' })).toContainText('Weather');
  await expect(page.getByTestId('bot-token')).toHaveCount(0);
});
