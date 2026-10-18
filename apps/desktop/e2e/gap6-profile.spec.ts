import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

// gap-audit-6 group D against the mock backend: automatic Idle (5), View Full Profile on the popout (6), image crop (9), phone profile editor (11).
// Screenshots go to $VOKKO_SHOTS_DIR when set. Run: npx playwright test -c e2e/gap6-profile.config.ts --workers=1

const SHOTS = process.env.VOKKO_SHOTS_DIR;
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

type StoreWin = {
  __vokko: {
    appStore: {
      getState(): {
        me: { id: string; avatar: string | null } | null;
        presences: Record<string, { status: string }>;
        channels: Record<string, { id: string; name?: string; guild_id: string | null }>;
        guilds: Record<string, { id: string; name: string; icon: string | null }>;
        members: Record<string, Record<string, { nick?: string | null }>>;
      };
    };
  };
};

const VIEWPORTS = [
  { name: 'desktop', size: { width: 1440, height: 900 }, phone: false },
  { name: 'phone', size: { width: 390, height: 844 }, phone: true },
] as const;

const myStatus = (page: Page) => page.evaluate(() => {
  const s = (window as unknown as StoreWin).__vokko.appStore.getState();
  return s.me ? s.presences[s.me.id]?.status ?? null : null;
});

/** A 300x900 PNG: yellow on top, blue below, so a centre crop and a dragged crop can be told apart. */
async function bandsPng(page: Page): Promise<Buffer> {
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 300;
    c.height = 900;
    const g = c.getContext('2d')!;
    g.fillStyle = '#f5d142';
    g.fillRect(0, 0, 300, 450);
    g.fillStyle = '#3b5bdb';
    g.fillRect(0, 450, 300, 450);
    return c.toDataURL('image/png').split(',')[1];
  });
  return Buffer.from(b64, 'base64');
}

/** Decodes an image URL in the page and reports its size and the luminance of its top and bottom pixel rows' centres. */
const probe = (page: Page, url: string) => page.evaluate(async (u) => {
  const bitmap = await createImageBitmap(await (await fetch(u)).blob());
  const c = document.createElement('canvas');
  c.width = bitmap.width;
  c.height = bitmap.height;
  const g = c.getContext('2d')!;
  g.drawImage(bitmap, 0, 0);
  const at = (y: number) => g.getImageData(Math.floor(bitmap.width / 2), y, 1, 1).data[0];
  return { w: bitmap.width, h: bitmap.height, top: at(2), bottom: at(bitmap.height - 3) };
}, url);

for (const vp of VIEWPORTS) {
  test.describe(`${vp.name} ${vp.size.width}x${vp.size.height}`, () => {
    test.use({ viewport: vp.size, ...(vp.phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });

    async function home(page: Page) {
      await page.goto('/channels/@me?as=sam&mockLatency=0');
      await page.waitForFunction(() => !!(window as unknown as StoreWin).__vokko?.appStore.getState().me);
    }

    async function openStockTalk(page: Page) {
      await home(page);
      await page.waitForFunction(() => Object.values((window as unknown as StoreWin).__vokko.appStore.getState().channels).some(c => c.name === 'stock-talk'));
      const target = await page.evaluate(() => {
        const c = Object.values((window as unknown as StoreWin).__vokko.appStore.getState().channels).find(x => x.name === 'stock-talk')!;
        return `/channels/${c.guild_id}/${c.id}`;
      });
      await page.evaluate(p => { history.pushState({}, '', p); window.dispatchEvent(new PopStateEvent('popstate')); }, target);
      if (vp.phone) await page.locator('a.channel-row[aria-current="page"]').first().tap();
      await page.locator('.chat-msg').first().waitFor();
    }

    async function openEditor(page: Page) {
      await home(page);
      await page.getByRole('button', { name: 'User Settings' }).click();
      await page.getByRole('dialog', { name: 'User Settings' }).locator('.sm-profile-edit').click();
      const editor = page.getByRole('dialog', { name: 'Edit Profile' });
      await expect(editor).toBeVisible();
      return editor;
    }

    test('Online goes Idle after 10 minutes without input and back on the next input', async ({ page }) => {
      await page.clock.install();
      await home(page);
      await expect.poll(() => myStatus(page)).toBe('online');
      await page.clock.fastForward('09:30');
      expect(await myStatus(page)).toBe('online');
      await page.clock.fastForward('01:00');
      await expect.poll(() => myStatus(page)).toBe('idle');
      expect(await page.evaluate(() => localStorage.getItem('vokko.status'))).toBeNull(); // the automatic Idle is not the user's choice
      await shot(page, `idle-${vp.name}`);
      if (vp.phone) await page.touchscreen.tap(200, 400);
      else await page.mouse.move(300, 300);
      await expect.poll(() => myStatus(page)).toBe('online');
    });

    test('a status the user picked is never replaced by Idle', async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem('vokko.status', JSON.stringify({ status: 'dnd', custom: '' })));
      await page.clock.install();
      await home(page);
      await expect.poll(() => myStatus(page)).toBe('dnd');
      await page.clock.fastForward('30:00');
      await page.waitForTimeout(200);
      expect(await myStatus(page)).toBe('dnd');
    });

    test('the profile card of a message author has View Full Profile', async ({ page }) => {
      await openStockTalk(page);
      const row = page.locator('.chat-msg:not(.grouped):not(.system)').last();
      await row.locator('.chat-author').click();
      const card = page.locator('.profile-card');
      await expect(card).toBeVisible();
      await shot(page, `view-full-profile-card-${vp.name}`);
      await card.getByRole('button', { name: 'View Full Profile' }).click();
      await expect(page.locator('.profile-card')).toHaveCount(0);
      await expect(page.getByText(/Mutual Servers?$/)).toBeVisible();
      await shot(page, `view-full-profile-modal-${vp.name}`);
    });

    test('an avatar upload is cropped before it is sent: drag, apply, the result has the chosen part', async ({ page }) => {
      const editor = await openEditor(page);
      await editor.getByTestId('pe-file-avatar').setInputFiles({ name: 'bands.png', mimeType: 'image/png', buffer: await bandsPng(page) });
      const crop = page.getByRole('dialog', { name: 'Edit Image' });
      await expect(crop).toBeVisible();
      const frame = crop.getByTestId('cropper-frame');
      await expect(frame.locator('img')).toBeVisible();
      await shot(page, `crop-avatar-${vp.name}`);
      // Pull the picture all the way down: the yellow top band fills the circle.
      const box = (await frame.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 400, { steps: 5 });
      await page.mouse.up();
      await shot(page, `crop-avatar-dragged-${vp.name}`);
      await crop.getByRole('button', { name: 'Apply' }).click();
      await expect(crop).toHaveCount(0);
      const avatar = editor.locator('.pe-card-avatar img').first();
      await expect(avatar).toHaveAttribute('src', /^blob:/); // the mock keeps the uploaded file under a blob URL
      const src = await avatar.getAttribute('src');
      const result = await probe(page, src!);
      expect(result.w).toBe(result.h);
      expect(result.w).toBe(300);
      expect(result.top).toBeGreaterThan(200);
      expect(result.bottom).toBeGreaterThan(200);
    });

    test('Cancel in the cropper sends nothing and a GIF skips the cropper', async ({ page }) => {
      const editor = await openEditor(page);
      await editor.getByTestId('pe-file-avatar').setInputFiles({ name: 'bands.png', mimeType: 'image/png', buffer: await bandsPng(page) });
      const crop = page.getByRole('dialog', { name: 'Edit Image' });
      await crop.getByRole('button', { name: 'Cancel' }).click();
      await expect(crop).toHaveCount(0);
      await expect(editor.locator('.cs-savebar')).toHaveCount(0);
      const gif = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
      await editor.getByTestId('pe-file-avatar').setInputFiles({ name: 'a.gif', mimeType: 'image/gif', buffer: gif });
      await expect(editor.locator('.cs-savebar')).toBeVisible();
      await expect(page.getByRole('dialog', { name: 'Edit Image' })).toHaveCount(0);
    });

    test('the banner crop frame is 17:6', async ({ page }) => {
      const editor = await openEditor(page);
      await editor.getByTestId('pe-file-card-banner').setInputFiles({ name: 'bands.png', mimeType: 'image/png', buffer: await bandsPng(page) });
      const crop = page.getByRole('dialog', { name: 'Edit Image' });
      const box = (await crop.getByTestId('cropper-frame').boundingBox())!;
      expect(box.width / box.height).toBeCloseTo(17 / 6, 1);
      await shot(page, `crop-banner-${vp.name}`);
      await crop.getByRole('button', { name: 'Apply' }).click();
      await expect(editor.locator('.cs-savebar')).toBeVisible();
    });

    test('server icon and banner go through the cropper', async ({ page }) => {
      await home(page);
      await page.waitForFunction(() => Object.values((window as unknown as StoreWin).__vokko.appStore.getState().guilds).some(g => g.name.endsWith("'s server")));
      const guildId = await page.evaluate(() => Object.values((window as unknown as StoreWin).__vokko.appStore.getState().guilds).find(g => g.name.endsWith("'s server"))!.id);
      await page.evaluate(id => { history.pushState({}, '', `/channels/${id}`); window.dispatchEvent(new PopStateEvent('popstate')); }, guildId);
      if (vp.phone) await page.getByRole('button', { name: 'Show Channels' }).tap();
      await page.locator('.guild-header-name-button').click();
      await page.getByRole('menuitem', { name: 'Server Settings' }).click();
      await page.getByRole('button', { name: 'Server Profile', exact: true }).first().click().catch(() => undefined);
      await page.locator('input[aria-label="Server icon file"]').setInputFiles({ name: 'bands.png', mimeType: 'image/png', buffer: await bandsPng(page) });
      const crop = page.getByRole('dialog', { name: 'Edit Image' });
      await expect(crop).toBeVisible();
      await shot(page, `crop-server-icon-${vp.name}`);
      await crop.getByRole('button', { name: 'Apply' }).click();
      await expect(crop).toHaveCount(0);
      await expect.poll(() => page.evaluate(id => (window as unknown as StoreWin).__vokko.appStore.getState().guilds[id].icon, guildId)).toBeTruthy();
    });

    test('the profile editor has its controls on a phone, and a server profile has a nickname field', async ({ page }) => {
      const editor = await openEditor(page);
      await expect(editor.getByRole('button', { name: 'Profile', exact: true })).toBeVisible();
      await expect(editor.locator('.pe-card')).toBeVisible();
      await expect(editor.getByRole('button', { name: 'Avatar', exact: true })).toBeVisible();
      await shot(page, `editor-main-${vp.name}`);
      await editor.getByRole('button', { name: 'Profile', exact: true }).click();
      await page.getByRole('menuitemcheckbox').nth(1).click();
      const nick = editor.getByLabel('Server nickname');
      await expect(nick).toBeVisible();
      await nick.fill('Captain');
      await shot(page, `editor-server-${vp.name}`);
      await expect(editor.getByRole('button', { name: 'Save Changes' })).toBeVisible();
      const over = await page.evaluate(() => document.scrollingElement!.scrollWidth - window.innerWidth);
      expect(over).toBeLessThanOrEqual(0);
      await editor.getByRole('button', { name: 'Save Changes' }).click();
      await expect(editor.locator('.cs-savebar')).toHaveCount(0);
      const nickSaved = await page.evaluate(() => {
        const s = (window as unknown as StoreWin).__vokko.appStore.getState();
        return Object.values(s.members).some(m => s.me && m[s.me.id]?.nick === 'Captain');
      });
      expect(nickSaved).toBe(true);
    });
  });
}
