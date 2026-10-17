import { expect, test, type Page } from '@playwright/test';
import { openStockTalk } from './helpers';

// "Listening to Spotify" (presence activity type 2): the member list line, the profile popout card and the Active Now card.
// The activity comes from the desktop app's local Spotify reader, so the specs set the friends' presences straight in the store.

type Hooks = {
  __vokko: {
    appStore: { getState(): { me: { id: string } | null; users: Record<string, unknown>; presences: Record<string, unknown> }; setState(s: unknown): void };
  };
};

const IMAGE = 'ab67616d00001e02e0f5c2a1b3d4e5f60718293a';
const TRACK = '4uLU6hMCjMI75M1A2tKUQC';

/** Gives every other user a song that started 1:05 ago and lasts 3:20. */
async function everyoneListens(page: Page) {
  // the real art host is not reachable from the test browser: serve a plain picture for it
  await page.route('https://i.scdn.co/**', route =>
    route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><defs><linearGradient id="g"><stop offset="0" stop-color="#7c3aed"/><stop offset="1" stop-color="#ec4899"/></linearGradient></defs><rect width="64" height="64" fill="url(#g)"/></svg>' }),
  );
  await page.evaluate(
    ({ image, track }) => {
      const store = (window as unknown as Hooks).__vokko.appStore;
      const { me, users, presences } = store.getState();
      const next = { ...presences };
      const start = Date.now() - 65_000;
      for (const id of Object.keys(users)) {
        if (id === me?.id) continue;
        next[id] = {
          user_id: id,
          status: 'online',
          custom_status: null,
          activities: [{ name: 'Spotify', type: 2, details: 'Midnight City', state: 'M83; Anthony Gonzalez', assets: { large_image: `spotify:${image}` }, sync_id: track, timestamps: { start, end: start + 200_000 } }],
        };
      }
      store.setState({ presences: next });
    },
    { image: IMAGE, track: TRACK },
  );
}

test('the member list shows the artist after a music note', async ({ page }) => {
  await openStockTalk(page);
  await everyoneListens(page);
  const line = page.locator('.member-list [data-testid="activity-line"]').first();
  await expect(line).toHaveText('M83; Anthony Gonzalez');
  await expect(line.locator('.activity-song-icon')).toBeVisible();
});

test('the profile popout shows the song, its artists, a progress bar and Play on Spotify', async ({ page }) => {
  await openStockTalk(page);
  await everyoneListens(page);
  await page.locator('.member-row', { has: page.getByTestId('activity-line') }).first().click();
  const card = page.getByTestId('spotify-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Listening to Spotify');
  await expect(card.getByTestId('spotify-title')).toHaveText('Midnight City');
  await expect(card.getByTestId('spotify-artists')).toHaveText('by M83; Anthony Gonzalez');
  await expect(card.locator('img.spotify-card-art')).toHaveAttribute('src', `https://i.scdn.co/image/${IMAGE}`);
  await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '200');
  await expect(card).toContainText('3:20');
  const play = card.getByRole('link', { name: 'Play on Spotify' });
  await expect(play).toHaveAttribute('href', `https://open.spotify.com/track/${TRACK}`);
  await expect(play).toHaveAttribute('target', '_blank');
  if (process.env.SPOTIFY_SHOT) await page.locator('.profile-card').screenshot({ path: process.env.SPOTIFY_SHOT });
});

test('a song without a track id or art falls back to a search link and a green tile', async ({ page }) => {
  await openStockTalk(page);
  await page.evaluate(() => {
    const store = (window as unknown as Hooks).__vokko.appStore;
    const { me, users, presences } = store.getState();
    const next = { ...presences };
    for (const id of Object.keys(users)) if (id !== me?.id) next[id] = { user_id: id, status: 'online', custom_status: null, activities: [{ name: 'Spotify', type: 2, details: 'Song', state: 'Artist' }] };
    store.setState({ presences: next });
  });
  await page.locator('.member-row', { has: page.getByTestId('activity-line') }).first().click();
  const card = page.getByTestId('spotify-card');
  await expect(card.locator('.spotify-art-placeholder')).toBeVisible();
  await expect(card.getByRole('progressbar')).toHaveCount(0);
  await expect(card.getByRole('link', { name: 'Play on Spotify' })).toHaveAttribute('href', 'https://open.spotify.com/search/Song%20Artist');
});

test('Active Now shows the song of a friend who listens', async ({ page }) => {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  await everyoneListens(page);
  const column = page.getByRole('complementary', { name: 'Active Now' });
  await expect(column.getByTestId('activity-line').first()).toHaveText('Listening to Spotify');
  await expect(column.locator('.active-card-title', { hasText: 'Midnight City' }).first()).toBeVisible();
  await expect(column.locator('.active-card-body-sub', { hasText: 'by M83; Anthony Gonzalez' }).first()).toBeVisible();
});
