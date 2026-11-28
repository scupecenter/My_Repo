import { expect, test } from '@playwright/test';
import { login } from './helpers';

// The chart view mode of a register (decision V4), against the mock layer: EN/light and AR/dark. The axis, the measure and the drawing are
// chosen in the Layout panel and kept in the URL.
for (const c of [{ locale: 'en', theme: 'light' }, { locale: 'ar', theme: 'dark' }] as const) {
  test(`register: the chart mode draws the rows of the view (${c.locale}/${c.theme})`, async ({ page }) => {
    await page.addInitScript(([l, t]) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.theme', t); }, [c.locale, c.theme]);
    await login(page, 'pm');
    await page.goto('/registers/procurement');
    await expect(page.getByTestId('register-count')).toBeVisible();
    await page.getByTestId('register-view').click();
    await page.getByTestId('register-layout-chart').click();
    await expect(page).toHaveURL(/layout=chart/);
    await expect(page.getByTestId('register-chart-card')).toBeVisible();
    await expect(page.getByTestId('register-chart-slices').locator('li').first()).toBeVisible();
    // the axis, the measure and the drawing live in the Layout panel and are kept in the URL
    await page.getByTestId('register-view').click();
    await expect(page.getByTestId('register-chart-axis')).toBeVisible();
    await page.getByTestId('register-chart-kind').selectOption('pie');
    await expect(page).toHaveURL(/chk=pie/);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `test-results/view-chart-${c.locale}.png` });
  });
}
