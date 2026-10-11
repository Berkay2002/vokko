import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { pickOption } from './helpers';

// Polls against the in-memory mock (?as=sam&mockLatency=0): create one from the composer "+" menu, vote, look at the voters, end it early.

type StoreWin = { __vokko: { appStore: { getState(): { channels: Record<string, { id: string; name?: string; guild_id: string | null }> } } } };

/** Signs in as sam and opens #general of the demo server (in-app navigation: a reload would re-seed the mock). */
async function openGeneral(page: Page): Promise<void> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.waitForFunction(() => Object.values((window as unknown as StoreWin).__vokko.appStore.getState().channels).some(c => c.name === 'general' && c.guild_id));
  const target = await page.evaluate(() => {
    const c = Object.values((window as unknown as StoreWin).__vokko.appStore.getState().channels).find(x => x.name === 'general' && x.guild_id)!;
    return `/channels/${c.guild_id}/${c.id}`;
  });
  await page.evaluate(path => { history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, target);
  await page.locator('.channel-header').getByRole('heading', { name: 'general', exact: true }).waitFor();
}

test('create a poll, vote, see the voters and end it now', async ({ page }) => {
  await openGeneral(page);
  const question = `Lunch ${Date.now()}?`;

  await page.getByRole('button', { name: 'Attach a file' }).click();
  await page.getByRole('menuitem', { name: 'Create Poll' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a Poll' });
  await expect(dialog.getByRole('button', { name: 'Post' })).toBeDisabled();
  await dialog.getByLabel('Question').fill(question);
  await dialog.getByRole('textbox', { name: 'Answer 1', exact: true }).fill('Pizza');
  await dialog.getByRole('textbox', { name: 'Answer 2', exact: true }).fill('Sushi');
  await dialog.getByRole('button', { name: 'Add another answer' }).click();
  await dialog.getByRole('textbox', { name: 'Answer 3', exact: true }).fill('Tacos');
  await pickOption(page, dialog.getByRole('combobox', { name: 'Duration' }), '3 days');
  await dialog.getByRole('button', { name: 'Post' }).click();
  await expect(dialog).toHaveCount(0);

  const poll = page.locator('.chat-msg .poll', { hasText: question });
  await expect(poll).toBeVisible();
  await expect(poll).toContainText('Select one answer');
  await expect(poll).toContainText('0 votes • 3d left');
  const vote = poll.getByRole('button', { name: 'Vote' });
  await expect(vote).toBeDisabled();
  await poll.getByRole('radio', { name: 'Sushi' }).click();
  await expect(poll.getByRole('radio', { name: 'Sushi' })).toHaveAttribute('aria-checked', 'true');
  await vote.click();

  // results: my answer checked with 100 %, the others at 0 %
  const sushi = poll.locator('.poll-answer', { hasText: 'Sushi' });
  await expect(sushi).toHaveClass(/mine/);
  await expect(sushi.locator('.poll-percent')).toHaveText('100%');
  await expect(poll.locator('.poll-answer', { hasText: 'Pizza' }).locator('.poll-percent')).toHaveText('0%');
  await expect(poll).toContainText('1 vote •');

  // voters popout
  await sushi.getByRole('button', { name: /1 votes for Sushi/ }).click();
  const voters = page.getByRole('dialog', { name: 'Voters for Sushi' });
  await expect(voters.locator('li')).toHaveCount(1);
  await page.keyboard.press('Escape');

  // remove and vote again for another answer
  await poll.getByRole('button', { name: 'Remove Vote' }).click();
  await expect(poll.getByRole('radio', { name: 'Pizza' })).toBeVisible();
  await poll.getByRole('radio', { name: 'Pizza' }).click();
  await poll.getByRole('button', { name: 'Vote' }).click();
  await expect(poll.locator('.poll-answer', { hasText: 'Pizza' })).toHaveClass(/mine/);

  // polls can't be edited; the author ends it from the message menu
  const row = page.locator('.chat-msg', { has: page.locator('.poll', { hasText: question }) });
  await row.click({ button: 'right', position: { x: 600, y: 10 } });
  const menu = page.getByRole('menu', { name: 'Message actions' });
  await expect(menu.getByRole('menuitem', { name: 'Edit Message' })).toHaveCount(0);
  await menu.getByRole('menuitem', { name: 'End Poll Now' }).click();

  await expect(poll).toContainText('Poll closed');
  await expect(poll.getByRole('button', { name: 'Remove Vote' })).toHaveCount(0);
  await expect(poll.locator('.poll-answer.winner', { hasText: 'Pizza' })).toBeVisible();
  const result = page.locator('.chat-msg.system', { hasText: `poll ${question} has closed` });
  await expect(result).toBeVisible();
  await expect(result).toContainText('Pizza won with 100% (1 vote).');
  await expect(page.locator('.chat-msg.system', { hasText: question })).toHaveCount(1);
});
