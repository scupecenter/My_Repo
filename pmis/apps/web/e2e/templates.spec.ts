import { expect, test, type Page } from '@playwright/test';
import { login, withStepUp } from './helpers';

// Approved-template entry for a register: download (blank and pre-filled), a refused old version, upload, the batch review with the diff and the reasons per cell,
// sending it into the flow, and the L2 decisions. EN/light and AR/dark (RTL, dark tokens).
const CASES = [
  { locale: 'en', theme: 'light', refused: 'older version', checked: 'Checked', inFlow: 'In approval', approved: 'Approved' },
  { locale: 'ar', theme: 'dark', refused: 'إصدار أقدم', checked: 'تم الفحص', inFlow: 'قيد الاعتماد', approved: 'معتمد' },
] as const;

const openMore = async (page: Page) => { await page.getByTestId('more-menu').click(); await expect(page.getByTestId('more-panel')).toBeVisible(); };

for (const c of CASES) {
  test.describe(`${c.locale}/${c.theme}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(([l, t]) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.theme', t); }, [c.locale, c.theme]);
      await login(page, 'pm');
      await expect(page.locator('html')).toHaveAttribute('dir', c.locale === 'ar' ? 'rtl' : 'ltr');
      if (c.theme === 'dark') await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    });

    test('download, refused old version, upload, review, send into the flow, approve', async ({ page }) => {
      await page.getByTestId('nav-procurement').click();
      await expect(page.getByTestId('page-register-procurement')).toBeVisible();

      // download: blank, then pre-filled
      await openMore(page);
      const [blank] = await Promise.all([page.waitForEvent('download'), page.getByTestId('register-template-download').click()]);
      expect(blank.suggestedFilename()).toBe('TPL-PO_v1.xlsx');
      await openMore(page);
      const [filled] = await Promise.all([page.waitForEvent('download'), page.getByTestId('register-template-prefill').click()]);
      expect(filled.suggestedFilename()).toBe('TPL-PO_v1_prefilled.xlsx');

      // an old version is refused in the dialog, with the reason, and no batch is made
      await openMore(page);
      await page.getByTestId('register-template-upload').click();
      await expect(page.getByTestId('template-upload-dialog')).toBeVisible();
      await page.getByTestId('template-upload-file').setInputFiles({ name: 'old.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from('retired') });
      await page.getByTestId('template-upload-submit').click();
      await expect(page.getByTestId('template-upload-error')).toHaveAttribute('data-reason', 'outdated_version');
      await expect(page.getByTestId('template-upload-error')).toContainText(c.refused);
      await expect(page.getByTestId('page-register-batch')).toHaveCount(0);

      // a good file: the preview with the diff per cell and the reasons per cell
      await page.getByTestId('template-upload-file').setInputFiles({ name: 'filled.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from('filled') });
      await page.getByTestId('template-upload-submit').click();
      await expect(page.getByTestId('page-register-batch')).toBeVisible();
      await expect(page.getByTestId('batch-status')).toContainText(c.checked);
      await expect(page.getByTestId('batch-count-invalid')).toContainText('2');
      await expect(page.getByTestId('batch-diff-new-4-order_status')).toBeVisible();
      await expect(page.getByTestId('batch-cell-error-7-site_code')).toBeVisible();

      // the uploader sends it into the flow; L2 approves all at once (final approval needs the step-up)
      await page.getByTestId('batch-submit').click();
      await expect(page.getByTestId('page-register-batch')).toHaveAttribute('data-status', 'in_approval');
      await expect(page.getByTestId('batch-status')).toContainText(c.inFlow);
      await withStepUp(page, async () => { await page.getByTestId('batch-approve-all').click(); });
      await expect(page.getByTestId('page-register-batch')).toHaveAttribute('data-status', 'approved');
      await expect(page.getByTestId('batch-done')).toBeVisible();
      await expect(page.getByTestId('batch-status')).toContainText(c.approved);

      // the batch is in the Templates page list
      await page.getByTestId('nav-templates').click();
      await expect(page.getByTestId('page-templates')).toBeVisible();
      await expect(page.locator('[data-testid^="batch-list-row-"][data-status="approved"]')).toHaveCount(1);
      await expect(page.getByTestId('tpl-version-TPL-PO')).toContainText('v1');
    });
  });
}
