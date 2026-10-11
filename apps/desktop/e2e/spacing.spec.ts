import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openStockTalk } from './helpers';

// Appearance > Message spacing: the preset sets the gap between message groups (--message-group-gap, plus the 1px the
// reference has) and the vertical padding of every row (--message-pad-y). Measured from the laid-out rows, in cozy and compact display.
const PRESETS = [
  { name: 'Compact', value: 'compact', gap: 0, padY: 2 },
  { name: 'Balanced', value: 'balanced', gap: 16, padY: 2 },
  { name: 'Roomy', value: 'roomy', gap: 24, padY: 4 },
] as const;

async function openAppearance(page: Page) {
  await page.getByRole('button', { name: 'User Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'User Settings' });
  await dialog.getByRole('button', { name: 'Appearance' }).click();
  await expect(dialog.getByRole('heading', { name: 'Message spacing', level: 3 }).or(dialog.getByText('Message spacing', { exact: true })).first()).toBeVisible();
  return dialog;
}

/** Smallest gap between two consecutive message rows where the second starts a group, and the content-to-content distance inside a group. */
function measure(page: Page) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll<HTMLElement>('.chat-msg')].filter(r => r.offsetParent !== null && !r.classList.contains('system'));
    let groupGap = Infinity;
    let lineGap = Infinity;
    let padTop = '';
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1]!;
      const b = rows[i]!;
      const between = b.getBoundingClientRect().top - a.getBoundingClientRect().bottom;
      if (!b.classList.contains('grouped')) {
        // margin 0 = first row, or right after a divider (chat.css): those are not a gap between two groups
        if (getComputedStyle(b).marginTop !== '0px' && between >= 0) groupGap = Math.min(groupGap, between);
      } else {
        padTop = getComputedStyle(b).paddingTop;
        const ca = a.querySelector('.chat-content');
        const cb = b.querySelector('.chat-content');
        if (ca && cb) {
          const d = cb.getBoundingClientRect().top - ca.getBoundingClientRect().bottom;
          // only plain single-block rows: reactions, embeds and attachments add their own space
          if (!a.querySelector('.chat-reactions, .chat-attachments, .chat-embeds') && d >= 0) lineGap = Math.min(lineGap, d);
        }
      }
    }
    return { groupGap, lineGap, padTop, cssGap: getComputedStyle(document.documentElement).getPropertyValue('--message-group-gap').trim(), cssPad: getComputedStyle(document.documentElement).getPropertyValue('--message-pad-y').trim() };
  });
}

for (const display of ['Cozy', 'Compact'] as const) {
  test(`message spacing presets set the group gap and the row padding (${display.toLowerCase()} display)`, async ({ page }) => {
    await openStockTalk(page);
    let dialog = await openAppearance(page);
    if (display === 'Compact') {
      await dialog.getByRole('radiogroup', { name: 'Message display' }).getByRole('radio', { name: /^Compact/ }).click();
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('html')).toHaveClass(display === 'Compact' ? /message-compact/ : /^(?!.*message-compact)/);

    for (const preset of PRESETS) {
      dialog = await openAppearance(page);
      await dialog.getByRole('radiogroup', { name: 'Message spacing' }).getByRole('radio', { name: new RegExp(`^${preset.name}`) }).click();
      await expect(dialog.getByRole('radiogroup', { name: 'Message spacing' }).getByRole('radio', { name: new RegExp(`^${preset.name}`) })).toHaveAttribute('aria-checked', 'true');
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await page.waitForTimeout(150);

      const m = await measure(page);
      expect(m.cssGap, `${preset.name} --message-group-gap`).toBe(`${preset.gap}px`);
      expect(m.cssPad, `${preset.name} --message-pad-y`).toBe(`${preset.padY}px`);
      expect(m.groupGap, `${preset.name} gap between groups`).toBe(preset.gap + 1);
      expect(m.padTop, `${preset.name} row padding`).toBe(`${preset.padY}px`);
      // two lines of one group: the padding of both rows sits between them (single-line rows only exist when something is grouped)
      if (Number.isFinite(m.lineGap)) expect(m.lineGap, `${preset.name} space between lines of a group`).toBeGreaterThanOrEqual(preset.padY * 2);
    }
  });
}

test('the slider moves over the stops and the choice survives a preset change only until another preset is picked', async ({ page }) => {
  await openStockTalk(page);
  const dialog = await openAppearance(page);
  const slider = dialog.getByRole('slider', { name: 'Space between message groups' });
  // stops 0, 4, 8, 16, 24: index 1 is 4px
  await slider.fill('1');
  expect((await measure(page)).cssGap).toBe('4px');
  await slider.fill('4');
  expect((await measure(page)).cssGap).toBe('24px');
  await dialog.getByRole('radiogroup', { name: 'Message spacing' }).getByRole('radio', { name: /^Compact/ }).click();
  expect((await measure(page)).cssGap).toBe('0px');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('vokko.prefs') ?? '{}').messageSpacing)).toBe('compact');
});
