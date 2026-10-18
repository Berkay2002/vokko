import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

// gap-audit-8 item 2: Add Friend answers from the relationship already in the store. Seed, as sam: alice, bob and carol are
// friends, nova has sent a request, spambot is unrelated. Screenshots go to $VOKKO_SHOTS_DIR when set.
// Run: npx playwright test -c e2e/gap8-friends.config.ts --workers=1

const SHOTS = process.env.VOKKO_SHOTS_DIR;

const SIZES = [
  { name: '1440', width: 1440, height: 900 },
  { name: '390', width: 390, height: 844 },
];

async function addFriend(page: Page, name: string) {
  await page.getByLabel('Username').fill(name);
  await page.getByRole('button', { name: 'Send Friend Request' }).click();
}

for (const size of SIZES) {
  test(`Add Friend answers from the relationship (${size.name})`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto('/channels/@me?as=sam&mockLatency=0');
    // at phone width the Friends page sits behind the list and Add Friend is a header button instead of a tab
    if (size.width < 500) await page.locator('.sidebar').getByText('Friends', { exact: true }).first().click();
    await page.locator('.friends-header').getByRole(size.width < 500 ? 'button' : 'tab', { name: 'Add Friend' }).click();
    const result = page.locator('.add-friend-result');
    const shot = async (name: string) => {
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `gap8-friend-${name}-${size.name}.png`) });
    };

    // friend: answered from the store, as an error
    await addFriend(page, 'alice');
    await expect(result).toHaveText("You're already friends with alice.");
    await expect(result).toHaveClass(/error/);
    await shot('already-friends');

    // unrelated: the request goes out and shows as pending; asking again says so
    await addFriend(page, 'spambot');
    await expect(result).toHaveText('Success! Your friend request to spambot was sent.');
    await expect(result).toHaveClass(/success/);
    await addFriend(page, 'spambot');
    await expect(result).toHaveText('You already sent spambot a friend request.');
    await expect(result).toHaveClass(/error/);
    await shot('already-sent');

    // incoming: sending accepts it
    await addFriend(page, 'nova');
    await expect(result).toHaveText('You are now friends with nova.');
    await expect(result).toHaveClass(/success/);
    await shot('now-friends');
    await page.getByRole('tab', { name: 'Pending' }).click();
    await expect(page.getByRole('main', { name: 'Friends' }).getByText('nova', { exact: true })).toHaveCount(0);
  });
}
