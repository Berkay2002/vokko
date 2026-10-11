import { expect, test } from '@playwright/test';
import { openDm } from './helpers';

// Quick switcher recents, keyboard shortcuts dialog and the unsaved-changes bar (mock backend).
test.use({ viewport: { width: 1280, height: 900 } });

test('quick switcher lists previously visited channels first and the PROTIP label is green', async ({ page }) => {
  await openDm(page, 'alice');
  const aliceUrl = page.url();
  await page.locator('.dm-row').filter({ hasNotText: /alice/i }).first().click();
  await page.locator('.chat-msg').first().waitFor();
  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('.quick-heading')).toHaveText('Previous channels');
  await expect(dialog.getByRole('option').first()).toContainText(/alice/i);
  await expect(dialog.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  const label = dialog.locator('.quick-tip-label');
  const [color, positive] = await Promise.all([
    label.evaluate(el => getComputedStyle(el).color),
    page.evaluate(() => { const p = document.createElement('i'); p.style.color = 'var(--text-feedback-positive)'; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; }),
  ]);
  expect(color).toBe(positive);
  await dialog.getByRole('option').first().click();
  await expect(page).toHaveURL(aliceUrl);
});

test('Ctrl+/ opens the shortcuts dialog with key-cap cards, Escape closes it', async ({ page }) => {
  await openDm(page, 'alice');
  await page.keyboard.press('Control+/');
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.shortcuts-heading').first()).toHaveText('Navigation');
  const card = dialog.locator('.shortcut-card', { hasText: 'Quick switcher' });
  await expect(card.locator('.shortcut-cap')).toHaveText([/^(Ctrl|Cmd)$/, 'K']);
  expect(await dialog.locator('.shortcuts-grid').first().evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(4);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('server profile name shows the unsaved-changes bar; Reset reverts, Save Changes saves', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  await page.getByRole('link', { name: /Vokko|server/i }).first().click();
  await page.locator('.guild-header-name-button').click();
  await page.getByRole('menuitem', { name: 'Server Settings' }).click();
  const dialog = page.getByRole('dialog', { name: /Server Settings/ });
  const name = dialog.getByRole('textbox', { name: 'Server name' });
  const bar = dialog.locator('.cs-savebar');
  await expect(bar).toHaveCount(0);
  const before = await name.inputValue();
  await name.fill(`${before} 2`);
  await expect(bar).toContainText('unsaved changes');
  // a small dialog on top (Ctrl+/, Ctrl+K) parks the settings instead of dropping the edit
  await page.keyboard.press('Control+/');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(name).toHaveValue(`${before} 2`);
  await expect(bar).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(page.locator('.quick-input')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(name).toHaveValue(`${before} 2`);
  // trailing whitespace is not a change
  await name.fill(`${before}  `);
  await expect(bar).toHaveCount(0);
  await name.fill(`${before} 2`);
  await bar.getByRole('button', { name: 'Reset' }).click();
  await expect(name).toHaveValue(before);
  await expect(bar).toHaveCount(0);
  await name.fill(`${before} 2`);
  await bar.getByRole('button', { name: 'Save Changes' }).click();
  await expect(bar).toHaveCount(0);
  await expect(name).toHaveValue(`${before} 2`);
});
