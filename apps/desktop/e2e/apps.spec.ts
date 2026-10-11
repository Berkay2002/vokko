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
