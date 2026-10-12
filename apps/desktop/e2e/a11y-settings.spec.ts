import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { message, openDm, pickOption, send } from './helpers';

// Settings > Accessibility (src/shell/settings/AccessibilityPage.tsx): every control must change a computed style or a behaviour
// somewhere in the app, and survive a reload. Runs on the mock backend. Set VOKKO_SHOTS=<dir> to write the page screenshots there.

const SHOTS = process.env.VOKKO_SHOTS;
const PREFS_KEY = 'vokko.prefs';

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** Pre-seeds the stored settings before the app starts (the app reads them once at load). */
async function seedPrefs(page: Page, prefs: Record<string, unknown>): Promise<void> {
  await page.addInitScript(([key, value]) => localStorage.setItem(key!, value!), [PREFS_KEY, JSON.stringify(prefs)]);
}

async function storedPrefs(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>, PREFS_KEY);
}

async function openGuild(page: Page): Promise<void> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.locator('.chat-msg').first().waitFor();
}

async function openAccessibility(page: Page): Promise<Locator> {
  await openGuild(page);
  await page.getByRole('button', { name: 'User Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'User Settings' });
  await dialog.waitFor();
  await dialog.getByRole('button', { name: 'Accessibility', exact: true }).click();
  await dialog.getByRole('slider', { name: 'Chat font size' }).waitFor();
  return dialog;
}

const slider = (dialog: Locator, name: string) => dialog.getByRole('slider', { name });
const toggle = (dialog: Locator, name: string) => dialog.getByRole('switch', { name, exact: true });
const radio = (dialog: Locator, group: string, name: RegExp) => dialog.getByRole('radiogroup', { name: group }).getByRole('radio', { name });

/** Moves a marker slider to `target` with the arrow keys (the way a keyboard user would). */
async function setSlider(dialog: Locator, name: string, target: number): Promise<void> {
  const el = slider(dialog, name);
  await el.focus();
  for (let i = 0; i < 24; i += 1) {
    const now = Number(await el.getAttribute('aria-valuenow'));
    if (now === target) return;
    await el.press(now < target ? 'ArrowRight' : 'ArrowLeft');
  }
  throw new Error(`could not set ${name} to ${target}`);
}

const root = (page: Page) => page.locator('html');
const rootToken = (page: Page, name: string) => page.evaluate(n => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
const style = (loc: Locator, prop: string) => loc.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);

const channelRgb = (value: string): number[] => (/\d+(\.\d+)?/g.exec(value) ? value.match(/\d+(\.\d+)?/g)!.slice(0, 3).map(Number) : []);

test.describe('page', () => {
  test('lists every Discord section and control, with the preview pinned on top', async ({ page }) => {
    const dialog = await openAccessibility(page);
    for (const title of ['Text Readability', 'Visual Density', 'Color & Contrast', 'Reduced Motion', 'Audio & Screen Reader', 'Related settings']) {
      await expect(dialog.getByRole('heading', { name: title })).toBeVisible();
    }
    for (const name of ['Chat font size', 'Space between message groups', 'Zoom level', 'Saturation', 'Minimum notification duration', 'Text-to-speech rate']) {
      await expect(slider(dialog, name)).toBeVisible();
    }
    for (const name of [
      'Always underline links', 'Display name styles', 'Apply saturation to custom colors', 'Enable high contrast mode', 'Sync contrast settings with computer',
      'Show switch indicators', 'Enable reduced motion', 'Sync with computer', 'Play GIFs when Vokko is focused', 'Play animated emoji', 'Show image descriptions', 'Use legacy chat input',
    ]) {
      await expect(toggle(dialog, name)).toBeVisible();
    }
    await expect(dialog.getByRole('combobox', { name: 'Role colors' })).toBeVisible();
    await expect(radio(dialog, 'UI density', /^Spacious/)).toBeVisible();
    await expect(radio(dialog, 'Chat message display', /^Standard/)).toBeVisible();
    await expect(radio(dialog, 'Sticker animations', /^Animate on interaction/)).toBeVisible();

    const preview = dialog.getByRole('group', { name: 'Preview' });
    await expect(preview.locator('.chat-msg')).toHaveCount(2);
    await expect(preview.locator('.chat-reaction')).toHaveCount(2);
    await expect(preview.locator('.a11y-sample-avatar')).toHaveCount(3);
    await expect(preview.locator('.a11y-sample-button')).toBeVisible();
    // screen reader pass: the sample content is not a tab stop, and a control names its row note as its description
    await expect(preview.getByRole('link')).toHaveAttribute('tabindex', '-1');
    await expect(slider(dialog, 'Zoom level')).toHaveAccessibleDescription(/Scales the whole app/);
    await expect(toggle(dialog, 'Enable high contrast mode')).toHaveAccessibleDescription(/Stronger text, borders/);
    await expect(dialog.getByRole('radiogroup', { name: 'UI density' })).toHaveAccessibleDescription(/How much space the server list/);
    // pinned: still in view after the page scrolls to the bottom
    await dialog.locator('.sm-scroll, .sm-main, .settings-content-inner').first().evaluate(el => { el.scrollTop = el.scrollHeight; });
    const box = await preview.boundingBox();
    expect(box && box.y >= 0 && box.y < 400).toBe(true);
    await shot(page, 'a11y-page');
  });

  test('Related settings opens Appearance', async ({ page }) => {
    const dialog = await openAccessibility(page);
    await dialog.locator('.a11y-related').click();
    await expect(dialog.getByRole('heading', { name: 'Appearance' }).first()).toBeVisible();
    await expect(dialog.getByRole('slider', { name: 'Chat font size' })).toHaveCount(0);
  });
});

test.describe('text readability', () => {
  test('chat font size drives the preview and the chat, and persists', async ({ page }) => {
    const dialog = await openAccessibility(page);
    const preview = dialog.locator('.a11y-preview .chat-content').first();
    expect(await style(preview, 'font-size')).toBe('16px');
    await setSlider(dialog, 'Chat font size', 20);
    expect(await style(preview, 'font-size')).toBe('20px');
    await expect(slider(dialog, 'Chat font size')).toHaveAttribute('aria-valuetext', '20px');
    expect(await style(page.locator('.chat-view .chat-content').first(), 'font-size')).toBe('20px');
    expect((await storedPrefs(page)).fontSize).toBe(20);
    await page.reload();
    expect(await rootToken(page, '--user-chat-font-size')).toBe('20px');
  });

  test('the slider offers the 14px step and clicking a tick sets it', async ({ page }) => {
    const dialog = await openAccessibility(page);
    await setSlider(dialog, 'Chat font size', 14);
    await expect(slider(dialog, 'Chat font size')).toHaveAttribute('aria-valuenow', '14');
    const track = slider(dialog, 'Chat font size');
    const box = (await track.boundingBox())!;
    await page.mouse.click(box.x + box.width - 2, box.y + box.height / 2);
    await expect(track).toHaveAttribute('aria-valuenow', '24');
  });

  test('always underline links', async ({ page }) => {
    const dialog = await openAccessibility(page);
    const link = dialog.locator('.a11y-preview .md-link').first();
    expect(await style(link, 'text-decoration-line')).toBe('none');
    await toggle(dialog, 'Always underline links').click();
    expect(await style(link, 'text-decoration-line')).toBe('underline');
    await expect(root(page)).toHaveClass(/underline-links/);
  });

  test('display name styles off makes names plain', async ({ page }) => {
    const dialog = await openAccessibility(page);
    const name = dialog.locator('.a11y-preview .a11y-sample-name').first();
    expect(await style(name, 'background-image')).toContain('linear-gradient');
    await toggle(dialog, 'Display name styles').click();
    expect(await style(name, 'background-image')).toBe('none');
    await expect(root(page)).toHaveClass(/plain-names/);
    await page.reload();
    await expect(root(page)).toHaveClass(/plain-names/);
  });
});

test.describe('visual density', () => {
  test('UI density resizes the server list, channel list and member list', async ({ page }) => {
    const dialog = await openAccessibility(page);
    const heights = async () => ({
      rail: Number((await style(page.locator('.rail-item').first(), 'height')).replace('px', '')),
      channel: Number((await style(page.locator('.channel-row').first(), 'height')).replace('px', '')),
      member: Number((await style(page.locator('.member-row').first(), 'height')).replace('px', '')),
    });
    const base = await heights();
    await radio(dialog, 'UI density', /^Compact/).click();
    await expect(root(page)).toHaveClass(/density-compact/);
    const compact = await heights();
    expect(compact.rail).toBeLessThan(base.rail);
    expect(compact.channel).toBeLessThan(base.channel);
    expect(compact.member).toBeLessThan(base.member);
    await radio(dialog, 'UI density', /^Spacious/).click();
    await expect(root(page)).toHaveClass(/density-cozy/);
    const spacious = await heights();
    expect(spacious.rail).toBeGreaterThan(base.rail);
    expect(spacious.channel).toBeGreaterThan(base.channel);
    expect(spacious.member).toBeGreaterThan(base.member);
    expect((await storedPrefs(page)).density).toBe('cozy');
  });

  test('chat message display switches the preview and the chat to one line', async ({ page }) => {
    const dialog = await openAccessibility(page);
    await expect(dialog.locator('.a11y-preview .chat-avatar').first()).toBeVisible();
    await radio(dialog, 'Chat message display', /^Compact/).click();
    await expect(root(page)).toHaveClass(/message-compact/);
    await expect(dialog.locator('.a11y-preview .chat-msg.compact')).toHaveCount(2);
    await expect(dialog.locator('.a11y-preview .chat-avatar')).toHaveCount(0);
  });

  test('space between message groups', async ({ page }) => {
    const dialog = await openAccessibility(page);
    const second = dialog.locator('.a11y-preview .chat-msg').nth(1);
    await setSlider(dialog, 'Space between message groups', 24);
    expect(await rootToken(page, '--message-group-gap')).toBe('24px');
    expect(await style(second, 'margin-top')).toBe('25px');
    await setSlider(dialog, 'Space between message groups', 0);
    expect(await style(second, 'margin-top')).toBe('1px');
  });

  test('zoom level, Ctrl +, Ctrl - and Ctrl 0', async ({ page }) => {
    const dialog = await openAccessibility(page);
    await setSlider(dialog, 'Zoom level', 150);
    expect(await page.evaluate(() => document.body.style.zoom)).toBe('1.5');
    await expect(slider(dialog, 'Zoom level')).toHaveAttribute('aria-valuetext', '150%');
    // the page still fills the window
    const body = await page.evaluate(() => ({ w: Math.round(document.body.getBoundingClientRect().width), vw: window.innerWidth }));
    expect(Math.abs(body.w - body.vw)).toBeLessThanOrEqual(2);
    await shot(page, 'a11y-zoom-150');
    await page.keyboard.press('Control+0');
    await expect(slider(dialog, 'Zoom level')).toHaveAttribute('aria-valuenow', '100');
    expect(await page.evaluate(() => document.body.style.zoom)).toBe('');
    await page.keyboard.press('Control+Equal');
    await expect(slider(dialog, 'Zoom level')).toHaveAttribute('aria-valuenow', '110');
    await page.keyboard.press('Control+Equal');
    await page.keyboard.press('Control+Minus');
    await expect(slider(dialog, 'Zoom level')).toHaveAttribute('aria-valuenow', '110');
    await page.keyboard.press('Control+Minus');
    await page.keyboard.press('Control+Minus');
    await expect(slider(dialog, 'Zoom level')).toHaveAttribute('aria-valuenow', '90');
    expect((await storedPrefs(page)).zoom).toBe(90);
    await page.reload();
    expect(await page.evaluate(() => document.body.style.zoom)).toBe('0.9');
  });
});

test.describe('color and contrast', () => {
  test('saturation mutes the interface tokens and never filters images or video', async ({ page }) => {
    const dialog = await openAccessibility(page);
    const before = channelRgb(await rootToken(page, '--text-feedback-positive').then(v => (v.startsWith('#') ? hexToRgb(v) : v)));
    expect(Math.max(...before) - Math.min(...before)).toBeGreaterThan(20);
    await setSlider(dialog, 'Saturation', 0);
    const after = channelRgb(await rootToken(page, '--text-feedback-positive').then(v => (v.startsWith('#') ? hexToRgb(v) : v)));
    expect(Math.max(...after) - Math.min(...after)).toBeLessThanOrEqual(2);
    // no element anywhere carries a saturate() filter, and avatars/images/video are untouched
    const filtered = await page.evaluate(() => [...document.querySelectorAll('*')].filter(el => /saturate|grayscale/.test(getComputedStyle(el).filter) || /saturate|grayscale/.test(getComputedStyle(el).getPropertyValue('backdrop-filter'))).length);
    expect(filtered).toBe(0);
    for (const sel of ['.chat-avatar', '.avatar-img', 'img', 'video']) {
      for (const el of await page.locator(sel).all()) expect(await style(el, 'filter')).toBe('none');
    }
    expect((await storedPrefs(page)).saturation).toBe(0);
    await page.reload();
    const reloaded = channelRgb(await rootToken(page, '--text-feedback-positive').then(v => (v.startsWith('#') ? hexToRgb(v) : v)));
    expect(Math.max(...reloaded) - Math.min(...reloaded)).toBeLessThanOrEqual(2);
  });

  test('saturation of custom colours is a separate switch, disabled at 100%', async ({ page }) => {
    const dialog = await openAccessibility(page);
    await expect(toggle(dialog, 'Apply saturation to custom colors')).toBeDisabled();
    await pickOption(page, dialog.getByRole('combobox', { name: 'Role colors' }), 'In names');
    await toggle(dialog, 'Display name styles').click();
    const sample = dialog.locator('.a11y-preview .a11y-sample-name').first();
    const full = channelRgb(await style(sample, 'color'));
    expect(Math.max(...full) - Math.min(...full)).toBeGreaterThan(20);
    await setSlider(dialog, 'Saturation', 0);
    await expect(toggle(dialog, 'Apply saturation to custom colors')).toBeEnabled();
    // custom colours keep their colour until the switch is on
    expect(channelRgb(await style(sample, 'color'))).toEqual(full);
    await toggle(dialog, 'Apply saturation to custom colors').click();
    const grey = channelRgb(await style(sample, 'color'));
    expect(Math.max(...grey) - Math.min(...grey)).toBeLessThanOrEqual(2);
  });

  test('high contrast raises muted text and borders, underlines links, on every theme', async ({ page }) => {
    const dialog = await openAccessibility(page);
    await toggle(dialog, 'Enable high contrast mode').click();
    await expect(root(page)).toHaveClass(/high-contrast/);
    for (const theme of ['dark', 'ash', 'onyx', 'light']) {
      await page.evaluate(t => {
        const el = document.documentElement;
        for (const n of ['dark', 'ash', 'onyx', 'light']) el.classList.toggle(`theme-${n}`, n === t);
      }, theme);
      // white on the dark themes, black on Light
      const fg = await rootToken(page, theme === 'light' ? '--text-overlay-dark' : '--text-overlay-light');
      expect(await rootToken(page, '--text-muted'), theme).toBe(fg);
      expect(await rootToken(page, '--text-default'), theme).toBe(fg);
      expect(await rootToken(page, '--border-strong'), theme).toContain('color-mix');
    }
    expect(await style(dialog.locator('.a11y-preview .md-link').first(), 'text-decoration-line')).toBe('underline');
    expect((await storedPrefs(page)).highContrast).toBe(true);
    await shot(page, 'a11y-high-contrast');
    await toggle(dialog, 'Enable high contrast mode').click();
    await expect(root(page)).not.toHaveClass(/high-contrast/);
  });

  const COMMUNITY: [string, 'dark' | 'light'][] = [
    ['dracula', 'dark'], ['gruvbox-dark', 'dark'], ['nord', 'dark'], ['catppuccin-mocha', 'dark'], ['tokyo-night', 'dark'], ['one-dark', 'dark'],
    ['solarized-dark', 'dark'], ['rose-pine', 'dark'], ['monokai', 'dark'], ['catppuccin-latte', 'light'], ['gruvbox-light', 'light'],
    ['solarized-light', 'light'], ['rose-pine-dawn', 'light'],
  ];
  for (const [theme, base] of COMMUNITY) {
    test(`high contrast works on top of the ${theme} community theme`, async ({ page }) => {
      await seedPrefs(page, { theme, highContrast: true });
      await openAccessibility(page);
      await expect(root(page)).toHaveClass(new RegExp(`theme-${theme}`));
      await expect(root(page)).toHaveClass(/high-contrast/);
      const fg = await rootToken(page, base === 'light' ? '--text-overlay-dark' : '--text-overlay-light');
      expect(await rootToken(page, '--text-muted')).toBe(fg);
      expect(await rootToken(page, '--text-default')).toBe(fg);
      // the high contrast layer sits on the theme: the theme's own surfaces are still the ones in use
      expect(await rootToken(page, '--background-base-low')).not.toBe('');
      const text = await style(page.locator('.a11y-preview .chat-content').first(), 'color');
      expect(channelRgb(text)).toEqual(channelRgb(base === 'light' ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)'));
    });
  }

  const GRADIENTS: [string, 'dark' | 'light'][] = [
    ['mint-apple', 'light'], ['citrus-sherbert', 'light'], ['retro-raincloud', 'light'], ['hanami', 'light'], ['sunrise', 'light'],
    ['cotton-candy', 'light'], ['lofi-vibes', 'light'], ['desert-khaki', 'light'], ['sunset', 'dark'], ['chroma-glow', 'dark'],
    ['forest', 'dark'], ['crimson', 'dark'], ['midnight-blurple', 'dark'], ['mars', 'dark'], ['dusk', 'dark'], ['under-the-sea', 'dark'],
    ['retro-storm', 'dark'], ['neon-nights', 'dark'], ['strawberry-lemonade', 'dark'], ['aurora', 'dark'], ['sepia', 'dark'],
    ['blurple-twilight', 'dark'],
  ];
  test('a gradient theme paints its veiled gradient on the chat pane without high contrast', async ({ page }) => {
    await seedPrefs(page, { theme: 'forest' });
    await openGuild(page);
    await expect(root(page)).toHaveClass(/custom-theme-background/);
    expect(await style(page.locator('.chat-view').first(), 'background-image')).toContain('gradient');
  });

  for (const [theme, base] of GRADIENTS) {
    test(`high contrast takes the veiled gradient off the ${theme} theme`, async ({ page }) => {
      await seedPrefs(page, { theme, highContrast: true });
      await openGuild(page);
      await expect(root(page)).toHaveClass(/custom-theme-background/);
      await expect(root(page)).toHaveClass(/high-contrast/);
      await expect(root(page)).toHaveClass(new RegExp(`theme-${base}`));
      expect(await style(page.locator('.chat-view').first(), 'background-image')).toBe('none');
      const text = await style(page.locator('.chat-msg .chat-content').first(), 'color');
      expect(channelRgb(text)).toEqual(channelRgb(base === 'light' ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)'));
    });
  }

  test('sync contrast settings follows the computer', async ({ page }) => {
    await page.emulateMedia({ contrast: 'more' });
    const dialog = await openAccessibility(page);
    await expect(root(page)).toHaveClass(/high-contrast/);
    await toggle(dialog, 'Sync contrast settings with computer').click();
    await expect(root(page)).not.toHaveClass(/high-contrast/);
    await toggle(dialog, 'Sync contrast settings with computer').click();
    await expect(root(page)).toHaveClass(/high-contrast/);
    await page.emulateMedia({ contrast: 'no-preference' });
    await expect(root(page)).not.toHaveClass(/high-contrast/);
  });

  test('role colours: in names, next to names, hide', async ({ page }) => {
    const dialog = await openAccessibility(page);
    const select = dialog.getByRole('combobox', { name: 'Role colors' });
    await select.click();
    await expect(page.getByRole('listbox', { name: 'Role colors' }).getByRole('option')).toHaveText(['In names', 'Next to names', 'Hide']);
    await page.getByRole('option', { name: 'Next to names', exact: true }).click();
    await expect(dialog.locator('.a11y-preview .a11y-sample-role')).toHaveCount(2);
    await pickOption(page, select, 'Hide');
    await expect(dialog.locator('.a11y-preview .a11y-sample-role')).toHaveCount(0);
    await pickOption(page, select, 'In names');
    await expect(dialog.locator('.a11y-preview .a11y-sample-name.role').first()).toBeVisible();
    expect((await storedPrefs(page)).roleColors).toBe('name');
  });

  test('show switch indicators draws a check or a cross on every switch', async ({ page }) => {
    const dialog = await openAccessibility(page);
    const knob = toggle(dialog, 'Always underline links').locator('.switch-knob');
    const content = (loc: Locator) => loc.evaluate(el => getComputedStyle(el, '::after').content);
    expect(await content(knob)).toBe('none');
    await toggle(dialog, 'Show switch indicators').click();
    await expect(root(page)).toHaveClass(/switch-indicators/);
    expect(await content(knob)).toBe('""');
    const maskOff = await knob.evaluate(el => getComputedStyle(el, '::after').maskImage || getComputedStyle(el, '::after').webkitMaskImage);
    await toggle(dialog, 'Always underline links').click();
    const maskOn = await knob.evaluate(el => getComputedStyle(el, '::after').maskImage || getComputedStyle(el, '::after').webkitMaskImage);
    expect(maskOff).toContain('url(');
    expect(maskOn).toContain('url(');
    expect(maskOn).not.toBe(maskOff);
    await shot(page, 'a11y-switch-indicators');
  });
});

test.describe('reduced motion', () => {
  test('enable reduced motion and sync with computer', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const dialog = await openAccessibility(page);
    await expect(root(page)).not.toHaveClass(/reduce-motion/);
    await toggle(dialog, 'Enable reduced motion').click();
    await expect(root(page)).toHaveClass(/reduce-motion/);
    // .reduce-motion * sets 0.001ms; the switch's own transition is longer than that otherwise
    const seconds = async () => parseFloat(await style(toggle(dialog, 'Enable reduced motion').locator('.switch-knob'), 'transition-duration'));
    expect(await seconds()).toBeLessThan(0.001);
    await toggle(dialog, 'Enable reduced motion').click();
    await expect(root(page)).not.toHaveClass(/reduce-motion/);
    expect(await seconds()).toBeGreaterThan(0.01);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(root(page)).toHaveClass(/reduce-motion/);
    expect(await seconds()).toBeLessThan(0.001);
    await toggle(dialog, 'Sync with computer').click();
    await expect(root(page)).not.toHaveClass(/reduce-motion/);
    await expect(root(page)).toHaveClass(/full-motion/);
    // the OS media rules must be undone too, not only the html class
    expect(await seconds()).toBeGreaterThan(0.01);
    expect(await storedPrefs(page)).toMatchObject({ reducedMotionEnabled: false, syncReducedMotion: false });
  });

  test('a stored pre-split setting migrates', async ({ page }) => {
    await seedPrefs(page, { reducedMotion: 'on' });
    const dialog = await openAccessibility(page);
    await expect(root(page)).toHaveClass(/reduce-motion/);
    await expect(toggle(dialog, 'Enable reduced motion')).toHaveAttribute('aria-checked', 'true');
    await expect(toggle(dialog, 'Sync with computer')).toHaveAttribute('aria-checked', 'false');
  });

  test('minimum notification duration keeps a toast on screen at least that long', async ({ page }) => {
    await seedPrefs(page, { minNotificationDuration: 5 });
    await openDm(page, 'alice');
    const text = `remind me ${Math.random().toString(36).slice(2, 8)}`;
    await send(page, text);
    await expect(message(page, text)).not.toHaveClass(/pending/);
    await message(page, text).click({ button: 'right', position: { x: 200, y: 10 } });
    await page.getByRole('menuitem', { name: 'Create Reminder' }).hover();
    await page.getByRole('menuitem', { name: 'In 1 hour' }).click();
    const toast = page.locator('.chat-toast', { hasText: 'Reminder set for' });
    await expect(toast).toBeVisible();
    // the default 3.5 s would be over by now
    await page.waitForTimeout(4200);
    await expect(toast).toBeVisible();
    await expect(toast).toHaveCount(0, { timeout: 4000 });
  });

  test('the slider stores the choice', async ({ page }) => {
    const dialog = await openAccessibility(page);
    await setSlider(dialog, 'Minimum notification duration', 10);
    await expect(slider(dialog, 'Minimum notification duration')).toHaveAttribute('aria-valuetext', '10 seconds');
    expect((await storedPrefs(page)).minNotificationDuration).toBe(10);
  });

  test('GIFs show a still frame when "Play GIFs" is off and play on hover', async ({ page }) => {
    await seedPrefs(page, { playGifs: false });
    await openDm(page, 'alice');
    await page.getByRole('button', { name: 'Open GIF picker' }).click();
    const picker = page.getByRole('dialog', { name: 'Expression picker' });
    await picker.getByRole('textbox', { name: 'Search GIFs' }).fill('party');
    await picker.getByRole('button', { name: /^Send GIF:/ }).first().click();
    const gif = page.locator('.chat-msg .media-gif').last();
    await expect(gif.locator('canvas')).toBeVisible();
    await expect(gif.locator('img')).toHaveCount(0);
    await gif.hover();
    await expect(gif.locator('img')).toBeVisible();
    await expect(gif.locator('canvas')).toHaveCount(0);
    await page.mouse.move(0, 0);
    await expect(gif.locator('canvas')).toBeVisible();
  });

  test('GIFs play on their own by default', async ({ page }) => {
    await openDm(page, 'alice');
    await page.getByRole('button', { name: 'Open GIF picker' }).click();
    const picker = page.getByRole('dialog', { name: 'Expression picker' });
    await picker.getByRole('textbox', { name: 'Search GIFs' }).fill('party');
    await picker.getByRole('button', { name: /^Send GIF:/ }).first().click();
    const gif = page.locator('.chat-msg .media-gif').last();
    await expect(gif.locator('img')).toBeVisible();
    await expect(gif.locator('canvas')).toHaveCount(0);
  });

  test('sticker animations and animated emoji are stored', async ({ page }) => {
    const dialog = await openAccessibility(page);
    await radio(dialog, 'Sticker animations', /^Never animate/).click();
    await toggle(dialog, 'Play animated emoji').click();
    await toggle(dialog, 'Play GIFs when Vokko is focused').click();
    expect(await storedPrefs(page)).toMatchObject({ stickerAnimation: 'never', playGifs: false });
    await page.reload();
    expect((await storedPrefs(page)).stickerAnimation).toBe('never');
  });
});

test.describe('audio and screen reader', () => {
  test('text-to-speech preview speaks at the chosen rate', async ({ page }) => {
    await page.addInitScript(() => {
      const spoken: { text: string; rate: number }[] = [];
      (window as unknown as { __spoken: typeof spoken }).__spoken = spoken;
      const synth = window.speechSynthesis;
      Object.defineProperty(synth, 'speak', { value: (u: SpeechSynthesisUtterance) => { spoken.push({ text: u.text, rate: u.rate }); } });
      Object.defineProperty(synth, 'cancel', { value: () => undefined });
    });
    const dialog = await openAccessibility(page);
    // 11 stops between 0.5x and 2x, 1x (the default) among them
    await expect(slider(dialog, 'Text-to-speech rate').locator('.ms-tick')).toHaveCount(11);
    await expect(slider(dialog, 'Text-to-speech rate')).toHaveAttribute('aria-valuetext', '1x');
    await setSlider(dialog, 'Text-to-speech rate', 1.4);
    await expect(slider(dialog, 'Text-to-speech rate')).toHaveAttribute('aria-valuetext', '1.4x');
    await dialog.getByRole('button', { name: 'Preview' }).click();
    const spoken = await page.evaluate(() => (window as unknown as { __spoken: { text: string; rate: number }[] }).__spoken);
    expect(spoken).toHaveLength(1);
    expect(spoken[0]!.rate).toBeCloseTo(1.4, 5); // utterance.rate is a float32
    expect(spoken[0]!.text.length).toBeGreaterThan(10);
  });

  test('image descriptions show under attachments only when asked for', async ({ page }) => {
    const png = { name: 'chart.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') };
    const sendWithAlt = async (): Promise<Locator> => {
      await page.goto('/channels/@me?as=sam&mockLatency=0');
      await page.getByRole('link', { name: /^Sam's server/ }).click();
      await page.locator('.chat-textarea').waitFor();
      await page.locator('input[type=file]').setInputFiles(png);
      const card = page.locator('.chat-tray-item');
      await expect(card).toHaveCount(1);
      await card.hover();
      await page.getByRole('button', { name: 'Edit chart.png' }).click();
      const modify = page.getByRole('dialog', { name: 'Modify Attachment' });
      await modify.getByLabel('Description (alt text)').fill('a one pixel chart');
      await modify.getByRole('button', { name: 'Save' }).click();
      await expect(page.locator('.chat-tray-item.uploading')).toHaveCount(0);
      await page.locator('.chat-textarea').fill('look at the chart');
      await page.keyboard.press('Enter');
      const row = message(page, 'look at the chart');
      await expect(row.locator('.chat-image')).toBeVisible();
      return row;
    };
    const off = await sendWithAlt();
    await expect(off.locator('.chat-attachment-alt')).toHaveCount(0);

    await page.evaluate(key => {
      const stored = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>;
      localStorage.setItem(key, JSON.stringify({ ...stored, showImageDescriptions: true }));
    }, PREFS_KEY);
    const on = await sendWithAlt();
    await expect(on.locator('.chat-attachment-alt')).toContainText('a one pixel chart');
  });

  test('legacy chat input is a plain text box that still autocompletes and sends real mentions', async ({ page }) => {
    await seedPrefs(page, { legacyChatInput: true });
    await openDm(page, 'alice');
    // a plain text box instead of the live-markdown editor
    const box = page.locator('textarea.chat-textarea');
    await expect(box).toBeVisible();
    await expect(page.locator('.chat-live')).toHaveCount(0);
    // no emoticon conversion
    await send(page, 'see you :)');
    await expect(message(page, 'see you')).toContainText('see you :)');
    // @mentions still autocomplete and go out as real mention tokens
    await box.click();
    await box.pressSequentially('hey @ali', { delay: 15 });
    await expect(page.getByRole('listbox', { name: 'Suggestions' })).toBeVisible();
    await box.press('Enter');
    await box.pressSequentially('hi', { delay: 5 });
    await box.press('Enter');
    await expect(message(page, 'hey').locator('.md-mention')).toContainText(/@alice/i);
  });

  test('Appearance shows the switches that legacy input overrides as off and disabled', async ({ page }) => {
    await seedPrefs(page, { legacyChatInput: true, previewMarkdown: true, convertEmoticons: true });
    await openGuild(page);
    await page.getByRole('button', { name: 'User Settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'User Settings' });
    await dialog.getByRole('button', { name: 'Appearance', exact: true }).click();
    for (const label of ['Preview Markdown as you type', 'Convert emoticons to emoji']) {
      const row = toggle(dialog, label);
      await expect(row).toHaveAttribute('aria-checked', 'false');
      await expect(row).toBeDisabled();
    }
  });

  test('the composer is unchanged without legacy input', async ({ page }) => {
    await openDm(page, 'alice');
    await expect(page.locator('.chat-live')).toBeVisible();
    await send(page, 'see you :)');
    await expect(message(page, 'see you')).toContainText('see you 🙂');
  });
});

test.describe('screenshots', () => {
  test.skip(!SHOTS, 'set VOKKO_SHOTS to write the page screenshots');
  test.use({ viewport: { width: 1440, height: 3000 } });

  test('full page: dark, community theme, high contrast', async ({ page }) => {
    const dialog = await openAccessibility(page);
    await expect(dialog.getByRole('group', { name: 'Preview' })).toBeVisible();
    await shot(page, 'a11y-dark');
    await toggle(dialog, 'Enable high contrast mode').click();
    await shot(page, 'a11y-dark-high-contrast');
  });

  test('full page: Dracula, then with high contrast and saturation', async ({ page }) => {
    await seedPrefs(page, { theme: 'dracula' });
    const dialog = await openAccessibility(page);
    await shot(page, 'a11y-dracula');
    await toggle(dialog, 'Enable high contrast mode').click();
    await shot(page, 'a11y-dracula-high-contrast');
  });
});

function hexToRgb(hex: string): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map(c => c + c).join('') : h;
  return `rgb(${parseInt(full.slice(0, 2), 16)}, ${parseInt(full.slice(2, 4), 16)}, ${parseInt(full.slice(4, 6), 16)})`;
}
