import { expect, test } from '@playwright/test';
import { login } from './helpers';

// Alert rules (item 13), against the mock layer: EN/light and AR/dark. The seeded rule is listed, the form opens with the closed
// catalogues (kind, audience, and the register/state/days of record_idle), and a create goes through the reason dialog.
for (const c of [{ locale: 'en', theme: 'light' }, { locale: 'ar', theme: 'dark' }] as const) {
  test(`alert rules: list, form and create (${c.locale}/${c.theme})`, async ({ page }) => {
    await page.addInitScript(([l, t]) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.theme', t); }, [c.locale, c.theme]);
    await login(page, 'pm');
    await page.goto('/admin/settings/alerts/rules');
    await expect(page.getByTestId('page-alert-rules')).toBeVisible();
    await expect(page.getByTestId('ar-row-weekly-status-missing')).toBeVisible();
    await page.getByTestId('page-alert-rules').screenshot({ path: `test-results/alr-1-list-${c.locale}.png` });

    await page.getByTestId('ar-new').click();
    await expect(page.getByTestId('ar-form')).toBeVisible();
    await page.getByTestId('ar-code').fill('idle-issues');
    await page.getByTestId('ar-kind').selectOption('record_idle');
    await page.getByTestId('ar-register').selectOption('issues');
    await page.getByTestId('ar-state').fill('open');
    await page.getByTestId('ar-days').fill('30');
    await page.getByTestId('ar-title_en').fill('Idle issues');
    await page.getByTestId('ar-title_ar').fill('بلاغات خامدة');
    await page.getByTestId('ar-body_en').fill('Record {{record}} idle {{days}} days.');
    await page.getByTestId('ar-body_ar').fill('السجل {{record}} خامد {{days}} يوم.');
    await page.getByTestId('page-alert-rules').screenshot({ path: `test-results/alr-2-form-${c.locale}.png` });

    await page.getByTestId('ar-save').click();
    await expect(page.getByTestId('ar-dialog')).toBeVisible();
    await page.getByTestId('ar-dialog-reason').fill('Watch idle issues');
    await page.getByTestId('page-alert-rules').screenshot({ path: `test-results/alr-3-reason-${c.locale}.png` });
    await page.getByTestId('ar-dialog-submit').click();
    await expect(page.getByTestId('ar-row-idle-issues')).toBeVisible();
    await page.getByTestId('page-alert-rules').screenshot({ path: `test-results/alr-4-created-${c.locale}.png` });
  });
}
