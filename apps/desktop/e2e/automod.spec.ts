import { expect, test, type Page } from '@playwright/test';
import { pickOption } from './helpers';

// AutoMod settings on the mock backend: Discord's four rule cards, the three-step editor, and what a saved rule shows.
// Enforcement itself is covered by mock/admin.test.ts and the server tests (server_admin.rs).

const SHOTS = process.env.VOKKO_AUTOMOD_SHOTS;

async function openAutoMod(page: Page): Promise<void> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.locator('.chat-msg').first().waitFor();
  await page.locator('.guild-header-name-button').click();
  await page.getByRole('menuitem', { name: 'Server Settings' }).click();
  await page.getByRole('dialog', { name: /Server Settings/ }).waitFor();
  await page.getByRole('button', { name: 'AutoMod', exact: true }).click();
  await page.getByRole('list', { name: 'AutoMod rules' }).waitFor();
}

test('AutoMod: set up mention spam with alert and timeout, then flagged words with an allow list', async ({ page }) => {
  await openAutoMod(page);
  const rules = page.getByRole('list', { name: 'AutoMod rules' });
  for (const title of ['Block Mention Spam', 'Block Suspected Spam Content', 'Block Commonly Flagged Words']) {
    await expect(rules.getByRole('button', { name: `Set Up ${title}` })).toBeVisible();
  }
  await expect(rules.getByRole('button', { name: 'Create Block Custom Words' })).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/automod-list.png` });

  await rules.getByRole('button', { name: 'Set Up Block Mention Spam' }).click();
  const editor = page.getByRole('listitem', { name: 'Edit Block Mention Spam' });
  await expect(editor.getByLabel('Mention limit')).toHaveValue('20');
  await editor.getByRole('button', { name: 'Fewer mentions' }).click();
  await expect(editor.getByLabel('Mention limit')).toHaveValue('19');
  await editor.getByLabel('Mention limit').fill('5');

  const bar = page.locator('.cs-savebar');
  await editor.getByRole('checkbox', { name: /Send alert/ }).check();
  await expect(bar).toContainText('Choose a channel for the alert.');
  await expect(bar.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
  await pickOption(page, editor.getByRole('combobox', { name: 'Alert channel' }), '#general');
  await editor.getByRole('checkbox', { name: /Time out member/ }).check();
  await pickOption(page, editor.getByRole('combobox', { name: 'Timeout duration' }), '5 minutes');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/automod-editor.png`, fullPage: true });
  await bar.getByRole('button', { name: 'Save Changes' }).click();
  await expect(bar).toBeHidden();

  // The saved rule is an Edit card with its three actions; reopening shows what was saved.
  await expect(rules.getByRole('button', { name: 'Edit Block Mention Spam' })).toBeVisible();
  await expect(rules.locator('.am-card').first()).toContainText('timeout member');
  await rules.getByRole('button', { name: 'Edit Block Mention Spam' }).click();
  await expect(editor.getByLabel('Mention limit')).toHaveValue('5');
  await expect(editor.getByRole('combobox', { name: 'Alert channel' })).toContainText('#general');
  await expect(editor.getByRole('combobox', { name: 'Timeout duration' })).toContainText('5 minutes');
  await bar.getByRole('button', { name: 'Reset' }).click();

  // Flagged words: no timeout on offer, categories and an allow list.
  await rules.getByRole('button', { name: 'Set Up Block Commonly Flagged Words' }).click();
  const preset = page.getByRole('listitem', { name: 'Edit Block Commonly Flagged Words' });
  await expect(preset.getByRole('checkbox', { name: /Time out member/ })).toHaveCount(0);
  await preset.getByRole('checkbox', { name: /Sexual Content/ }).uncheck();
  await preset.getByLabel('Allowed words').fill('scunthorpe');
  await bar.getByRole('button', { name: 'Save Changes' }).click();
  await expect(bar).toBeHidden();
  await rules.getByRole('button', { name: 'Edit Block Commonly Flagged Words' }).click();
  await expect(preset.getByRole('checkbox', { name: /Sexual Content/ })).not.toBeChecked();
  await expect(preset.getByRole('checkbox', { name: /Profanity/ })).toBeChecked();
  await expect(preset.getByLabel('Allowed words')).toHaveValue('scunthorpe');

  // Delete puts the Set Up card back.
  await preset.getByRole('button', { name: 'Delete Block Commonly Flagged Words' }).click();
  await expect(rules.getByRole('button', { name: 'Set Up Block Commonly Flagged Words' })).toBeVisible();
});

test('AutoMod: custom word rules stop at six', async ({ page }) => {
  await openAutoMod(page);
  const rules = page.getByRole('list', { name: 'AutoMod rules' });
  const bar = page.locator('.cs-savebar');
  for (let n = 1; n <= 6; n++) {
    await rules.getByRole('button', { name: 'Create Block Custom Words' }).click();
    const editor = page.getByRole('listitem', { name: 'Edit Block Custom Words' });
    await editor.getByLabel('Rule name').fill(`Words ${n}`);
    await editor.getByLabel('Blocked words').fill(`bad${n}*`);
    await bar.getByRole('button', { name: 'Save Changes' }).click();
    await expect(bar).toBeHidden();
  }
  await expect(rules.getByRole('button', { name: /^Edit Words / })).toHaveCount(6);
  await expect(rules.getByRole('button', { name: 'Limit Reached Block Custom Words' })).toBeVisible();
});

test('AutoMod at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.locator('.guild-header-name-button').click();
  await page.getByRole('menuitem', { name: 'Server Settings' }).click();
  await page.getByRole('button', { name: 'AutoMod', exact: true }).click();
  const rules = page.getByRole('list', { name: 'AutoMod rules' });
  await rules.getByRole('button', { name: 'Set Up Block Mention Spam' }).click();
  await page.getByRole('listitem', { name: 'Edit Block Mention Spam' }).getByRole('checkbox', { name: /Send alert/ }).check();
  const overflow = await page.evaluate(() => [...document.querySelectorAll('.am-card')].some(el => el.scrollWidth > el.clientWidth + 1));
  expect(overflow).toBe(false);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/automod-phone.png`, fullPage: true });
});
