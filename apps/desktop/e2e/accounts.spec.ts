import { expect, test } from '@playwright/test';
import { goInApp, lastMail, mockReady, totpCode, type AccountHooks as Hooks } from './accountHelpers';

// Account flows against the in-memory mock (src/api/mock/accounts.ts). A reload re-seeds the mock, so every test
// stays inside one page load and moves between routes with history.pushState.

test('register: Discord fields, live username check, strength meter, date of birth and email verification', async ({ page }) => {
  await page.goto('/login?mockLatency=0');
  await mockReady(page);
  await page.evaluate(() => (window as unknown as Hooks).__vokkoMockAccounts.instance({ terms: 'I agree to the house rules.', terms_url: 'https://example.test/terms' }));
  await goInApp(page, '/register');

  // an empty form flags every required field at once, before any request; a malformed email is caught the same way
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.locator('.field-label-error')).toHaveText([' - Required.', ' - Required.', ' - Required.', ' - Required.']);
  await expect(page.getByText('You need to agree to the terms.')).toBeVisible();
  await page.getByLabel('Email').fill('not-an-email');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByText('Not a well formed email address.')).toBeVisible();

  await page.getByLabel('Email').fill('newbie@example.test');
  await page.getByLabel('Display name').fill('New Bie');

  const username = page.getByLabel('Username');
  await username.fill('alice');
  await expect(page.getByText('Username is unavailable.', { exact: false })).toBeVisible();
  await username.fill('bad..name');
  await expect(page.getByText("Can't contain two dots in a row.")).toBeVisible();
  await username.fill('newbie');
  await expect(page.getByText('Username is available. Nice!')).toBeVisible();

  const password = page.getByLabel('Password');
  await password.fill('password123');
  await expect(page.getByText('Password strength: Too weak', { exact: false })).toBeVisible();
  await password.fill('Plain-word-longer-9');
  await expect(page.getByText('Password strength: Strong')).toBeVisible();

  // too young
  await page.getByLabel('Month').selectOption('5');
  await page.getByLabel('Day').selectOption('10');
  await page.getByLabel('Year').selectOption(String(new Date().getFullYear() - 10));
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByText('You need to be 13 or older to use Vokko.')).toBeVisible();

  await page.getByLabel('Year').selectOption('1995');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page).toHaveURL(/\/channels\/@me/);

  const mail = await lastMail(page, 'newbie@example.test');
  expect(mail.subject).toBe('Verify your email address');
  const link = new URL(mail.body);
  await goInApp(page, `${link.pathname}${link.hash}`);
  await expect(page.getByRole('heading', { name: 'Email verified!' })).toBeVisible();
  // the token is dropped from the address bar once read
  expect(new URL(page.url()).hash).toBe('');
  // links are single use
  await page.getByRole('link', { name: 'Continue to Vokko' }).click();
  await expect(page.getByRole('heading', { name: 'Friends' })).toBeVisible();
  await goInApp(page, `${link.pathname}${link.hash}`);
  await expect(page.getByRole('heading', { name: 'Verification failed' })).toBeVisible();
});

test('register: closed instances say so instead of showing the form', async ({ page }) => {
  await page.goto('/login?mockLatency=0');
  await mockReady(page);
  await page.evaluate(() => (window as unknown as Hooks).__vokkoMockAccounts.instance({ registration: 'closed' }));
  await goInApp(page, '/register');
  await expect(page.getByRole('heading', { name: 'Registration is closed' })).toBeVisible();
  await expect(page.getByLabel('Email')).toHaveCount(0);
});

test('register: a card taller than the window scrolls from its top on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await page.goto('/login?mockLatency=0');
  await mockReady(page);
  await page.evaluate(() => (window as unknown as Hooks).__vokkoMockAccounts.instance({ terms: 'I agree to the house rules.', terms_url: 'https://example.test/terms' }));
  await goInApp(page, '/register');
  const card = page.locator('.auth-card');
  await expect(card).toBeVisible();
  const box = (await card.boundingBox())!;
  expect(box.height).toBeGreaterThan(640);
  // The top (logo and heading) is on screen, not cut off above the page, and the rest scrolls into view.
  expect(box.y).toBeGreaterThanOrEqual(0);
  await page.getByRole('button', { name: 'Continue', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeInViewport();
  await page.locator('.auth-page').evaluate(el => el.scrollTo(0, 0));
  await expect(page.getByRole('heading', { level: 1 })).toBeInViewport();
});

async function openMyAccount(page: import('@playwright/test').Page) {
  await page.goto('/channels/@me?as=sam&mockLatency=0');
  await page.locator('.dm-row').first().waitFor();
  await page.getByRole('button', { name: 'User Settings' }).click();
  return page.getByRole('dialog', { name: 'User Settings' });
}

test('My Account: username change checks availability and asks for the password', async ({ page }) => {
  const settings = await openMyAccount(page);
  await expect(settings.locator('.sm-row', { hasText: 'Email' })).toContainText('@vokko.local');
  await settings.locator('.sm-row', { hasText: 'Username' }).getByRole('button', { name: 'Edit' }).click();
  const dialog = page.getByRole('dialog', { name: 'Change your username' });
  const name = dialog.getByLabel('Username');
  await name.fill('alice');
  await expect(dialog.getByText('Username is unavailable.', { exact: false })).toBeVisible();
  await name.fill('sam.renamed');
  await expect(dialog.getByText('Username is available. Nice!')).toBeVisible();
  await dialog.getByLabel('Current Password').fill('wrong password');
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog.getByText('Password does not match.')).toBeVisible();
  await dialog.getByLabel('Current Password').fill('vokko-dev');
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(settings.locator('.sm-row', { hasText: 'Username' })).toContainText('sam.renamed');
});

test('My Account: email change waits for the link sent to the new address', async ({ page }) => {
  const settings = await openMyAccount(page);
  const row = settings.locator('.sm-row', { hasText: 'Email' });
  await row.getByRole('button', { name: 'Edit' }).click();
  const dialog = page.getByRole('dialog', { name: 'Enter an email address' });
  await dialog.getByLabel('Email').fill('sam.new@example.test');
  await dialog.getByLabel('Current Password').fill('vokko-dev');
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toHaveCount(0);
  // the old address stays until the link is opened, and is told about the change
  await expect(settings.getByText('We sent a verification link to sam.new@example.test.', { exact: false })).toBeVisible();
  await row.getByRole('button', { name: 'Reveal' }).click();
  await expect(row).not.toContainText('sam.new@example.test');
  expect((await lastMail(page, 'sam@vokko.local')).subject).toBe('Your Vokko email is changing');

  const link = new URL((await lastMail(page, 'sam.new@example.test')).body);
  await settings.getByRole('button', { name: 'Close' }).click();
  await expect(settings).toHaveCount(0);
  await goInApp(page, `${link.pathname}${link.hash}`);
  await goInApp(page, '/channels/@me');
  await page.getByRole('button', { name: 'User Settings' }).click();
  const reopened = page.getByRole('dialog', { name: 'User Settings' }).locator('.sm-row', { hasText: 'Email' });
  await reopened.getByRole('button', { name: 'Reveal' }).click();
  await expect(reopened).toContainText('sam.new@example.test');
});

test('My Account: password change, then only the new password logs in', async ({ page }) => {
  const settings = await openMyAccount(page);
  await settings.getByRole('button', { name: 'Change Password' }).click();
  const dialog = page.getByRole('dialog', { name: 'Update your password' });
  await dialog.getByLabel('Current Password').fill('vokko-dev');
  await dialog.getByLabel('New Password', { exact: true }).fill('password123');
  await expect(dialog.getByText('Password strength: Too weak', { exact: false })).toBeVisible();
  await dialog.getByLabel('New Password', { exact: true }).fill('a much better passphrase');
  await dialog.getByLabel('Confirm New Password').fill('a much better passphrase');
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(settings.getByText('Password changed.', { exact: false })).toBeVisible();

  await settings.getByRole('button', { name: 'Log Out' }).click();
  await page.getByRole('dialog', { name: 'Log Out' }).getByRole('button', { name: 'Log Out' }).click();
  await expect(page).toHaveURL(/\/login/);
  const login = async (password: string) => {
    await page.getByLabel('Email or username').fill('sam');
    await page.locator('input[type=password]').fill(password);
    await page.getByRole('button', { name: 'Log In' }).click();
  };
  await login('vokko-dev');
  await expect(page.getByText('Login or password is invalid.').first()).toBeVisible();
  await login('a much better passphrase');
  await expect(page).toHaveURL(/\/channels\/@me/);
});

test('My Account: delete is refused while owning a server, disable signs out', async ({ page }) => {
  const settings = await openMyAccount(page);
  await settings.getByRole('button', { name: 'Delete Account' }).click();
  let dialog = page.getByRole('dialog', { name: 'Delete Account' });
  await dialog.getByLabel('Password').fill('vokko-dev');
  await dialog.getByRole('button', { name: 'Delete Account' }).click();
  await expect(dialog.getByText('transfer ownership', { exact: false })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await settings.getByRole('button', { name: 'Disable Account' }).click();
  dialog = page.getByRole('dialog', { name: 'Disable Account' });
  await dialog.getByLabel('Password').fill('vokko-dev');
  await dialog.getByRole('button', { name: 'Disable Account' }).click();
  await expect(page).toHaveURL(/\/login/);
});

test('two-factor: enable with the QR secret, then login asks for the code', async ({ page }) => {
  const settings = await openMyAccount(page);
  await settings.getByRole('button', { name: 'Enable Authenticator App' }).click();
  const dialog = page.getByRole('dialog', { name: 'Enable Authenticator App' });
  await expect(dialog.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
  const secret = (await dialog.getByTestId('totp-secret').textContent())!.replace(/\s/g, '');
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  await dialog.getByLabel('6-digit code from the app').fill('000000');
  await dialog.getByLabel('Password').fill('vokko-dev');
  await dialog.getByRole('button', { name: 'Activate' }).click();
  await expect(dialog.getByText('Invalid two-factor code')).toBeVisible();
  await dialog.getByLabel('6-digit code from the app').fill(await totpCode(secret));
  await dialog.getByRole('button', { name: 'Activate' }).click();
  const codes = page.getByRole('dialog', { name: 'Backup Codes' });
  await expect(codes.getByRole('listitem')).toHaveCount(10);
  const backup = (await codes.getByRole('listitem').first().textContent())!.replace('-', '');
  await codes.getByRole('button', { name: 'Done' }).click();
  await expect(settings.getByRole('button', { name: 'Remove Authenticator App' })).toBeVisible();

  await settings.getByRole('button', { name: 'Log Out', exact: true }).click();
  await page.getByRole('dialog', { name: 'Log Out' }).getByRole('button', { name: 'Log Out' }).click();
  await page.getByLabel('Email or username').fill('sam');
  await page.locator('input[type=password]').fill('vokko-dev');
  await page.getByRole('button', { name: 'Log In' }).click();
  await expect(page.getByRole('heading', { name: 'Multi-Factor Authentication' })).toBeVisible();
  await page.getByLabel('Authentication code').fill('123456');
  await page.getByRole('button', { name: 'Log In' }).click();
  await expect(page.getByText('Invalid two-factor code')).toBeVisible();
  await page.getByLabel('Authentication code').fill(await totpCode(secret, 1));
  await page.getByRole('button', { name: 'Log In' }).click();
  await expect(page).toHaveURL(/\/channels\/@me/);

  // devices: the new session is "this device"; a backup code works on the next login
  await page.getByRole('button', { name: 'User Settings' }).click();
  await expect(page.getByRole('list', { name: 'Logged-in devices' })).toContainText('This device');
  await page.getByRole('button', { name: 'Log Out', exact: true }).click();
  await page.getByRole('dialog', { name: 'Log Out' }).getByRole('button', { name: 'Log Out' }).click();
  await page.getByLabel('Email or username').fill('sam');
  await page.locator('input[type=password]').fill('vokko-dev');
  await page.getByRole('button', { name: 'Log In' }).click();
  await page.getByRole('button', { name: 'Use a backup code' }).click();
  await page.getByLabel('Backup code').fill(backup);
  await page.getByRole('button', { name: 'Log In' }).click();
  await expect(page).toHaveURL(/\/channels\/@me/);
});

test('password reset: forgot link from the login page, new password from the mailed link', async ({ page }) => {
  await page.goto('/login?mockLatency=0');
  await mockReady(page);
  await page.getByLabel('Email or username').fill('alice');
  await page.getByRole('button', { name: 'Forgot your password?' }).click();
  await expect(page.getByText('password reset instructions', { exact: false })).toBeVisible();
  const mail = await lastMail(page, 'alice@vokko.local');
  expect(mail.subject).toBe('Reset your password');
  const link = new URL(mail.body);
  await goInApp(page, `${link.pathname}${link.hash}`);
  await page.getByLabel('New Password').fill('password');
  await page.getByRole('button', { name: 'Change Password' }).click();
  // the strength meter repeats the sentence: check the server's field error
  await expect(page.locator('.field-label-error', { hasText: 'Password is too weak or common to use.' })).toBeVisible();
  await page.getByLabel('New Password').fill('a fresh new passphrase');
  await page.getByRole('button', { name: 'Change Password' }).click();
  await expect(page).toHaveURL(/\/channels\/@me/);
});

test('OAuth: Continue with GitHub signs up, then Sign-in Methods keeps the last method', async ({ page }) => {
  await page.goto('/login?mockLatency=0');
  await mockReady(page);
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with GitLab' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue with GitHub' }).click();

  // first sign-in: GitHub shared no verified email, so the form asks for one
  await expect(page.getByRole('heading', { name: 'Finish creating your account' })).toBeVisible();
  await expect(page.getByLabel('Username')).toHaveValue('octocat');
  await expect(page.getByText('Username is available. Nice!')).toBeVisible();
  await page.getByLabel('Email').fill('octo@example.test');
  await page.getByLabel('Month').selectOption('7');
  await page.getByLabel('Day').selectOption('4');
  await page.getByLabel('Year').selectOption('1990');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page).toHaveURL(/\/channels\/@me/);
  const verify = await lastMail(page, 'octo@example.test');
  expect(verify.subject).toBe('Verify your email address');
  // linking another provider needs a verified address
  const verifyLink = new URL(verify.body);
  await goInApp(page, `${verifyLink.pathname}${verifyLink.hash}`);
  await expect(page.getByRole('heading', { name: 'Email verified!' })).toBeVisible();
  await page.getByRole('link', { name: 'Continue to Vokko' }).click();

  await page.getByRole('button', { name: 'User Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'User Settings' });
  await expect(settings.getByRole('button', { name: 'Set Password' })).toBeVisible();
  const github = settings.locator('.sm-row', { hasText: 'GitHub' });
  await expect(github).toContainText('Linked');
  await github.getByRole('button', { name: 'Unlink' }).click();
  await expect(settings.getByText('This is your only way to sign in. Set a password first.')).toBeVisible();

  // link Google too, then GitHub can go
  await settings.locator('.sm-row', { hasText: 'Google' }).getByRole('button', { name: 'Link' }).click();
  await expect(page.getByRole('heading', { name: 'Sign-in method linked' })).toBeVisible();
  await page.getByRole('link', { name: 'Continue to Vokko' }).click();
  // the settings modal was open when the flow started and comes back with the app
  await expect(settings).toBeVisible();
  await expect(settings.locator('.sm-row', { hasText: 'Google' })).toContainText('Linked as octo@google.example');
  await settings.locator('.sm-row', { hasText: 'GitHub' }).getByRole('button', { name: 'Unlink' }).click();
  await expect(settings.locator('.sm-row', { hasText: 'GitHub' })).toContainText('Not linked');

  // signing in with Google opens the same account
  await settings.getByRole('button', { name: 'Log Out', exact: true }).click();
  await page.getByRole('dialog', { name: 'Log Out' }).getByRole('button', { name: 'Log Out' }).click();
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page).toHaveURL(/\/channels\/@me/);
  await page.getByRole('button', { name: 'User Settings' }).click();
  await expect(settings.locator('.sm-row', { hasText: 'Username' })).toContainText('octocat');
});
