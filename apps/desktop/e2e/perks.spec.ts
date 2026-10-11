import { expect, test } from '@playwright/test';

// Profile perks (free in Vokko): banner colour, pronouns, theme colours, avatar decoration, profile effect, per-server profile.

async function openProfiles(page: import('@playwright/test').Page) {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  await page.getByRole('button', { name: 'User Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'User Settings' });
  await dialog.locator('.sm-profile-edit').click();
  await expect(dialog.getByRole('heading', { name: 'Profiles', level: 1 })).toBeVisible();
  return dialog;
}

test('profile perks are all enabled and show in the preview and the profile card', async ({ page }) => {
  const dialog = await openProfiles(page);
  await expect(dialog).not.toContainText(/nitro|upgrade|subscribe/i);

  await dialog.getByRole('textbox', { name: 'Pronouns' }).fill('they/them');
  await dialog.getByRole('radio', { name: 'Forest' }).click();
  await dialog.getByRole('radiogroup', { name: 'Avatar decoration' }).getByRole('radio').nth(1).click();
  await dialog.getByRole('radiogroup', { name: 'Profile effect' }).getByRole('radio').nth(1).click();

  // live preview carries the decoration, the effect, the theme and the pronouns before saving
  const preview = dialog.locator('.profile-card.static');
  await expect(preview.locator('.avatar-deco')).toHaveCount(1);
  await expect(preview.locator('.profile-effect')).toHaveCount(1);
  await expect(preview).toHaveClass(/pv-themed/);
  await expect(preview).toContainText('they/them');

  await dialog.getByRole('button', { name: 'Save Changes' }).click();
  await expect(dialog.getByRole('button', { name: 'Save Changes' })).toHaveCount(0);

  const me = await page.evaluate(() => (window as unknown as { __vokko: { appStore: { getState(): { me: Record<string, unknown> } } } }).__vokko.appStore.getState().me);
  expect(me.pronouns).toBe('they/them');
  expect(me.avatar_decoration).toBeTruthy();
  expect(me.profile_effect).toBeTruthy();
  expect(me.theme_colors).toHaveLength(2);

  // the user panel avatar and the profile card popout render the perks
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.user-panel .avatar-deco')).toHaveCount(1);
});

test('a per-server profile overrides the global fields only in that server', async ({ page }) => {
  const dialog = await openProfiles(page);
  await dialog.getByRole('tab', { name: 'Per-server profiles' }).click();
  await dialog.getByRole('textbox', { name: 'Pronouns' }).fill('server/pronouns');
  await dialog.getByRole('button', { name: 'Save Changes' }).click();
  await expect(dialog.getByRole('button', { name: 'Save Changes' })).toHaveCount(0);

  const stored = await page.evaluate(() => {
    const s = (window as unknown as { __vokko: { appStore: { getState(): { me: { id: string; pronouns?: string | null }; members: Record<string, Record<string, { pronouns?: string | null }>> } } } }).__vokko.appStore.getState();
    return { global: s.me.pronouns ?? null, perServer: Object.values(s.members).map(m => m[s.me.id]?.pronouns).filter(Boolean) };
  });
  expect(stored.global).toBeNull();
  expect(stored.perServer).toContain('server/pronouns');
});
