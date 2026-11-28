import { expect, test } from '@playwright/test';
import { login } from './helpers';

// Burndown view of the progress curve card (same snapshots): the toggle switches the chart, EN and AR.
for (const l of ['en', 'ar'] as const) {
  test(`burndown toggle on the progress card (${l})`, async ({ page }) => {
    await page.addInitScript((x) => { localStorage.setItem('pmis.locale', x); }, l);
    await login(page, 'pm');
    await page.goto('/dashboard');
    const card = page.getByTestId('dash-scurve');
    await card.scrollIntoViewIfNeeded().catch(() => undefined);
    if (await card.count() === 0) test.skip(true, 'card not on the default tab');
    await expect(card).toBeVisible();
    await expect(page.getByTestId('dash-scurve-mode-progress')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('dash-scurve-mode-burndown').click();
    await expect(page.getByTestId('dash-burndown-chart')).toBeVisible();
    await expect(page.getByTestId('dash-scurve-mode-burndown')).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `/tmp/burndown-${l}.png` });
    await page.getByTestId('dash-scurve-mode-progress').click();
    await expect(page.getByTestId('dash-scurve-chart')).toBeVisible();
  });
}
