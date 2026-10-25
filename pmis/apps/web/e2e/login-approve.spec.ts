import { expect, test } from '@playwright/test';

for (const locale of ['en', 'ar'] as const) {
  test(`login -> My Work -> approve with step-up (${locale})`, async ({ page }) => {
    await page.addInitScript((l) => localStorage.setItem('pmis.locale', l), locale);
    await page.goto('/login');
    await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');

    // One box: an employee ID, no email hint is shown on the Microsoft page.
    await page.getByTestId('login-identifier').fill('1001');
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('mock-m365')).toBeVisible();
    await expect(page.getByTestId('mock-hint')).toHaveCount(0);
    await page.getByTestId('mock-account-pm').click();

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

    // Final approval needs a step-up in a popup; the click resumes afterwards.
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.getByTestId('approval-approve').click({ trial: false }).then(() => page.getByTestId('stepup-continue').click())]);
    await popup.getByTestId('mock-stepup-verify').click();
    await expect(row).toHaveCount(0);
    await expect(page.getByTestId('toast').first()).toBeVisible();
  });
}

test('pending user sees the pending screen only', async ({ page }) => {
  await page.goto('/login');
  await page.getByTestId('login-submit').click();
  await page.getByTestId('mock-account-pending').click();
  await expect(page.getByTestId('pending-screen')).toBeVisible();
  await expect(page.getByTestId('sidebar')).toHaveCount(0);
});

test('first sign-in asks for the employee ID', async ({ page }) => {
  await page.goto('/login');
  await page.getByTestId('login-submit').click();
  await page.getByTestId('mock-account-newbie').click();
  await page.getByTestId('employee-id-input').fill('1305');
  await page.getByTestId('employee-id-submit').click();
  await expect(page.getByTestId('pending-screen')).toBeVisible();
});
