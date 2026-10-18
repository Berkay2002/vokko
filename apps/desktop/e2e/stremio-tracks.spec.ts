import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Audio and subtitle languages of a Stremio session against the mock backend (src/api/mock/stremio.ts): the stand-in bot reports
// three audio tracks, two text subtitles and one picture subtitle, and publishes a cue every 5 s of media time per text track.
// Alice starts the session; we join, then switch audio, pick subtitles and turn them off.
// Run from apps/desktop: npx playwright test -c e2e/stremio-tracks.config.ts
const SHOTS = process.env.STREMIO_SHOTS ?? '../../.private/artifacts/stremio-tracks';

type MockWin = { __vokkoMock: { channelIdByName(name: string): string | null; requestAs(user: string, method: string, path: string, body?: unknown): unknown } };
type Stream = { sid: string; playable: boolean };

const poster = (url: string) => {
  const hue = [...url].reduce((sum, c) => (sum * 31 + c.charCodeAt(0)) % 360, 7);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><rect width="300" height="450" fill="hsl(${hue} 45% 28%)"/></svg>`;
};
const shot = (page: Page, name: string) => (mkdirSync(SHOTS, { recursive: true }), page.screenshot({ path: join(SHOTS, name) }));
const as = (page: Page, user: string, method: string, path: string, body?: unknown) =>
  page.evaluate(([u, m, p, b]) => (window as unknown as MockWin).__vokkoMock.requestAs(u as string, m as string, p as string, b), [user, method, path, body] as const);

test('switch the audio, pick a subtitle, turn it off', async ({ page }) => {
  await page.route(/^https:\/\/(images|episodes)\.metahub\.space\/|^https:\/\/m\.media-amazon\.com\//, route => route.fulfill({ contentType: 'image/svg+xml', body: poster(route.request().url()) }));
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.getByRole('list', { name: 'Channels', exact: true }).waitFor();
  await page.locator('.sidebar-scroller').evaluate(el => { el.scrollTop = el.scrollHeight; });
  const channelId = await page.evaluate(() => (window as unknown as MockWin).__vokkoMock.channelIdByName('General') ?? '');
  const path = `/channels/${channelId}/stremio`;
  await as(page, 'sam', 'POST', '/users/@me/stremio/login', { email: 'sam@example.com', password: 'right' }); // addon subtitles are the viewer's own
  const streams = (await as(page, 'alice', 'GET', '/stremio/streams/movie/tt0113277')) as { streams: Stream[] };
  await as(page, 'alice', 'PUT', path, { sid: streams.streams.find(s => s.playable)!.sid });

  await page.getByRole('button', { name: 'General voice channel' }).click();
  const tile = page.getByRole('region', { name: /call$/ }).locator('.voice-tile.stremio');
  await expect(tile).toHaveAttribute('data-status', 'playing', { timeout: 10_000 });
  await expect(tile).toHaveAttribute('data-room', 'connected');
  const languages = tile.getByRole('button', { name: 'Audio and subtitles' });
  const menu = tile.getByRole('menu', { name: 'Audio and subtitles' });
  const row = (name: RegExp) => menu.getByRole('menuitemradio', { name });
  const audio = (name: RegExp) => menu.getByRole('region', { name: 'Audio' }).getByRole('menuitemradio', { name });
  const subtitle = (name: RegExp) => menu.getByRole('region', { name: 'Subtitles' }).getByRole('menuitemradio', { name });

  // Audio: the file's default is in use; every language is listed by name; Swedish switches it for everyone.
  await languages.click();
  await expect(audio(/^English · Surround/)).toHaveAttribute('aria-checked', 'true');
  await expect(audio(/^Swedish/)).toHaveAttribute('aria-checked', 'false');
  await expect(audio(/^French/)).toBeVisible();
  await shot(page, '01-menu-audio.png');
  await audio(/^Swedish/).click();
  await expect(audio(/^Swedish/)).toHaveAttribute('aria-checked', 'true');
  await expect(audio(/^English · Surround/)).toHaveAttribute('aria-checked', 'false');
  // Someone else's change comes through the session state, not through our click.
  await as(page, 'alice', 'PATCH', path, { audio: 3 });
  await expect(audio(/^French/)).toHaveAttribute('aria-checked', 'true');
  // A track the file does not have is refused.
  await expect(as(page, 'alice', 'PATCH', path, { audio: 99 })).rejects.toBeTruthy();

  // Subtitles: off to begin with; embedded text, a picture subtitle (shown to everyone) and the addons' are listed.
  await expect(row(/^Off/)).toHaveAttribute('aria-checked', 'true');
  await expect(row(/shown to everyone/)).toBeVisible();
  await expect(row(/^French.*OpenSubtitles/)).toBeVisible();
  await expect(row(/^German.*OpenSubtitles/)).toBeVisible();
  await menu.getByRole('heading', { name: 'Subtitles' }).scrollIntoViewIfNeeded();
  await menu.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await shot(page, '02-menu-subtitles.png');
  await subtitle(/^Swedish$/).click();
  await expect(tile.getByTestId('stremio-cue')).toContainText(/Svenska line \d+/, { timeout: 8_000 });
  await menu.press('Escape'); // the menu covers the line
  await expect(menu).toHaveCount(0);
  await shot(page, '03-subtitle-on.png');
  await languages.click();
  await expect(row(/^Off/)).toHaveAttribute('aria-checked', 'false');

  // An addon's file replaces it.
  await row(/^German.*OpenSubtitles/).click();
  await expect(tile.getByTestId('stremio-cue')).toContainText(/Deutsch \d+/, { timeout: 8_000 });

  // Off removes the line; a picture subtitle is a session change that Off also undoes.
  await row(/^Off/).click();
  await expect(tile.getByTestId('stremio-cue')).toHaveCount(0);
  await row(/shown to everyone/).click();
  await expect(row(/shown to everyone/)).toHaveAttribute('aria-checked', 'true');
  await expect(row(/^Off/)).toHaveAttribute('aria-checked', 'false');
  await row(/^Off/).click();
  await expect(row(/shown to everyone/)).toHaveAttribute('aria-checked', 'false');
  await expect(row(/^Off/)).toHaveAttribute('aria-checked', 'true');
  await expect(as(page, 'alice', 'PATCH', path, { burned_subtitle: 4 })).rejects.toBeTruthy();

  // The menu closes with Escape.
  await menu.press('Escape');
  await expect(menu).toHaveCount(0);
});
