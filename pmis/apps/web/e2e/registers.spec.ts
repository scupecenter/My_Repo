import { expect, test } from '@playwright/test';
import { login, withStepUp } from './helpers';

// Registers: manual entry create -> submit -> review -> approve, and a Responsibility Matrix edit. EN/light and AR/dark (RTL, dark tokens).
const CASES = [
  { locale: 'en', theme: 'light', group: 'Registers', proc: 'Procurement', approved: 'Approved', matrix: 'Responsibility Matrix' },
  { locale: 'ar', theme: 'dark', group: 'السجلات', proc: 'المشتريات', approved: 'معتمد', matrix: 'مصفوفة المسؤوليات' },
] as const;

for (const c of CASES) {
  test.describe(`${c.locale}/${c.theme}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(([l, t]) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.theme', t); }, [c.locale, c.theme]);
      await login(page, 'pm');
      await expect(page.locator('html')).toHaveAttribute('dir', c.locale === 'ar' ? 'rtl' : 'ltr');
      if (c.theme === 'dark') await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    });

    test('procurement record: create, submit, review, approve', async ({ page }) => {
      await expect(page.getByTestId('sidebar')).toContainText(c.group);
      await page.getByTestId('nav-procurement').click();
      await expect(page.getByTestId('page-register-procurement')).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toContainText(c.locale === 'ar' ? c.proc : 'Procurement');
      await expect(page.getByTestId('register-export')).toBeVisible();
      await page.getByTestId('register-new').click();
      await page.getByTestId('reg-site-search').fill('TR101');
      await page.getByTestId('reg-site-opt-TR101').click();
      await page.getByTestId('reg-field-scope').selectOption('CW');
      await page.getByTestId('reg-field-delivery').selectOption('Outsourced');
      await page.getByTestId('reg-field-order_status').fill('Open');
      await page.getByTestId('reg-field-pr_no').fill('PR-2026-E2E');
      await page.getByTestId('reg-submit').click();
      await expect(page.getByTestId('register-drawer-body')).toHaveAttribute('data-state', 'in_review');
      await page.getByTestId('reg-review').click();
      await expect(page.getByTestId('register-drawer-body')).toHaveAttribute('data-state', 'in_approval');
      await page.getByTestId('reg-approve').click();
      await expect(page.getByTestId('register-drawer-body')).toHaveAttribute('data-state', 'approved');
      await expect(page.getByTestId('reg-state')).toHaveText(c.approved);
      await page.getByTestId('reg-close').click();
      await page.getByTestId('register-search').fill('PR-2026-E2E');
      await expect(page.locator('[data-testid^="reg-row-"][data-state="approved"]')).toHaveCount(1);
    });

    test('permits: the expiry switch hides the date and marks the permit permanent', async ({ page }) => {
      await page.getByTestId('nav-permits_hse').click();
      await page.getByTestId('register-new').click();
      await expect(page.getByTestId('reg-field-valid_to')).toBeVisible();
      await page.getByTestId('reg-field-has_expiry').uncheck();
      await expect(page.getByTestId('reg-field-valid_to')).toHaveCount(0);
      await expect(page.getByTestId('reg-permanent')).toBeVisible();
    });

    test('matrix: edit a holder, publish with a reason and re-authentication', async ({ page }) => {
      await page.getByTestId('nav-admin.users').click();
      await page.getByTestId('people-tab-matrix').click();
      await expect(page.getByTestId('page-matrix')).toBeVisible();
      await expect(page.getByTestId('page-matrix')).toContainText(c.matrix);
      await expect(page.getByTestId('matrix-row-procurement')).toBeVisible();
      await expect(page.getByTestId('matrix-rule-pre_cw-1')).toBeVisible();
      const cell = page.getByTestId('matrix-cell-pre_cw-1');
      await cell.getByTestId('matrix-add').click();
      await page.getByTestId('matrix-picker-q').fill('Hana');
      await page.getByTestId('matrix-opt-user-1210').click();
      await expect(cell.getByTestId('person-id-1210')).toBeVisible();
      await expect(page.getByTestId('matrix-dirty')).toContainText('1');
      await page.getByTestId('matrix-publish').click();
      await page.getByTestId('matrix-reason').fill('Cover Middle region');
      await withStepUp(page, () => page.getByTestId('matrix-publish-confirm').click());
      await expect(page.getByTestId('matrix-dirty')).toContainText('0');
      await expect(page.getByTestId('matrix-cell-pre_cw-1').getByTestId('person-id-1210')).toBeVisible();
    });
  });
}
