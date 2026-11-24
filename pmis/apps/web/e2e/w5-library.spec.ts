import { expect, test } from '@playwright/test';
import { login } from './helpers';

// W5 of plan 2026-11-23-next-ui-cleanup: generate a filled document for a site (Library > Forms), upload the signed copy, and see it in the Archive with
// its lifecycle. Synthetic data of the mocks only.
for (const locale of ['en', 'ar'] as const) {
  test(`W5 library: generate, upload the signed copy, see it in the archive (${locale})`, async ({ page }) => {
    await page.addInitScript((l) => { localStorage.setItem('pmis.locale', l); }, locale);
    await login(page, 'pm');
    await page.getByTestId('nav-library.forms').click();
    await expect(page.getByTestId('page-library-forms')).toBeVisible();
    await page.getByTestId('lib-form-generate-SSR').click();
    const dlg = page.getByTestId('lib-generate-dialog');
    await dlg.getByTestId('lib-site-input').fill('MI102');
    await page.getByTestId('lib-site-hit-MI102').click();
    // the auto-filled preview: a frame that runs no script
    const frame = page.getByTestId('lib-preview-frame');
    await expect(frame).toHaveAttribute('sandbox', '');
    await expect(page.frameLocator('[data-testid="lib-preview-frame"]').locator('body')).toContainText('MI102');
    await page.getByTestId('lib-generate').click();
    await expect(page.getByTestId('lib-generated-number')).toContainText('SSR-2026-0001');
    // print and sign offline, then upload the signed copy into the task's slot
    await page.getByTestId('lib-upload-input').setInputFiles({ name: 'MI102-signed.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 signed copy') });
    await expect(page.getByTestId('lib-generated-status')).toHaveAttribute('class', /chip/);
    await expect(page.getByTestId('lib-generated-status')).toContainText(locale === 'en' ? 'Signed and uploaded' : 'موقَّع ومرفوع');
    await page.keyboard.press('Escape');
    // the Archive: the TSSR card, then its list with the uploaded row
    await page.getByTestId('nav-library.archive').click();
    await page.getByTestId('lib-card-open-A2').click();
    await expect(page.getByTestId('lib-archive-toolbar')).toBeVisible();
    await page.getByTestId('lib-archive-search').fill('MI102');
    const row = page.getByTestId('lib-row-site-MI102').locator('xpath=ancestor::*[@role="row"][1]');
    await expect(row).toHaveAttribute('data-status', 'signed_uploaded');
    await expect(row).toContainText('SSR-2026-0001');
    await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
  });
}
