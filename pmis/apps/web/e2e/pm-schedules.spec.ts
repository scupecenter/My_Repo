import { expect, test } from '@playwright/test';
import { login } from './helpers';

// Preventive-maintenance schedules (contract 0.15.161), against the mock layer: EN/light and AR/dark. Settings adds a schedule due today and saves it with a
// reason; the register shows it as due; "Create draft" creates one draft and moves the next due date on, so the panel goes away.
for (const c of [{ locale: 'en', theme: 'light', title: 'Preventive maintenance' }, { locale: 'ar', theme: 'dark', title: 'الصيانة الوقائية' }] as const) {
  test(`pm schedules: add, see due on the register, create the draft (${c.locale}/${c.theme})`, async ({ page }) => {
    await page.addInitScript(([l, t]) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.theme', t); }, [c.locale, c.theme]);
    await login(page, 'pm');
    await page.goto('/admin/settings/screens/pm-schedules');
    await expect(page.getByTestId('page-pm-settings')).toBeVisible();
    await expect(page.getByTestId('settings-section-screens-pm-schedules')).toHaveText(c.title);
    await expect(page.getByTestId('pm-empty')).toBeVisible();
    await page.getByTestId('pm-add').click();
    await page.getByTestId('pm-name-en-schedule').fill('Monthly check');
    await page.getByTestId('pm-add-field-schedule').click();
    await page.getByTestId('pm-save').click();
    await page.getByTestId('pm-save-dialog-reason').fill('Plan');
    await page.getByTestId('pm-save-dialog-submit').click();
    await expect(page.getByTestId('pm-version')).toContainText('1');
    await expect(page.getByTestId('pm-create-schedule')).toBeVisible();
    await page.getByTestId('page-pm-settings').screenshot({ path: `test-results/pm-settings-${c.locale}.png` });

    await page.getByTestId('pm-open-schedule').click();
    await expect(page.getByTestId('pm-due')).toBeVisible();
    await page.getByTestId('pm-due').screenshot({ path: `test-results/pm-due-${c.locale}.png` });
    await page.getByTestId('pm-create-schedule').click();
    await expect(page.getByTestId('pm-due')).toHaveCount(0);
  });
}
