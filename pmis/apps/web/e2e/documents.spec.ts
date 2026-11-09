import { expect, test } from '@playwright/test';
import { login, stepUp } from './helpers';

// These specs drive the list grid; the site page opens on the Excel-like row by default (2026-11-08).
test.beforeEach(async ({ page }) => { await page.addInitScript(() => { if (!localStorage.getItem('pmis.site.layout')) localStorage.setItem('pmis.site.layout', '"list"'); }); });

/** The document upload module on the mock layer: a slot takes a good file and refuses a bad one, Submit follows the mandatory slots, the site Documents tab and the Document Library. */
for (const locale of ['en', 'ar'] as const) {
  test(`upload to a named slot, refuse a program, submit, then find the file on the Documents tab (${locale})`, async ({ page }) => {
    await page.addInitScript((l) => { if (!localStorage.getItem('pmis.locale')) localStorage.setItem('pmis.locale', l); }, locale);
    await login(page, 'reviewer');
    await page.getByTestId('nav-sites').click();
    await page.getByTestId('site-row-TR101').click();
    await expect(page.getByTestId('pipeline')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');

    // the actual date, then open the task
    const row = page.locator('[data-task="A1"]');
    await row.locator('[data-testid$="-actual"]').click();
    await row.locator('[data-testid^="grid-input-"]').fill('2026-10-20');
    await row.locator('[data-testid^="grid-input-"]').press('Enter');
    await row.locator('[data-testid^="grid-open-"]').click();
    await expect(page.getByTestId('task-drawer')).toBeVisible();

    // Submit is disabled until the mandatory slot is filled; the slot says what it takes
    await expect(page.getByTestId('drawer-submit')).toBeDisabled();
    const slot = page.locator('[data-testid^="slot-input-"]').first();
    const slotId = (await slot.getAttribute('data-testid'))!.replace('slot-input-', '');
    await expect(page.getByTestId(`slot-limits-${slotId}`)).toContainText('pdf');
    await expect(page.getByTestId(`slot-status-${slotId}`)).toHaveAttribute('class', /chip/);
    // the phone camera is offered for a slot that takes images
    await expect(page.locator('input[capture="environment"]').first()).toBeAttached();

    // a program is refused with its reason, the slot stays missing and Submit stays disabled
    await slot.setInputFiles({ name: 'invoice.exe', mimeType: 'application/x-msdownload', buffer: Buffer.from('MZ') });
    await expect(page.getByText(/invoice\.exe/)).toBeVisible();
    await expect(page.getByTestId('drawer-submit')).toBeDisabled();

    // a PDF is accepted; the slot shows the file with its version; Submit is enabled
    await slot.setInputFiles({ name: 'sar.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 sar') });
    await expect(page.getByTestId(`slot-${slotId}`)).toHaveAttribute('data-status', 'uploaded');
    await expect(page.locator(`[data-testid="slot-${slotId}"] [data-testid^="file-v-"]`).first()).toHaveText('v1');
    await expect(page.getByTestId('drawer-submit')).toBeEnabled();
    await page.getByTestId('drawer-submit').click();
    await expect(page.getByTestId('task-drawer-body')).toHaveAttribute('data-state', 'in_approval');
    await expect(page.getByTestId(`slot-${slotId}`)).toHaveAttribute('data-status', 'in_review');
    // under review the slot takes no new file
    await expect(page.getByTestId(`slot-drop-${slotId}`)).toHaveCount(0);
    await page.keyboard.press('Escape');

    // the site Documents tab lists the file; a filter narrows it; the zip is offered
    await page.getByTestId('site-section-documents').click();
    await expect(page.getByTestId('site-documents')).toBeVisible();
    await expect(page.locator('[data-testid^="doc-row-"]').first()).toBeVisible();
    await page.getByTestId('docs-filter-doc').fill('ZZZ');
    await expect(page.getByTestId('docs-empty')).toBeVisible();
    await page.getByTestId('docs-filter-doc').fill('');
    await expect(page.locator('[data-testid^="doc-row-"]').first()).toBeVisible();
    const download = page.waitForEvent('download');
    await page.locator('[data-testid^="doc-dl-"]').first().click();
    expect((await download).suggestedFilename()).toMatch(/_A1_/);
    await page.locator('[data-testid^="doc-pick-"]').first().check();
    const zip = page.waitForEvent('download');
    await page.getByTestId('docs-zip-picked').click();
    expect((await zip).suggestedFilename()).toMatch(/^GSDN_Documents_\d{8}\.zip$/);
  });

  test(`Document Library: new document, draft, publish for open tasks too, versions (${locale})`, async ({ page }) => {
    await page.addInitScript((l) => { if (!localStorage.getItem('pmis.locale')) localStorage.setItem('pmis.locale', l); }, locale);
    await login(page, 'pm');
    await page.goto('/admin/settings/documents');
    await expect(page.getByTestId('page-document-library')).toBeVisible();
    await expect(page.getByTestId('lib-row-A2')).toContainText('v1');
    await expect(page.getByTestId('lib-review-D16_PAC')).toBeVisible();

    await page.getByTestId('lib-new').click();
    await page.getByTestId('doc-code').fill('E2E_DOC');
    await page.getByTestId('doc-name-en').fill('E2E document');
    await page.getByTestId('doc-placement-ref-0').fill('F1');
    await page.getByTestId('doc-dialog-reason').fill('e2e test');
    await page.getByTestId('doc-dialog-submit').click();
    await expect(page.getByTestId('lib-row-E2E_DOC')).toBeVisible();
    await expect(page.getByTestId('lib-draft-E2E_DOC')).toBeVisible();

    await page.getByTestId('lib-publish-E2E_DOC').click();
    await expect(page.getByTestId('doc-apply-new')).toBeChecked();
    await expect(page.getByTestId('doc-open-count')).toContainText('7');
    await page.getByTestId('doc-apply-open').check();
    await page.getByTestId('doc-publish-dialog-reason').fill('apply to open tasks');
    await page.getByTestId('doc-publish-dialog-submit').click();
    await stepUp(page, 'pm');
    await expect(page.getByTestId('lib-version-E2E_DOC')).toHaveText(/1/);
    await page.getByTestId('lib-versions-E2E_DOC').click();
    await expect(page.getByTestId('doc-versions')).toContainText('7');
  });
}
