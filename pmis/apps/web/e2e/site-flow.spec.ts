import { expect, test } from '@playwright/test';

async function signIn(page: import('@playwright/test').Page, id: string, account: 'pm' | 'reviewer') {
  await page.goto('/login');
  await page.getByTestId('login-identifier').fill(id);
  await page.getByTestId('login-submit').click();
  await page.getByTestId(`mock-account-${account}`).click();
}

for (const locale of ['en', 'ar'] as const) {
  test(`site -> edit date -> upload -> submit -> switch account -> approve (${locale})`, async ({ page }) => {
    await page.addInitScript((l) => { if (!localStorage.getItem('pmis.locale')) localStorage.setItem('pmis.locale', l); }, locale);
    await signIn(page, '1102', 'reviewer');
    await page.getByTestId('nav-sites').click();
    await expect(page.getByTestId('page-sites')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
    await page.getByTestId('site-row-TR101').click();
    await expect(page.getByTestId('pipeline')).toBeVisible();

    // inline date edit on A1 (Site search)
    const row = page.locator('[data-task="A1"]');
    await row.locator('[data-testid$="-actual"]').click();
    await row.locator('[data-testid^="grid-input-"]').fill('2026-10-20');
    await row.locator('[data-testid^="grid-input-"]').press('Enter');
    await expect(row.locator('[data-testid$="-actual"]')).toHaveText('2026-10-20');

    // upload the mandatory document in the drawer, then submit
    await row.locator('[data-testid^="grid-open-"]').click();
    await expect(page.getByTestId('task-drawer')).toBeVisible();
    await expect(page.getByTestId('drawer-submit')).toBeDisabled();
    await page.locator('[data-testid^="slot-input-"]').first().setInputFiles({ name: 'sar.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
    await expect(page.getByTestId('drawer-submit')).toBeEnabled();
    await page.getByTestId('drawer-submit').click();
    await expect(page.getByTestId('task-drawer-body')).toHaveAttribute('data-state', 'in_approval');
    await page.keyboard.press('Escape');

    // switch account: the Project Manager approves with step-up
    await page.getByTestId('topbar-signout').click();
    await signIn(page, '1001', 'pm');
    await page.getByTestId('nav-approvals').click();
    const item = page.locator('[data-site="TR101"]');
    await expect(item).toBeVisible();
    await item.locator('[data-testid^="approval-open-"]').click();
    await expect(page.getByTestId('approval-docs')).toContainText('SAR');
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.getByTestId('approval-approve').click().then(() => page.getByTestId('stepup-continue').click())]);
    await popup.getByTestId('mock-stepup-verify').click();
    await expect(item).toHaveCount(0);
  });
}
