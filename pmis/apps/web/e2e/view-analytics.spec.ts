import { expect, test } from '@playwright/test';
import { login } from './helpers';

// Analytics of a register view (item 8), against the mock layer: EN/light and AR/dark.
for (const c of [{ locale: 'en', theme: 'light' }, { locale: 'ar', theme: 'dark' }] as const) {
  test(`register: the analytics panel counts the rows of the view (${c.locale}/${c.theme})`, async ({ page }) => {
    await page.addInitScript(([l, t]) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.theme', t); }, [c.locale, c.theme]);
    await login(page, 'pm');
    await page.goto('/registers/procurement');
    await expect(page.getByTestId('register-count')).toBeVisible();
    await page.getByTestId('view-analytics').click();
    const panel = page.getByTestId('view-analytics-panel');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('analytics-counted')).toBeVisible();
    await expect(page.getByTestId('analytics-slices').locator('li').first()).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `test-results/view-analytics-${c.locale}.png` });
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
  });
}
