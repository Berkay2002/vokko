import type { Page } from '@playwright/test';

// Shared by the thread and forum specs. The mock seed has: #general with threads "gateway docs" (sam joined), "coffee setups" (locked,
// owned by bob, sam not in it) and an archived "replay buffer sizing"; #announcements (type 5); the forum #support with tags
// Question / Bug / Feature / Docs / Solved and five posts, one pinned, two with reactions; sam has read all but the newest post.

type StoreWin = { __vokko: { appStore: { getState(): { channels: Record<string, { id: string; name?: string; guild_id: string | null }> } } } };

/** Signs in (sam by default) and opens the channel called `name` of the demo server (in-app navigation: a reload would re-seed the mock). */
export async function openChannel(page: Page, name: string, as = 'sam'): Promise<string> {
  await page.goto(`/channels/@me?as=${as}&mockLatency=0`);
  await page.waitForFunction(n => Object.values((window as unknown as StoreWin).__vokko.appStore.getState().channels).some(c => c.name === n && c.guild_id), name);
  const target = await page.evaluate(n => {
    const c = Object.values((window as unknown as StoreWin).__vokko.appStore.getState().channels).find(x => x.name === n && x.guild_id)!;
    return `/channels/${c.guild_id}/${c.id}`;
  }, name);
  await page.evaluate(path => { history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, target);
  // Phone widths: Home is the list page and a server picked in the rail keeps it open; tapping the open channel shows the chat.
  if (await page.locator('.app-frame.nav-open').count()) await page.locator('.app-frame.nav-open a.channel-row[aria-current="page"]').first().click();
  await page.locator('.channel-header').getByRole('heading', { name, exact: true }).waitFor();
  return target.split('/').pop()!;
}

export const panel = (page: Page) => page.locator('.thread-panel');

/** Opens a thread of the current channel from the threads popout. */
export async function openThreadFromPopout(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await page.getByRole('dialog', { name: 'Threads' }).getByRole('button', { name: new RegExp(name) }).click();
  await panel(page).locator('.thread-panel-header').getByRole('heading', { name, level: 2 }).waitFor();
}
