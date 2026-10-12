import { expect, test } from '@playwright/test';
import { pickOption } from './helpers';
import { openChannel, openThreadFromPopout, panel } from './threadHelpers';

// Threads popout (GLD-013): joined / other active / archived sections, search and sort.

test('joined and other active threads are listed apart; archived ones on their own tab', async ({ page }) => {
  await openChannel(page, 'general');
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  const popout = page.getByRole('dialog', { name: 'Threads' });
  const joined = popout.getByRole('region', { name: 'Joined Threads' });
  const other = popout.getByRole('region', { name: 'Other Active Threads' });
  await expect(joined.getByRole('heading')).toHaveText('1 Joined Threads');
  await expect(joined.getByRole('button', { name: /gateway docs/ })).toBeVisible();
  await expect(other.getByRole('heading')).toHaveText('1 Other Active Threads');
  await expect(other.getByRole('button', { name: /coffee setups/ })).toBeVisible();
  await expect(other.getByLabel('Locked')).toBeVisible();

  await popout.getByRole('tab', { name: 'Archived Threads' }).click();
  const archived = popout.getByRole('region', { name: 'Archived Threads' });
  await expect(archived.getByRole('button', { name: /replay buffer sizing/ })).toBeVisible();
  await expect(popout.getByRole('button', { name: /gateway docs/ })).toHaveCount(0);

  // opening a row shows it in the panel and closes the popout
  await archived.getByRole('button', { name: /replay buffer sizing/ }).click();
  await expect(popout).toHaveCount(0);
  await expect(panel(page).getByRole('heading', { name: 'replay buffer sizing', level: 2 })).toBeVisible();
});

test('search filters by name and sort switches between activity and creation time', async ({ page }) => {
  await openChannel(page, 'general');
  // a new thread (created now) and then a reply in the older "gateway docs": activity and creation order now disagree
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await page.getByRole('dialog', { name: 'Threads' }).getByRole('button', { name: /Create/ }).click();
  const create = page.getByRole('dialog', { name: 'Create Thread' });
  await create.getByLabel('Thread name').fill('fresh talk');
  await create.getByRole('button', { name: 'Create Thread' }).click();
  await expect(panel(page).getByRole('heading', { name: 'fresh talk', level: 2 })).toBeVisible();
  await openThreadFromPopout(page, 'gateway docs');
  await panel(page).locator('.chat-textarea').fill('bumping this thread');
  await panel(page).locator('.chat-textarea').press('Enter');
  await expect(panel(page).locator('.chat-msg', { hasText: 'bumping this thread' })).not.toHaveClass(/pending/);

  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  const popout = page.getByRole('dialog', { name: 'Threads' });
  const joined = popout.getByRole('region', { name: 'Joined Threads' }).locator('.thread-row-name');
  await expect(joined).toHaveText(['gateway docs', 'fresh talk']);
  await pickOption(page, popout.getByRole('combobox', { name: 'Sort threads' }), 'Date Created');
  await expect(joined).toHaveText(['fresh talk', 'gateway docs']);

  await popout.getByLabel('Search for thread name').fill('COFFEE');
  await expect(popout.locator('.thread-row-name')).toHaveText(['coffee setups']);
  await expect(popout.getByRole('region', { name: 'Joined Threads' })).toHaveCount(0);
  await popout.getByLabel('Search for thread name').fill('nothing like this');
  await expect(popout.getByText('No threads match your search.')).toBeVisible();
});

test('a thread is muted from its row menu in the popout and the sidebar; both rows dim and unmuting restores them', async ({ page }) => {
  await openChannel(page, 'general');
  const link = page.locator('.thread-row-link', { hasText: 'gateway docs' });
  await expect(link).not.toHaveClass(/muted/);
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  const row = page.getByRole('dialog', { name: 'Threads' }).getByRole('button', { name: /gateway docs/ });
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Mute Thread' }).hover();
  await page.getByRole('menuitem', { name: 'Until I turn it back on' }).click();
  await expect(row).toHaveClass(/muted/);
  await expect(link).toHaveClass(/muted/);
  await expect(link.getByLabel('Muted')).toBeVisible();

  await link.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Unmute Thread' }).click();
  await expect(link).not.toHaveClass(/muted/);
});
