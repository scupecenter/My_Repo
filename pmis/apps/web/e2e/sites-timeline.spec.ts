import { expect, test } from '@playwright/test';
import { login } from './helpers';

// Cross-site timeline (item 7): EN and AR, read only. The layout opens from the View menu, draws markers, and a date column can be switched.
for (const c of [{ locale: 'en' }, { locale: 'ar' }] as const) {
  test(`timeline: sites on a date axis (${c.locale})`, async ({ page }) => {
    await page.addInitScript((l) => { localStorage.setItem('pmis.locale', l); }, c.locale);
    await login(page, 'pm');
    await page.goto('/sites?layout=timeline');
    await expect(page.getByTestId('sites-timeline')).toBeVisible();
    await expect(page.getByTestId('timeline-cols')).toBeVisible();
    await expect(page.locator('[data-testid^="timeline-row-"]').first()).toBeVisible();
    await expect(page.getByTestId('timeline-today')).toBeAttached();
    await page.getByTestId('sites-timeline').screenshot({ path: `test-results/timeline-${c.locale}.png` });
    await expect(page.locator('[data-testid^="timeline-row-"] a').first()).toHaveAttribute('href', /\/sites\//);
  });
}
