import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { composer } from './helpers';

// Custom emoji against the in-memory mock (?as=sam&mockLatency=0: sam owns "Sam's server", which is seeded with four Vokko-drawn emoji).

type StoreWin = { __vokko: { appStore: { getState(): { channels: Record<string, { id: string; name?: string; guild_id: string | null }> } } } };

// 1x1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

async function openChannel(page: Page, name: string): Promise<void> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.waitForFunction(n => Object.values((window as unknown as StoreWin).__vokko.appStore.getState().channels).some(c => c.name === n && c.guild_id), name);
  const target = await page.evaluate(n => {
    const c = Object.values((window as unknown as StoreWin).__vokko.appStore.getState().channels).find(x => x.name === n && x.guild_id)!;
    return `/channels/${c.guild_id}/${c.id}`;
  }, name);
  await page.evaluate(path => { history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, target);
  await page.locator('.channel-header').getByRole('heading', { name, exact: true }).waitFor();
}

test('upload an emoji in Server Settings, use it in a message and react with it', async ({ page }) => {
  await openChannel(page, 'general');

  // ---- Server Settings > Emoji: the seeded list with uploaders, then an upload and a rename ----
  await page.locator('.guild-header-name-button').click();
  await page.getByRole('menuitem', { name: 'Server Settings' }).click();
  await page.getByRole('button', { name: 'Emoji', exact: true }).click();
  const settings = page.locator('.emoji-settings');
  await expect(settings.getByRole('heading', { name: 'Emoji', exact: true })).toBeVisible();
  await expect(settings.locator('.emoji-row')).toHaveCount(4);
  await expect(settings.locator('.emoji-row', { hasText: 'Sam' }).first()).toBeVisible();
  await expect(settings.getByRole('region', { name: 'Animated Emoji' }).locator('.emoji-row')).toHaveCount(1);

  await settings.getByLabel('Emoji file').setInputFiles({ name: 'probe blob.png', mimeType: 'image/png', buffer: PNG });
  const rename = settings.getByLabel('Rename probe_blob');
  await expect(rename).toHaveValue('probe_blob');
  await rename.fill('probe_wave');
  await rename.press('Enter');
  await expect(settings.getByLabel('Rename probe_wave')).toHaveValue('probe_wave');
  await expect(settings.getByRole('region', { name: 'Emoji', exact: true }).getByRole('heading')).toContainText('246 of 250 slots available');

  // a too-large file is refused before upload
  await settings.getByLabel('Emoji file').setInputFiles({ name: 'big.png', mimeType: 'image/png', buffer: Buffer.alloc(256 * 1024 + 1) });
  await expect(settings.getByRole('alert')).toContainText('256 KiB');
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);

  // ---- ":" autocomplete inserts the custom emoji, the message renders it jumbo ----
  const box = composer(page);
  await box.click();
  await box.pressSequentially(':probe_w');
  const option = page.locator('.chat-autocomplete-item', { hasText: ':probe_wave:' });
  await expect(option).toBeVisible();
  await expect(option.locator('img')).toHaveCount(1);
  await box.press('Enter');
  // The live editor shows the emoji as an image chip; the message source is on the chip (`data-raw`).
  await expect(box.locator('[data-atom="emoji"]')).toHaveAttribute('data-raw', /^<:probe_wave:\d+>$/);
  await box.press('Enter');
  const sent = page.locator('.chat-msg').last();
  const glyph = sent.locator('img.md-emoji-custom[alt=":probe_wave:"]');
  await expect(glyph).toBeVisible();
  await expect(sent.locator('.md-jumbo')).toHaveCount(1);
  expect(await glyph.evaluate(el => el.getBoundingClientRect().height)).toBe(48);

  // hover tooltip and click popout name the emoji and its server
  await glyph.hover();
  await expect(page.getByRole('tooltip')).toContainText(':probe_wave:');
  await glyph.click();
  await expect(page.getByRole('dialog', { name: ':probe_wave:' })).toContainText("Sam's server");
  await page.keyboard.press('Escape');

  // inline (non-jumbo) size is 22 px
  await box.click();
  await box.fill('');
  await box.pressSequentially('hello :vokko_sm');
  await box.press('Enter');
  await box.press('Enter');
  const inline = page.locator('.chat-msg').last().locator('img.md-emoji-custom[alt=":vokko_smile:"]');
  await expect(inline).toBeVisible();
  expect(await inline.evaluate(el => el.getBoundingClientRect().height)).toBe(22);

  // ---- react from the picker: server section with its icon in the rail, search finds custom emoji ----
  await sent.hover();
  await sent.getByRole('button', { name: 'Add Reaction' }).click();
  const picker = page.getByRole('dialog', { name: 'Emoji picker' });
  await expect(picker.locator('.chat-emoji-cats').getByRole('button', { name: "Sam's server" })).toBeVisible();
  await expect(picker.getByRole('region', { name: "Sam's server" }).locator('.emoji-custom-cell')).toHaveCount(4);
  await picker.getByLabel('Search emoji').fill('probe');
  await picker.getByRole('button', { name: ':probe_wave:' }).click();
  const pill = sent.locator('.chat-reaction.me');
  await expect(pill).toHaveCount(1);
  await expect(pill.locator('img[alt=":probe_wave:"]')).toBeVisible();
  await expect(pill).toContainText('1');
  // clicking the pill removes the reaction again
  await pill.click();
  await expect(sent.locator('.chat-reaction')).toHaveCount(0);
});

test('role-restricted emoji only show up for members with the role', async ({ page }) => {
  await openChannel(page, 'general');
  await page.locator('.chat-textarea').click();
  await composer(page).pressSequentially(':mods_o');
  // sam is an Admin, not a Moderator: mods_only is restricted to Moderator
  await expect(page.locator('.chat-autocomplete-item', { hasText: ':mods_only:' })).toHaveCount(0);
  await composer(page).fill('');
  await composer(page).pressSequentially(':ship_');
  await expect(page.locator('.chat-autocomplete-item', { hasText: ':ship_it:' })).toBeVisible();
});
