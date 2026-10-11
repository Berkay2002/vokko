import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { appOrigin, channelIdOf, composer, message, openDm, send } from './helpers';

type Win = {
  __vokkoMock: { say(c: string, u: string, t: string): string; channelIdByName(n: string): string | null };
  __vokko: { request(m: string, p: string, b?: unknown): Promise<unknown>; gateway: { dispatch(t: string, d: unknown): void }; appStore: { getState(): { guilds: Record<string, { id: string; name: string }>; channels: Record<string, { id: string; name?: string; guild_id: string | null; last_message_id: string | null }>; readStates: Record<string, { last_message_id: string | null }> } } };
};

/** In-app navigation: a page reload re-seeds the mock backend and drops the session. */
async function navigate(page: Page, to: string): Promise<void> {
  await page.evaluate(path => { history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, to);
}

test('start-of-DM intro sits directly above the first message and the column is bottom-anchored', async ({ page }) => {
  await openDm(page);
  const intro = await page.locator('.chat-start').boundingBox();
  const first = await page.locator('.chat-msg').first().boundingBox();
  const composerBox = await page.locator('.chat-composer').boundingBox();
  const lastMsg = await page.locator('.chat-msg').last().boundingBox();
  expect(intro && first && composerBox && lastMsg).toBeTruthy();
  // intro bottom -> first message top: only the day divider in between (no viewport-sized gap)
  expect(first!.y - (intro!.y + intro!.height)).toBeLessThan(90);
  // newest message sits right above the composer
  expect(composerBox!.y - (lastMsg!.y + lastMsg!.height)).toBeLessThan(60);
});

test('an empty DM shows the intro at the bottom of the list', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  // the store fills after the load event: wait for the users list before looking nova up
  await page.waitForFunction(() => Object.values((window as unknown as Win).__vokko.appStore.getState().users).some(u => u.username === 'nova'));
  // create a DM with nova (no history)
  const id = await page.evaluate(async () => {
    const w = window as unknown as Win;
    const users = (w.__vokko.appStore.getState() as unknown as { users: Record<string, { id: string; username: string }> }).users;
    const nova = Object.values(users).find(u => u.username === 'nova');
    const ch = await w.__vokko.request('POST', '/users/@me/channels', { recipient_id: nova!.id }) as { id: string };
    return ch.id;
  });
  await navigate(page, `/channels/@me/${id}`);
  await page.locator('.chat-start').waitFor();
  await expect(page.locator('.chat-msg')).toHaveCount(0);
  const intro = await page.locator('.chat-start').boundingBox();
  const composerBox = await page.locator('.chat-composer').boundingBox();
  expect(composerBox!.y - (intro!.y + intro!.height)).toBeLessThan(60);
});

test('intro relationship row: mutual servers, remove/add friend, block and unblock', async ({ page }) => {
  await openDm(page);
  const row = page.locator('.chat-start-relation');
  await expect(row).toContainText(/\d+ Mutual Servers?/);
  await expect(row.getByRole('button', { name: 'Remove Friend' })).toBeVisible();
  await row.getByRole('button', { name: 'Remove Friend' }).click();
  await expect(row.getByRole('button', { name: 'Add Friend' })).toBeVisible();
  await row.getByRole('button', { name: 'Add Friend' }).click();
  await expect(row.getByRole('button', { name: 'Friend Request Sent' })).toBeDisabled();
  await row.getByRole('button', { name: 'Block' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Block' }).click();
  await expect(row.getByRole('button', { name: 'Unblock' })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Add Friend' })).toHaveCount(0);
  await row.getByRole('button', { name: 'Unblock' }).click();
  await expect(row.getByRole('button', { name: 'Add Friend' })).toBeVisible();
});

test('composer GIF / sticker / emoji / apps buttons', async ({ page }) => {
  await openDm(page);
  await page.getByRole('button', { name: 'Open GIF picker' }).click();
  const picker = page.getByRole('dialog', { name: 'Expression picker' });
  await expect(picker.getByRole('tab', { name: 'GIFs' })).toHaveAttribute('aria-selected', 'true');
  await expect(picker).toContainText('aren’t available yet');
  await picker.getByRole('tab', { name: 'Stickers' }).click();
  await expect(picker.getByPlaceholder('Find the perfect sticker')).toBeVisible();
  await picker.getByRole('tab', { name: 'Emoji' }).click();
  await picker.getByRole('button', { name: /grinning face/i }).first().click();
  await expect(composer(page)).not.toHaveValue('');
  await page.getByRole('button', { name: 'Open sticker picker' }).click();
  await expect(page.getByRole('tab', { name: 'Stickers' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Apps' }).click();
  await expect(page.getByRole('dialog', { name: 'Apps' })).toContainText('aren’t available yet');
});

test('context menu Add Reaction submenu and View Reactions modal', async ({ page }) => {
  await openDm(page);
  await send(page, 'react to me through the menu');
  const m = message(page, 'react to me through the menu');
  await m.click({ button: 'right', position: { x: 120, y: 12 } });
  await expect(page.getByRole('menuitem', { name: 'View Reactions' })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Add Reaction' }).hover();
  await page.getByRole('menuitem', { name: /^:/ }).first().click();
  await expect(m.locator('.chat-reaction.me')).toHaveCount(1);
  await m.click({ button: 'right', position: { x: 120, y: 12 } });
  await page.getByRole('menuitem', { name: 'View Reactions' }).click();
  const modal = page.getByRole('dialog', { name: 'Reactions' });
  await expect(modal.getByRole('tab')).toHaveCount(1);
  await expect(modal.locator('.chat-reactions-user')).toContainText('sam');
});

test('invite embeds: invalid code and a real invite', async ({ page }) => {
  await openDm(page);
  await send(page, `${appOrigin(page)}/invite/MXuWj96Fr`);
  const bad = message(page, '/invite/MXuWj96Fr');
  await expect(bad.locator('.chat-invite.invalid')).toContainText('Invalid Invite');
  await expect(bad.locator('.chat-invite.invalid')).toContainText('You sent an invite, but');

  const code = await page.evaluate(async () => {
    const w = window as unknown as Win;
    const general = w.__vokkoMock.channelIdByName('general')!;
    const invite = await w.__vokko.request('POST', `/channels/${general}/invites`, { max_age: 0 }) as { code: string };
    return invite.code;
  });
  await send(page, `join us ${appOrigin(page)}/invite/${code}`);
  const good = message(page, `/invite/${code}`);
  await expect(good.locator('.chat-invite:not(.invalid)')).toContainText('You sent an invite to join a server');
  await expect(good.locator('.chat-invite-join')).toHaveText('Joined'); // sam is already a member
});

test('link embeds from the server render title, description, fields, colour bar and footer', async ({ page }) => {
  await openDm(page);
  await send(page, 'check https://example.org/post');
  const m = message(page, 'check https://example.org/post');
  await expect(m).toBeVisible();
  await expect(m).not.toHaveClass(/pending/);
  const id = await m.getAttribute('data-message-id');
  const cid = channelIdOf(page);
  await page.evaluate(async ([cid, id]) => {
    const w = window as unknown as Win;
    const list = await w.__vokko.request('GET', `/channels/${cid}/messages?limit=10`) as { id: string }[];
    const msg = list.find(x => x.id === id)!;
    w.__vokko.gateway.dispatch('MESSAGE_UPDATE', {
      ...msg,
      embeds: [{
        type: 'rich', title: 'A rich embed', url: 'https://example.org/post', description: 'Some **bold** description', color: 0x5865f2,
        provider: { name: 'Example' }, author: { name: 'Writer' },
        fields: [{ name: 'One', value: '1', inline: true }, { name: 'Two', value: '2', inline: true }, { name: 'Wide', value: 'full width' }],
        footer: { text: 'Footer text' },
      }, {
        type: 'link', title: 'Unsafe link', url: 'javascript:alert(1)',
      }],
    });
  }, [cid, id] as const);
  const card = m.locator('.chat-embed-rich').first();
  await expect(card.locator('.chat-embed-title')).toHaveText('A rich embed');
  await expect(card.locator('.chat-embed-desc b, .chat-embed-desc strong')).toHaveText('bold');
  await expect(card.locator('.chat-embed-field')).toHaveCount(3);
  await expect(card.locator('.chat-embed-footer')).toContainText('Footer text');
  await expect(card).toHaveCSS('border-left-color', 'rgb(88, 101, 242)');
  // the javascript: URL is never turned into a link
  const unsafe = m.locator('.chat-embed-rich').nth(1);
  await expect(unsafe.locator('a')).toHaveCount(0);
  await card.locator('.chat-embed-title').click();
  await expect(page.getByRole('dialog', { name: /Leaving/ })).toBeVisible();
});

test('Shift+Escape marks the whole server read', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.waitForFunction(() => Object.values((window as unknown as Win).__vokko.appStore.getState().channels).some(c => c.guild_id));
  const ids = await page.evaluate(() => {
    const w = window as unknown as Win;
    const s = w.__vokko.appStore.getState();
    const find = (name: string) => Object.values(s.channels).find(c => c.name === name && c.guild_id);
    const welcome = find('welcome') ?? find('general')!;
    const general = Object.values(s.channels).find(c => c.name === 'general' && c.guild_id)!;
    return { guild: welcome.guild_id!, view: welcome.id, other: general.id };
  });
  await navigate(page, `/channels/${ids.guild}/${ids.view}`);
  await page.locator('.chat-textarea').waitFor();
  const other = ids.view === ids.other ? (await page.evaluate(g => {
    const s = (window as unknown as Win).__vokko.appStore.getState();
    return Object.values(s.channels).find(c => c.guild_id === g && c.id !== (new URL(location.href).pathname.split('/').pop()))?.id ?? null;
  }, ids.guild)) : ids.other;
  expect(other).toBeTruthy();
  await page.evaluate(([c]) => { (window as unknown as Win).__vokkoMock.say(c!, 'alice', 'unread in another channel'); }, [other] as const);
  const unread = () => page.evaluate(([c]) => {
    const s = (window as unknown as Win).__vokko.appStore.getState();
    return s.readStates[c!]?.last_message_id !== s.channels[c!]?.last_message_id;
  }, [other] as const);
  await expect.poll(unread).toBe(true);
  await page.locator('body').click({ position: { x: 700, y: 300 } });
  await page.keyboard.press('Shift+Escape');
  await expect.poll(unread, { timeout: 5000 }).toBe(false);
});
