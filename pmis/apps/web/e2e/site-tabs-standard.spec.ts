import { expect, test } from '@playwright/test';
import { login } from './helpers';

// Item (b): every lower tab of the site page carries the table standard toolbar (search, count, columns, density, display, export).
const TABS: Array<[string, string]> = [['documents', 'docs-table'], ['snags', 'site-snags-toolbar'], ['scope', 'scope-tasks-table']];

for (const locale of ['en', 'ar'] as const) {
  test(`site lower tabs use the table standard (${locale})`, async ({ page }) => {
    await page.addInitScript((l) => { if (!localStorage.getItem('pmis.locale')) localStorage.setItem('pmis.locale', l); }, locale);
    await login(page, 'reviewer');
    await page.getByTestId('nav-sites').click();
    await page.getByTestId('site-row-TR101').click();
    await expect(page.getByTestId('site-section-tabs')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
    for (const [tab, tid] of TABS) {
      await page.getByTestId(`site-section-${tab}`).click();
      await expect(page.getByTestId(tid).first()).toBeVisible();
      await expect(page.locator('[data-testid$="-search"]:visible').first()).toBeVisible();
      await page.screenshot({ path: `/downloads/site-tab-${tab}-${locale}.png` });
    }
  });
}
