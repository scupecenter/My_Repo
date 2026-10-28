import { expect, test, type Page } from '@playwright/test';
import { login, withStepUp, type DemoAccount } from './helpers';

async function signIn(page: Page, locale: 'en' | 'ar', account: DemoAccount) {
  await page.addInitScript((l) => { if (!localStorage.getItem('pmis.locale')) localStorage.setItem('pmis.locale', l); }, locale);
  await login(page, account);
}

for (const locale of ['en', 'ar'] as const) {
  test.describe(locale, () => {
    test('settings: calendar, notification policy rules, retention reduction', async ({ page }) => {
      await signIn(page, locale, 'pm');
      await page.getByTestId('nav-admin.settings').click();
      await expect(page.getByTestId('cal-banner-tentative')).toBeVisible();
      await page.getByTestId('cal-add').click();
      await page.getByTestId('holiday-date').fill('2026-12-01');
      await page.getByTestId('holiday-name-en').fill('Test day');
      await page.getByTestId('holiday-dialog-reason').fill('Added from the official list');
      await page.getByTestId('holiday-dialog-submit').click();
      await expect(page.getByTestId('holiday-2026-12-01')).toBeVisible();
      await page.getByTestId('holiday-confirm-2026-11-03').click();
      await page.getByTestId('holiday-confirm-dialog-reason').fill('Official announcement');
      await page.getByTestId('holiday-confirm-dialog-submit').click();
      await expect(page.getByTestId('cal-banner-tentative')).toHaveCount(0);

      await page.getByTestId('settings-tab-notifications').click();
      await page.getByTestId('np-th-approval_remind_hours').fill('168');
      await page.getByTestId('np-th-approval_escalate_days').fill('3');
      await expect(page.getByTestId('np-save')).toBeDisabled();
      await page.getByTestId('np-th-approval_escalate_days').fill('8');
      await expect(page.getByTestId('np-save')).toBeEnabled();
      await expect(page.getByTestId('np-lock-audit_integrity_failure')).toBeVisible();

      await page.getByTestId('settings-tab-retention').click();
      await page.getByTestId('ret-security').fill('400');
      await expect(page.getByTestId('ret-warning')).toBeVisible();
      await page.getByTestId('ret-save').click();
      await page.getByTestId('ret-dialog-reason').fill('Storage pressure');
      await withStepUp(page, () => page.getByTestId('ret-dialog-submit').click());
      await expect(page.getByTestId('toast').first()).toBeVisible();

      await page.getByTestId('settings-tab-freeze').click();
      await page.getByTestId('freeze-lift').click();
      await page.getByTestId('freeze-confirm').fill('structural-freeze');
      await page.getByTestId('freeze-dialog-reason').fill('Pilot ended early');
      await page.getByTestId('freeze-dialog-submit').click(); // step-up from the retention save is still valid
      await expect(page.getByTestId('freeze-status')).toHaveText(locale === 'ar' ? 'تم رفع التجميد.' : 'The freeze was lifted.');
    });

    test('SLA rule set: draft, min over max, preview, publish with step-up', async ({ page }) => {
      await signIn(page, locale, 'pm');
      await page.getByTestId('nav-admin.settings').click();
      await page.getByTestId('settings-tab-sla').click();
      await page.getByTestId('sla-create-draft').click();
      await page.getByTestId('sla-create-dialog-reason').fill('Tighten A2');
      await page.getByTestId('sla-create-dialog-submit').click();
      await expect(page.getByTestId('sla-editor-status')).toBeVisible();
      await page.getByTestId('sla-min-D14').fill('9');
      await expect(page.getByTestId('sla-err-D14')).toBeVisible();
      await expect(page.getByTestId('sla-save')).toBeDisabled();
      await page.getByTestId('sla-min-D14').fill('2');
      await expect(page.getByTestId('sla-err-D14')).toHaveCount(0);
      await page.getByTestId('sla-max-A2').fill('6');
      await page.getByTestId('sla-save').click();
      await page.getByTestId('sla-save-dialog-reason').fill('A2 gets one more day');
      await page.getByTestId('sla-save-dialog-submit').click();
      await expect(page.getByTestId('sla-dirty')).toHaveCount(0);
      await page.getByTestId('sla-preview').click();
      await expect(page.getByTestId('sla-preview-changed')).toHaveText('14');
      await page.getByTestId('sla-preview-dialog-submit').click();
      await page.getByTestId('sla-publish').click();
      await expect(page.getByTestId('sla-publish-apply')).not.toBeChecked();
      await expect(page.getByTestId('sla-publish-warning')).toBeVisible();
      await page.getByTestId('sla-publish-dialog-reason').fill('Approved by the PM');
      await withStepUp(page, () => page.getByTestId('sla-publish-dialog-submit').click());
      await expect(page.getByTestId('sla-publish')).toHaveCount(0);
      await expect(page.getByTestId('sla-version-3')).toBeVisible();
    });

    test('weight sets: the 100% rule per level, then draft, save, publish', async ({ page }) => {
      await signIn(page, locale, 'pm');
      await page.getByTestId('nav-admin.settings').click();
      await page.getByTestId('settings-tab-weights').click();
      await page.getByTestId('weights-code').selectOption('health_index');
      await expect(page.getByTestId('weights-sum-activities')).toHaveAttribute('data-ok', 'false');
      await page.getByTestId('weights-publish-health_index').click();
      await page.getByTestId('weights-publish-dialog-reason').fill('Try to publish');
      await withStepUp(page, () => page.getByTestId('weights-publish-dialog-submit').click());
      await expect(page.getByTestId('weights-publish-error--activities')).toBeVisible();
      await expect(page.getByTestId('weights-publish-error--activities-0-items')).toBeVisible();
      await page.keyboard.press('Escape');

      await page.getByTestId('weights-code').selectOption('project_status');
      await page.getByTestId('weights-create-draft').click();
      await page.getByTestId('weights-create-dialog-reason').fill('Shift one point to CW');
      await page.getByTestId('weights-create-dialog-submit').click();
      await page.getByTestId('weights-weight-a3').fill('6');
      await expect(page.getByTestId('weights-sum-activities')).toHaveAttribute('data-ok', 'false');
      await page.getByTestId('weights-weight-a1').fill('11');
      await expect(page.getByTestId('weights-sum-activities')).toHaveAttribute('data-ok', 'true');
      await page.getByTestId('weights-save').click();
      await page.getByTestId('weights-save-dialog-reason').fill('Saving the draft');
      await page.getByTestId('weights-save-dialog-submit').click();
      await page.getByTestId('weights-preview').click();
      await expect(page.getByTestId('weights-preview-valid')).toHaveAttribute('data-valid', 'true');
      await page.getByTestId('weights-preview-dialog-submit').click();
      await page.getByTestId('weights-publish-project_status').click();
      await page.getByTestId('weights-publish-dialog-reason').fill('Owner approved');
      await page.getByTestId('weights-publish-dialog-submit').click(); // step-up from the first publish try is still valid
      await expect(page.getByTestId('weights-publish-project_status')).toHaveCount(0);
      await expect(page.getByTestId('weights-version-project_status-4')).toBeVisible();
    });

    test('holiday import asks for a reason', async ({ page }) => {
      await signIn(page, locale, 'pm');
      await page.getByTestId('nav-admin.settings').click();
      await page.getByTestId('cal-import-file').setInputFiles({ name: 'holidays.csv', mimeType: 'text/csv', buffer: Buffer.from('date,name_en\n2026-12-30,Test day\n') });
      await page.getByTestId('holiday-import-dialog-submit').click();
      await expect(page.getByTestId('holiday-import-dialog-reason-error')).toBeVisible();
      await page.getByTestId('holiday-import-dialog-reason').fill('Official list 2026');
      await page.getByTestId('holiday-import-dialog-submit').click();
      await expect(page.getByTestId('holiday-2026-12-30')).toBeVisible();
    });

    test('security log, integrity check and online now', async ({ page }) => {
      await signIn(page, locale, 'pm');
      await page.getByTestId('nav-admin.security_log').click();
      await expect(page.getByTestId('seclog-ip-col')).toBeVisible();
      await page.getByTestId('integrity-audit').click();
      await expect(page.getByTestId('integrity-status-audit')).toBeVisible();
      await expect(page.getByTestId('integrity-count-audit')).toHaveText('1842');
      await page.getByTestId('seclog-outcome').selectOption('failure');
      await expect(page.getByTestId('seclog-list').locator('tr').first()).toBeVisible();
      await page.getByTestId('nav-admin.users').click(); await page.getByTestId('people-tab-online').click();
      await expect(page.getByTestId('session-own')).toBeVisible();
      const other = page.locator('[data-testid^="session-revoke-"]').first();
      await other.click();
      await page.getByTestId('revoke-session-dialog-reason').fill('Shared device left open');
      await withStepUp(page, () => page.getByTestId('revoke-session-dialog-submit').click());
      await expect(page.getByTestId('toast').first()).toBeVisible();
    });

    test('security auditor sees the log without IPs and without online now', async ({ page }) => {
      await signIn(page, locale, 'auditor');
      await expect(page.getByTestId('nav-admin.online')).toHaveCount(0); // Online now is a tab of Users & Roles now
      await expect(page.getByTestId('people-tab-online')).toHaveCount(0);
      await page.getByTestId('nav-admin.security_log').click();
      await expect(page.locator('[data-testid^="seclog-row-"]').first()).toBeVisible();
      await expect(page.getByTestId('seclog-ip-col')).toHaveCount(0);
    });

    test('users: delete, deleted tab with blocked restore, then restore; act on behalf', async ({ page }) => {
      await signIn(page, locale, 'pm');
      await page.getByTestId('nav-admin.users').click();
      await page.getByTestId('user-delete-1305').click();
      await page.getByTestId('user-act-dialog-reason').fill('Duplicate account');
      await withStepUp(page, () => page.getByTestId('user-act-dialog-submit').click());
      await expect(page.getByTestId('user-row-1305')).toHaveCount(0);
      await page.getByTestId('users-tab-deleted').click();
      await expect(page.getByTestId('user-restore-9001')).toBeDisabled();
      await expect(page.getByTestId('restore-blocked-9001')).toBeVisible();
      await page.getByTestId('user-restore-1305').click();
      await page.getByTestId('user-act-dialog-reason').fill('Returned to the project');
      await page.getByTestId('user-act-dialog-submit').click();
      await expect(page.getByTestId('deleted-row-1305')).toHaveCount(0);

      await page.getByTestId('nav-absence').click();
      const list = page.getByTestId('alerts-absent');
      await expect(list.getByRole('listitem').first()).toBeVisible();
      const before = Number(await page.getByTestId('alerts-count-absent').textContent());
      await list.getByRole('listitem').first().locator('[data-testid^="alert-act_on_behalf-"]').click();
      await page.getByTestId('cover-dialog-reason').fill('Mona is on sick leave');
      await page.getByTestId('cover-dialog-submit').click();
      await expect(page.getByTestId('alerts-count-absent')).toHaveText(String(before - 1));
    });
  });
}
