import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Profile editor modal: opened from the User Settings header, stacked over settings. Mock backend.

type Win = {
  __vokko: {
    appStore: {
      getState(): {
        me: Record<string, unknown> & { id: string };
        guilds: Record<string, { name: string }>;
        guildOrder: string[];
        members: Record<string, Record<string, Record<string, unknown>>>;
      };
    };
  };
};

async function openEditor(page: Page) {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  await page.getByRole('button', { name: 'User Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'User Settings' });
  await settings.locator('.sm-profile-edit').click();
  const editor = page.getByRole('dialog', { name: 'Edit Profile' });
  await expect(editor).toBeVisible();
  return { settings, editor };
}

const me = (page: Page) => page.evaluate(() => (window as unknown as Win).__vokko.appStore.getState().me);

test('the settings header opens the editor over settings; Esc closes only the editor', async ({ page }) => {
  const { settings, editor } = await openEditor(page);

  // settings stays mounted behind the editor; the editor has its three columns and offers every perk without an upsell
  await expect(page.locator('.sm-profile-edit')).toBeAttached();
  await expect(editor.getByRole('complementary', { name: 'Profile customisation' })).toBeVisible();
  await expect(editor.getByTestId('pe-card')).toBeVisible();
  await expect(editor.getByRole('tab', { name: 'Board' })).toHaveAttribute('aria-selected', 'true');
  await expect(editor.getByRole('tab', { name: 'Activity' })).toBeVisible();
  await expect(editor).not.toContainText(/nitro|upgrade|subscribe|wishlist/i);

  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  await expect(settings).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
});

test('Tab and Shift+Tab walk through the editor controls and never leave it while settings is parked underneath', async ({ page }) => {
  const { editor } = await openEditor(page);
  // every key press must land on a different element that is still inside the editor (two stacked traps used to pin focus to one control)
  const step = async (key: string, label: string) => {
    const before = await page.evaluateHandle(() => document.activeElement);
    await page.keyboard.press(key);
    const state = await page.evaluate(
      before => {
        const now = document.activeElement;
        return { moved: now !== before, inside: !!now?.closest('.pe[role="dialog"]') };
      },
      before,
    );
    expect(state, label).toEqual({ moved: true, inside: true });
  };
  const seen = new Set<string>();
  for (let i = 0; i < 45; i++) {
    await step('Tab', `Tab ${i + 1}`);
    seen.add(await page.evaluate(() => `${document.activeElement?.getAttribute('aria-label') ?? ''}|${document.activeElement?.textContent?.slice(0, 20) ?? ''}`));
  }
  expect(seen.size).toBeGreaterThan(15);
  for (let i = 0; i < 12; i++) await step('Shift+Tab', `Shift+Tab ${i + 1}`);
  await expect(editor).toBeVisible();
});

test('display name and bio edit in place; the guard bar blocks closing until saved', async ({ page }) => {
  const { editor } = await openEditor(page);
  const bar = editor.locator('.cs-savebar');
  await expect(bar).toHaveCount(0);

  await editor.getByRole('button', { name: 'Edit Display name' }).click();
  const name = editor.getByRole('textbox', { name: 'Display name' });
  await expect(name).toBeFocused();
  await name.fill('Sam Edited');
  await expect(bar).toBeVisible();
  // Esc ends the inline edit first and leaves the editor open
  await page.keyboard.press('Escape');
  await expect(name).toHaveCount(0);
  await expect(editor).toBeVisible();

  await editor.getByRole('button', { name: 'Edit Bio' }).click();
  await editor.getByRole('textbox', { name: 'Bio' }).fill('Mid laner. Shield enjoyer.');
  await editor.getByRole('textbox', { name: 'Bio' }).blur();
  await expect(editor.getByTestId('pe-card')).toContainText('Mid laner. Shield enjoyer.');

  // the unsaved guard refuses Esc and the close button, and the bar shakes
  await page.keyboard.press('Escape');
  await expect(editor).toBeVisible();
  await expect(bar).toHaveAttribute('data-shake', /^[ab]$/);
  await editor.getByRole('button', { name: 'Close' }).click();
  await expect(editor).toBeVisible();

  await bar.getByRole('button', { name: 'Save Changes' }).click();
  await expect(bar).toHaveCount(0);
  const saved = await me(page);
  expect(saved.global_name).toBe('Sam Edited');
  expect(saved.bio).toBe('Mid laner. Shield enjoyer.');
  await expect(page.locator('.sm-profile-name')).toHaveText('Sam Edited');

  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
});

test('Reset drops the draft', async ({ page }) => {
  const { editor } = await openEditor(page);
  const before = (await me(page)).global_name;
  await editor.getByRole('button', { name: 'Edit Display name' }).click();
  await editor.getByRole('textbox', { name: 'Display name' }).fill('Throwaway');
  await editor.getByRole('textbox', { name: 'Display name' }).blur();
  await expect(editor.locator('.cs-savebar')).toBeVisible();
  await editor.getByRole('button', { name: 'Reset' }).click();
  await expect(editor.locator('.cs-savebar')).toHaveCount(0);
  await expect(editor.getByTestId('pe-card')).not.toContainText('Throwaway');
  expect((await me(page)).global_name).toBe(before);
});

test('avatar menu: decoration opens its panel, previews live and saves; Remove avatar is a danger item', async ({ page }) => {
  const { editor } = await openEditor(page);
  await editor.getByRole('button', { name: 'Edit avatar' }).click();
  await expect(page.getByRole('menuitem', { name: 'Change avatar', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Remove avatar' })).toHaveClass(/danger/);
  await page.getByRole('menuitem', { name: 'Change avatar decoration' }).click();

  const grid = editor.getByRole('radiogroup', { name: 'Avatar decoration' });
  await expect(grid).toBeVisible();
  await grid.getByRole('radio').nth(1).click();
  await expect(editor.getByTestId('pe-card').locator('.avatar-deco')).toHaveCount(1);

  await editor.locator('.cs-savebar').getByRole('button', { name: 'Save Changes' }).click();
  await expect(editor.locator('.cs-savebar')).toHaveCount(0);
  expect((await me(page)).avatar_decoration).toBeTruthy();
});

test('tiles: theme, banner colour and effect preview on the card; nameplate and display name style tiles are live', async ({ page }) => {
  const { editor } = await openEditor(page);
  await editor.getByRole('button', { name: 'Profile theme' }).click();
  await editor.getByRole('radio', { name: 'Forest' }).click();
  await expect(editor.getByTestId('pe-card')).toHaveClass(/pv-themed/);

  await editor.getByRole('button', { name: 'Banner colour', exact: true }).click();
  await editor.getByRole('button', { name: '#dc4247' }).click();
  await expect(editor.getByTestId('pe-card').locator('.pe-card-banner')).toHaveCSS('background-color', 'rgb(220, 66, 71)');

  await editor.getByRole('button', { name: 'Profile effect', exact: true }).click();
  await editor.getByRole('radiogroup', { name: 'Profile effect' }).getByRole('radio').nth(1).click();
  await expect(editor.getByTestId('pe-card').locator('.profile-effect')).toHaveCount(1);

  // the perks pickers are registered, so these tiles are live (perks.spec.ts drives them)
  await expect(editor.getByRole('button', { name: 'Nameplate' })).toBeEnabled();
  await expect(editor.getByRole('button', { name: 'Display name style' })).toBeEnabled();
  // the frame picker is still unregistered: its tile says so and stays inert
  const soon = editor.getByRole('button', { name: 'Profile frame' });
  await expect(soon).toBeDisabled();
  await expect(soon).toContainText('Coming soon');
});

test('the profile switcher lists the servers; a server profile edits its own pronouns and locks shared tiles', async ({ page }) => {
  const { editor } = await openEditor(page);
  const names = await page.evaluate(() => {
    const s = (window as unknown as Win).__vokko.appStore.getState();
    return s.guildOrder.map(id => s.guilds[id]!.name);
  });
  expect(names.length).toBeGreaterThan(0);

  await editor.locator('.pe-switcher').click();
  await expect(page.getByRole('menuitemcheckbox', { name: 'Main Profile' })).toHaveAttribute('aria-checked', 'true');
  for (const name of names) await expect(page.getByRole('menuitemcheckbox', { name, exact: true })).toBeVisible();
  await page.getByRole('menuitemcheckbox', { name: names[0]!, exact: true }).click();

  await expect(editor.locator('.pe-switcher-label')).toHaveText(names[0]!);
  await expect(editor.getByRole('button', { name: 'Banner colour', exact: true })).toBeDisabled();
  await expect(editor.getByRole('button', { name: 'Avatar decoration' })).toBeDisabled();
  await expect(editor.getByRole('button', { name: 'Avatar', exact: true })).toBeEnabled();

  await editor.getByRole('button', { name: 'Edit Pronouns' }).click();
  await editor.getByRole('textbox', { name: 'Pronouns' }).fill('server/pronouns');
  await editor.getByRole('textbox', { name: 'Pronouns' }).blur();
  await editor.locator('.cs-savebar').getByRole('button', { name: 'Save Changes' }).click();
  await expect(editor.locator('.cs-savebar')).toHaveCount(0);

  const stored = await page.evaluate(() => {
    const s = (window as unknown as Win).__vokko.appStore.getState();
    return { global: (s.me.pronouns as string | null | undefined) ?? null, perServer: Object.values(s.members).map(m => m[s.me.id]?.pronouns).filter(Boolean) };
  });
  expect(stored.global).toBeNull();
  expect(stored.perServer).toContain('server/pronouns');
});

test('switching profiles is refused while there are unsaved changes', async ({ page }) => {
  const { editor } = await openEditor(page);
  await editor.getByRole('button', { name: 'Edit Display name' }).click();
  await editor.getByRole('textbox', { name: 'Display name' }).fill('Unsaved');
  await editor.getByRole('textbox', { name: 'Display name' }).blur();
  await editor.locator('.pe-switcher').click();
  await page.getByRole('menuitemcheckbox').nth(1).click();
  await expect(editor.locator('.pe-switcher-label')).toHaveText('Main Profile');
  await expect(editor.locator('.cs-savebar')).toHaveAttribute('data-shake', /^[ab]$/);
});

test('board widgets: add a favourite game and a games list, save, and they persist on the user', async ({ page }) => {
  const { editor } = await openEditor(page);
  await editor.getByRole('button', { name: 'Add widget' }).click();
  await page.getByRole('menuitem', { name: 'Favourite game' }).click();
  await editor.getByRole('textbox', { name: 'Favourite game name' }).fill('Hades');
  await editor.getByRole('textbox', { name: "Why it's your favourite" }).fill('Every run feels different.');
  await editor.getByRole('textbox', { name: 'Add a tag' }).fill('roguelike');
  await page.keyboard.press('Enter');

  await editor.getByRole('button', { name: 'Add widget' }).click();
  await page.getByRole('menuitem', { name: 'Games I like' }).click();
  await editor.getByRole('button', { name: 'Add a game' }).click();
  await editor.getByRole('textbox', { name: 'Game name', exact: true }).fill('Celeste');
  await page.keyboard.press('Enter');
  await expect(editor.getByRole('button', { name: 'Remove Celeste' })).toBeVisible();

  await editor.locator('.cs-savebar').getByRole('button', { name: 'Save Changes' }).click();
  await expect(editor.locator('.cs-savebar')).toHaveCount(0);
  const widgets = (await me(page)).widgets as { favorite_game: { name: string; reason: string; tags: string[] }; games_i_like: { name: string }[] };
  expect(widgets.favorite_game).toMatchObject({ name: 'Hades', reason: 'Every run feels different.', tags: ['roguelike'] });
  expect(widgets.games_i_like.map(g => g.name)).toEqual(['Celeste']);
});

test('custom status bubble sets the status note immediately, outside the draft', async ({ page }) => {
  const { editor } = await openEditor(page);
  await editor.getByRole('button', { name: "What's on your mind?" }).click();
  await editor.getByRole('textbox', { name: 'Custom status' }).fill('Queueing up');
  await page.keyboard.press('Enter');
  await expect(editor.locator('.pe-status-bubble')).toContainText('Queueing up');
  await expect(editor.locator('.cs-savebar')).toHaveCount(0);

  await editor.getByRole('tab', { name: 'Activity' }).click();
  await expect(editor.getByRole('heading', { name: 'Activity' })).toBeVisible();
  await expect(editor).toContainText('Queueing up');
});

test('the Profiles settings page still opens from the user panel popout', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  await page.locator('.user-panel-account').click();
  await page.getByRole('menuitem', { name: 'Edit Profile' }).click();
  await expect(page.getByRole('dialog', { name: 'User Settings' }).getByRole('heading', { name: 'Profiles', level: 1 })).toBeVisible();
});
