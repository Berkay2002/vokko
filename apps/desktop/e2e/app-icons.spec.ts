import { expect, test, type Page } from '@playwright/test';
import { openStockTalk } from './helpers';

// App names and icons (docs/api.md "App icons"): the desktop shell is faked (isTauri + invoke), the mock backend stands in for the server.
// With APP_ICON_SHOTS=<dir> the run also saves the three review screenshots there.

const ICONS: Record<string, string> = {"chrome.exe": "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAS4ElEQVR4nNVbC5BcVZn+/nPu7e7p6XklG2aICBpIiAHkEUJQtphEMxsVWVxxghVKLZV1feDK7rq1W7VVzkRWa8vCcl3F0kVZFQWcyBJXyIZHHqMRJQ+ICUSe4ZHII2Qyr56e7nvPOf/Wf253J0xmkumZQdifumG6+97T///97/+cBl5jYgZxDzR/DyEzdE8P9ET39nR2au7s1DsWLw43t7cHDCj8fyQWoTcjYB5fAHmfH0Yzb0Zz/8fObeb29ubnL764btx7AWIBo+u1AYNmcjHRtF90FWz1vQcwC0V9vmX9DoY7gwI6lWNuA9FcBI6HfjQf9olmQiYeCqCeMswDIWg3iHenFbZn792xv7qW8NvZqbB2rSP/8g0CACeaZqKEKd5cd4qF6QD4Awy6JAgxGykArnwJPDGAlMPwD89E9HgTgjqDFGm/UECEmBkFYwtEtEsDd1KA9Y0btu2tfmdnp6a1a6tAvy4AMIOwFqqicd6iOxzRR9jRFboOjR6OIhCbqujyjQKTvyjlMPTjBYifaILKGGZX1qp8yiCtSNcphVApjFhjFNNmy/jJC7Pyt5+9dm/kY0QXQGvKa/8pAeAe6Krgm4KlLqDrFaEDIcAFwFhYvzpDkQh9zAKAB+BHCQCUMWJDY29hYnZM8gkFOa2hCSgxPxI7/urs+7fdNl1rUFMSfjMCEX5kHebaLcHNTtGvVYiOuAgXDcMa691BeNXjCj9JIm8vpEV4+dphY2x/bCwBZ2eUunWo46J7D3UsXSrCc1eX8jHitQSAJbqLRpfDxPfqlZnmcLvK0sedQRjnYYmgFE1P6OMQEYlXkC4Y64aNcaFSHSF4a/+Ki66jNWt8YJRU+poAwF3elEWzLt4Ydgd1aoMizI0HYLyp0sT5faaJiJQiUoOxsSXHOhfob/R3XPSzRy5eNGuVWEMNIKhJC78GjtehwfYGPwia0WVKsHEERwqBN9XXgcQaJGr2xbFpCvSqNzXkNuy/9Lz5VAMIatLC34UW1xzer7L0ifgwYk78+3Wv1AR8BQoORrFJkVrSlE797vlLL1wyWRDUCdNcN5j/B1mbDe9RGVwUDyAmQvi6qPw4JCBIkGTQrJa0uuf5FYvPmQwI6rirbvFaZpMNvqMbsCQeToTHG5TEJUattZpUSwPpnx5495LZWLSWj5cd1HFTnUT7e8LuoIU+VtE83uAkIAxZY3Jan5Ni3O6LJCmfJ7ofExU5y2FGN+gOnUWX6YfBjAtPZQ8uXzPsDodjE89KBSteXL6kW1xBusvx7x1DvuvqBOfvQluQVreQBfvcj+mSCKrhaxpSAEvlZwATA8Yk72mdXDMACAFhf2RsQ6i+9NK7L1yxvLfXjBcP1DFPdkuahUulgn8L6tEaR0mBMy1WfCHngFgag1HAlIAgB4SzQQ2zQI2N4GIBPDgIHhxIQPFATC/JSEHqywbGjdJSjxcP6OgXXtMEF90TLtZ1+A0bBM557U9NJaJxFwHGAaksaPZfgGa9C1R/Fig7HwgawJECRw72uX2wLx5AvGsnStsegP3jflAmA8rUAXbqTZ9jti1hoAdic23rph03ju0baDwA4vvCLUEO7eXydmoVnmhdtJ2aBXXaF0CtV4Hqz5wc0/19iLb2otBzC+LH90I1t3jm/FUjyVMpIrGGgVLsFszt3dnn2SvPE9SrAp8XXi/TdWg3I1MVvhzcolHQnPdCL/0d1LwvJcKzK/u+9X9LcKlccC7RtLVQLbORufyDaPnuLai/+hPgkZHELVTtLiHWG7GzzUHQorX+nBe8vb0qlzr2Ef0pUZ7wNTXhGbAR1II10BesT0xdhIYDk4LjAJYT/5ZgU7mkprakwUonmrYWVJ9D7gv/hKavfAOUzYGLxSmBIHIWrGMF/qgfvfX22kosUJWKT9rb/Ga0QfHlruCF11PSvGjw7O97rVc0Le4gXy93CP9aJQofHmUMFxklUa70zipJAE7u1GUgjEF62Qo0f+N7UI1NQBzXnCUI5AFoDPW8TM69y1tBuTYI/B1bvLAmY8KVugG5eHgK5i8BLxqFOvPLUHM/mQQ/JXMwwLpEOGOB3z1lsfUJgz/80aF/JDGyuhQwv03hHfMDvHO+Rks9ld1dJgGBByFY8DY0XX8D+j//yeS9GomInSIi51wngLuPgINq8OPovvCuMIf3xeL/tViACB8XQXNWQl+wITF5eU9mW2JrBGzfZ/HteyM8/qIUFkAqIA+KkGMgMuz/39qk8PFLQ3xwSVJ3VZ73tUIQoPDjmzD87RugWmbVlB18MFRExrmXhogXnn7/zkG/tDd/Ag9swKz6MHwqUGiJje/vJ2lnYlDSGzYguHg7UDevbPbi7wnzP/51jJs2RZ6NbDpZVj7zjlb+Fl8QQoAARkqMy84L8ffvS6Ehk9zg560+Ezj0X/sJxHt2gbLZxJcmCwLD5QKlhiO3om3L9o2SEpUMNeXDeq0vCFJolgFmTRMd0bSJod5yXVn4pKoTsxe//snWGF9fX/JmXpci/75cXpayhqtJwAGBBmblCOt2xrj+zpIHJvGGMks6QO4z15XRq5GIXUopCS+Xysud+/Yphf5yIIS+EGkveA0TVuEuBlL1UG1XlyediebFvB961uK7GyO0NSbzcq/1E5CPexZoayJs/oPBLVtjD6R/ViIoO4RnnYtg4dng0UJtWYFB1iNOF8nLffPmOYUXylAy3uZFr0n7EtkMaHZHWfueS79AyTC+uSEqT7hrr2GkeGyqI9zcG+H5Q+4ICB5djbqV7weXSrVlBCKKHMuo+a2SDjt7epzCWRVb4lOnOl33ACQ6rvr9rmcdHnvReZ+fjObHkg8rCsgXGet/L3VEGcSywOH5i6FyuZpigDxtJBAwz826QyERscKjYN6MDBS3+im/TIEmz2ZSatUvqtYBFU3/6jGpAaa3eyXAZULyqdPHFHUEAN32JlBDU7mTnDzLlsFppUKua5orr/28DwHqADrVb1dNuvER/zdA2AzKnl59T5iUSL7ngPWpbirar5A8mgqA5/scDhz25RFkl8RXbnV10KecCo6jSQMgunLMXKdVxgZ0iryXRBDjHTWuueeTdCfFTtBUZjgJIKWYMTDC1Tw/ZZK9LwJGY6Avz2P8I/Clco0u4EmUoihRt5qBTbIEiKPIK2QGhzwTLjcF4ceS8v8GPljXXl9WAUiCVIVE8xnZI5yBDWxZQ2qDbGrsB+XucQrToyTX+ykNlB99Gz/wTCqC8hb3JFgDVAhEfeDCk+WFkywgBc/Ck7V3hekYgsgWW+DkJsJb5iS6kvGOBBrpDM3+Z0FhqiakpciL2RkNMyivfSVIyyEe9nR57FmD3qStY2B0X/kx6e2TTy5ZoJOyYhoIiP8XY8b5p2mkw6SKrCzn+g6BhwZ9fzBZAMRWAyIqWDeqobzWjsQARn/t6krqVHd4U9VThWlh5+IztG9sJCNMBwRShPecm3inX6fs92bvHjiZH0rbPHliv1dPGGyJR/1MoFoKE7Db93+1DEKk3w8U+NB6cNwnRwG8iYpCmrKEa5aFyJdYbqmZQg2fSS47N8B5p+lK5PYoCIuj960H6clrP+GXOa0kU9GT1Ls3v7azU1VLYcf0KCSW1bS1LVylYQsvgQ79wreVAoowKuZ6xeIQl58f4qVB9gJNdmG5V2YF81o1rntvKmmJPZNJh0XPPYfiQw8C9fW1ZQLyLiB/PSr/9PtmqDs55WFK0QO2iIK06ZMdh/kjIOyQDoGDT/87CmbUW4E87l2BgX94Xworzg58HvdjpvLU5xjeyhMhKaQO5xlvPUnhyx9K+3a4UgHLChJWn1h3MxoG8giZYGvZsWDyzZBjiM9iQS7nXcJvfGTfjxfZYg9lyuH8OCQ1mVxpisBw+EU0Hx94rgX/sfs2kG+FbVXIXIZww+oMPteRaFI0KyMwIeHdz9wl2htgsMDIF4HLzg9x0zV1WNCWdJbeotiClMbGA7/Fh5q24at/dTr6MkBLIRmKyATnhAFQkR4xdqhUNA/Ke8t6e5PHKvuA0X2pfwwb+WvxEAzRsXWBaMJCIUMiAeO3URtuHDkL26I5yCmHKB7Gt5Z9CctPWQrjDAIVVF1UhHz2FYe7dxlse9r60nZUjjnJnpuWSRDh/Ldoby1L5iWB7WjhNWm8MHIQV/3v32HYjqKUCXHSUIwP7R7Chx8eQjZyyKeTYCNnZY7hndk2hYEcqljfumnH+yvb/uQ/LL8o3ocFQRhKLJCDBzTW3AM4aGXwrGnCd/KLcFfpVGgw6ikZgpSsQX1Yh/981/VYNOv0KghHC1P5W1pcMXX5lmwqyfNSPCXMHgHNsEVAGsPxCD69qQu/P/QYcmHWF0FRoFAICQsPRvjMA4dxyTOjXqJCijwIUjJUrZbZzk6F+nBkPt66afsPZaeIentNVUhxg+5u4F/+PLw/rMeyuODX0mLqclOoIgzZDH4yegZuHT0Dr9gMmpWMucpTXG/SCkVTQlO6AV+75Iu4uO28BDx20OVBSaXNHY98ni+7hfMoSCxR2J9/Cf/8mxuw8+CjaE43eovwAAmonAgsY6xLning0w8c9oCMhoRIAppMnwAOZfQO7ouK8aK5W3e9Uu7a+QgAZTco3ReuTjXgp3Lai4l02pu7wrriafivkTOx17SgUUUI4crn4F5NwnBkY8/k596+GtectcoLnwAhTyT/+RqxoiE/DywPTpJkmmQUAPc8txVf2fFd9BUH0BDWV4V/1XeW1xEXyMQOVzwyjI9tH8RJeePfM8RmThAGfXH8g7aNO645enuMqgAA1N0F6l6GVGzD3WHGzUfJugejNvX9wkL8qnQyMmSQJePjwPHSRBJZgYHSEJa2nYvPvn01Lmp9exWII2Z55OxkReAKPTnwLG7eewfW7duIOp1BSsuGyvFTngAhZptPKZw0YjwIV+wZ4qxhjjLKxZE75896dz5e9i6/GI13+JE3pjpfTqV7bjy00K4rvlXL4YBGisszn8mnHa008lHBP7Fo9hm47LR2XNh6Nt6Ua0VTquFV9+bjERwcPYzdhx73Wt/28m4UTBGNqVyS/mooeMTsxfzFNc7dP2q/+FBen7x/5MY337/92uNujgp19nTqtavW2o7bL99yINPcXl/IWzmyOp65T4bEJcS+CqaEko18ABOhTms4GdkgOSAumn1maD+GojwGSnkESvnPxGJOpPWJyMcHxzxSrzmwGDycLpz+3GV3D/jPjmr4aOyDXQy1BuDTb119wZy6+EEj00mx+WkefkzOy4pA1l8SJ5JAl9hjSqWglZy5C7zGK+4xHWJmk25IB9FQ8dodq++8saLcV/GFMbSG4DrXdqqnr751Z1Q0XwzqU/qYhn8KJMJWApgIWR9m0ZCq91curEeoZChB/p4ZEd6xCRtSQWk4umMi4YUm1Gr75vagd3mvWXzblT9PNaWvjAaKhlQyRHijEzt2QTZQNuZnSlFh8Z7Vdw1UU80YUhMt0rus14K7VOSKfx0X4h1BNgzYjZOD3mDEzE6FCs5yv43dqj1X393fhe4k845DasKVSApEQBaICsVVzrp+ndb6jQyCCE9KOZUJlCuYTz28+o4dYslraM2EPqWOt6A8KL6z+6O/fCYumJXSywTZUECYdkyYaRLFKK2UrguCeDj+1M6P3Pnzihsf7zl1ooUlcAgIuz5y53bOu3ez44fDxrR0OeWe7vUnUYjOhvJriv44H1/10Oo7bhKeTyS80KRTWyWKnvOdy1rqWrO3qUyw0gxHss/gj6/j9aBk+GTDXCqwsX0yHomvFkVNRvMVolq+7+hUsvhnV3brUHf5UzGjxnoQXpsfSoxH8kMaCXZaZ0OYUduTfzH67GOfX9dXi/BCtTPsu5guAq1xF9z+wZUq0F/XKX2WK1k444zfb5zuCccTaFxmFSK4M/YgDP/r9lU//5Z8PFGuPx6pmpnwjdwaJ0g/9OH/vqewBxe42PwtNA5K4aHCQEk0lm3+2s4aTEC+DWArQY4CoiAn36EjG9lvldic44Xv6pLujGoVXmhaJns04ktvvbzVpTOfAXCVCtRCaeq9VcS+y5eu3J+IO+rwzXi/JPO/SkpmklLNMymttEoHkJ9O2WL8MoF+6Qx9c8eHex4Zy8NUiKYDQGWNzp5OVWHijPXvSTePNqwkxgeYuUOF+hQlo3PZl7YObMoHJB0n46jKUSH/k6hkaC+FDMnuj5TPRTNEijYz0S90oNY/eMXtL1cF71wrzem0NuBoBgCoSEHSQxytjXeu+8sGY9NLrHGXEuOdAN5MitrYukZdn1LeURLh4SI5PeYG2WKYND1JRLsRopes2b7tyjsPVNb0gj+6iLFm4uKmFqKZWGQ8i5A/xpqmMH9wTrYh/8JwW9AYtpl8EqyDTAA3avLZk3NP5Z/oi3b+zV2FV63IXaq9e4vq7e6VrpxnlFm8llS2ioNzDtJJr5zEk/XVBKiDhC1AL5a5mdL2ePR/k/9SQP9i7CEAAAAASUVORK5CYII=", "claude.exe": "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"};
const SHOTS = process.env.APP_ICON_SHOTS;

type Hooks = {
  __vokko: {
    appStore: { getState(): { me: { id: string } | null; users: Record<string, unknown>; presences: Record<string, { activities?: { name: string; assets?: { large_image?: string } }[] }> }; setState(s: unknown): void };
  };
};

/** The shell: Chrome and Claude are running, and `desktop_app_info` answers with their real names and icons. */
async function fakeDesktop(page: Page) {
  await page.addInitScript(icons => {
    const w = window as unknown as Record<string, unknown>;
    w.isTauri = true;
    const names: Record<string, string> = { 'chrome.exe': 'Google Chrome', 'claude.exe': 'Claude' };
    const processes = [
      { name: 'chrome.exe', startedAt: Date.now() - 12 * 60_000, system: false, pathKnown: true },
      { name: 'claude.exe', startedAt: Date.now() - 5 * 60_000, system: false, pathKnown: true },
    ];
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
      transformCallback: () => 1,
      invoke: async (command: string, args?: { exe?: string }) => {
        if (command === 'desktop_list_processes') return processes;
        if (command === 'desktop_take_pending_links') return [];
        if (command === 'desktop_update_status') return { state: 'disabled' };
        if (command === 'desktop_app_info') {
          const key = (args?.exe ?? '').toLowerCase();
          return names[key] ? { name: names[key], icon: icons[key] } : null;
        }
        return null;
      },
    };
  }, ICONS);
}

test('added apps show their real name and icon, and the icon follows the activity everywhere', async ({ page }) => {
  await fakeDesktop(page);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();

  await page.getByRole('button', { name: 'User Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'User Settings' });
  await dialog.getByRole('button', { name: 'Registered Games' }).click();
  await expect(dialog.getByRole('heading', { name: 'App Detection' })).toBeVisible();
  await expect(dialog.getByText('Game Detection')).toHaveCount(0);
  await expect(dialog.getByTestId('detected-game')).toContainText('No app detected');

  await dialog.getByRole('button', { name: 'Add chrome.exe' }).click();
  await dialog.getByRole('button', { name: 'Add claude.exe' }).click();
  const added = dialog.getByRole('list', { name: 'Added apps' });
  await expect(added).toContainText('Google Chrome');
  await expect(added).toContainText('Claude');
  await expect(added.getByTestId('activity-app-icon')).toHaveCount(2);
  // Chrome started first, so it is the detected app, with its own icon
  await expect(dialog.getByTestId('detected-game')).toContainText('Google Chrome');
  await expect(dialog.getByTestId('detected-game').getByTestId('activity-app-icon')).toBeVisible();
  if (SHOTS) await dialog.screenshot({ path: `${SHOTS}/settings-app-detection.png` });

  // the icon went up while sharing, and the own presence carries the asset the mock backend now holds
  const asset = () =>
    page.evaluate(() => {
      const { me, presences } = (window as unknown as Hooks).__vokko.appStore.getState();
      return presences[me?.id ?? '']?.activities?.[0]?.assets?.large_image ?? null;
    });
  await expect.poll(asset, { timeout: 25_000 }).toMatch(/^app:[0-9a-f]{64}$/);
  const image = (await asset())!;

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 900 });
  // every other user plays Chrome with that icon
  await page.evaluate(large_image => {
    const store = (window as unknown as Hooks).__vokko.appStore;
    const { me, users, presences } = store.getState();
    const next = { ...presences };
    for (const id of Object.keys(users)) {
      if (id === me?.id) continue;
      next[id] = { user_id: id, status: 'online', custom_status: null, activities: [{ name: 'Google Chrome', type: 0, timestamps: { start: Date.now() - 12 * 60_000 }, assets: { large_image } }] } as never;
    }
    store.setState({ presences: next });
  }, image);

  const column = page.getByRole('complementary', { name: 'Active Now' });
  await expect(column.getByTestId('activity-app-icon').first()).toBeVisible();
  await expect(column.getByTestId('activity-line').first()).toContainText('Google Chrome');
  if (SHOTS) {
    await column.screenshot({ path: `${SHOTS}/active-now.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/active-now-mobile.png` });
    await page.setViewportSize({ width: 1440, height: 900 });
  }

  // an icon the server does not have falls back to the pad
  await page.evaluate(() => {
    const store = (window as unknown as Hooks).__vokko.appStore;
    const { me, users, presences } = store.getState();
    const next = { ...presences };
    for (const id of Object.keys(users)) if (id !== me?.id) next[id] = { ...(next[id] as object), activities: [{ name: 'Factorio', type: 0, assets: { large_image: `app:${'f'.repeat(64)}` } }] } as never;
    store.setState({ presences: next });
  });
  await expect(column.getByTestId('activity-line').first()).toContainText('Factorio');
  await expect(column.getByTestId('activity-app-icon')).toHaveCount(0);
});

test('the profile popout shows the app icon', async ({ page }) => {
  await openStockTalk(page);
  const image = await page.evaluate(async png => {
    const { request } = (window as unknown as { __vokko: { request(m: string, p: string, b?: unknown): Promise<{ asset: string }> } }).__vokko;
    return (await request('POST', '/app-icons', { png })).asset;
  }, ICONS['chrome.exe']!);
  expect(image).toMatch(/^app:[0-9a-f]{64}$/);
  await page.evaluate(large_image => {
    const store = (window as unknown as Hooks).__vokko.appStore;
    const { me, users, presences } = store.getState();
    const next = { ...presences };
    for (const id of Object.keys(users)) {
      if (id === me?.id) continue;
      next[id] = { user_id: id, status: 'online', custom_status: null, activities: [{ name: 'Google Chrome', type: 0, timestamps: { start: Date.now() - 12 * 60_000 }, assets: { large_image } }] } as never;
    }
    store.setState({ presences: next });
  }, image);
  await page.locator('.member-row', { has: page.getByTestId('activity-line') }).first().click();
  const card = page.getByTestId('activity-card').first();
  await expect(card).toBeVisible();
  await expect(card.getByTestId('activity-app-icon')).toBeVisible();
  if (SHOTS) {
    await card.screenshot({ path: `${SHOTS}/profile-activity-card.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/profile-popout-mobile.png` });
  }
});
