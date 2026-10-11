import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { openDm } from './helpers';

// Accessibility audit (docs/audits/a11y-2026-10.md). Runs on the mock backend.
//
// Two kinds of tests:
//  * axe scans: every rule axe reports for a screen must be listed in that screen's KNOWN map, each with the
//    audit finding (A11Y-nn) it belongs to. A rule that is not listed fails the test (regression); a listed rule
//    that stops being reported is harmless (remove it from the map when the fix lands).
//  * keyboard checks: tests of behaviour that works today pass as-is; tests of behaviour that is broken today are
//    marked test.fail() with the finding id, so they flip to "unexpectedly passed" (red) once the bug is fixed and
//    the marker must then be removed.
// Visual quality (contrast under real rendering, focus ring look) cannot be judged here beyond what axe computes.

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

type Known = Record<string, string>;

// Findings shared by several screens.
const CONTRAST: Known = { 'color-contrast': 'A11Y-07 muted text tokens (--text-muted, --chat-text-muted, group titles) are below 4.5:1' };
const REGION: Known = { region: 'A11Y-12 sidebar list and resize handle sit outside any landmark' };
const TARGET: Known = { 'target-size': 'A11Y-09 user-panel input/output chevrons are 16x32 and hover-only channel actions are small' };
const HEADINGS: Known = { 'heading-order': 'A11Y-20 message author names are <h3> directly under the page <h1>' };
const CHAT_LIST: Known = { 'aria-required-parent': 'A11Y-01 .chat-row role=listitem has no role=list parent (react-virtuoso wrappers sit in between)' };
const OVERLAY_MAIN: Known = { 'landmark-no-duplicate-main': 'A11Y-13 settings overlay renders a second <main> while the app shell behind it stays in the a11y tree' };

test.beforeEach(async ({ page }) => {
  // Fade-in animations otherwise make axe measure half-transparent text.
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

async function scan(page: Page, include?: string) {
  let builder = new AxeBuilder({ page }).withTags(TAGS);
  if (include) builder = builder.include(include);
  return (await builder.analyze()).violations;
}

function expectOnlyKnown(info: TestInfo, violations: Awaited<ReturnType<typeof scan>>, known: Known): void {
  for (const v of violations) {
    const note = known[v.id];
    if (note) info.annotations.push({ type: 'known-issue', description: `${note} [${v.id}, ${v.impact}, ${v.nodes.length} node(s)]` });
  }
  const unexpected = violations.filter(v => !(v.id in known)).map(v => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`);
  expect(unexpected, 'axe violations not in the known list').toEqual([]);
}

async function openGuild(page: Page): Promise<void> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.locator('.chat-msg').first().waitFor();
}

async function openUserSettings(page: Page, section: string): Promise<void> {
  await openGuild(page);
  await page.getByRole('button', { name: 'User Settings' }).click();
  await page.getByRole('dialog', { name: 'User Settings' }).waitFor();
  await page.getByRole('button', { name: section, exact: true }).click();
}

/** Label of the focused element (aria-label, else text), and whether it sits inside `selector`. */
function focusInfo(page: Page, selector?: string) {
  return page.evaluate(sel => {
    const el = document.activeElement as HTMLElement | null;
    return { label: (el?.getAttribute('aria-label') ?? el?.textContent ?? '').trim().slice(0, 40), tag: el?.tagName ?? '', inside: !!(sel && el?.closest(sel)) };
  }, selector);
}

// ---------------------------------------------------------------- axe scans

test.describe('axe: main screens', () => {
  test('friends / home', async ({ page }, info) => {
    await page.goto('/channels/@me?as=sam&mockLatency=0');
    await page.getByRole('heading', { name: /friends/i }).first().waitFor();
    expectOnlyKnown(info, await scan(page), { ...CONTRAST, ...REGION, ...TARGET });
  });

  test('DM chat', async ({ page }, info) => {
    await openDm(page);
    expectOnlyKnown(info, await scan(page), { ...CONTRAST, ...REGION, ...TARGET, ...CHAT_LIST, ...HEADINGS });
  });

  test('guild channel with member list', async ({ page }, info) => {
    await openGuild(page);
    await expect(page.getByRole('complementary', { name: 'Members' })).toBeVisible();
    expectOnlyKnown(info, await scan(page), { ...CONTRAST, ...REGION, ...TARGET, ...CHAT_LIST, ...HEADINGS });
  });

  test('message context menu', async ({ page }, info) => {
    await openGuild(page);
    await page.locator('.chat-msg').first().click({ button: 'right' });
    await expect(page.getByRole('menu')).toBeVisible();
    // Scoped to the menu: the page behind is covered by the screens above.
    expectOnlyKnown(info, await scan(page, '.context-menu'), {});
  });

  test('member profile popout', async ({ page }, info) => {
    await openGuild(page);
    await page.locator('.member-row').nth(1).click();
    await expect(page.locator('.profile-card')).toBeVisible();
    expectOnlyKnown(info, await scan(page, '.profile-card'), {});
    // axe cannot see that the popout has no dialog role/name or focus handling: see the keyboard tests (A11Y-04).
  });

  test('quick switcher', async ({ page }, info) => {
    await openGuild(page);
    await page.keyboard.press('Control+k');
    await expect(page.locator('.quick-input')).toBeFocused();
    expectOnlyKnown(info, await scan(page, '.modal'), {
      'aria-dialog-name': 'A11Y-02 quick switcher dialog has no accessible name',
      'aria-input-field-name': 'A11Y-02 listbox has no accessible name',
      'aria-required-children': 'A11Y-02 listbox contains <li> wrappers instead of options',
      'aria-required-parent': 'A11Y-02 options sit inside <li>, not directly in the listbox',
      listitem: 'A11Y-02 <li> inside a role=listbox element',
      'color-contrast': 'A11Y-07 .quick-sub on the selected row is 3.96:1',
    });
  });

  test('profile modal', async ({ page }, info) => {
    await openDm(page);
    await page.getByRole('button', { name: 'View Full Profile' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    expectOnlyKnown(info, await scan(page, '[role=dialog]'), {});
  });
});

test.describe('axe: settings', () => {
  test('user settings: Appearance', async ({ page }, info) => {
    await openUserSettings(page, 'Appearance');
    expectOnlyKnown(info, await scan(page, '[role=dialog]'), { ...CONTRAST, ...OVERLAY_MAIN });
  });

  test('user settings: Accessibility', async ({ page }, info) => {
    await openUserSettings(page, 'Accessibility');
    expectOnlyKnown(info, await scan(page, '[role=dialog]'), { ...CONTRAST, ...OVERLAY_MAIN });
  });

  test('server settings: Roles', async ({ page }, info) => {
    await openGuild(page);
    await page.locator('.guild-header-name-button').click();
    await page.getByRole('menuitem', { name: 'Server Settings' }).click();
    await page.getByRole('button', { name: 'Roles', exact: true }).click();
    await expect(page.locator('.ss-role-list')).toBeVisible();
    expectOnlyKnown(info, await scan(page, '[role=dialog]'), {
      ...CONTRAST,
      ...OVERLAY_MAIN,
      'aria-required-children': 'A11Y-03 .ss-role-list (role=list) has a <button> child next to its listitems',
    });
  });

  test('channel settings', async ({ page }, info) => {
    await openGuild(page);
    await page.locator('.channel-row-wrap').first().hover();
    await page.getByRole('button', { name: 'Edit Channel' }).first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expectOnlyKnown(info, await scan(page, '[role=dialog]'), { ...CONTRAST, ...OVERLAY_MAIN });
  });
});

// ---------------------------------------------------------------- keyboard only

test.describe('keyboard: tab order and focus rings', () => {
  test('Tab visits rail, channel list, chat header, chat, composer, then the member list', async ({ page }, info) => {
    await openGuild(page);
    await page.mouse.click(1, 1); // move the sequential-focus starting point to the top of the page
    const regions = ['.server-rail', '.sidebar', '.channel-header', '.chat-scroller', '.chat-composer', '.member-list', '.user-panel'];
    const firstStop: Record<string, number> = {};
    let composerStop = 0;
    for (let i = 1; i <= 70; i += 1) {
      await page.keyboard.press('Tab');
      const region = await page.evaluate(list => list.find(sel => document.activeElement?.closest(sel)) ?? '', regions);
      if (region && !(region in firstStop)) firstStop[region] = i;
      if (!composerStop && (await focusInfo(page)).tag === 'TEXTAREA') composerStop = i;
    }
    const stops = regions.map(r => firstStop[r]);
    expect(stops.every(n => n !== undefined), JSON.stringify(firstStop)).toBe(true);
    expect([...stops].sort((a, b) => a - b), `regions in DOM order: ${JSON.stringify(firstStop)}`).toEqual(stops);
    // A11Y-14: no skip link and no roving focus, so the composer is this many Tab presses away.
    info.annotations.push({ type: 'known-issue', description: `A11Y-14 composer textarea is Tab stop #${composerStop} (rail, channel list and header are all individual stops)` });
  });

  test('every control class shows a focus ring when reached with the keyboard', async ({ page }) => {
    await openGuild(page);
    const targets = [
      page.getByRole('link', { name: "Sam's server" }),
      page.getByRole('button', { name: 'Invite People' }),
      page.getByRole('link', { name: 'general' }),
      page.getByRole('button', { name: 'Threads' }),
      page.getByRole('button', { name: 'Attach a file' }),
      page.locator('.member-row').first(),
      page.getByRole('button', { name: 'Mute' }),
    ];
    await page.locator('body').press('Tab'); // switch Chromium to keyboard modality so :focus-visible applies
    for (const target of targets) {
      await target.focus();
      // Forward then back: Shift+Tab then Tab breaks when the previous stop is inside a message (its toolbar opens on focus-within).
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      const ring = await target.evaluate(el => ({ style: getComputedStyle(el).outlineStyle, width: parseFloat(getComputedStyle(el).outlineWidth) }));
      expect(ring.style, await target.evaluate(el => el.outerHTML.slice(0, 80))).not.toBe('none');
      expect(ring.width).toBeGreaterThanOrEqual(2);
    }
  });

  test('message list scroller shows a focus ring when tabbed to', async ({ page }) => {
    test.fail(true, 'A11Y-08: react-virtuoso sets inline outline:none on the scroller, which is still a Tab stop');
    await openGuild(page);
    await page.locator('.chat-scroller').focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    const outline = await page.locator('.chat-scroller').evaluate(el => getComputedStyle(el).outlineStyle);
    expect(outline).not.toBe('none');
  });

  test('composer shows a focus indicator on the box', async ({ page }) => {
    test.fail(true, 'A11Y-08: chat.css:245 removes the textarea ring and nothing on .chat-composer-box replaces it (Discord shows only the caret, parity)');
    await openGuild(page);
    const box = page.locator('.chat-composer-box');
    const before = await box.evaluate(el => { const s = getComputedStyle(el); return `${s.outlineStyle}|${s.boxShadow}|${s.borderColor}`; });
    await page.locator('.chat-textarea').focus();
    const after = await box.evaluate(el => { const s = getComputedStyle(el); return `${s.outlineStyle}|${s.boxShadow}|${s.borderColor}`; });
    expect(after).not.toBe(before);
  });
});

test.describe('keyboard: menus', () => {
  test('context menu: arrows move the highlight, Enter selects, Esc closes and keeps focus on the trigger', async ({ page }) => {
    await openGuild(page);
    const row = page.getByRole('link', { name: 'general' });
    await row.focus();
    await page.keyboard.press('Shift+F10');
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    const focused = () => page.locator('.context-menu-item.focused').first().textContent();
    await page.keyboard.press('ArrowDown');
    const first = await focused();
    await page.keyboard.press('ArrowDown');
    expect(await focused()).not.toBe(first);
    await page.keyboard.press('ArrowUp');
    expect(await focused()).toBe(first);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(row).toBeFocused();
  });

  test('context menu moves DOM focus into the menu', async ({ page }) => {
    test.fail(true, 'A11Y-06: items are non-focusable divs driven by a document keydown listener; no focus move, no aria-activedescendant');
    await openGuild(page);
    await page.getByRole('link', { name: 'general' }).focus();
    await page.keyboard.press('Shift+F10');
    await page.keyboard.press('ArrowDown');
    expect((await focusInfo(page, '.context-menu')).inside || (await page.evaluate(() => !!document.activeElement?.getAttribute('aria-activedescendant')))).toBe(true);
  });

  test('Tab does not walk away from an open context menu', async ({ page }) => {
    test.fail(true, 'A11Y-06: Tab moves focus to the next control behind the menu and the menu stays open');
    await openGuild(page);
    await page.getByRole('link', { name: 'general' }).focus();
    await page.keyboard.press('Shift+F10');
    await page.keyboard.press('Tab');
    const open = (await page.getByRole('menu').count()) > 0;
    const insideMenu = (await focusInfo(page, '.context-menu')).inside;
    expect(!open || insideMenu).toBe(true);
  });

  test('message actions are reachable without a mouse', async ({ page }) => {
    await openGuild(page);
    await page.locator('.chat-scroller').focus();
    let reached = false;
    for (let i = 0; i < 12 && !reached; i += 1) {
      await page.keyboard.press('Tab');
      reached = (await focusInfo(page, '.chat-msg')).inside;
    }
    expect(reached).toBe(true);
  });

  for (const popout of [
    { name: 'server name menu', open: (p: Page) => p.locator('.guild-header-name-button').focus().then(() => p.keyboard.press('Enter')), box: '.popout' },
    { name: 'member profile card', open: (p: Page) => p.locator('.member-row').nth(1).focus().then(() => p.keyboard.press('Enter')), box: '.profile-card' },
    { name: 'emoji picker', open: (p: Page) => p.getByRole('button', { name: 'Select emoji' }).focus().then(() => p.keyboard.press('Enter')), box: '.popout' },
  ]) {
    test(`popout takes focus: ${popout.name}`, async ({ page }) => {
      test.fail(true, 'A11Y-04: popouts are portaled to the end of <body> and never receive focus, so their controls are not in the Tab sequence');
      await openGuild(page);
      await popout.open(page);
      await expect(page.locator(popout.box).first()).toBeVisible();
      // Either focus moves in immediately, or the first Tab goes into the popout.
      if (!(await focusInfo(page, popout.box)).inside) await page.keyboard.press('Tab');
      expect((await focusInfo(page, popout.box)).inside).toBe(true);
    });
  }

  test('Esc closes the top layer first (dialog over menu)', async ({ page }) => {
    await openGuild(page);
    await page.locator('.chat-msg').first().click({ button: 'right' });
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('menu')).toHaveCount(1); // A11Y-19: Ctrl+K leaves the menu open underneath
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
  });
});

test.describe('keyboard: dialogs', () => {
  test('modal traps Tab and returns focus to the opener on Esc', async ({ page }) => {
    await openGuild(page);
    const opener = page.getByRole('button', { name: 'Add a Server' });
    await opener.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    for (let i = 0; i < 20; i += 1) {
      await page.keyboard.press('Tab');
      expect((await focusInfo(page, '[role=dialog]')).inside, `Tab #${i + 1} stayed in the dialog`).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  test('user settings traps Tab and returns focus to the User Settings button on Esc', async ({ page }) => {
    await openGuild(page);
    const opener = page.getByRole('button', { name: 'User Settings' });
    await opener.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'User Settings' })).toBeVisible();
    for (let i = 0; i < 50; i += 1) {
      await page.keyboard.press('Tab');
      expect((await focusInfo(page, '[role=dialog]')).inside, `Tab #${i + 1} stayed in settings`).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(opener).toBeFocused();
  });

  test('server settings opened from a menu returns focus somewhere useful on Esc', async ({ page }) => {
    test.fail(true, 'A11Y-11: the opener (a menu item) is unmounted before Esc, focus falls to <body>');
    await openGuild(page);
    await page.locator('.guild-header-name-button').click();
    await page.getByRole('menuitem', { name: 'Server Settings' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect((await focusInfo(page)).tag).not.toBe('BODY');
  });

  test('settings background is hidden from assistive tech while a settings overlay is open', async ({ page }) => {
    test.fail(true, 'A11Y-13: .app-frame is neither inert nor aria-hidden behind the settings overlay');
    await openUserSettings(page, 'Appearance');
    const hidden = await page.locator('.app-frame').evaluate(el => el.hasAttribute('inert') || el.getAttribute('aria-hidden') === 'true');
    expect(hidden).toBe(true);
  });
});

test.describe('keyboard: shortcuts', () => {
  test('Ctrl+K opens the quick switcher with the input focused, arrows select, Enter navigates, Ctrl+K toggles', async ({ page }) => {
    await openGuild(page);
    await page.keyboard.press('Control+k');
    const input = page.locator('.quick-input');
    await expect(input).toBeFocused();
    await page.keyboard.type('rand');
    await expect(page.locator('.quick-row[aria-selected=true]')).toContainText(/random/i);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page).toHaveURL(/\/channels\/\d+\/\d+/);
    await expect(page.locator('.channel-row.selected')).toContainText(/random/i);
    await page.keyboard.press('Control+k');
    await expect(input).toBeFocused();
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('quick switcher returns focus to where it was opened from', async ({ page }) => {
    test.fail(true, 'A11Y-11: closing the switcher leaves focus on <body> (QuickSwitcher is unmounted by the modal store before the focus restore runs)');
    await openGuild(page);
    const opener = page.getByRole('button', { name: 'Inbox' });
    await opener.focus();
    await page.keyboard.press('Control+k');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  test('Alt+Down / Alt+Up move between text channels and keep focus in the composer', async ({ page }) => {
    await openGuild(page);
    await page.locator('.chat-textarea').focus();
    const current = () => page.locator('.channel-row.selected').first().textContent();
    const start = await current();
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(current).not.toBe(start);
    await expect(page.locator('.chat-textarea')).toBeFocused();
    await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(current).toBe(start);
  });

  test('Up in an empty composer edits the last own message (Discord parity, Q3.9)', async ({ page }) => {
    await openDm(page);
    const box = page.locator('.chat-textarea');
    await box.click();
    await box.fill('a11y probe message');
    await box.press('Enter');
    await expect(page.locator('.chat-msg', { hasText: 'a11y probe message' })).toBeVisible();
    await box.press('ArrowUp');
    await expect(page.locator('.chat-edit textarea')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('.chat-edit')).toHaveCount(0);
  });
});

test.describe('screen-reader structure', () => {
  test('landmarks are labelled', async ({ page }) => {
    await openGuild(page);
    await expect(page.getByRole('navigation', { name: 'Servers sidebar' })).toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Members' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'User status and settings' })).toBeVisible();
  });

  test('new messages are announced through a live region or log', async ({ page }) => {
    test.fail(true, 'A11Y-10: the message list has no role=log / aria-live and the Virtuoso scroller (a Tab stop) has no role or name');
    await openGuild(page);
    const announced = await page.evaluate(() => !!document.querySelector('.chat-scroller')?.closest('[role=log], [aria-live]') || !!document.querySelector('.chat-scroller[role=log], .chat-scroller[aria-live]'));
    expect(announced).toBe(true);
  });

  test('settings sidebar marks the current section', async ({ page }) => {
    test.fail(true, 'A11Y-15: UserSettings.tsx:260 sets a "selected" class but no aria-current (server and channel settings do)');
    await openUserSettings(page, 'Appearance');
    await expect(page.getByRole('button', { name: 'Appearance', exact: true })).toHaveAttribute('aria-current', /.+/);
  });

  test('only one h1 per screen', async ({ page }) => {
    test.fail(true, 'A11Y-20: the channel title and the channel-start intro are both <h1>, and message author names are <h3> with no <h2> above them');
    await openGuild(page);
    expect(await page.locator('h1').count()).toBe(1);
  });
});
