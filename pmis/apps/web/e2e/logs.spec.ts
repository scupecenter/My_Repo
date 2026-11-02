import { expect, test, type Page } from '@playwright/test';
import { login, stepUp } from './helpers';

async function signIn(page: Page, locale: 'en' | 'ar', theme: 'light' | 'dark') {
  await page.addInitScript(([l, t]) => {
    if (!localStorage.getItem('pmis.locale')) localStorage.setItem('pmis.locale', l);
    if (!localStorage.getItem('pmis.theme')) localStorage.setItem('pmis.theme', t);
  }, [locale, theme]);
  await login(page, 'pm');
  await expect(page.getByTestId('nav-group-logs')).toBeVisible();
}

const runs = [{ locale: 'en', theme: 'light' }, { locale: 'ar', theme: 'dark' }] as const;

for (const { locale, theme } of runs) {
  test.describe(`${locale} / ${theme}`, () => {
    test.beforeEach(async ({ page }) => { await signIn(page, locale, theme); });

    test('sets direction and theme, and shows the open-alert badge in the menu', async ({ page }) => {
      await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
      if (theme === 'dark') await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await expect(page.getByTestId('alerts-badge')).toHaveText('3');
    });

    test('audit log: filter, open the drawer with the diff, check integrity', async ({ page }) => {
      await page.getByTestId('nav-audit').click();
      await expect(page.getByTestId('page-audit-log')).toBeVisible();
      await expect(page.locator('[data-testid^="audit-table-row-"]').first()).toBeVisible();
      await page.getByTestId('f-via').selectOption('bulk');
      await expect(page.getByTestId('chip-via')).toBeVisible();
      await page.getByTestId('chips-clear').click();
      await page.getByTestId('audit-table-row-1848').click();
      await expect(page.getByTestId('ad-self-approval')).toBeVisible();
      await expect(page.getByTestId('diff-row-state')).toHaveAttribute('data-changed', 'true');
      await page.getByTestId('audit-drawer-close').click();
      await page.getByTestId('audit-integrity').click();
      await expect(page.getByTestId('integrity-status-audit')).toBeVisible();
    });

    test('field changes: who changed the Power-On date', async ({ page }) => {
      await page.getByTestId('nav-logs.field_changes').click();
      await page.getByTestId('f-more').click();
      await page.getByTestId('f-entity-id').fill('a0000000-0000-4000-8000-000000000501');
      await expect(page.locator('[data-testid^="fc-table-row-"]')).toHaveCount(3);
      await expect(page.getByTestId('fc-new-fc-002')).toHaveText('2026-11-03');
      await page.getByTestId('fc-table-row-fc-002').click();
      await expect(page.getByTestId('fc-device')).toBeVisible();
    });

    test('online now: end a session with a reason and step-up', async ({ page }) => {
      await page.getByTestId('nav-logs.online').click();
      await expect(page.locator('[data-testid^="asession-"]')).toHaveCount(5);
      await page.getByTestId('session-end-90000000-0000-4000-8000-000000001002').click();
      await page.getByTestId('end-session-dialog-reason').fill('Shared device left open');
      await page.getByTestId('end-session-dialog-submit').click();
      await stepUp(page);
      await expect(page.locator('[data-testid^="asession-"]')).toHaveCount(4);
    });

    test('security alerts: acknowledge with a note and the badge drops', async ({ page }) => {
      await page.getByTestId('nav-logs.alerts').click();
      await page.getByTestId('alert-ack-al-1').click();
      await page.getByTestId('ack-dialog-reason').fill('Checked with the owner');
      await page.getByTestId('ack-dialog-submit').click();
      await expect(page.getByTestId('alert-al-1')).toHaveCount(0);
      await expect(page.getByTestId('alerts-badge')).toHaveText('2');
    });

    test('job runs, deployments, security log and the monthly report', async ({ page }) => {
      await page.getByTestId('nav-logs.job_runs').click();
      await expect(page.getByTestId('job-outcome-job-5')).toBeVisible();
      await page.getByTestId('nav-logs.deployments').click();
      await expect(page.getByTestId('deployment-dep-8')).toBeVisible();
      await page.getByTestId('nav-admin.security_log').click();
      await expect(page.getByTestId('page-security-log')).toBeVisible();
      await page.getByTestId('nav-logs.activity_report').click();
      await expect(page.getByTestId('report-user-1001')).toBeVisible();
      const download = page.waitForEvent('download');
      await page.getByTestId('report-csv').click();
      expect((await download).suggestedFilename()).toMatch(/^activity-\d{4}-\d{2}\.csv$/);
    });

    test('readable on a phone: no sideways page scroll on the log screens', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 800 });
      for (const path of ['/audit', '/admin/logs/field-changes', '/admin/logs/alerts', '/admin/logs/activity-report']) {
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(over, path).toBeLessThanOrEqual(1);
      }
    });
  });
}
