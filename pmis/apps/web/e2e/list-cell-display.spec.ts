import { expect, test, type Page } from '@playwright/test';
import { login } from './helpers';

// Visual check for item 15: coloured list values, a percentage bar and a relative date in register cells.
const show = async (page: Page, col: string) => {
  await page.getByTestId('cols-menu').click();
  const toggle = page.getByTestId(`col-toggle-${col}`);
  if (!(await toggle.isChecked())) await toggle.click();
  await page.keyboard.press('Escape');
};
for (const locale of ['en', 'ar'] as const) {
  test(`list cell display (${locale})`, async ({ page }) => {
    await page.addInitScript((l) => { localStorage.setItem('pmis.locale', l); localStorage.removeItem('pmis.table.v1'); }, locale);
    await login(page, 'pm');
    await page.getByTestId('nav-permits_hse').click();
    await expect(page.getByTestId('page-register-permits_hse')).toBeVisible();
    await show(page, 'f:valid_to');
    await page.screenshot({ path: `test-results/lcd-1-permits-${locale}.png` });
    await page.getByTestId('nav-procurement').click();
    await expect(page.getByTestId('page-register-procurement')).toBeVisible();
    await show(page, 'f:receipt_pct');
    await page.screenshot({ path: `test-results/lcd-2-proc-${locale}.png` });
  });
}
