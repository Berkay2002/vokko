import { expect, test, type Page } from '@playwright/test';
import { channelIdOf, openDm } from './helpers';

// DM calls against the mock backend: start a call from the DM header, an incoming ring (accept / decline) from a fake remote
// caller, and the call / missed-call rows.

type MockWin = { __vokkoMock: { call(username: string, other: string | null): string | null; voice(username: string, channelId: string | null): void } };

const panel = (page: Page) => page.getByRole('region', { name: 'Call', exact: true });
const incoming = (page: Page) => page.getByRole('alertdialog', { name: /^Incoming call from/ });
const callRow = (page: Page) => page.locator('.chat-system-text[data-call]').last();

async function ringFrom(page: Page, username: string): Promise<string> {
  const id = await page.evaluate(name => (window as unknown as MockWin).__vokkoMock.call(name, 'sam'), username);
  return id ?? '';
}

test('start a call from the DM header: ringing, answered, call row with duration', async ({ page }) => {
  await openDm(page, 'alice');
  const dm = channelIdOf(page);
  await expect(panel(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Start Voice Call' }).click();

  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByRole('group', { name: /ringing$/ })).toBeVisible();
  await expect(panel(page).getByRole('status')).toHaveText(/Ringing…|Connecting…/);
  await expect(callRow(page)).toHaveText(/Sam started a call\./);
  await expect(page.getByRole('img', { name: 'In this call' })).toBeVisible();

  // Alice picks up.
  await page.evaluate(id => (window as unknown as MockWin).__vokkoMock.voice('alice', id), dm);
  await expect(panel(page).locator('.voice-tile')).toHaveCount(2);
  await expect(panel(page).getByRole('group', { name: /ringing$/ })).toHaveCount(0);

  // We leave, then she does: the call ends and the row shows how long it lasted.
  await panel(page).getByRole('button', { name: 'Leave Call' }).click();
  await expect(panel(page).getByRole('button', { name: 'Join Call' })).toBeVisible();
  await page.evaluate(() => (window as unknown as MockWin).__vokkoMock.voice('alice', null));
  await expect(panel(page)).toHaveCount(0);
  await expect(callRow(page)).toHaveText(/Sam started a call that lasted a few seconds\./);
});

test('incoming call: overlay with accept, accept with video and decline; accepting joins the DM call', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('navigation', { name: 'Servers sidebar' }).waitFor();
  const dm = await ringFrom(page, 'alice');
  await expect(incoming(page)).toBeVisible();
  await expect(incoming(page)).toContainText('Alice');
  await expect(incoming(page).getByRole('button', { name: 'Accept with Video' })).toBeVisible();
  await expect(incoming(page).getByRole('button', { name: 'Decline' })).toBeVisible();
  // The DM with the call is on the rail.
  await expect(page.getByRole('link', { name: 'Alice' }).first()).toBeVisible();

  await incoming(page).getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(incoming(page)).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/channels/@me/${dm}$`));
  await expect(panel(page).locator('.voice-tile')).toHaveCount(2);
  await expect(page.getByRole('region', { name: 'Voice connection' }).getByRole('status')).toHaveText('Voice Connected');
  await expect(callRow(page)).toHaveText(/Alice started a call\./);
});

test('Start Voice Call in the friend menu and Start a Call in the DM menu open the DM and call', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  const row = page.locator('.people-row', { hasText: 'Alice' });
  await row.hover();
  await row.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Start Voice Call' }).click();
  await expect(page).toHaveURL(/\/channels\/@me\/\d+$/);
  await expect(panel(page).getByRole('group', { name: /ringing$/ })).toBeVisible();
  await panel(page).getByRole('button', { name: 'Leave Call' }).click();
  // Nobody answered, so the call may end with us leaving: only check we are out of it.
  await expect(page.getByRole('button', { name: 'Leave Call' })).toHaveCount(0);

  await page.locator('.dm-row', { hasText: 'Alice' }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Start a Call' }).click();
  await expect(panel(page).getByRole('button', { name: 'Leave Call' })).toBeVisible();
});

test('stacked incoming calls: the gap between the toasts is not caught by the overlay', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('navigation', { name: 'Servers sidebar' }).waitFor();
  await ringFrom(page, 'alice');
  await ringFrom(page, 'bob');
  await expect(incoming(page)).toHaveCount(2);
  const hit = await page.evaluate(() => {
    const [a, b] = [...document.querySelectorAll('.incoming-call')].map(el => el.getBoundingClientRect());
    if (!(b.top > a.bottom)) return null; // the toasts must be stacked with a gap, or the probe would land inside one
    const el = document.elementFromPoint(a.x + a.width / 2, (a.bottom + b.top) / 2);
    return el?.classList.contains('incoming-calls') ?? false;
  });
  expect(hit).toBe(false);
});

test('declined and hung up: the call shows as missed', async ({ page }) => {
  await openDm(page, 'alice');
  await ringFrom(page, 'alice');
  await expect(incoming(page)).toBeVisible();
  await incoming(page).getByRole('button', { name: 'Decline' }).click();
  await expect(incoming(page)).toHaveCount(0);
  // Not in the call: the panel offers to join.
  await expect(panel(page).getByRole('button', { name: 'Join Call' })).toBeVisible();
  await expect(callRow(page)).toContainText('Join the call');

  await page.evaluate(() => (window as unknown as MockWin).__vokkoMock.call('alice', null));
  await expect(panel(page)).toHaveCount(0);
  await expect(callRow(page)).toHaveAttribute('data-call', 'missed');
  await expect(callRow(page)).toHaveText(/You missed a call from Alice that lasted a few seconds\./);
});
