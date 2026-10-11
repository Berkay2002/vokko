import { expect, test, type Page } from '@playwright/test';
import { openDm } from './helpers';

// Keyboard parity (MOD-005, MOD-006): one test per shortcut group. ControlOrMeta is Cmd on macOS, like the bindings.
test.use({ viewport: { width: 1440, height: 900 } });

type St = { threads: Record<string, { id: string; name?: string }>; channels: Record<string, { id: string; name?: string; guild_id: string | null; last_message_id?: string | null }>; readStates: Record<string, { channel_id: string; last_message_id: string | null; mention_count: number }> };
type Win = { __vokko: { appStore: { getState(): St; setState(p: Partial<St>): void } } };

const selected = (page: Page) => page.locator('.channel-row.selected').first();

async function openGuild(page: Page): Promise<void> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.locator('.chat-msg').first().waitFor();
}

/** Navigates in-app to the named guild channel (a reload would re-seed the mock). */
async function openChannel(page: Page, name: string): Promise<string> {
  await openGuild(page);
  const path = await page.evaluate(n => {
    const c = Object.values((window as unknown as Win).__vokko.appStore.getState().channels).find(x => x.name === n)!;
    return `/channels/${c.guild_id}/${c.id}`;
  }, name);
  await page.evaluate(p => { history.pushState({}, '', p); window.dispatchEvent(new PopStateEvent('popstate')); }, path);
  await expect(selected(page)).toContainText(name);
  await page.locator('.chat-msg').first().waitFor();
  return path.split('/').pop()!;
}

const mentions = (page: Page, id: string) => page.evaluate(c => (window as unknown as Win).__vokko.appStore.getState().readStates[c]?.mention_count ?? 0, id);

// The URL changes before the shell re-renders with the new route; wait for Friends so the shortcuts see it too.
async function atFriends(page: Page) {
  await expect(page).toHaveURL(/\/channels\/@me/);
  await expect(page.getByRole('main', { name: 'Friends' })).toBeVisible();
}

test('navigation: Alt+Up/Down channels, Mod+Alt servers, Alt+Shift unread, Mod+Shift+Alt mentions', async ({ page }) => {
  await openGuild(page);
  // Mentions across the app first: visiting #random (two mentions in the seed) acks them, and Alt+Down can pass through it.
  await page.keyboard.press('ControlOrMeta+Alt+ArrowUp');
  await atFriends(page);
  await page.keyboard.press('ControlOrMeta+Shift+Alt+ArrowDown');
  await expect(selected(page)).toContainText('random');

  // Compare links, not text: the row's mention badge disappears once the channel is read.
  const start = await selected(page).getAttribute('href');
  await page.keyboard.press('Alt+ArrowDown');
  await expect(selected(page)).not.toHaveAttribute('href', start!);
  await page.keyboard.press('Alt+ArrowUp');
  await expect(selected(page)).toHaveAttribute('href', start!);

  // Unread channels: down to the next one marked unread in the sidebar.
  await page.keyboard.press('Alt+Shift+ArrowDown');
  await expect(selected(page)).toHaveClass(/unread/);

  await page.keyboard.press('ControlOrMeta+Alt+ArrowUp');
  await atFriends(page);
  // Focus may still be in a field from the last route, where Alt+arrows belong to the field.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('ControlOrMeta+Alt+ArrowDown');
  await expect(page.locator('.guild-header-name-button')).toContainText("Sam's server");

  await page.keyboard.press('ControlOrMeta+Shift+N');
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('read state: Esc marks the channel read, Shift+Esc the server, Shift+PageUp jumps to the oldest unread', async ({ page }) => {
  // dev-talk is partly unread at open: the first message after the pointer flashes.
  await openChannel(page, 'dev-talk');
  await page.keyboard.press('Shift+PageUp');
  await expect(page.locator('.chat-msg.flash')).toContainText('does that handle channels with no read state yet?');

  const random = await openChannel(page, 'random');
  await expect(page.locator('.chat-msg', { hasText: 'making popcorn' })).toBeVisible();
  await page.locator('.chat-textarea').focus();
  await page.keyboard.press('Escape');
  await expect.poll(() => mentions(page, random)).toBe(0);
  await expect(page.locator('.rail-badge')).toHaveCount(0);

  await page.keyboard.press('Shift+Escape');
  await expect(page.locator('.channel-row.unread')).toHaveCount(0);
});

test('composer and pickers: Tab, Up, Mod+E/G/S, Mod+Shift+U', async ({ page }) => {
  await openDm(page, 'alice');
  const box = page.locator('.chat-textarea');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Tab');
  await expect(box).toBeFocused();

  await box.fill('keyboard probe');
  await box.press('Enter');
  await expect(page.locator('.chat-msg', { hasText: 'keyboard probe' })).toBeVisible();
  await box.press('ArrowUp');
  await expect(page.locator('.chat-edit')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.chat-edit')).toHaveCount(0);

  for (const [k, button] of [['e', 'Select emoji'], ['g', 'Open GIF picker'], ['s', 'Open sticker picker']] as const) {
    await page.keyboard.press(`ControlOrMeta+${k}`);
    await expect(page.getByRole('button', { name: button })).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press(`ControlOrMeta+${k}`);
    await expect(page.getByRole('button', { name: button })).toHaveAttribute('aria-expanded', 'false');
  }

  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+Shift+U');
  await chooser;
});

test('voice: Mod+Shift+M mutes, Mod+Shift+D deafens', async ({ page }) => {
  await openDm(page, 'alice');
  await page.keyboard.press('ControlOrMeta+Shift+M');
  await expect(page.getByRole('button', { name: 'Unmute' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ControlOrMeta+Shift+M');
  await expect(page.getByRole('button', { name: 'Mute', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('ControlOrMeta+Shift+D');
  await expect(page.getByRole('button', { name: 'Undeafen' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ControlOrMeta+Shift+D');
  await expect(page.getByRole('button', { name: 'Deafen', exact: true })).toHaveAttribute('aria-pressed', 'false');
});

test('panels: Mod+I inbox, Mod+P pins, Mod+U member list', async ({ page }) => {
  await openGuild(page);
  await page.keyboard.press('ControlOrMeta+i');
  await expect(page.locator('.inbox-popout')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+i');
  await expect(page.locator('.inbox-popout')).toHaveCount(0);

  await page.keyboard.press('ControlOrMeta+p');
  await expect(page.locator('.pins-popout-host')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+p');
  await expect(page.locator('.pins-popout-host')).toHaveCount(0);

  const members = page.locator('.member-list');
  const before = await members.count();
  await page.keyboard.press('ControlOrMeta+u');
  await expect(members).toHaveCount(before ? 0 : 1);
  await page.keyboard.press('ControlOrMeta+u');
  await expect(members).toHaveCount(before);
});

test('switcher: prefixes, fuzzy ranking, mention badges, arrows/Tab and Enter', async ({ page }) => {
  await openGuild(page);
  await page.keyboard.press('ControlOrMeta+k');
  const input = page.getByRole('combobox', { name: 'Search channels, people and servers' });
  await expect(input).toBeFocused();
  const options = page.getByRole('option');

  // Reference modals/06 (spec.md): 682 wide, 70 px input 20 px in from the edge, 32 px rows, fixed 228 px list.
  const box = async (sel: string) => (await page.locator(sel).first().boundingBox())!;
  await page.locator('.modal.quick-switcher').evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
  const dialog = await box('.modal.quick-switcher');
  const field = await box('.quick-input');
  expect(dialog.width).toBe(682);
  expect(field.height).toBe(70);
  expect(field.x - dialog.x).toBe(20);
  expect((await box('.quick-row')).height).toBe(32);
  expect((await box('.quick-scroller')).height).toBe(228);

  await input.fill('#dvtlk');
  await expect(options.first()).toContainText('dev-talk');
  await input.fill('@ali');
  await expect(options.first()).toContainText(/alice/i);
  await input.fill('*sam');
  await expect(options).toHaveCount(1);
  await expect(options.first()).toContainText("Sam's server");
  await input.fill('!');
  for (const tag of await options.locator('.quick-tag').allTextContents()) expect(tag).toBe('Voice channels');

  await input.fill('random');
  await expect(options.first().locator('.quick-badge')).toHaveText('2');

  await input.fill('#');
  const first = await options.first().getAttribute('id');
  await expect(input).toHaveAttribute('aria-activedescendant', first!);
  await input.press('Tab');
  const second = await options.nth(1).getAttribute('id');
  await expect(input).toHaveAttribute('aria-activedescendant', second!);
  await input.press('Shift+Tab');
  await expect(input).toHaveAttribute('aria-activedescendant', first!);
  await input.press('ArrowDown');
  await expect(input).toHaveAttribute('aria-activedescendant', second!);
  const target = (await options.nth(1).locator('.quick-label').textContent())!;
  await input.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(selected(page)).toContainText(target);
  await expect(page.locator('.quick-tip')).toHaveCount(0);
});

test('dialog: Mod+/ lists every shortcut with OS keys; shortcuts stay off while it is open', async ({ page }) => {
  await openGuild(page);
  const start = await selected(page).textContent();
  await page.keyboard.press('ControlOrMeta+/');
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.shortcuts-heading')).toHaveText(['Navigation', 'Unreads', 'Chat', 'Voice', 'Panels']);
  await expect(dialog.locator('.shortcut-card')).toHaveCount(21);
  const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
  await expect(dialog.locator('.shortcut-card', { hasText: 'Navigate between servers' }).locator('.shortcut-cap')).toHaveText(mac ? ['⌘', '⌥', '↑ ↓'] : ['Ctrl', 'Alt', '↑ ↓']);

  await page.keyboard.press('Alt+ArrowDown');
  await expect(selected(page)).toHaveText(start!);
  await page.keyboard.press('ControlOrMeta+/');
  await expect(dialog).toHaveCount(0);
});

test('read state with a thread panel open: Esc in the channel composer marks the channel, not the thread', async ({ page }) => {
  const general = await openChannel(page, 'general');
  await page.locator('.chat-msg .thread-chip', { hasText: 'gateway docs' }).click();
  await expect(page.locator('.thread-panel .chat-textarea')).toBeVisible();
  const ids = await page.evaluate(g => {
    const st = (window as unknown as Win).__vokko.appStore;
    const s = st.getState();
    const thread = Object.values(s.threads).find(c => c.name === 'gateway docs')!.id;
    // Make #general unread again on the client so its ack is observable.
    st.setState({ readStates: { ...s.readStates, [g]: { channel_id: g, last_message_id: '1', mention_count: 0 } } });
    return { thread, threadRead: s.readStates[thread]?.last_message_id ?? null, last: s.channels[g]!.last_message_id };
  }, general);
  await page.locator('.channel-chat .chat-textarea').focus();
  await page.keyboard.press('Escape');
  const pointer = (id: string) => page.evaluate(c => (window as unknown as Win).__vokko.appStore.getState().readStates[c]?.last_message_id ?? null, id);
  await expect.poll(() => pointer(general)).toBe(ids.last);
  expect(await pointer(ids.thread)).toBe(ids.threadRead);
});

test('Esc on a route without a channel chat (voice page, chat closed) still marks it read; Alt+Down stays in other inputs', async ({ page }) => {
  await openGuild(page);
  const voice = await page.evaluate(() => Object.values((window as unknown as Win).__vokko.appStore.getState().channels).find(x => x.name === 'AFK')!.id);
  // Give the channel a message through its text chat (Open Chat does not join), then close the chat again.
  const guild = new URL(page.url()).pathname.split('/')[2];
  await page.evaluate(p => { history.pushState({}, '', p); window.dispatchEvent(new PopStateEvent('popstate')); }, `/channels/${guild}/${voice}`);
  await page.locator('.channel-header').getByRole('button', { name: 'Show Chat' }).click();
  const box = page.locator('.voice-chat .chat-textarea');
  await box.fill('voice probe');
  await box.press('Enter');
  await expect(page.locator('.voice-chat .chat-msg', { hasText: 'voice probe' })).not.toHaveClass(/pending/);
  await page.locator('.channel-header').getByRole('button', { name: 'Hide Chat' }).click();
  await expect(page.locator('.chat-view')).toHaveCount(0);
  await page.evaluate(v => {
    const st = (window as unknown as Win).__vokko.appStore;
    const s = st.getState();
    st.setState({ readStates: { ...s.readStates, [v]: { channel_id: v, last_message_id: '1', mention_count: 0 } } });
  }, voice);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(v => (window as unknown as Win).__vokko.appStore.getState().readStates[v]?.last_message_id, voice)).not.toBe('1');

  // In the server search box Alt+Down is the field's own key, not channel navigation.
  await openGuild(page);
  const url = page.url();
  await page.getByRole('combobox', { name: 'Search' }).focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(page).toHaveURL(url);
});
