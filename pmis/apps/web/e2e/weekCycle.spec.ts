import { expect, test } from '@playwright/test';
import { login } from './helpers';

// Weekly cycle plan (PM item 10): the Week tab of My Work > Daily Plan shows the seven days, and the carry-over adds the rows below target to the next working day.
for (const c of [{ locale: 'en', theme: 'light' }, { locale: 'ar', theme: 'dark' }] as const) {
  test(`week cycle: grid and carry-over (${c.locale}/${c.theme})`, async ({ page }) => {
    await page.addInitScript(([l, t]) => { localStorage.setItem('pmis.locale', l); localStorage.setItem('pmis.theme', t); }, [c.locale, c.theme]);
    await login(page, 'pm');
    await page.getByTestId('nav-daily_plan').click();
    await expect(page.getByTestId('page-daily-plan')).toBeVisible();
    // TR102 is removed from the plan of the next working day, so the carry-over has something to add
    await page.getByTestId('daily-plan-date').fill('2026-11-23');
    await page.getByTestId('daily-plan-remove-TR102').click();
    await expect(page.getByTestId('daily-plan-row-TR102')).toHaveCount(0);
    await page.getByTestId('daily-plan-date').fill('2026-11-22');
    await page.getByTestId('daily-plan-tab-week').click();
    await expect(page.getByTestId('week-cycle')).toBeVisible();
    await expect(page.getByTestId('week-range')).toContainText('2026-11-22');
    await expect(page.getByTestId('week-row-TR102')).toBeVisible();
    await expect(page.getByTestId('week-cell-TR102-2026-11-22')).toHaveAttribute('data-state', 'below');
    await page.screenshot({ path: `test-results/week-cycle-${c.locale}.png`, fullPage: true });

    await page.getByTestId('week-carry-2026-11-22').click();
    await expect(page.getByTestId('week-carry-dialog')).toBeVisible();
    await expect(page.getByTestId('week-carry-list')).toContainText('TR102');
    await page.screenshot({ path: `test-results/week-cycle-carry-${c.locale}.png` });
    await page.getByTestId('week-carry-dialog-submit').click();
    await expect(page.getByTestId('week-carry-dialog')).toHaveCount(0);
    await expect(page.getByTestId('week-cell-TR102-2026-11-23')).not.toHaveAttribute('data-state', 'none');
    await page.getByTestId('week-next').click();
    await page.getByTestId('week-prev').click();
    await expect(page.getByTestId('week-range')).toContainText('2026-11-22');
  });
}
