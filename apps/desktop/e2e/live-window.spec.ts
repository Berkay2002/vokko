import { expect, test, type Page } from '@playwright/test';

// A channel left open for hours (a call chat): while the list follows the bottom, its oldest messages are dropped as new ones
// arrive (messageState.trimOldest), the view stays at the newest message, and scrolling up loads the dropped ones again.
// Scrolled up, nothing is dropped under the reader.

type Win = {
  __vokko: { messageStore: { getState(id: string): { messages: unknown[]; hasMoreBefore: boolean } } };
  __vokkoMock: { channelIdByName(name: string): string | null; say(channelId: string, username: string, content: string): string };
};

async function openGeneral(page: Page): Promise<string> {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.getByRole('list', { name: 'Channels' }).waitFor();
  const id = await page.evaluate(() => (window as unknown as Win).__vokkoMock.channelIdByName('general')!);
  await page.locator(`a[href$="/${id}"]`).first().click();
  await page.locator('.chat-msg').first().waitFor();
  return id;
}

async function burst(page: Page, channelId: string, from: number, count: number): Promise<void> {
  for (let i = from; i < from + count; i += 20) {
    await page.evaluate(({ channelId, i, end }) => {
      const m = (window as unknown as Win).__vokkoMock;
      for (let k = i; k < Math.min(i + 20, end); k++) m.say(channelId, 'alice', `live ${k}`);
    }, { channelId, i, end: from + count });
    await page.waitForTimeout(30);
  }
}

const loaded = (page: Page, id: string) => page.evaluate(id => (window as unknown as Win).__vokko.messageStore.getState(id).messages.length, id);
const gap = (page: Page) => page.locator('.chat-scroller').evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight);

test('following the bottom: old messages are dropped, the newest stays in view, scrolling up brings them back', async ({ page }) => {
  const id = await openGeneral(page);
  await burst(page, id, 0, 400);
  await expect(page.locator('.chat-content', { hasText: /^live 399$/ })).toBeVisible();
  // The trim remounts the list: no frame may show it anywhere but at the newest message.
  await page.waitForFunction(id => (window as unknown as Win).__vokko.messageStore.getState(id).messages.length < 300, id);
  // Fill the window to LIVE_MAX, then one more message trims it.
  const fill = 300 - (await loaded(page, id));
  await page.evaluate(({ id, fill }) => {
    const m = (window as unknown as Win).__vokkoMock;
    for (let k = 0; k < fill; k++) m.say(id, 'alice', `fill ${k}`);
  }, { id, fill });
  await expect(page.locator('.chat-content', { hasText: `fill ${fill - 1}` })).toBeVisible();
  const frames = await page.evaluate(async id => {
    const out: string[] = [];
    const newest = () => [...document.querySelectorAll('.chat-content')].at(-1)?.textContent ?? '';
    (window as unknown as Win).__vokkoMock.say(id, 'alice', 'trigger');
    for (let f = 0; f < 12; f++) {
      await new Promise(r => requestAnimationFrame(r));
      const el = document.querySelector('.chat-scroller');
      const bottom = el ? el.scrollHeight - el.scrollTop - el.clientHeight < 5 : false;
      out.push(`${newest() === 'trigger' ? 'trigger' : 'before'}|${bottom}`);
    }
    return out;
  }, id);
  // Frames before the message lands are at the bottom too; from the first frame with it, it is the newest row in view.
  const landed = frames.indexOf('trigger|true');
  expect(landed, frames.join(' ')).toBeGreaterThanOrEqual(0);
  expect(frames.slice(0, landed).every(f => f === 'before|true') && frames.slice(landed).every(f => f === 'trigger|true'), frames.join(' ')).toBe(true);
  expect(await loaded(page, id)).toBeLessThanOrEqual(300);
  await expect.poll(() => gap(page)).toBeLessThan(5);

  const scroller = page.locator('.chat-scroller');
  await scroller.hover();
  const first = page.locator('.chat-content', { hasText: /^live 0$/ });
  for (let i = 0; i < 40 && (await first.count()) === 0; i++) {
    await page.mouse.wheel(0, -3000);
    await page.waitForTimeout(150);
  }
  await expect(first).toBeVisible();
});

test('scrolled up: nothing is dropped under the reader', async ({ page }) => {
  const id = await openGeneral(page);
  await burst(page, id, 0, 60);
  await page.locator('.chat-scroller').hover();
  // A wheel that lands while the burst's rows are still being measured is pulled back to the bottom: repeat until it stays up.
  await expect.poll(async () => { await page.mouse.wheel(0, -2500); await page.waitForTimeout(400); return gap(page); }).toBeGreaterThan(500);
  const before = await loaded(page, id);
  await burst(page, id, 60, 300);
  expect(await loaded(page, id)).toBe(before + 300);
});

test('editing: messages past the limit leave the draft alone (no trim under the editor); the trim waits for the edit to end', async ({ page }) => {
  const id = await openGeneral(page);
  await expect.poll(() => loaded(page, id)).toBeGreaterThan(0);
  const fill = 300 - (await loaded(page, id)) - 1;
  await page.evaluate(({ id, fill }) => {
    const m = (window as unknown as Win).__vokkoMock;
    for (let k = 0; k < fill; k++) m.say(id, 'alice', `fill ${k}`);
    m.say(id, 'sam', 'mine to edit');
  }, { id, fill });
  const mine = page.locator('.chat-msg', { hasText: 'mine to edit' });
  await mine.hover();
  await mine.getByRole('button', { name: 'Edit' }).click();
  const editor = page.getByLabel('Edit message');
  await editor.fill('half-typed draft');
  await page.evaluate(id => {
    const m = (window as unknown as Win).__vokkoMock;
    for (let k = 0; k < 3; k++) m.say(id, 'alice', `during edit ${k}`);
  }, id);
  await expect(page.locator('.chat-content', { hasText: 'during edit 2' })).toBeVisible();
  expect(await loaded(page, id)).toBe(303);
  await expect(editor).toHaveValue('half-typed draft');
  await expect(editor).toBeFocused();

  await editor.press('Escape');
  await expect(editor).toHaveCount(0);
  await page.evaluate(id => (window as unknown as Win).__vokkoMock.say(id, 'alice', 'after edit'), id);
  await expect.poll(() => loaded(page, id)).toBeLessThanOrEqual(300);
  await expect(page.locator('.chat-content', { hasText: 'after edit' })).toBeVisible();
});
