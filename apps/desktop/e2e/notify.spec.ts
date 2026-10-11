import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import path from 'node:path';

// Notifications, sounds, unread title/favicon and the connection / permission banners, against the mock backend.
// The Notification API, AudioContext and document.hasFocus are stubbed in the page so the real code path runs and can be observed.
// Screenshots are written when VOKKO_SHOTS_DIR is set.
const dir = process.env.VOKKO_SHOTS_DIR;
test.describe.configure({ mode: 'serial' });

interface Probe {
  notes: { title: string; body: string; tag: string; icon?: string; fire(): void; closed: boolean }[];
  beeps: number;
  focused: boolean;
  permission: NotificationPermission;
  askedPermission: number;
}
type Win = {
  __probe: Probe;
  __vokkoMock: { say(c: string, u: string, t: string): string; channelIdByName(n: string): string | null; offline(on: boolean): void; presence(u: string, s: string): void };
  __vokko: { appStore: { getState(): { me: { id: string }; channels: Record<string, { id: string; name: string | null; guild_id: string | null; recipients?: { username: string }[] }>; readStates: Record<string, unknown>; connection: string } } };
};

/** What the browser chrome showed, collected by the tests and drawn into one strip PNG by the last test (a viewport screenshot has no tab). */
const seen: { states: { label: string; title: string; icon: string }[]; toast?: { title: string; body: string; tag: string } } = { states: [] };
const chrome = (page: Page) =>
  page.evaluate(() => ({ title: document.title, icon: decodeURIComponent(document.querySelector<HTMLLinkElement>('link[rel="icon"]')!.href.replace('data:image/svg+xml,', '')) }));

const shot = async (page: Page, name: string) => {
  if (!dir) return;
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
};

/** Stubs, installed before the app boots. `prefs` is merged into vokko.prefs, `permission` is the initial Notification.permission. */
async function setup(page: Page, opts: { permission?: NotificationPermission; prefs?: Record<string, unknown>; slowGateway?: number } = {}) {
  await page.addInitScript(
    ({ permission, prefs, slowGateway }) => {
      const probe: Probe = { notes: [], beeps: 0, focused: false, permission, askedPermission: 0 };
      (window as unknown as { __probe: Probe }).__probe = probe;
      class FakeNotification {
        static get permission() { return probe.permission; }
        static requestPermission() { probe.askedPermission += 1; probe.permission = 'granted'; return Promise.resolve('granted' as NotificationPermission); }
        onclick: (() => void) | null = null;
        constructor(public title: string, init: { body?: string; tag?: string; icon?: string } = {}) {
          const note = { title, body: init.body ?? '', tag: init.tag ?? '', icon: init.icon, closed: false, fire: () => this.onclick?.() };
          probe.notes.push(note);
        }
        close() { probe.notes[probe.notes.length - 1]!.closed = true; }
      }
      (window as unknown as { Notification: unknown }).Notification = FakeNotification;
      class FakeAudio {
        state = 'running';
        currentTime = 0;
        destination = {};
        resume() { return Promise.resolve(); }
        createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
        createOscillator() { probe.beeps += 1; return { type: 'sine', frequency: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, start() {}, stop() {} }; }
      }
      (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudio;
      document.hasFocus = () => probe.focused;
      if (slowGateway) {
        const real = window.setTimeout.bind(window);
        // The mock socket says Hello 15 ms after opening: hold it back so the first-connect splash stays on screen.
        (window as unknown as { setTimeout: unknown }).setTimeout = (fn: TimerHandler, ms?: number, ...rest: unknown[]) => real(fn, ms === 15 ? slowGateway : ms, ...rest);
      }
      if (!localStorage.getItem('vokko.prefs')) localStorage.setItem('vokko.prefs', JSON.stringify(prefs));
    },
    { permission: opts.permission ?? 'granted', prefs: { desktopNotifications: true, notificationSounds: true, ...(opts.prefs ?? {}) }, slowGateway: opts.slowGateway ?? 0 },
  );
}

async function boot(page: Page, as = 'sam', route = '/channels/@me') {
  await page.goto(`${route}?as=${as}&mockLatency=0`);
  await page.waitForFunction(() => (window as unknown as Win).__vokko.appStore.getState().connection === 'ready' && Object.keys((window as unknown as Win).__vokko.appStore.getState().channels).length > 0);
}

/** The seed leaves unread channels and mentions behind: ack every channel so a test starts from a clean title. */
async function readEverything(page: Page) {
  await page.evaluate(async () => {
    const w = window as unknown as Win & { __vokko: { request(m: string, p: string, b?: unknown): Promise<unknown> } };
    for (const c of Object.values(w.__vokko.appStore.getState().channels) as { id: string; last_message_id?: string | null }[]) {
      if (c.last_message_id) await w.__vokko.request('POST', `/channels/${c.id}/messages/${c.last_message_id}/ack`);
    }
  });
  await expect.poll(() => page.title()).toBe('Vokko | Friends');
}

const dmWith = (page: Page, username: string) =>
  page.evaluate(u => Object.values((window as unknown as Win).__vokko.appStore.getState().channels).find(c => !c.guild_id && c.recipients?.some(r => r.username === u))?.id ?? null, username);

const channelNamed = (page: Page, name: string) => page.evaluate(n => (window as unknown as Win).__vokkoMock.channelIdByName(n), name);

const say = (page: Page, channelId: string, user: string, text: string) =>
  page.evaluate(([c, u, t]) => (window as unknown as Win).__vokkoMock.say(c!, u!, t!), [channelId, user, text] as const);

const probe = <T,>(page: Page, read: (p: Probe) => T) => page.evaluate(`(${read.toString()})(window.__probe)`) as Promise<T>;

// localState.ts and prefs.ts are the same module instances the app uses (one URL under Vite), so tests import them from the page.

test('DM from another user raises a desktop notification and a mention ping when the channel is not open', async ({ page }) => {
  await setup(page);
  await boot(page);
  const dm = (await dmWith(page, 'alice'))!;
  await say(page, dm, 'alice', 'are you around for a quick call?');
  await expect.poll(() => probe(page, p => p.notes.length)).toBe(1);
  const note = await probe(page, p => ({ title: p.notes[0]!.title, body: p.notes[0]!.body, tag: p.notes[0]!.tag, icon: p.notes[0]!.icon }));
  expect(note.title.toLowerCase()).toContain('alice');
  expect(note.body).toBe('are you around for a quick call?');
  expect(note.tag).toBe(dm);
  expect(note.icon).toBeTruthy();
  // mention / DM ping = 3 notes
  expect(await probe(page, p => p.beeps)).toBe(3);
  seen.toast = { title: note.title, body: note.body, tag: note.tag };
});

test('clicking the notification focuses the app on that channel and the message', async ({ page }) => {
  await setup(page);
  await boot(page);
  const dm = (await dmWith(page, 'alice'))!;
  await say(page, dm, 'alice', 'open me from the toast');
  await expect.poll(() => probe(page, p => p.notes.length)).toBe(1);
  await page.evaluate(() => (window as unknown as Win).__probe.notes[0]!.fire());
  await expect(page).toHaveURL(new RegExp(`/channels/@me/${dm}$`));
  await expect(page.locator('.chat-msg', { hasText: 'open me from the toast' })).toBeVisible();
});

test('no desktop notification while the window is focused on that channel; sound follows "sounds for the channel you are viewing"', async ({ page }) => {
  await setup(page);
  await boot(page);
  const dm = (await dmWith(page, 'alice'))!;
  await page.getByRole('link', { name: /^alice/i }).first().click();
  await expect(page).toHaveURL(new RegExp(`/channels/@me/${dm}$`));
  await page.locator('.chat-textarea').waitFor();
  await page.evaluate(() => { (window as unknown as Win).__probe.focused = true; });
  await say(page, dm, 'alice', 'you are looking right at me');
  await expect(page.locator('.chat-msg', { hasText: 'looking right at me' })).toBeVisible();
  await page.waitForTimeout(300);
  expect(await probe(page, p => p.notes.length)).toBe(0);
  expect(await probe(page, p => p.beeps)).toBe(0);
  // the same message in another channel while focused: toast + sound
  const general = (await channelNamed(page, 'general'))!;
  await say(page, general, 'alice', 'hello from general');
  await expect.poll(() => probe(page, p => p.notes.length)).toBe(1);
});

test('channel, category and server mute, notification levels and suppress @everyone are respected', async ({ page }) => {
  await setup(page);
  await boot(page);
  const general = (await channelNamed(page, 'general'))!;
  const guildId = (await page.evaluate(id => (window as unknown as Win).__vokko.appStore.getState().channels[id]!.guild_id, general))!;
  const meId = await page.evaluate(() => (window as unknown as Win).__vokko.appStore.getState().me.id);

  // muted channel: nothing
  await page.evaluate(`import('/src/shell/localState.ts').then(m => m.muteFor(${JSON.stringify(general)}, -1))`);
  await say(page, general, 'alice', 'muted channel message');
  await page.waitForTimeout(300);
  expect(await probe(page, p => p.notes.length)).toBe(0);
  await page.evaluate(`import('/src/shell/localState.ts').then(m => m.unmute(${JSON.stringify(general)}))`);

  // server level "only @mentions": plain message silent, direct mention fires
  await page.evaluate(`import('/src/shell/localState.ts').then(m => m.setNotifyLevel(${JSON.stringify(guildId)}, 'mentions'))`);
  await say(page, general, 'alice', 'plain message in a mentions-only server');
  await page.waitForTimeout(300);
  expect(await probe(page, p => p.notes.length)).toBe(0);
  await say(page, general, 'alice', `<@${meId}> this one is for you`);
  await expect.poll(() => probe(page, p => p.notes.length)).toBe(1);
  const body = await probe(page, p => p.notes[0]!.body);
  expect(body).toMatch(/^@.+ this one is for you$/);
  const title = await probe(page, p => p.notes[0]!.title);
  expect(title).toContain('#general');

  // @everyone fires, unless it is suppressed for the server
  await say(page, general, 'alice', '@everyone standup in five');
  await expect.poll(() => probe(page, p => p.notes.length)).toBe(2);
  await page.evaluate(`import('/src/shell/localState.ts').then(m => m.toggleFlag('suppressEveryone', ${JSON.stringify(guildId)}))`);
  await say(page, general, 'alice', '@everyone standup in one');
  await page.waitForTimeout(300);
  expect(await probe(page, p => p.notes.length)).toBe(2);

  // "Nothing" silences even direct mentions
  await page.evaluate(`import('/src/shell/localState.ts').then(m => m.setNotifyLevel(${JSON.stringify(guildId)}, 'none'))`);
  const before = await probe(page, p => p.notes.length);
  await say(page, general, 'alice', `<@${meId}> but the server says Nothing`);
  await page.waitForTimeout(300);
  expect(await probe(page, p => p.notes.length)).toBe(before);
});

test('do-not-disturb, desktop pref off and sounds pref off', async ({ page }) => {
  await setup(page, { prefs: { desktopNotifications: false } });
  await boot(page);
  const dm = (await dmWith(page, 'alice'))!;
  await say(page, dm, 'alice', 'pref off, sound still plays');
  await expect.poll(() => probe(page, p => p.beeps)).toBeGreaterThan(0);
  expect(await probe(page, p => p.notes.length)).toBe(0);
  const beeps = await probe(page, p => p.beeps);
  await page.evaluate(`import('/src/ui/prefs.ts').then(m => { m.setPref('notificationSounds', false); m.setPref('desktopNotifications', true); })`);
  await say(page, dm, 'alice', 'sounds off, toast on');
  await expect.poll(() => probe(page, p => p.notes.length)).toBe(1);
  expect(await probe(page, p => p.beeps)).toBe(beeps);
});

test('document title and favicon show unread and mention state', async ({ page }) => {
  await setup(page);
  await boot(page);
  await readEverything(page);
  const general = (await channelNamed(page, 'general'))!;
  const meId = await page.evaluate(() => (window as unknown as Win).__vokko.appStore.getState().me.id);
  seen.states.push({ label: 'nothing unread', ...(await chrome(page)) });
  await say(page, general, 'alice', 'something unread');
  await expect.poll(() => page.title()).toBe('• Vokko | Friends');
  const plain = await chrome(page);
  expect(plain.icon).toContain('#f23f42');
  seen.states.push({ label: 'unread, no mention', ...plain });
  await say(page, general, 'alice', `<@${meId}> ping`);
  await expect.poll(() => page.title()).toBe('(1) Vokko | Friends');
  const mention = await chrome(page);
  expect(mention.icon).not.toBe(plain.icon);
  expect(mention.icon).toContain('>1<');
  seen.states.push({ label: '1 mention', ...mention });
  // the unread badge pref turns the title/favicon indicator off
  await page.evaluate(`import('/src/ui/prefs.ts').then(m => m.setPref('unreadBadge', false))`);
  await expect.poll(() => page.title()).toBe('Vokko | Friends');
});

test('opening the channel reads it and clears the title', async ({ page }) => {
  await setup(page);
  await boot(page);
  await readEverything(page);
  const general = (await channelNamed(page, 'general'))!;
  await say(page, general, 'alice', 'to be read');
  await expect.poll(() => page.title()).toMatch(/^• /);
  // The chat only acks while the window has focus.
  await page.evaluate(() => { (window as unknown as Win).__probe.focused = true; });
  await page.evaluate(id => {
    const guild = (window as unknown as Win).__vokko.appStore.getState().channels[id]!.guild_id;
    history.pushState({}, '', `/channels/${guild}/${id}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, general);
  await expect(page.locator('.chat-msg', { hasText: 'to be read' })).toBeVisible();
  await expect.poll(() => page.title()).toMatch(/^Vokko \| #general \|/);
});

test('connection banner appears when the gateway is down and goes away on reconnect', async ({ page }) => {
  await setup(page);
  await boot(page);
  await expect(page.getByTestId('connection-banner')).toHaveCount(0);
  await page.evaluate(() => (window as unknown as Win).__vokkoMock.offline(true));
  const banner = page.getByTestId('connection-banner');
  await expect(banner).toBeVisible({ timeout: 8000 });
  await expect(banner).toContainText('Connection lost');
  // the app is pushed down by the banner height instead of being covered
  expect(await page.evaluate(() => document.documentElement.classList.contains('has-top-banner'))).toBe(true);
  await shot(page, '03-connection-banner');
  await page.evaluate(() => (window as unknown as Win).__vokkoMock.offline(false));
  await banner.getByRole('button', { name: 'Reconnect now' }).click();
  await expect(banner).toHaveCount(0, { timeout: 8000 });
  expect(await page.evaluate(() => (window as unknown as Win).__vokko.appStore.getState().connection)).toBe('ready');
  expect(await page.evaluate(() => document.documentElement.classList.contains('has-top-banner'))).toBe(false);
});

test('a quick resume does not flash the banner', async ({ page }) => {
  await setup(page);
  await boot(page);
  await page.evaluate(() => {
    (window as unknown as { __seen: boolean }).__seen = false;
    new MutationObserver(() => { if (document.querySelector('[data-testid="connection-banner"]')) (window as unknown as { __seen: boolean }).__seen = true; }).observe(document.body, { childList: true, subtree: true });
    (window as unknown as { __vokkoMock: { dropConnections(): void } }).__vokkoMock.dropConnections();
  });
  await page.waitForTimeout(2500);
  expect(await page.evaluate(() => (window as unknown as { __seen: boolean }).__seen)).toBe(false);
  expect(await page.evaluate(() => (window as unknown as Win).__vokko.appStore.getState().connection)).toBe('ready');
});

test('permission banner: enable grants and flips the pref, dismiss is remembered', async ({ page }) => {
  await setup(page, { permission: 'default', prefs: { desktopNotifications: false } });
  await boot(page);
  const banner = page.getByTestId('permission-banner');
  await expect(banner).toBeVisible();
  await shot(page, '04-permission-banner');
  await banner.getByRole('button', { name: 'Enable Desktop Notifications' }).click();
  await expect(banner).toHaveCount(0);
  expect(await probe(page, p => p.askedPermission)).toBe(1);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('vokko.prefs')!).desktopNotifications)).toBe(true);
});

test('permission banner: "No thanks" hides it for good', async ({ page }) => {
  await setup(page, { permission: 'default', prefs: { desktopNotifications: false } });
  await boot(page);
  const banner = page.getByTestId('permission-banner');
  await banner.getByRole('button', { name: 'No thanks' }).click();
  await expect(banner).toHaveCount(0);
  await page.reload();
  await page.waitForFunction(() => (window as unknown as Win).__vokko.appStore.getState().connection === 'ready');
  await page.waitForTimeout(400);
  await expect(page.getByTestId('permission-banner')).toHaveCount(0);
});

test('first-connect splash', async ({ page }) => {
  await setup(page, { slowGateway: 9000 });
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  const splash = page.getByTestId('splash');
  await expect(splash).toBeVisible();
  await expect(splash).toContainText('Connecting');
  await shot(page, '05-splash-connecting');
  await expect(splash.getByRole('button', { name: 'Try again' })).toBeVisible({ timeout: 8000 });
  await shot(page, '06-splash-slow');
});

test('strip: tab title, favicon states and the toast text (a viewport screenshot cannot show browser chrome)', async ({ browser }) => {
  test.skip(!dir, 'set VOKKO_SHOTS_DIR to capture screenshots');
  expect(seen.states.length).toBe(3);
  const rows = seen.states
    .map(s => {
      const uri = `data:image/svg+xml,${encodeURIComponent(s.icon)}`;
      const icons = [16, 32, 64].map(n => `<img src="${uri}" width="${n}" height="${n}" style="margin-right:12px">`).join('');
      return `<div class="row"><div class="icons">${icons}</div><div><div class="tab">${s.title.replace(/</g, '&lt;')}</div><div class="label">${s.label}</div></div></div>`;
    })
    .join('');
  const toast = seen.toast
    ? `<div class="toast"><div class="toast-title">${seen.toast.title}</div><div class="toast-body">${seen.toast.body}</div><div class="label">Notification payload: title / body, tag = channel id ${seen.toast.tag}</div></div>`
    : '';
  const page = await browser.newPage({ viewport: { width: 760, height: 420 } });
  await page.setContent(`<style>body{margin:0;padding:24px;background:#1e1f22;color:#efeff1;font:14px 'Noto Sans',Segoe UI,sans-serif}
    .row{display:flex;align-items:center;gap:24px;margin-bottom:20px}.icons{width:150px;display:flex;align-items:center}
    .tab{font-size:15px;font-weight:600}.label{color:#96979e;font-size:12px;margin-top:2px}
    .toast{margin-top:8px;padding:12px 16px;background:#2b2d31;border-radius:8px;width:420px}.toast-title{font-weight:700}.toast-body{margin-top:2px}</style>
    <h3 style="margin:0 0 16px">Document title + favicon states, values captured from the e2e run</h3>${rows}${toast}`);
  await page.screenshot({ path: path.join(dir!, '02-title-favicon-states.png') });
  await page.close();
});
