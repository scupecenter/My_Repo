import { expect, test } from '@playwright/test';
import { DEMO, login, stepUp } from './helpers';

for (const locale of ['en', 'ar'] as const) {
  test.describe(locale, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((l) => { if (!localStorage.getItem('pmis.locale')) localStorage.setItem('pmis.locale', l); }, locale);
    });

    test('login errors are generic, then login -> My Work -> approve with step-up by password', async ({ page }) => {
      await page.goto('/login');
      await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
      await expect(page.getByTestId('login-m365')).toHaveCount(0); // Microsoft 365 is hidden by default

      // An unknown ID and a wrong password give the very same message.
      await page.getByTestId('login-identifier').fill('9999');
      await page.getByTestId('login-password').fill('not-a-real-password');
      await page.getByTestId('login-submit').click();
      const unknown = await page.getByTestId('login-error').textContent();
      await page.getByTestId('login-identifier').fill(DEMO.pm.id);
      await page.getByTestId('login-password').fill('not-a-real-password');
      await page.getByTestId('login-submit').click();
      await expect(page.getByTestId('login-password')).toHaveValue('');
      await expect(page.getByTestId('login-error')).toHaveText(unknown ?? '');

      await login(page, 'pm');
      await expect(page.getByTestId('page-my-work')).toBeVisible();
      await expect(page.getByTestId('my-work-count-do_now')).toHaveText('7');
      await expect(page.getByTestId('bell-count')).toHaveText('2');

      await page.getByTestId('my-work-go-approvals').click();
      const row = page.locator('[data-site="WM105"]');
      await expect(row).toBeVisible();
      await row.locator('[data-testid^="approval-open-"]').click();
      await expect(page.getByTestId('approval-detail')).toContainText('WM105');
      await page.getByTestId('person-id-1204').first().focus();
      await expect(page.getByTestId('staff-card')).toContainText('1204');

      // Final approval needs the password again; a wrong one keeps the dialog open.
      await page.getByTestId('approval-approve').click();
      await page.getByTestId('stepup-password').fill('wrong-password-here');
      await page.getByTestId('stepup-continue').click();
      await expect(page.getByTestId('stepup-error')).toBeVisible();
      await expect(page.getByTestId('stepup-dialog')).toBeVisible();
      await stepUp(page, 'pm');
      await expect(row).toHaveCount(0);
      await expect(page.getByTestId('toast').first()).toBeVisible();
    });

    test('admin creates a user, shows the temporary password once, the user changes it at first sign-in', async ({ page }) => {
      await login(page, 'pm');
      await page.getByTestId('nav-admin.users').click();
      await page.getByTestId('users-new').click();
      await page.getByTestId('new-user-name').fill('Sara Test');
      await page.getByTestId('new-user-email').fill('sara.test@example.com');
      await page.getByTestId('new-user-employee-id').fill('4821');
      await page.getByTestId('new-user-dialog-reason').fill('New site engineer');
      await page.getByTestId('new-user-dialog-submit').click();
      const temp = (await page.getByTestId('temp-password').textContent()) ?? '';
      expect(temp).toHaveLength(16);
      await expect(page.getByTestId('temp-password-warning')).toBeVisible();
      await page.getByTestId('temp-password-done').click();
      await expect(page.getByTestId('temp-password-dialog')).toHaveCount(0);
      await expect(page.getByTestId('must-change-badge-4821')).toBeVisible();
      await expect(page.getByTestId('local-badge-4821')).toBeVisible();
      await page.getByTestId('topbar-signout').click();

      await page.getByTestId('login-identifier').fill('4821');
      await page.getByTestId('login-password').fill(temp);
      await page.getByTestId('login-submit').click();
      await expect(page.getByTestId('change-password-forced')).toBeVisible();
      await page.goto('/approvals'); // nothing else is reachable
      await expect(page.getByTestId('change-password-forced')).toBeVisible();
    });

    test('first sign-in account: change the temporary password, enter the employee ID, wait for assignment', async ({ page }) => {
      await login(page, 'newbie');
      await expect(page.getByTestId('change-password-forced')).toBeVisible();
      await page.getByTestId('cp-current').fill(DEMO.newbie.password);
      await page.getByTestId('cp-new').fill('password12345');
      await page.getByTestId('cp-confirm').fill('password12345');
      await page.getByTestId('cp-submit').click();
      await expect(page.getByTestId('cp-new-error')).toBeVisible();
      await page.getByTestId('cp-new').fill('A-fresh-long-passphrase-7');
      await page.getByTestId('cp-confirm').fill('A-fresh-long-passphrase-7');
      await page.getByTestId('cp-submit').click();
      await page.getByTestId('employee-id-input').fill('1305');
      await page.getByTestId('employee-id-submit').click();
      await expect(page.getByTestId('pending-screen')).toBeVisible();
      await expect(page.getByTestId('sidebar')).toHaveCount(0);
    });

    test('pending user sees the pending screen only', async ({ page }) => {
      await login(page, 'pending');
      await expect(page.getByTestId('pending-screen')).toBeVisible();
      await expect(page.getByTestId('sidebar')).toHaveCount(0);
    });
  });
}
