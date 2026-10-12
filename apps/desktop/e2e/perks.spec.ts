import { expect, test } from '@playwright/test';
import { message, openDm, openStockTalk, send } from './helpers';

// Profile perks (free in Vokko): banner colour, pronouns, theme colours, avatar decoration, profile effect, per-server profile.

async function openProfiles(page: import('@playwright/test').Page) {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  // the Profiles page is reached from the user panel popout; the settings header opens the profile editor instead
  await page.locator('.user-panel-account').click();
  await page.getByRole('menuitem', { name: 'Edit Profile' }).click();
  const dialog = page.getByRole('dialog', { name: 'User Settings' });
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
  // the button reads "Saving…" while the request is in flight: the save bar (which also shows a failed save's error) goes away once it is done
  await expect(dialog.getByRole('alert')).toHaveCount(0);

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
  // the button reads "Saving…" while the request is in flight, so wait for the save bar itself to go away
  await expect(dialog.getByRole('alert').filter({ hasText: 'unsaved changes' })).toHaveCount(0);

  const stored = await page.evaluate(() => {
    const s = (window as unknown as { __vokko: { appStore: { getState(): { me: { id: string; pronouns?: string | null }; members: Record<string, Record<string, { pronouns?: string | null }>> } } } }).__vokko.appStore.getState();
    return { global: s.me.pronouns ?? null, perServer: Object.values(s.members).map(m => m[s.me.id]?.pronouns).filter(Boolean) };
  });
  expect(stored.global).toBeNull();
  expect(stored.perServer).toContain('server/pronouns');
});

async function pickReaction(page: import('@playwright/test').Page, target: import('@playwright/test').Locator, query: string, burst: boolean) {
  await target.hover();
  await target.getByRole('button', { name: 'Add Reaction' }).first().click();
  if (burst) {
    await page.getByRole('button', { name: 'Super Reaction' }).click();
    await expect(page.getByRole('button', { name: 'Super Reaction' })).toHaveAttribute('aria-pressed', 'true');
  }
  await page.getByRole('textbox', { name: 'Search emoji' }).fill(query);
  await page.locator('.chat-emoji-cell').first().click();
}

test('super react from the picker: glowing burst pill, particles, split tooltip', async ({ page }) => {
  await openDm(page);
  await send(page, 'super react to this');
  const target = message(page, 'super react to this');
  await expect(target).not.toHaveClass(/pending/);

  await pickReaction(page, target, 'rocket', true);
  const burst = target.locator('.chat-reaction.burst.me');
  await expect(burst).toHaveCount(1);
  await expect(burst).toHaveAttribute('aria-pressed', 'true');
  // glow in the emoji's own colours, and a short particle burst that cleans up after itself
  await expect(burst).toHaveAttribute('style', /--burst-a/);
  await expect(burst.getByTestId('burst-particles')).toHaveCount(1);
  await expect(burst.getByTestId('burst-particles')).toHaveCount(0, { timeout: 3000 });

  // a normal reaction with the same emoji is a separate pill; the tooltip splits super and normal reactors
  await pickReaction(page, target, 'rocket', false);
  await expect(target.locator('.chat-reaction:not(.burst).me')).toHaveCount(1);
  await burst.hover();
  const tip = page.locator('.reactors-split');
  await expect(tip).toContainText('Super Reactions');
  await expect(tip).toContainText('super reacted with 🚀');
  await expect(tip).toContainText('reacted with 🚀');

  // clicking the burst pill takes only the super reaction back
  await burst.click();
  await expect(target.locator('.chat-reaction.burst')).toHaveCount(0);
  await expect(target.locator('.chat-reaction.me')).toHaveCount(1);
});

test('reduced motion: no particles on a super reaction', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openDm(page);
  await send(page, 'calm super reaction');
  const target = message(page, 'calm super reaction');
  await expect(target).not.toHaveClass(/pending/);
  await pickReaction(page, target, 'rocket', true);
  await expect(target.locator('.chat-reaction.burst.me')).toHaveCount(1);
  await page.waitForTimeout(100);
  await expect(target.getByTestId('burst-particles')).toHaveCount(0);
});

test('decoration, effect, nameplate and name style show in the popout and the member list', async ({ page }) => {
  await openStockTalk(page);
  await page.getByRole('button', { name: 'User Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'User Settings' });
  await settings.locator('.sm-profile-edit').click();
  // the profile editor is its own dialog over settings; each tile opens one inline panel at a time
  const editor = page.getByRole('dialog', { name: 'Edit Profile' });
  await expect(editor).toBeVisible();
  const pick = async (tile: string, ...options: [group: string, option: string][]) => {
    await editor.getByRole('button', { name: tile, exact: true }).click();
    for (const [group, option] of options) await editor.getByRole('radiogroup', { name: group }).getByRole('radio', { name: option }).click();
  };
  await pick('Avatar decoration', ['Avatar decoration', 'Halo']);
  await pick('Profile effect', ['Profile effect', 'Snowfall']);
  await pick('Nameplate', ['Nameplate', 'Aurora']);
  await pick('Display name style', ['Display name font', 'Serif'], ['Display name effect', 'Gradient']);
  await expect(editor.getByRole('button', { name: 'Nameplate', exact: true }).locator('.nameplate')).toHaveCount(1);
  await editor.getByRole('button', { name: 'Edit Bio' }).click();
  await editor.getByRole('textbox', { name: 'Bio' }).fill('I like **bold** things');
  await editor.getByRole('button', { name: 'Save Changes' }).click();
  await expect(editor.getByRole('alert').filter({ hasText: 'unsaved changes' })).toHaveCount(0);

  const me = await page.evaluate(() => (window as unknown as { __vokko: { appStore: { getState(): { me: Record<string, unknown> } } } }).__vokko.appStore.getState().me);
  expect(me.nameplate).toBe('aurora');
  expect(me.display_name_styles).toMatchObject({ font_id: 'serif', effect_id: 'gradient' });
  expect((me.display_name_styles as { colors: number[] }).colors).toHaveLength(2);

  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  const row = page.locator('.member-row', { hasText: /sam/i }).first();
  await expect(row.locator('.nameplate[data-nameplate="aurora"]')).toHaveCount(1);
  await expect(row.locator('.avatar-deco[data-decoration="halo"]')).toHaveCount(1);
  await expect(row.locator('.styled-name.dn-gradient')).toHaveCount(1);

  await row.click();
  const card = page.locator('.profile-card').last();
  await expect(card.locator('.avatar-deco[data-decoration="halo"]')).toHaveCount(1);
  await expect(card.locator('.profile-effect[data-effect="snowfall"]')).toHaveCount(1);
  await expect(card.locator('.styled-name.dn-gradient')).toHaveCount(1);
  // the bio is Markdown, rendered as elements (not HTML from the text)
  await expect(card.locator('.pv-bio strong')).toHaveText('bold');
});
