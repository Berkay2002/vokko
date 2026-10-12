import { expect, test, type Page } from '@playwright/test';
import { goInApp } from './accountHelpers';

// Apply to Join against the in-memory mock (sam owns "Sam's server"). One page is one mock, so the other user acts through
// `__vokkoMock.requestAs`, and the page itself is either the owner (settings and review UI) or the applicant (invite page).

type Win = {
  __vokko: { appStore: { getState(): { guilds: Record<string, { id: string; name: string }> } } };
  __vokkoMock: { requestAs(user: string, method: string, path: string, body?: unknown): unknown; channelIdByName(name: string): string | null };
};

const ANSWERS = (why: string) => [{ field_type: 'TERMS', response: true }, { field_type: 'TEXT_INPUT', response: why }];

async function start(page: Page, as: string): Promise<void> {
  await page.goto(`/channels/@me?as=${as}&mockLatency=0`);
  await page.locator('.dm-row').first().waitFor();
}

/** Sam sets the join mode and form through the API; `applicant` has left the server and holds an invite code. */
async function prepare(page: Page, applicants: string[], withForm: boolean): Promise<{ guildId: string; code: string }> {
  return page.evaluate(
    async ({ applicants, withForm }) => {
      const w = window as unknown as Win;
      const call = (u: string, m: string, p: string, b?: unknown) => w.__vokkoMock.requestAs(u, m, p, b);
      const guildId = Object.values(w.__vokko.appStore.getState().guilds).find(g => g.name === "Sam's server")!.id;
      const code = (call('sam', 'POST', `/channels/${w.__vokkoMock.channelIdByName('dev-talk')}/invites`, { max_age: 0 }) as { code: string }).code;
      for (const a of applicants) call(a, 'DELETE', `/users/@me/guilds/${guildId}`);
      if (withForm) {
        call('sam', 'PUT', `/guilds/${guildId}/member-verification`, {
          description: null,
          form_fields: [
            { field_type: 'TERMS', label: 'Server Rules', required: true, values: ['Be kind'] },
            { field_type: 'TEXT_INPUT', label: 'Why join?', required: true },
          ],
        });
        call('sam', 'PATCH', `/guilds/${guildId}`, { join_mode: 1 });
      }
      return { guildId, code };
    },
    { applicants, withForm },
  );
}

const asUser = (page: Page, user: string, method: string, path: string, body?: unknown) =>
  page.evaluate(([u, m, p, b]) => {
    try {
      return (window as unknown as Win).__vokkoMock.requestAs(u as string, m as string, p as string, b);
    } catch (e) {
      throw new Error(JSON.stringify((e as { api?: unknown }).api));
    }
  }, [user, method, path, body] as const);

test('the owner sets up Apply to Join, then approves and rejects applications', async ({ page }) => {
  await start(page, 'sam');
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.waitForURL(/\/channels\/\d+\/\d+/);
  await page.locator('.guild-header-name-button').click();
  await page.getByRole('menuitem', { name: 'Server Settings' }).click();
  await page.getByRole('button', { name: 'Access', exact: true }).click();
  await page.getByRole('radio', { name: /Apply to Join/ }).click();
  await page.getByRole('button', { name: 'Add a rule' }).click();
  await page.getByRole('textbox', { name: 'Rule 1' }).fill('Be kind');
  await page.getByRole('button', { name: 'Add a question' }).click();
  await page.getByRole('textbox', { name: 'Question 1 label' }).fill('Why join?');
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await page.waitForFunction(() => Object.values((window as unknown as Win).__vokko.appStore.getState().guilds).some(g => (g as { join_mode?: number }).join_mode === 1));
  await expect(page.getByRole('button', { name: /Save/ })).toHaveCount(0);
  await expect(page.getByRole('radio', { name: /Apply to Join/ })).toBeChecked();

  const { guildId, code } = await prepare(page, ['bob', 'alice'], false);
  await asUser(page, 'bob', 'PUT', `/guilds/${guildId}/requests/@me`, { invite_code: code, form_fields: ANSWERS('I <b>love</b> it') });
  await asUser(page, 'alice', 'PUT', `/guilds/${guildId}/requests/@me`, { invite_code: code, form_fields: ANSWERS('hello') });

  await page.getByRole('button', { name: 'Join Requests', exact: true }).click();
  const rows = page.getByTestId('join-request');
  await expect(rows).toHaveCount(2);
  const bob = rows.filter({ hasText: 'bob' });
  await bob.getByRole('button', { name: 'View answers' }).click();
  await expect(bob.getByText('I <b>love</b> it')).toBeVisible();
  await bob.getByRole('button', { name: 'Approve' }).click();
  await expect(rows).toHaveCount(1);
  await page.getByRole('tab', { name: 'Approved' }).click();
  await expect(rows.filter({ hasText: 'bob' })).toHaveCount(1);

  await page.getByRole('tab', { name: 'Submitted' }).click();
  await rows.getByRole('button', { name: 'Reject' }).click();
  await page.getByRole('textbox', { name: 'Rejection reason (optional)' }).fill('Not a fit');
  await page.getByRole('button', { name: 'Confirm reject' }).click();
  await expect(rows).toHaveCount(0);
  await expect(page.getByText('No pending applications.')).toBeVisible();
  await page.getByRole('tab', { name: 'Rejected' }).click();
  await expect(rows.getByText('Reason: Not a fit')).toBeVisible();
});

test('an applicant applies from the invite page, sees pending, and is let in once approved', async ({ page }) => {
  await start(page, 'bob');
  const { guildId, code } = await prepare(page, ['bob'], true);
  await page.evaluate(id => (window as unknown as { __vokko: { appStore: { getState(): { removeGuild(id: string): void } } } }).__vokko.appStore.getState().removeGuild(id), guildId);
  await goInApp(page, `/invite/${code}`);

  await page.getByRole('button', { name: 'Apply to Join' }).click();
  const dialog = page.getByRole('dialog', { name: /Apply to join/ });
  await expect(dialog.getByText('Be kind')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Submit' })).toBeDisabled();
  await dialog.getByRole('checkbox', { name: /I have read and agree/ }).check();
  await dialog.getByRole('textbox', { name: /Why join/ }).fill('I like it');
  await dialog.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByRole('dialog', { name: 'Application pending' })).toBeVisible();

  // Reject, apply again, then approve.
  const request = (await asUser(page, 'sam', 'GET', `/guilds/${guildId}/requests`)) as { guild_join_requests: { id: string }[] };
  await asUser(page, 'sam', 'PATCH', `/guilds/${guildId}/requests/${request.guild_join_requests[0]!.id}`, { action: 'REJECTED', rejection_reason: 'Try later' });
  await expect(page.getByText('Your application was rejected: Try later')).toBeVisible();
  await page.getByRole('dialog').getByRole('checkbox', { name: /I have read and agree/ }).check();
  await page.getByRole('dialog').getByRole('textbox', { name: /Why join/ }).fill('Please');
  await page.getByRole('button', { name: 'Apply again' }).click();
  await expect(page.getByRole('dialog', { name: 'Application pending' })).toBeVisible();
  const again = (await asUser(page, 'sam', 'GET', `/guilds/${guildId}/requests`)) as { guild_join_requests: { id: string }[] };
  await asUser(page, 'sam', 'PATCH', `/guilds/${guildId}/requests/${again.guild_join_requests[0]!.id}`, { action: 'APPROVED' });
  await expect(page).toHaveURL(new RegExp(`/channels/${guildId}`));
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('Join a Server with an apply-mode invite keeps the apply form open', async ({ page }) => {
  await start(page, 'bob');
  const { code } = await prepare(page, ['bob'], true);
  await page.getByRole('button', { name: 'Add a Server' }).click();
  await page.getByRole('button', { name: 'Join a Server' }).click();
  await page.getByLabel(/Invite link/).fill(code);
  await page.getByRole('button', { name: 'Join Server' }).click();
  const dialog = page.getByRole('dialog', { name: /Apply to join/ });
  await expect(dialog.getByRole('button', { name: 'Submit' })).toBeVisible();
  await page.waitForTimeout(300);
  await expect(dialog).toBeVisible();
});

test('Join Requests pages 50 at a time with Load more', async ({ page }) => {
  await start(page, 'sam');
  const { guildId, code } = await prepare(page, [], false);
  await page.evaluate(
    ({ guildId, code }) => {
      const w = window as unknown as Win & { __vokkoMock: { addUser(name: string): string } };
      w.__vokkoMock.requestAs('sam', 'PATCH', `/guilds/${guildId}`, { join_mode: 1 });
      for (let i = 0; i < 55; i++) {
        const name = `applicant${i}`;
        w.__vokkoMock.addUser(name);
        w.__vokkoMock.requestAs(name, 'PUT', `/guilds/${guildId}/requests/@me`, { invite_code: code, form_fields: [] });
      }
    },
    { guildId, code },
  );
  await page.getByRole('link', { name: /^Sam's server/ }).click();
  await page.waitForURL(/\/channels\/\d+\/\d+/);
  await page.locator('.guild-header-name-button').click();
  await page.getByRole('menuitem', { name: 'Server Settings' }).click();
  await page.getByRole('button', { name: 'Join Requests', exact: true }).click();
  const rows = page.getByTestId('join-request');
  await expect(rows).toHaveCount(50);
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(rows).toHaveCount(55);
  await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);
});
