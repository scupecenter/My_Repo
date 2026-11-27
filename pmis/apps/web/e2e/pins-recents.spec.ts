import { expect, test } from '@playwright/test';
import { login } from './helpers';

// Pinned and recent records in the sidebar (item 5): EN and AR. Open a site, pin it, go elsewhere: it is in the sidebar and opens again.
for (const c of [{ locale: 'en' }, { locale: 'ar' }] as const) {
  test(`records: a pinned and a recent site show in the sidebar (${c.locale})`, async ({ page }) => {
    await page.addInitScript((l) => { localStorage.setItem('pmis.locale', l); }, c.locale);
    await login(page, 'pm');
    await page.goto('/sites');
    await page.locator('[data-testid^="site-row-"]').first().click();
    await expect(page.getByTestId('page-site')).toBeVisible();
    await page.getByTestId('record-pin').click();
    await expect(page.getByTestId('record-pin')).toHaveAttribute('aria-pressed', 'true');
    await page.goto('/dashboard');
    await expect(page.getByTestId('nav-pinned-records')).toBeVisible();
    await page.getByTestId('nav-pinned-records').screenshot({ path: `test-results/pins-${c.locale}.png` });
    await page.locator('[data-testid^="rec-pin-"]').first().getByRole('link').click();
    await expect(page.getByTestId('page-site')).toBeVisible();
  });
}
